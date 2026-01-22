#!/usr/bin/env bun
import { TextToSpeechClient } from '@google-cloud/text-to-speech';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { GoogleGenAI } from '@google/genai';
import { Readability } from '@mozilla/readability';
import chalk from 'chalk';
import crypto from 'crypto';
import { parseHTML } from 'linkedom';
import path from 'path';
import pLimit from 'p-limit';
import sharp from 'sharp';
import TurndownService from 'turndown';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import { createScript, style } from './utils/createScript';

// =============================================================================
// Constants
// =============================================================================

const GEMINI_CONCURRENCY = 5;
const TTS_CONCURRENCY = 5;
const FETCH_CONCURRENCY = 10;

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
const GCS_BUCKET = 'stefan-rss-feed';
const GCS_BASE_URL = `https://storage.googleapis.com/${GCS_BUCKET}`;

const THUMBNAIL_SIZE = 1400;
const THUMBNAIL_BORDER_WIDTH = 40;
const THUMBNAIL_BORDER_COLOR = '#1E90FF';
const THUMBNAIL_TAG_COLOR = '#FFFFFF';

const MD_IMAGE_REGEX = /!\[.*?\]\(([^)]+)\)/g;

const IMAGE_CACHE_DIR = path.join(process.cwd(), '.cache', 'read-to-me', 'images');
const IMAGE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 1 week

const TTS_OPTIMIZER_PROMPT_PATH = path.join(import.meta.dir, 'prompts', 'tts-optimizer.md');

// =============================================================================
// Concurrency Limiters
// =============================================================================

const geminiLimit = pLimit(GEMINI_CONCURRENCY);
const ttsLimit = pLimit(TTS_CONCURRENCY);
const fetchLimit = pLimit(FETCH_CONCURRENCY);

// =============================================================================
// API Clients
// =============================================================================

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
/** Standard Gemini client for text/image analysis */
const geminiClient = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;
/** New Gemini client for image generation (Gemini 2.5 Flash Image) */
const geminiImageClient = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;
const ttsClient = new TextToSpeechClient();

// =============================================================================
// Voice Configuration
// =============================================================================

const ENGLISH_DIALECTS = ['en-AU', 'en-GB', 'en-IN', 'en-US'] as const;
type EnglishDialect = typeof ENGLISH_DIALECTS[number];

const CHIRP3_VOICES = ['Aoede', 'Charon', 'Fenrir', 'Kore', 'Leda', 'Orus', 'Puck', 'Zephyr'] as const;
type Voice = typeof CHIRP3_VOICES[number];

const VOICE_GENDERS: Record<Voice, 'male' | 'female'> = {
    Aoede: 'female', Charon: 'male', Fenrir: 'male', Kore: 'female',
    Leda: 'female', Orus: 'male', Puck: 'male', Zephyr: 'female',
};

const argv = yargs(hideBin(process.argv))
    .scriptName('read-to-me')
    .usage('$0 <url>', 'Convert a webpage to audio', (yargs) => {
        return yargs.positional('url', {
            describe: 'URL of the webpage to convert',
            type: 'string',
            demandOption: true,
        });
    })
    .option('voice', {
        alias: 'v',
        describe: 'Voice to use for TTS',
        choices: [...CHIRP3_VOICES, 'random', 'random-male', 'random-female'] as const,
        default: 'Zephyr' as const,
    })
    .option('dialect', {
        alias: 'd',
        describe: 'English dialect to use',
        choices: ENGLISH_DIALECTS,
        default: 'en-GB' as EnglishDialect,
    })
    .option('output', {
        alias: 'o',
        describe: 'Output directory path',
        type: 'string',
    })
    .option('skip-upload', {
        describe: 'Skip uploading to GCS bucket (for testing)',
        type: 'boolean',
        default: false,
    })
    .option('cache-images', {
        describe: 'Cache AI image parsing results (expires in 1 week)',
        type: 'boolean',
        default: true,
    })
    .option('enhance-speech', {
        describe: 'Enhance text for better TTS using AI (converts to SSML)',
        type: 'boolean',
        default: true,
    })
    .strict()
    .help()
    .parseSync();

// =============================================================================
// Types
// =============================================================================

interface Chapter {
    title: string;
    content: string;
    images: string[];
}

interface TableData {
    html: string;
    cells: string[];
}

interface ExtractedContent {
    title: string;
    byline: string | null;
    chapters: Chapter[];
    allImages: string[];
    allTables: TableData[];
}

interface ChapterAudio {
    title: string;
    audioBuffer: Buffer;
    durationMs: number;
}

interface ChapterMetadata {
    index: number;
    title: string;
    startMs: number;
    endMs: number;
    startFormatted: string;
}

interface EpisodeData {
    title: string;
    author: string;
    summary: string;
    sourceUrl: string;
    audioUrl: string;
    thumbnailUrl: string;
    audioSizeBytes: number;
    durationMs: number;
    pubDate: string;
    chapters: Array<{ title: string; startMs: number }>;
}

type ImageDescriptionResult =
    | { type: 'description'; text: string }
    | { type: 'skipped'; reason: 'stock_photo' | 'fetch_error' | 'no_api_key' | 'api_error' };

interface ImageDescriptionResultWithCache {
    result: ImageDescriptionResult;
    fromCache: boolean;
}

interface ImageCacheEntry {
    result: ImageDescriptionResult;
    expiresAt: number;
    promptHash: string;
}

// =============================================================================
// Utility Functions
// =============================================================================

function escapeXml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function unescapeXml(text: string): string {
    return text
        .replace(/&apos;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
}

function escapeMetadata(text: string): string {
    return text
        .replace(/\\/g, '\\\\')
        .replace(/=/g, '\\=')
        .replace(/;/g, '\\;')
        .replace(/#/g, '\\#')
        .replace(/\n/g, '\\\n');
}

function formatMs(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    return `${hours}:${String(minutes % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function parseTimeToMs(timeStr: string): number {
    const parts = timeStr.split(':').map(Number);
    if (parts.length !== 3) return 0;
    return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
}

async function fetchWithUA(url: string): Promise<Response> {
    return fetch(url, { headers: { 'User-Agent': USER_AGENT } });
}

function extractImagesFromMarkdown(content: string): string[] {
    const images: string[] = [];
    let match;
    const regex = new RegExp(MD_IMAGE_REGEX.source, 'g');
    while ((match = regex.exec(content)) !== null) {
        images.push(match[1]);
    }
    return images;
}

// =============================================================================
// Content Extraction
// =============================================================================

async function fetchWebpage(url: string): Promise<string> {
    console.log(chalk.blue('Fetching webpage...'));
    const response = await fetchWithUA(url);
    if (!response.ok) {
        throw new Error(`Failed to fetch: ${response.status} ${response.statusText}`);
    }
    return response.text();
}

function extractContent(html: string, url: string): ExtractedContent {
    console.log(chalk.blue('Extracting main content...'));

    const { document } = parseHTML(html);
    const reader = new Readability(document as any, { charThreshold: 100 });
    const article = reader.parse();

    if (!article) {
        throw new Error('Failed to extract article content');
    }

    const turndown = new TurndownService({
        headingStyle: 'atx',
        codeBlockStyle: 'fenced',
    });

    const markdown = turndown.turndown(article.content);

    // Extract images from the original content
    const imgRegex = /<img[^>]+src=["']([^"']+)["']/gi;
    const allImages: string[] = [];
    let match;
    while ((match = imgRegex.exec(article.content)) !== null) {
        const imgUrl = new URL(match[1], url).href;
        allImages.push(imgUrl);
    }

    // Extract tables from the original HTML content
    const tableRegex = /<table[\s\S]*?<\/table>/gi;
    const allTables: TableData[] = [];
    let tableMatch;
    while ((tableMatch = tableRegex.exec(article.content)) !== null) {
        const tableHtml = tableMatch[0];
        // Extract cell contents to use for matching in markdown
        const cellRegex = /<t[hd][^>]*>([^<]*)</gi;
        let cellMatch;
        const cells: string[] = [];
        while ((cellMatch = cellRegex.exec(tableHtml)) !== null) {
            const cellText = cellMatch[1].trim();
            if (cellText) cells.push(cellText);
        }
        if (cells.length > 0) {
            allTables.push({ html: tableHtml, cells });
        }
    }

    // Split content into chapters based on h1/h2 headers
    const lines = markdown.split('\n');
    const chapters: Chapter[] = [];
    let currentChapter: Chapter = { title: 'Introduction', content: '', images: [] };

    for (const line of lines) {
        const h1Match = line.match(/^# (.+)$/);
        const h2Match = line.match(/^## (.+)$/);

        if (h1Match || h2Match) {
            if (currentChapter.content.trim()) {
                chapters.push(currentChapter);
            }
            currentChapter = {
                title: (h1Match || h2Match)![1],
                content: '',
                images: [],
            };
        } else {
            currentChapter.content += line + '\n';
            currentChapter.images.push(...extractImagesFromMarkdown(line));
        }
    }

    if (currentChapter.content.trim()) {
        chapters.push(currentChapter);
    }

    // If no chapters found, create one from all content
    if (chapters.length === 0) {
        chapters.push({
            title: article.title || 'Content',
            content: markdown,
            images: allImages,
        });
    }

    console.log(chalk.green(`  Extracted ${chapters.length} chapter(s)`));
    console.log(chalk.green(`  Found ${allImages.length} image(s)`));
    console.log(chalk.green(`  Found ${allTables.length} table(s)`));

    return {
        title: article.title,
        byline: article.byline,
        chapters,
        allImages,
        allTables,
    };
}

// =============================================================================
// AI Processing (Images, Tables, Chapters)
// =============================================================================

const IMAGE_DESCRIPTION_PROMPT = `You are helping convert an article to audio format. Analyze this image and determine if it adds meaningful content to the article.

SKIP the image (respond with exactly "SKIP") if it is:
- A generic stock photo (business people shaking hands, smiling models, abstract tech imagery)
- A purely decorative/aesthetic image with no informational value
- A website logo, avatar, or UI element
- A social media icon or sharing button
- An advertisement or promotional banner

DESCRIBE the image (1-2 sentences) if it is:
- A chart, graph, or data visualization - focus on the key insight or trend it shows
- A diagram or illustration explaining a concept
- A photo that provides context or evidence for the article's topic
- An infographic with meaningful information
- A screenshot demonstrating something relevant

Your description should:
- Capture the meaning and significance, not just what's visually present
- Be concise and suitable for spoken audio
- Help the listener understand the gist without seeing the image

Respond with either "SKIP" or your description (no other text).`;

const IMAGE_PROMPT_HASH = crypto.createHash('sha256').update(IMAGE_DESCRIPTION_PROMPT).digest('hex').slice(0, 16);

function getImageCacheKey(imageUrl: string): string {
    const urlHash = crypto.createHash('sha256').update(imageUrl).digest('hex').slice(0, 32);
    return `${urlHash}_${IMAGE_PROMPT_HASH}`;
}

async function getImageFromCache(imageUrl: string): Promise<ImageDescriptionResult | null> {
    if (!argv['cache-images']) return null;

    const cacheKey = getImageCacheKey(imageUrl);
    const cachePath = path.join(IMAGE_CACHE_DIR, `${cacheKey}.json`);

    try {
        const file = Bun.file(cachePath);
        if (!await file.exists()) return null;

        const entry: ImageCacheEntry = await file.json();

        // Check if cache entry has expired
        if (Date.now() > entry.expiresAt) {
            return null;
        }

        // Verify prompt hash matches (in case prompt was updated)
        if (entry.promptHash !== IMAGE_PROMPT_HASH) {
            return null;
        }

        return entry.result;
    } catch {
        return null;
    }
}

async function saveImageToCache(imageUrl: string, result: ImageDescriptionResult): Promise<void> {
    if (!argv['cache-images']) return;

    const cacheKey = getImageCacheKey(imageUrl);
    const cachePath = path.join(IMAGE_CACHE_DIR, `${cacheKey}.json`);

    const entry: ImageCacheEntry = {
        result,
        expiresAt: Date.now() + IMAGE_CACHE_TTL_MS,
        promptHash: IMAGE_PROMPT_HASH,
    };

    try {
        // Ensure cache directory exists
        await Bun.write(path.join(IMAGE_CACHE_DIR, '.gitkeep'), '');
        await Bun.write(cachePath, JSON.stringify(entry, null, 2));
    } catch (err) {
        console.log(chalk.yellow(`  Warning: Failed to cache image result: ${(err as Error).message}`));
    }
}

async function fetchImageAsBase64(imageUrl: string): Promise<{ data: string; mimeType: string } | null> {
    try {
        const response = await fetchWithUA(imageUrl);
        if (!response.ok) return null;

        const contentType = response.headers.get('content-type') || 'image/jpeg';
        const arrayBuffer = await response.arrayBuffer();
        const base64 = Buffer.from(arrayBuffer).toString('base64');
        return { data: base64, mimeType: contentType };
    } catch {
        return null;
    }
}

async function describeImage(imageUrl: string): Promise<ImageDescriptionResultWithCache> {
    if (!geminiClient) {
        return { result: { type: 'skipped', reason: 'no_api_key' }, fromCache: false };
    }

    // Check cache first
    const cachedResult = await getImageFromCache(imageUrl);
    if (cachedResult) {
        return { result: cachedResult, fromCache: true };
    }

    const imageData = await fetchImageAsBase64(imageUrl);
    if (!imageData) {
        return { result: { type: 'skipped', reason: 'fetch_error' }, fromCache: false };
    }

    try {
        const model = geminiClient.getGenerativeModel({ model: 'gemini-2.0-flash' });
        const result = await model.generateContent([
            {
                inlineData: {
                    mimeType: imageData.mimeType,
                    data: imageData.data,
                },
            },
            IMAGE_DESCRIPTION_PROMPT,
        ]);
        const response = result.response.text().trim();

        // If AI determined this is a stock/decorative image, skip it
        let descriptionResult: ImageDescriptionResult;
        if (response.toUpperCase() === 'SKIP') {
            descriptionResult = { type: 'skipped', reason: 'stock_photo' };
        } else {
            descriptionResult = { type: 'description', text: response };
        }

        // Save to cache
        await saveImageToCache(imageUrl, descriptionResult);

        return { result: descriptionResult, fromCache: false };
    } catch (err) {
        console.log(chalk.yellow(`  Error describing image: ${(err as Error).message}`));
        return { result: { type: 'skipped', reason: 'api_error' }, fromCache: false };
    }
}

async function describeTable(tableHtml: string): Promise<string | null> {
    if (!geminiClient) {
        console.log(chalk.yellow('  Skipping table (no GEMINI_API_KEY)'));
        return null;
    }

    try {
        const model = geminiClient.getGenerativeModel({ model: 'gemini-2.0-flash' });
        const result = await model.generateContent([
            `You are helping convert an article to audio format. Analyze this HTML table and provide a concise narrative explanation that captures the key insights and conclusions the table conveys.

Your explanation should:
- Be 2-4 sentences long
- Highlight the most important data points or patterns
- Help someone listening to audio understand the gist without seeing the table
- Use natural language suitable for spoken content

Do NOT:
- List every row/cell value
- Use phrases like "This table shows..." - just provide the insight directly
- Include any markdown or formatting

HTML TABLE:
${tableHtml}`,
        ]);
        return result.response.text().trim();
    } catch (err) {
        console.log(chalk.yellow(`  Error describing table: ${(err as Error).message}`));
        return null;
    }
}

async function processTablesInContent(content: ExtractedContent): Promise<ExtractedContent> {
    if (!geminiClient) {
        console.log(chalk.yellow('Skipping table processing (no GEMINI_API_KEY)'));
        return content;
    }

    if (content.allTables.length === 0) {
        return content;
    }

    console.log(chalk.blue(`Processing ${content.allTables.length} table(s) with Gemini (concurrency: ${GEMINI_CONCURRENCY})...`));

    const tableResults: Array<{ cells: string[]; description: string }> = [];
    let completed = 0;
    const total = content.allTables.length;

    // Process tables in parallel with concurrency limit
    const descriptionPromises = content.allTables.map((table) =>
        geminiLimit(async () => {
            const description = await describeTable(table.html);
            completed++;
            if (description) {
                tableResults.push({ cells: table.cells, description });
                console.log(chalk.green(`  [${completed}/${total}] Table → ${description.slice(0, 60)}...`));
            } else {
                console.log(chalk.yellow(`  [${completed}/${total}] Table → (skipped)`));
            }
            return { table, description };
        })
    );

    await Promise.all(descriptionPromises);

    // Replace table content in chapters using cell-based matching
    const updatedChapters = content.chapters.map(chapter => {
        let updatedContent = chapter.content;
        for (const { cells, description } of tableResults) {
            // Create a regex pattern from cell contents that matches them in sequence with whitespace between
            const pattern = cells.map(c => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
            const tableRegex = new RegExp(pattern, 's');
            updatedContent = updatedContent.replace(tableRegex, `[Table: ${description}]`);
        }
        return { ...chapter, content: updatedContent };
    });

    return { ...content, chapters: updatedChapters };
}

async function processImagesInContent(content: ExtractedContent): Promise<ExtractedContent> {
    if (!geminiClient) {
        console.log(chalk.yellow('Skipping image processing (no GEMINI_API_KEY)'));
        return content;
    }

    const cacheInfo = argv['cache-images'] ? ' (cache enabled)' : '';
    console.log(chalk.blue(`Processing ${content.allImages.length} images with Gemini (concurrency: ${GEMINI_CONCURRENCY})${cacheInfo}...`));

    const imageDescriptions = new Map<string, string>();
    let completed = 0;
    let cacheHits = 0;
    const total = content.allImages.length;
    const skippedImages = new Set<string>(); // Track images to remove from content

    // Process images in parallel with concurrency limit
    const descriptionPromises = content.allImages.map((imgUrl, i) =>
        geminiLimit(async () => {
            const { result, fromCache } = await describeImage(imgUrl);
            completed++;
            if (fromCache) cacheHits++;
            const cacheTag = fromCache ? chalk.cyan('[cached] ') : '';
            if (result.type === 'description') {
                imageDescriptions.set(imgUrl, result.text);
                console.log(chalk.green(`  [${completed}/${total}] ${cacheTag}${imgUrl.slice(0, 40)}... → ${result.text.slice(0, 60)}...`));
            } else {
                skippedImages.add(imgUrl);
                const reasonText = {
                    'stock_photo': 'stock/decorative photo',
                    'fetch_error': 'fetch failed',
                    'no_api_key': 'no API key',
                    'api_error': 'API error',
                }[result.reason];
                console.log(chalk.yellow(`  [${completed}/${total}] ${cacheTag}${imgUrl.slice(0, 40)}... → (skipped: ${reasonText})`));
            }
            return { imgUrl, result };
        })
    );

    await Promise.all(descriptionPromises);

    if (argv['cache-images'] && cacheHits > 0) {
        console.log(chalk.cyan(`  Cache hits: ${cacheHits}/${total} images`));
    }

    // Replace image references in chapter content with descriptions or remove skipped images
    const updatedChapters = content.chapters.map(chapter => {
        let updatedContent = chapter.content;

        // Replace described images with their descriptions
        for (const [imgUrl, description] of imageDescriptions) {
            const mdImgRegex = new RegExp(`!\\[.*?\\]\\(${imgUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`, 'g');
            updatedContent = updatedContent.replace(mdImgRegex, `[Image: ${description}]`);
        }

        // Remove skipped images (stock photos, failed fetches, etc.) from content
        for (const imgUrl of skippedImages) {
            const mdImgRegex = new RegExp(`!\\[.*?\\]\\(${imgUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)\\s*`, 'g');
            updatedContent = updatedContent.replace(mdImgRegex, '');
        }

        return { ...chapter, content: updatedContent };
    });

    return { ...content, chapters: updatedChapters };
}

async function filterChapterContent(chapter: Chapter, chapterIndex: number, totalChapters: number): Promise<Chapter> {
    if (!geminiClient) {
        return chapter;
    }

    // Skip filtering for very short content (likely already clean)
    if (chapter.content.length < 200) {
        return chapter;
    }

    try {
        const model = geminiClient.getGenerativeModel({ model: 'gemini-2.0-flash' });
        const result = await model.generateContent([
            `You are a content filter for an article-to-audio converter. Your task is to clean up the following article section by removing content that is NOT part of the main article.

REMOVE these types of content:
- Advertisements and promotional content
- User comments and comment sections
- "Related articles" or "You might also like" sections
- Social media sharing buttons/text (e.g., "Share on Twitter", "Follow us")
- Newsletter signup prompts
- Cookie consent notices
- Navigation elements (e.g., "Back to top", "Next article")
- Author bios that are generic (keep if relevant to the article)
- Subscription/paywall prompts
- Footer content (copyright notices, site links)
- Metadata that doesn't add value (e.g., "Posted 3 hours ago", "5 min read")

KEEP these types of content:
- The main article text
- Relevant quotes and citations
- Image descriptions (text in [Image: ...] format)
- Relevant data, statistics, and examples
- Author information if it provides context
- Any content that contributes to understanding the topic

IMPORTANT: Preserve the original text exactly as written. Do not rephrase, summarize, or modify sentences. Only remove non-article content. Keep all punctuation and paragraph breaks intact.

Return ONLY the cleaned content. Do not add any explanations or commentary. If the entire content should be removed, return "EMPTY_CHAPTER".

CONTENT TO FILTER:
---
${chapter.content}
---`,
        ]);

        let filteredContent = result.response.text().trim();

        // Remove any markdown code block wrapping if Gemini added it
        filteredContent = filteredContent.replace(/^```(?:markdown)?\n?/, '').replace(/\n?```$/, '');

        // If AI determined the chapter is all non-article content
        if (filteredContent === 'EMPTY_CHAPTER' || filteredContent.length < 10) {
            console.log(chalk.yellow(`    → Chapter filtered out (non-article content)`));
            return { ...chapter, content: '' };
        }

        // Calculate reduction percentage
        const reduction = ((chapter.content.length - filteredContent.length) / chapter.content.length * 100).toFixed(1);
        if (parseFloat(reduction) > 5) {
            console.log(chalk.green(`    → Filtered ${reduction}% non-article content`));
        }

        return { ...chapter, content: filteredContent };
    } catch (err) {
        console.log(chalk.yellow(`    → Filter error, keeping original: ${(err as Error).message}`));
        return chapter;
    }
}

async function suggestChapters(content: ExtractedContent): Promise<ExtractedContent> {
    if (!geminiClient) {
        console.log(chalk.yellow('Skipping AI chapter suggestion (no GEMINI_API_KEY)'));
        return content;
    }

    // Combine all content to analyze as a whole
    const fullContent = content.chapters.map(c => c.content).join('\n\n');

    // Skip for very short content
    if (fullContent.length < 1000) {
        console.log(chalk.gray('  Content too short for chapter analysis'));
        return content;
    }

    console.log(chalk.blue('Analyzing content for chapter suggestions...'));

    try {
        const model = geminiClient.getGenerativeModel({ model: 'gemini-2.0-flash' });
        const result = await model.generateContent([
            `You are analyzing an article to suggest logical chapter divisions for an audio version.

Your task is to identify natural topic breaks where chapters should begin. A good chapter break occurs when:
- The topic shifts significantly
- A new section or concept is introduced
- There's a natural pause point for listeners
- The narrative moves to a new phase

Aim for chapters that are:
- Between 500-2000 characters each (roughly 1-4 minutes of audio)
- Self-contained enough to be meaningful
- Not too granular (avoid splitting every paragraph)

Respond with a JSON array of chapter suggestions. Each suggestion should have:
- "title": A short descriptive title (2-5 words) for the chapter
- "startPhrase": The exact first 50-100 characters where this chapter should start (must match text exactly)

The first chapter should start at the beginning of the content.

Example response format:
[
  {"title": "Introduction", "startPhrase": "The history of artificial intelligence"},
  {"title": "Early Research", "startPhrase": "In the 1950s, researchers at Dartmouth"},
  {"title": "Modern Advances", "startPhrase": "The breakthrough came in 2012 when"}
]

IMPORTANT:
- Return ONLY valid JSON, no other text
- The startPhrase MUST be copied exactly from the content (including punctuation)
- Suggest 3-10 chapters depending on content length

CONTENT TO ANALYZE:
---
${fullContent}
---`,
        ]);

        let responseText = result.response.text().trim();
        // Remove markdown code block wrapping if present
        responseText = responseText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');

        const suggestions = JSON.parse(responseText) as Array<{ title: string; startPhrase: string }>;

        if (!Array.isArray(suggestions) || suggestions.length === 0) {
            console.log(chalk.yellow('  No chapter suggestions returned'));
            return content;
        }

        console.log(chalk.green(`  AI suggested ${suggestions.length} chapters`));

        // Build new chapters based on suggestions
        const newChapters: Chapter[] = [];

        for (let i = 0; i < suggestions.length; i++) {
            const suggestion = suggestions[i];
            const nextSuggestion = suggestions[i + 1];

            // Find start position
            const startIndex = fullContent.indexOf(suggestion.startPhrase);
            if (startIndex === -1) {
                console.log(chalk.yellow(`  Could not find start phrase for "${suggestion.title}", skipping`));
                continue;
            }

            // Find end position (start of next chapter or end of content)
            let endIndex = fullContent.length;
            if (nextSuggestion) {
                const nextStart = fullContent.indexOf(nextSuggestion.startPhrase);
                if (nextStart !== -1) {
                    endIndex = nextStart;
                }
            }

            const chapterContent = fullContent.slice(startIndex, endIndex).trim();

            newChapters.push({
                title: suggestion.title,
                content: chapterContent,
                images: extractImagesFromMarkdown(chapterContent),
            });

            console.log(chalk.gray(`    - ${suggestion.title} (${chapterContent.length} chars)`));
        }

        // If we couldn't build any chapters from suggestions, keep original
        if (newChapters.length === 0) {
            console.log(chalk.yellow('  Could not create chapters from suggestions, keeping original'));
            return content;
        }

        return { ...content, chapters: newChapters };
    } catch (err) {
        console.log(chalk.yellow(`  Chapter suggestion failed: ${(err as Error).message}`));
        console.log(chalk.gray('  Keeping original chapter structure'));
        return content;
    }
}

async function generateSummary(content: ExtractedContent): Promise<string> {
    if (!geminiClient) {
        return `Audio version of "${content.title}"`;
    }

    console.log(chalk.blue('Generating article summary...'));

    try {
        const model = geminiClient.getGenerativeModel({ model: 'gemini-2.0-flash' });
        const fullContent = content.chapters.map(c => c.content).join('\n\n').slice(0, 4000);

        const result = await model.generateContent([
            `Generate a brief summary (2-3 sentences, max 200 characters) for a podcast episode based on this article.
The summary should capture the main topic and key insights, suitable for an RSS feed description.
Write in third person and avoid phrases like "This article" or "The author".

Article title: ${content.title}
${content.byline ? `Author: ${content.byline}` : ''}

Content:
${fullContent}

Respond with ONLY the summary text, no quotes or other formatting.`,
        ]);

        const summary = result.response.text().trim();
        console.log(chalk.green(`  Summary: ${summary.slice(0, 80)}...`));
        return summary;
    } catch (err) {
        console.log(chalk.yellow(`  Summary generation failed: ${(err as Error).message}`));
        return `Audio version of "${content.title}"`;
    }
}

async function loadTtsOptimizerPrompt(): Promise<string> {
    const file = Bun.file(TTS_OPTIMIZER_PROMPT_PATH);
    if (!await file.exists()) {
        throw new Error(`TTS optimizer prompt not found at: ${TTS_OPTIMIZER_PROMPT_PATH}`);
    }
    return file.text();
}

async function enhanceChapterForTTS(
    chapterContent: string,
    ttsPrompt: string,
    chapterIndex: number,
    totalChapters: number,
): Promise<string> {
    if (!geminiClient) {
        return chapterContent;
    }

    try {
        const model = geminiClient.getGenerativeModel({ model: 'gemini-2.0-flash' });
        const result = await model.generateContent([
            ttsPrompt,
            `\n\n**Text to optimize:**\n\n${chapterContent}`,
        ]);

        let ssmlOutput = result.response.text().trim();

        // Remove markdown code block wrapping if Gemini added it
        ssmlOutput = ssmlOutput.replace(/^```(?:xml|ssml)?\n?/, '').replace(/\n?```$/, '');

        // Validate that we got SSML back
        if (!ssmlOutput.includes('<speak>')) {
            console.log(chalk.yellow(`    → Chapter ${chapterIndex + 1}: AI didn't return SSML, using original`));
            return chapterContent;
        }

        return ssmlOutput;
    } catch (err) {
        console.log(chalk.yellow(`    → Chapter ${chapterIndex + 1}: Enhancement failed: ${(err as Error).message}`));
        return chapterContent;
    }
}

async function enhanceContentForTTS(content: ExtractedContent): Promise<ExtractedContent> {
    if (!geminiClient) {
        console.log(chalk.yellow('Skipping speech enhancement (no GEMINI_API_KEY)'));
        return content;
    }

    if (!argv['enhance-speech']) {
        console.log(chalk.gray('Speech enhancement disabled'));
        return content;
    }

    console.log(chalk.blue(`Enhancing ${content.chapters.length} chapters for TTS (concurrency: ${GEMINI_CONCURRENCY})...`));

    // Load the TTS optimizer prompt
    let ttsPrompt: string;
    try {
        ttsPrompt = await loadTtsOptimizerPrompt();
    } catch (err) {
        console.log(chalk.yellow(`  Failed to load TTS prompt: ${(err as Error).message}`));
        return content;
    }

    let completed = 0;
    const total = content.chapters.length;

    // Process chapters in parallel with concurrency limit
    const enhancePromises = content.chapters.map((chapter, i) =>
        geminiLimit(async () => {
            const enhancedContent = await enhanceChapterForTTS(chapter.content, ttsPrompt, i, total);
            completed++;

            const isEnhanced = enhancedContent.includes('<speak>');
            if (isEnhanced) {
                console.log(chalk.green(`  [${completed}/${total}] Enhanced: ${chapter.title}`));
            } else {
                console.log(chalk.yellow(`  [${completed}/${total}] Kept original: ${chapter.title}`));
            }

            return { ...chapter, content: enhancedContent, originalIndex: i };
        })
    );

    const results = await Promise.all(enhancePromises);

    // Sort by original index to maintain order
    const enhancedChapters = results
        .sort((a, b) => a.originalIndex - b.originalIndex)
        .map(({ originalIndex, ...chapter }) => chapter);

    const enhancedCount = enhancedChapters.filter(c => c.content.includes('<speak>')).length;
    console.log(chalk.green(`  Enhanced ${enhancedCount}/${total} chapters with SSML`));

    return { ...content, chapters: enhancedChapters };
}

async function filterContentWithAI(content: ExtractedContent): Promise<ExtractedContent> {
    if (!geminiClient) {
        console.log(chalk.yellow('Skipping content filtering (no GEMINI_API_KEY)'));
        return content;
    }

    console.log(chalk.blue(`Filtering ${content.chapters.length} chapters to remove ads/comments (concurrency: ${GEMINI_CONCURRENCY})...`));

    let completed = 0;
    const total = content.chapters.length;

    // Process chapters in parallel with concurrency limit
    const filterPromises = content.chapters.map((chapter, i) =>
        geminiLimit(async () => {
            const filteredChapter = await filterChapterContent(chapter, i, total);
            completed++;

            const hasContent = filteredChapter.content.trim().length > 0;
            if (hasContent) {
                console.log(chalk.green(`  [${completed}/${total}] Filtered: ${chapter.title}`));
            } else {
                console.log(chalk.yellow(`  [${completed}/${total}] Removed empty chapter: ${chapter.title}`));
            }

            return { filteredChapter, hasContent, originalIndex: i };
        })
    );

    const results = await Promise.all(filterPromises);

    // Sort by original index to maintain order, then filter out empty chapters
    const filteredChapters = results
        .sort((a, b) => a.originalIndex - b.originalIndex)
        .filter(r => r.hasContent)
        .map(r => r.filteredChapter);

    // If all chapters were filtered out, keep at least the first original chapter
    if (filteredChapters.length === 0 && content.chapters.length > 0) {
        console.log(chalk.yellow('  Warning: All chapters filtered, keeping first chapter'));
        filteredChapters.push(content.chapters[0]);
    }

    console.log(chalk.green(`  Kept ${filteredChapters.length}/${content.chapters.length} chapters after filtering`));

    return { ...content, chapters: filteredChapters };
}

// =============================================================================
// Audio Synthesis
// =============================================================================

function cleanTextForTTS(content: string): string {
    // Clean up markdown for TTS (remove links, code blocks, etc.)
    return content
        .replace(/```[\s\S]*?```/g, '') // Remove code blocks
        .replace(/`[^`]+`/g, '') // Remove inline code
        // Replace markdown links with link text (handles nested parens in URLs)
        .replace(/\[([^\]]*)\]\((?:[^()]*|\([^()]*\))*\)/g, '$1')
        .replace(/\[\]\s*/g, '') // Remove any remaining empty brackets
        .replace(/<https?:\/\/[^>]+>/g, '') // Remove autolinks <url>
        .replace(/https?:\/\/[^\s<>\[\]"']+/g, '') // Remove bare URLs
        .replace(/\s+([.,!?;:])/g, '$1') // Clean up spaces before punctuation
        .replace(/[#*_~]/g, '') // Remove markdown formatting
        .replace(/\n{3,}/g, '\n\n') // Normalize multiple newlines
        .replace(/  +/g, ' ') // Normalize multiple spaces
        .trim();
}

function splitTextIntoChunks(text: string): string[] {
    const MAX_BYTES = 4500;
    const MAX_SENTENCE_LENGTH = 300;
    const chunks: string[] = [];
    let currentChunk = '';

    // Function to split long text at natural break points
    function splitLongText(text: string, maxLen: number): string[] {
        const result: string[] = [];
        const parts = text.split(/(?<=[,;:\)\]])\s+/);

        for (const part of parts) {
            if (part.length <= maxLen) {
                result.push(part);
            } else {
                const words = part.split(/\s+/);
                let current = '';
                for (const word of words) {
                    if ((current + ' ' + word).length <= maxLen) {
                        current = current ? current + ' ' + word : word;
                    } else {
                        if (current) result.push(current + '.');
                        current = word;
                    }
                }
                if (current) result.push(current);
            }
        }
        return result;
    }

    const sentences = text.split(/(?<=[.!?])\s+/);
    const processedSentences: string[] = [];

    for (const sentence of sentences) {
        if (sentence.length <= MAX_SENTENCE_LENGTH) {
            processedSentences.push(sentence);
        } else {
            processedSentences.push(...splitLongText(sentence, MAX_SENTENCE_LENGTH));
        }
    }

    for (const sentence of processedSentences) {
        if (Buffer.byteLength(currentChunk + sentence, 'utf-8') > MAX_BYTES) {
            if (currentChunk) chunks.push(currentChunk.trim());
            currentChunk = sentence;
        } else {
            currentChunk += ' ' + sentence;
        }
    }
    if (currentChunk.trim()) chunks.push(currentChunk.trim());

    return chunks;
}

function splitSsmlIntoChunks(ssml: string): string[] {
    // For SSML, we need to split at <p> or <s> boundaries, or at sentence boundaries within the content
    // Google TTS has a 5000 byte limit per request
    const MAX_BYTES = 4500;
    const chunks: string[] = [];

    // Extract content between <speak> tags
    const speakMatch = ssml.match(/<speak>([\s\S]*)<\/speak>/);
    if (!speakMatch) {
        // If no speak tags, treat as plain text
        return splitTextIntoChunks(ssml);
    }

    const innerContent = speakMatch[1];

    // Try to split at paragraph boundaries first
    const paragraphs = innerContent.split(/<\/p>\s*/);

    let currentChunk = '';
    for (const para of paragraphs) {
        const paraWithClose = para.includes('<p>') ? para + '</p>' : para;
        const wrappedPara = `<speak>${paraWithClose}</speak>`;

        if (Buffer.byteLength(wrappedPara, 'utf-8') > MAX_BYTES) {
            // Paragraph too large, split at sentence boundaries
            const sentences = para.split(/<\/s>\s*/);
            for (const sent of sentences) {
                const sentWithClose = sent.includes('<s>') ? sent + '</s>' : sent;
                const wrappedSent = `<speak>${sentWithClose}</speak>`;

                if (Buffer.byteLength(wrappedSent, 'utf-8') > MAX_BYTES) {
                    // Even a single sentence is too large, fall back to text chunking
                    // Strip SSML tags and chunk as plain text
                    const plainText = sent.replace(/<[^>]+>/g, '').trim();
                    const textChunks = splitTextIntoChunks(plainText);
                    for (const textChunk of textChunks) {
                        if (currentChunk) {
                            chunks.push(`<speak>${currentChunk}</speak>`);
                            currentChunk = '';
                        }
                        chunks.push(textChunk); // Plain text chunk (no SSML wrapper)
                    }
                } else if (Buffer.byteLength(`<speak>${currentChunk}${sentWithClose}</speak>`, 'utf-8') > MAX_BYTES) {
                    if (currentChunk) chunks.push(`<speak>${currentChunk}</speak>`);
                    currentChunk = sentWithClose;
                } else {
                    currentChunk += sentWithClose;
                }
            }
        } else if (Buffer.byteLength(`<speak>${currentChunk}${paraWithClose}</speak>`, 'utf-8') > MAX_BYTES) {
            if (currentChunk) chunks.push(`<speak>${currentChunk}</speak>`);
            currentChunk = paraWithClose;
        } else {
            currentChunk += paraWithClose;
        }
    }

    if (currentChunk.trim()) {
        chunks.push(`<speak>${currentChunk}</speak>`);
    }

    // If we couldn't split it, just return the original
    if (chunks.length === 0) {
        chunks.push(ssml);
    }

    return chunks;
}

async function synthesizeChapter(
    chapter: Chapter,
    voice: Voice,
    dialect: EnglishDialect,
    chapterIndex: number,
    totalChapters: number,
): Promise<ChapterAudio> {
    console.log(chalk.gray(`  [${chapterIndex + 1}/${totalChapters}] Synthesizing: ${chapter.title}`));

    // Check if content is SSML (contains <speak> tags)
    const isSSML = chapter.content.includes('<speak>');

    let chunks: string[];
    if (isSSML) {
        chunks = splitSsmlIntoChunks(chapter.content);
    } else {
        // Note: Chapter titles are NOT spoken - they are metadata only (embedded in M4A file)
        const text = cleanTextForTTS(chapter.content);
        chunks = splitTextIntoChunks(text);
    }

    // Process TTS chunks in parallel with concurrency limit
    const audioPromises = chunks.map((chunk, chunkIndex) =>
        ttsLimit(async () => {
            // Determine if this chunk is SSML or plain text
            const chunkIsSSML = chunk.startsWith('<speak>');

            const [response] = await ttsClient.synthesizeSpeech({
                input: chunkIsSSML ? { ssml: chunk } : { text: chunk },
                voice: {
                    languageCode: dialect,
                    name: `${dialect}-Chirp3-HD-${voice}`,
                },
                audioConfig: {
                    audioEncoding: 'MP3',
                    speakingRate: 1.0,
                },
            });

            return {
                index: chunkIndex,
                buffer: response.audioContent ? Buffer.from(response.audioContent as Uint8Array) : null,
            };
        })
    );

    const results = await Promise.all(audioPromises);

    // Sort by index and extract buffers to maintain order
    const audioBuffers = results
        .sort((a, b) => a.index - b.index)
        .filter(r => r.buffer !== null)
        .map(r => r.buffer as Buffer);

    // Concatenate all audio buffers
    const audioBuffer = Buffer.concat(audioBuffers);

    // Estimate duration (rough: MP3 at 24kbps is ~3KB per second)
    const durationMs = Math.round((audioBuffer.length / 3000) * 1000);

    const ssmlTag = isSSML ? chalk.cyan(' [SSML]') : '';
    console.log(chalk.green(`    → ${(audioBuffer.length / 1024).toFixed(1)} KB, ~${(durationMs / 1000).toFixed(1)}s${ssmlTag}`));

    return {
        title: chapter.title,
        audioBuffer,
        durationMs,
    };
}

async function synthesizeContent(
    content: ExtractedContent,
    voice: Voice,
    dialect: EnglishDialect,
): Promise<ChapterAudio[]> {
    console.log(chalk.blue(`Synthesizing ${content.chapters.length} chapters with ${voice} voice (concurrency: ${TTS_CONCURRENCY})...`));

    // Process chapters sequentially to avoid deadlock with ttsLimit
    // (synthesizeChapter internally uses ttsLimit for TTS chunks, so we can't wrap chapters in ttsLimit too)
    const results: Array<{ index: number; audio: ChapterAudio }> = [];
    for (let i = 0; i < content.chapters.length; i++) {
        const chapter = content.chapters[i];
        const audio = await synthesizeChapter(
            chapter,
            voice,
            dialect,
            i,
            content.chapters.length,
        );
        results.push({ index: i, audio });
    }

    // Results are already in order since we processed sequentially
    return results.map(r => r.audio);
}

function resolveVoice(voice: typeof argv.voice): Voice {
    if (voice === 'random') {
        return CHIRP3_VOICES[Math.floor(Math.random() * CHIRP3_VOICES.length)];
    }
    if (voice === 'random-male') {
        const maleVoices = CHIRP3_VOICES.filter(v => VOICE_GENDERS[v] === 'male');
        return maleVoices[Math.floor(Math.random() * maleVoices.length)];
    }
    if (voice === 'random-female') {
        const femaleVoices = CHIRP3_VOICES.filter(v => VOICE_GENDERS[v] === 'female');
        return femaleVoices[Math.floor(Math.random() * femaleVoices.length)];
    }
    return voice;
}

createScript(async () => {
    const url = argv.url;
    const voice = resolveVoice(argv.voice);
    const dialect = argv.dialect;
    const output = argv.output;
    const noUpload = argv['skip-upload'];

    const enhanceSpeech = argv['enhance-speech'];

    console.log(style.header('Read To Me'));
    console.log('Configuration:');
    console.log(`  URL: ${url}`);
    console.log(`  Voice: ${dialect}-Chirp3-HD-${voice} (${VOICE_GENDERS[voice]})`);
    console.log(`  Dialect: ${dialect}`);
    console.log(`  Output: ${output || '(auto)'}`);
    console.log(`  Upload: ${noUpload ? 'disabled' : 'enabled'}`);
    console.log(`  Speech enhancement: ${enhanceSpeech ? 'enabled' : 'disabled'}`);
    console.log();

    // Step 1: Extract content from webpage
    const html = await fetchWebpage(url);
    let content = extractContent(html, url);

    console.log();
    console.log(style.header('Content Summary'));
    console.log(`  Title: ${content.title}`);
    if (content.byline) console.log(`  Author: ${content.byline}`);
    console.log(`  Chapters: ${content.chapters.length}`);
    for (const chapter of content.chapters) {
        console.log(`    - ${chapter.title} (${chapter.content.length} chars, ${chapter.images.length} images)`);
    }

    // Step 2: Filter content to remove ads, comments, and non-article content
    console.log();
    content = await filterContentWithAI(content);

    // Step 3: Use AI to suggest better chapter divisions
    console.log();
    content = await suggestChapters(content);

    // Step 3.5: Generate a summary for RSS feed and metadata
    console.log();
    const summary = await generateSummary(content);

    // Update summary after processing
    console.log();
    console.log(style.header('Final Chapter Structure'));
    console.log(`  Chapters: ${content.chapters.length}`);
    for (const chapter of content.chapters) {
        console.log(`    - ${chapter.title} (${chapter.content.length} chars)`);
    }

    // Step 4: Process images with Gemini
    if (content.allImages.length > 0) {
        console.log();
        content = await processImagesInContent(content);
    }

    // Step 5: Process tables with Gemini
    if (content.allTables.length > 0) {
        console.log();
        content = await processTablesInContent(content);
    }

    // Step 5.5: Enhance content for TTS (convert to SSML)
    console.log();
    content = await enhanceContentForTTS(content);

    // Step 6: Synthesize audio with Google Chirp 3
    console.log();
    const chapterAudios = await synthesizeContent(content, voice, dialect);

    // Step 7: Save individual chapter files and generate output
    const titleSlug = content.title.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
    const outputDir = output
        ? path.resolve(output)
        : path.join(process.cwd(), 'output', titleSlug);
    // Use the folder name for the final audio file
    const outputBase = path.basename(outputDir);
    await Bun.write(path.join(outputDir, '.gitkeep'), ''); // Ensure dir exists

    console.log();
    console.log(style.header('Saving Audio Files'));
    console.log(`  Output directory: ${outputDir}`);

    // Save individual chapter MP3s
    const chapterFiles: string[] = [];
    for (let i = 0; i < chapterAudios.length; i++) {
        const audio = chapterAudios[i];
        const filename = `${String(i + 1).padStart(2, '0')}-${audio.title.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase()}.mp3`;
        const filepath = path.join(outputDir, filename);
        await Bun.write(filepath, audio.audioBuffer);
        chapterFiles.push(filepath);
        console.log(chalk.green(`  ✓ ${filename}`));
    }

    // Create combined audio file with embedded chapter metadata (M4A format)
    const combinedBuffer = Buffer.concat(chapterAudios.map(a => a.audioBuffer));
    const tempMp3Path = path.join(outputDir, `${outputBase}.temp.mp3`);
    await Bun.write(tempMp3Path, combinedBuffer);

    // Calculate chapter timestamps
    let currentTime = 0;
    const chapters = chapterAudios.map((audio, i) => {
        const chapter = {
            index: i + 1,
            title: audio.title,
            startMs: currentTime,
            endMs: currentTime + audio.durationMs,
            startFormatted: formatMs(currentTime),
        };
        currentTime += audio.durationMs;
        return chapter;
    });

    // Generate ffmetadata file for chapters
    const ffmetadataContent = generateFfmetadata(content, chapters, currentTime, summary);
    const ffmetadataPath = path.join(outputDir, 'ffmetadata.txt');
    await Bun.write(ffmetadataPath, ffmetadataContent);

    // Convert to M4A with embedded chapters using ffmpeg
    const combinedPath = path.join(outputDir, `${outputBase}.m4a`);
    console.log(chalk.gray('  Converting to M4A with embedded chapters...'));

    // Use -map_chapters 1 to properly map chapter metadata from the ffmetadata file
    // Use -movflags +faststart for better streaming compatibility
    // Note: The order of flags matters - -map 0 ensures we take audio from first input,
    // -map_chapters 1 takes chapters from second input (ffmetadata file)
    const ffmpegResult = await Bun.$`ffmpeg -y -i ${tempMp3Path} -f ffmetadata -i ${ffmetadataPath} -map 0:a -map_chapters 1 -map_metadata 1 -c:a aac -b:a 192k -movflags +faststart ${combinedPath}`.quiet();
    if (ffmpegResult.exitCode !== 0) {
        console.log(chalk.yellow('  ⚠ ffmpeg conversion failed, keeping MP3 format'));
        const mp3Path = path.join(outputDir, `${outputBase}.mp3`);
        await Bun.$`mv ${tempMp3Path} ${mp3Path}`;
    } else {
        // Clean up temp files
        await Bun.$`trash ${tempMp3Path}`;
        await Bun.$`trash ${ffmetadataPath}`;
        console.log(chalk.green.bold(`  ✓ ${outputBase}.m4a (combined with chapters)`));
    }

    // Generate chapter metadata JSON file
    const metadataPath = path.join(outputDir, 'chapters.json');
    await Bun.write(metadataPath, JSON.stringify({
        title: content.title,
        author: content.byline,
        summary,
        voice,
        dialect,
        sourceUrl: url,
        totalDurationMs: currentTime,
        totalDurationFormatted: formatMs(currentTime),
        chapters: chapters.map(c => ({
            index: c.index,
            title: c.title,
            startMs: c.startMs,
            startFormatted: c.startFormatted,
        })),
    }, null, 2));
    console.log(chalk.green(`  ✓ chapters.json`));

    // Save markdown content
    const markdownContent = generateMarkdown(content, url);
    const markdownPath = path.join(outputDir, 'article.md');
    await Bun.write(markdownPath, markdownContent);
    console.log(chalk.green(`  ✓ article.md`));

    // Save all images from the article (in parallel)
    if (content.allImages.length > 0) {
        console.log(chalk.gray(`  Saving ${content.allImages.length} images (concurrency: ${FETCH_CONCURRENCY})...`));
        const imagesDir = path.join(outputDir, 'images');
        await Bun.write(path.join(imagesDir, '.gitkeep'), ''); // Ensure dir exists

        const imageDownloadPromises = content.allImages.map((imgUrl, i) =>
            fetchLimit(async () => {
                try {
                    const response = await fetchWithUA(imgUrl);
                    if (!response.ok) return { success: false, error: 'Response not ok' };

                    const contentType = response.headers.get('content-type') || 'image/jpeg';
                    const ext = contentType.includes('png') ? 'png'
                        : contentType.includes('gif') ? 'gif'
                        : contentType.includes('webp') ? 'webp'
                        : contentType.includes('svg') ? 'svg'
                        : 'jpg';
                    const filename = `${String(i + 1).padStart(2, '0')}-image.${ext}`;
                    const imagePath = path.join(imagesDir, filename);
                    const arrayBuffer = await response.arrayBuffer();
                    await Bun.write(imagePath, Buffer.from(arrayBuffer));
                    console.log(chalk.green(`  ✓ images/${filename}`));
                    return { success: true, filename };
                } catch {
                    console.log(chalk.yellow(`  ⚠ Could not save image: ${imgUrl.slice(0, 50)}...`));
                    return { success: false, error: 'Fetch failed' };
                }
            })
        );

        await Promise.all(imageDownloadPromises);
    }

    // Step 8: Generate thumbnail
    console.log();
    console.log(style.header('Generating Thumbnail'));
    const thumbnailPath = path.join(outputDir, 'thumbnail.png');
    await generateThumbnail(content, thumbnailPath);
    console.log(chalk.green(`  ✓ thumbnail.png`));

    // Step 9: Upload to GCS and generate RSS feed (unless --no-upload)
    let podcastUrl: string | null = null;
    if (!noUpload) {
        console.log();
        console.log(style.header('Uploading to GCS'));

        const gcsPath = `read-to-me/${titleSlug}`;

        // Upload M4A audio file
        const audioGcsPath = `gs://${GCS_BUCKET}/${gcsPath}/${outputBase}.m4a`;
        console.log(chalk.gray(`  Uploading audio file...`));
        const audioUploadResult = await Bun.$`gcloud storage cp ${combinedPath} ${audioGcsPath}`.quiet();
        if (audioUploadResult.exitCode !== 0) {
            console.log(chalk.yellow(`  ⚠ Failed to upload audio file`));
        } else {
            console.log(chalk.green(`  ✓ ${outputBase}.m4a`));
        }

        // Upload thumbnail
        const thumbnailGcsPath = `gs://${GCS_BUCKET}/${gcsPath}/thumbnail.png`;
        console.log(chalk.gray(`  Uploading thumbnail...`));
        const thumbnailUploadResult = await Bun.$`gcloud storage cp ${thumbnailPath} ${thumbnailGcsPath}`.quiet();
        if (thumbnailUploadResult.exitCode !== 0) {
            console.log(chalk.yellow(`  ⚠ Failed to upload thumbnail`));
        } else {
            console.log(chalk.green(`  ✓ thumbnail.png`));
        }

        // Generate and upload RSS feed
        console.log(chalk.gray(`  Generating RSS feed...`));
        const audioUrl = `${GCS_BASE_URL}/${gcsPath}/${outputBase}.m4a`;
        const thumbnailUrl = `${GCS_BASE_URL}/${gcsPath}/thumbnail.png`;

        // Get audio file size for enclosure
        const audioStats = await Bun.file(combinedPath).size;

        const rssFeed = generateRssFeed({
            title: content.title,
            author: content.byline || 'Read To Me',
            summary,
            sourceUrl: url,
            audioUrl,
            thumbnailUrl,
            audioSizeBytes: audioStats,
            durationMs: currentTime,
            chapters: chapters.map(c => ({
                title: c.title,
                startMs: c.startMs,
            })),
        });

        const rssFeedPath = path.join(outputDir, 'feed.xml');
        await Bun.write(rssFeedPath, rssFeed);
        console.log(chalk.green(`  ✓ feed.xml (local)`));

        // Upload RSS feed
        const rssGcsPath = `gs://${GCS_BUCKET}/${gcsPath}/feed.xml`;
        const rssUploadResult = await Bun.$`gcloud storage cp ${rssFeedPath} ${rssGcsPath}`.quiet();
        if (rssUploadResult.exitCode !== 0) {
            console.log(chalk.yellow(`  ⚠ Failed to upload RSS feed`));
        } else {
            console.log(chalk.green(`  ✓ feed.xml (uploaded)`));
        }

        // Set correct content type for RSS feed
        await Bun.$`gcloud storage objects update ${rssGcsPath} --content-type=application/rss+xml`.quiet();

        // Update master feed with all episodes
        console.log(chalk.gray(`  Updating master feed...`));
        const masterFeedUrl = `${GCS_BASE_URL}/read-to-me/feed.xml`;
        const masterFeedGcsPath = `gs://${GCS_BUCKET}/read-to-me/feed.xml`;

        const newEpisode: EpisodeData = {
            title: content.title,
            author: content.byline || 'Read To Me',
            summary,
            sourceUrl: url,
            audioUrl,
            thumbnailUrl,
            audioSizeBytes: audioStats,
            durationMs: currentTime,
            pubDate: new Date().toUTCString(),
            chapters: chapters.map(c => ({
                title: c.title,
                startMs: c.startMs,
            })),
        };

        const masterFeed = await updateMasterFeed(masterFeedUrl, newEpisode);
        const masterFeedPath = path.join(outputDir, 'master-feed.xml');
        await Bun.write(masterFeedPath, masterFeed);

        const masterUploadResult = await Bun.$`gcloud storage cp ${masterFeedPath} ${masterFeedGcsPath}`.quiet();
        if (masterUploadResult.exitCode !== 0) {
            console.log(chalk.yellow(`  ⚠ Failed to upload master feed`));
        } else {
            await Bun.$`gcloud storage objects update ${masterFeedGcsPath} --content-type=application/rss+xml`.quiet();
            console.log(chalk.green(`  ✓ master feed.xml (uploaded)`));
        }

        podcastUrl = masterFeedUrl;
    }

    console.log();
    console.log(style.header('Done!'));
    console.log(`  Total duration: ${formatMs(currentTime)}`);
    console.log(`  Output: ${combinedPath}`);
    if (podcastUrl) {
        console.log();
        console.log(chalk.cyan.bold(`  🎧 Podcast RSS Feed:`));
        console.log(chalk.cyan(`     ${podcastUrl}`));
        console.log();
        console.log(chalk.gray(`  Add this URL to Overcast or any podcast app to subscribe.`));
    }
});

// =============================================================================
// Thumbnail Generation
// =============================================================================

async function generateThumbnail(content: ExtractedContent, outputPath: string): Promise<void> {
    let baseImage: Buffer | null = null;

    // Try to generate an AI thumbnail using Gemini 2.5 Flash Image (nano-banana)
    if (geminiImageClient) {
        console.log(chalk.gray('  Generating AI thumbnail with Gemini...'));
        try {
            // Create a prompt based on the article title and content
            const titleSummary = content.title.slice(0, 100);
            const contentPreview = content.chapters[0]?.content.slice(0, 200) || '';

            const prompt = `Create a visually striking podcast cover art thumbnail for an article titled "${titleSummary}".
The image should be artistic, professional, and suitable as a podcast cover.
Use bold colors and an eye-catching composition that captures the essence of the topic.
Do NOT include any text in the image.
Article context: ${contentPreview}`;

            const response = await geminiImageClient.models.generateContent({
                model: 'gemini-2.5-flash-image',
                contents: prompt,
                config: {
                    responseModalities: ['IMAGE'],
                },
            });

            // Extract the generated image
            if (response.candidates?.[0]?.content?.parts) {
                for (const part of response.candidates[0].content.parts) {
                    if (part.inlineData?.data) {
                        baseImage = Buffer.from(part.inlineData.data, 'base64');
                        console.log(chalk.green('  AI thumbnail generated successfully'));
                        break;
                    }
                }
            }
        } catch (err) {
            console.log(chalk.yellow(`  AI image generation failed: ${(err as Error).message}`));
        }
    }

    // Fall back to using an article image if AI generation failed
    if (!baseImage && content.allImages.length > 0 && geminiClient) {
        console.log(chalk.gray('  Falling back to article image (rating with AI)...'));
        try {
            const model = geminiClient.getGenerativeModel({ model: 'gemini-2.0-flash' });
            const imagesToRate = content.allImages.slice(0, 5);

            // Rate images in parallel with concurrency limit
            const ratingPromises = imagesToRate.map((imgUrl) =>
                geminiLimit(async () => {
                    const imageData = await fetchImageAsBase64(imgUrl);
                    if (!imageData) return { imgUrl, score: -1 };

                    try {
                        const result = await model.generateContent([
                            {
                                inlineData: {
                                    mimeType: imageData.mimeType,
                                    data: imageData.data,
                                },
                            },
                            'Rate this image from 0-10 for use as a podcast thumbnail. Consider: visual appeal, relevance, composition. Reply with just a number.',
                        ]);
                        const score = parseInt(result.response.text().trim(), 10);
                        return { imgUrl, score: isNaN(score) ? -1 : score };
                    } catch {
                        return { imgUrl, score: -1 };
                    }
                })
            );

            const ratings = await Promise.all(ratingPromises);

            // Find the best rated image
            const bestRating = ratings.reduce((best, current) =>
                current.score > best.score ? current : best,
                { imgUrl: null as string | null, score: -1 }
            );

            if (bestRating.imgUrl && bestRating.score >= 0) {
                const imageData = await fetchImageAsBase64(bestRating.imgUrl);
                if (imageData) {
                    baseImage = Buffer.from(imageData.data, 'base64');
                    console.log(chalk.gray(`  Using article image (score: ${bestRating.score}/10)`));
                }
            }
        } catch (err) {
            console.log(chalk.yellow(`  Could not select image with AI: ${(err as Error).message}`));
        }
    }

    // Generate the thumbnail with border and R2M tag
    if (baseImage) {
        const innerSize = THUMBNAIL_SIZE - (THUMBNAIL_BORDER_WIDTH * 2);

        const resizedImage = await sharp(baseImage)
            .resize(innerSize, innerSize, { fit: 'cover' })
            .toBuffer();

        // Create the R2M tag SVG overlay
        const tagWidth = 120;
        const tagHeight = 50;
        const tagPadding = 15;
        const tagSvg = Buffer.from(`
            <svg width="${tagWidth}" height="${tagHeight}" xmlns="http://www.w3.org/2000/svg">
                <rect x="0" y="0" width="${tagWidth}" height="${tagHeight}" rx="8" ry="8" fill="${THUMBNAIL_BORDER_COLOR}"/>
                <text x="50%" y="55%" font-family="Arial, Helvetica, sans-serif" font-size="28"
                      fill="${THUMBNAIL_TAG_COLOR}" text-anchor="middle" dominant-baseline="middle" font-weight="bold">
                    R2M
                </text>
            </svg>
        `);

        // Create thumbnail with border and R2M tag
        const thumbnail = await sharp({
            create: {
                width: THUMBNAIL_SIZE,
                height: THUMBNAIL_SIZE,
                channels: 4,
                background: THUMBNAIL_BORDER_COLOR,
            },
        })
            .composite([
                {
                    input: resizedImage,
                    top: THUMBNAIL_BORDER_WIDTH,
                    left: THUMBNAIL_BORDER_WIDTH,
                },
                {
                    input: tagSvg,
                    top: THUMBNAIL_BORDER_WIDTH + tagPadding,
                    left: THUMBNAIL_SIZE - THUMBNAIL_BORDER_WIDTH - tagWidth - tagPadding,
                },
            ])
            .png()
            .toBuffer();

        await Bun.write(outputPath, thumbnail);
    } else {
        // Generate a placeholder thumbnail with title
        console.log(chalk.gray('  Generating placeholder thumbnail...'));

        const tagWidth = 120;
        const tagHeight = 50;
        const tagPadding = 15;

        const svg = `
            <svg width="${THUMBNAIL_SIZE}" height="${THUMBNAIL_SIZE}" xmlns="http://www.w3.org/2000/svg">
                <defs>
                    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
                        <stop offset="0%" style="stop-color:#1a1a2e;stop-opacity:1" />
                        <stop offset="100%" style="stop-color:#16213e;stop-opacity:1" />
                    </linearGradient>
                </defs>
                <rect width="100%" height="100%" fill="url(#bg)"/>
                <rect x="${THUMBNAIL_BORDER_WIDTH / 2}" y="${THUMBNAIL_BORDER_WIDTH / 2}"
                      width="${THUMBNAIL_SIZE - THUMBNAIL_BORDER_WIDTH}" height="${THUMBNAIL_SIZE - THUMBNAIL_BORDER_WIDTH}"
                      fill="none" stroke="${THUMBNAIL_BORDER_COLOR}" stroke-width="${THUMBNAIL_BORDER_WIDTH}"/>
                <text x="50%" y="45%" font-family="Arial, sans-serif" font-size="72"
                      fill="white" text-anchor="middle" font-weight="bold">
                    ${escapeXml(content.title.slice(0, 30))}${content.title.length > 30 ? '...' : ''}
                </text>
                <text x="50%" y="55%" font-family="Arial, sans-serif" font-size="36"
                      fill="#888888" text-anchor="middle">
                    Audio Article
                </text>
                <!-- R2M Tag -->
                <rect x="${THUMBNAIL_SIZE - THUMBNAIL_BORDER_WIDTH - tagWidth - tagPadding}" y="${THUMBNAIL_BORDER_WIDTH + tagPadding}"
                      width="${tagWidth}" height="${tagHeight}" rx="8" ry="8" fill="${THUMBNAIL_BORDER_COLOR}"/>
                <text x="${THUMBNAIL_SIZE - THUMBNAIL_BORDER_WIDTH - tagWidth / 2 - tagPadding}" y="${THUMBNAIL_BORDER_WIDTH + tagPadding + tagHeight / 2 + 8}"
                      font-family="Arial, Helvetica, sans-serif" font-size="28"
                      fill="${THUMBNAIL_TAG_COLOR}" text-anchor="middle" font-weight="bold">
                    R2M
                </text>
            </svg>
        `;

        const thumbnail = await sharp(Buffer.from(svg))
            .png()
            .toBuffer();

        await Bun.write(outputPath, thumbnail);
    }
}

// =============================================================================
// Output Generation (Markdown, RSS, Metadata)
// =============================================================================

function generateMarkdown(content: ExtractedContent, sourceUrl: string): string {
    let markdown = `# ${content.title}\n\n`;

    if (content.byline) {
        markdown += `*By ${content.byline}*\n\n`;
    }

    markdown += `> Source: ${sourceUrl}\n\n---\n\n`;

    for (const chapter of content.chapters) {
        markdown += `## ${chapter.title}\n\n`;
        markdown += chapter.content.trim() + '\n\n';
    }

    return markdown;
}

function generateFfmetadata(
    content: ExtractedContent,
    chapters: ChapterMetadata[],
    totalDurationMs: number,
    summary: string,
): string {
    // Generate ffmetadata format for ffmpeg chapter embedding
    // See: https://ffmpeg.org/ffmpeg-formats.html#Metadata-1
    let metadata = `;FFMETADATA1\ntitle=${escapeMetadata(content.title)}\n`;
    if (content.byline) {
        metadata += `artist=${escapeMetadata(content.byline)}\n`;
    }
    metadata += `album=Read To Me\n`;
    metadata += `description=${escapeMetadata(summary)}\n`;
    metadata += `comment=${escapeMetadata(summary)}\n`;
    metadata += `genre=Podcast\n`;
    metadata += `\n`;

    for (const chapter of chapters) {
        // TIMEBASE=1/1000 means times are in milliseconds
        const endMs = chapter.index < chapters.length
            ? chapters[chapter.index].startMs
            : totalDurationMs;

        metadata += `[CHAPTER]\n`;
        metadata += `TIMEBASE=1/1000\n`;
        metadata += `START=${chapter.startMs}\n`;
        metadata += `END=${endMs}\n`;
        metadata += `title=${escapeMetadata(chapter.title)}\n`;
        metadata += `\n`;
    }

    return metadata;
}

interface RssFeedOptions {
    title: string;
    author: string;
    summary: string;
    sourceUrl: string;
    audioUrl: string;
    thumbnailUrl: string;
    audioSizeBytes: number;
    durationMs: number;
    chapters: Array<{ title: string; startMs: number }>;
}

function generateRssFeed(options: RssFeedOptions): string {
    const {
        title,
        author,
        summary,
        sourceUrl,
        audioUrl,
        thumbnailUrl,
        audioSizeBytes,
        durationMs,
        chapters,
    } = options;

    const pubDate = new Date().toUTCString();
    const durationFormatted = formatMs(durationMs);

    // Generate podcast chapters in PSC format (used by Overcast and other apps)
    const pscChapters = chapters.map(c => {
        const timeFormatted = formatMs(c.startMs);
        return `            <psc:chapter start="${timeFormatted}" title="${escapeXml(c.title)}" />`;
    }).join('\n');

    return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
    xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"
    xmlns:podcast="https://podcastindex.org/namespace/1.0"
    xmlns:psc="http://podlove.org/simple-chapters">
    <channel>
        <title>${escapeXml(title)}</title>
        <link>${escapeXml(sourceUrl)}</link>
        <description>${escapeXml(summary)}</description>
        <language>en</language>
        <itunes:author>${escapeXml(author)}</itunes:author>
        <itunes:summary>${escapeXml(summary)}</itunes:summary>
        <itunes:image href="${escapeXml(thumbnailUrl)}" />
        <itunes:category text="Technology" />
        <itunes:explicit>false</itunes:explicit>
        <image>
            <url>${escapeXml(thumbnailUrl)}</url>
            <title>${escapeXml(title)}</title>
            <link>${escapeXml(sourceUrl)}</link>
        </image>
        <item>
            <title>${escapeXml(title)}</title>
            <description>${escapeXml(summary)}</description>
            <link>${escapeXml(sourceUrl)}</link>
            <guid isPermaLink="false">${escapeXml(audioUrl)}</guid>
            <pubDate>${pubDate}</pubDate>
            <enclosure url="${escapeXml(audioUrl)}" length="${audioSizeBytes}" type="audio/mp4" />
            <itunes:duration>${durationFormatted}</itunes:duration>
            <itunes:summary>${escapeXml(summary)}</itunes:summary>
            <itunes:image href="${escapeXml(thumbnailUrl)}" />
            <psc:chapters version="1.2">
${pscChapters}
            </psc:chapters>
            <podcast:chapters url="${escapeXml(audioUrl.replace('.m4a', '-chapters.json'))}" type="application/json+chapters" />
        </item>
    </channel>
</rss>`;
}

async function updateMasterFeed(masterFeedUrl: string, newEpisode: EpisodeData): Promise<string> {
    // Try to fetch existing master feed
    let existingEpisodes: EpisodeData[] = [];

    try {
        const response = await fetch(masterFeedUrl);
        if (response.ok) {
            const existingFeed = await response.text();
            existingEpisodes = parseEpisodesFromFeed(existingFeed);
        }
    } catch {
        // No existing feed, start fresh
    }

    // Remove any existing episode with the same audio URL (re-processing same article)
    existingEpisodes = existingEpisodes.filter(ep => ep.audioUrl !== newEpisode.audioUrl);

    // Add new episode at the beginning
    const allEpisodes = [newEpisode, ...existingEpisodes];

    return generateMasterFeed(allEpisodes);
}

function parseEpisodesFromFeed(feedXml: string): EpisodeData[] {
    const episodes: EpisodeData[] = [];

    // Parse <item> elements from the feed
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;

    while ((match = itemRegex.exec(feedXml)) !== null) {
        const itemXml = match[1];

        const getTag = (tag: string): string => {
            const tagMatch = itemXml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
            return tagMatch ? tagMatch[1].trim() : '';
        };

        const getAttr = (tag: string, attr: string): string => {
            const tagMatch = itemXml.match(new RegExp(`<${tag}[^>]*${attr}="([^"]*)"`, 'i'));
            return tagMatch ? tagMatch[1] : '';
        };

        // Parse enclosure attributes
        const enclosureMatch = itemXml.match(/<enclosure[^>]*url="([^"]*)"[^>]*length="(\d+)"/);

        // Parse chapters
        const chapters: Array<{ title: string; startMs: number }> = [];
        const chapterRegex = /<psc:chapter[^>]*start="([^"]*)"[^>]*title="([^"]*)"/g;
        let chapterMatch;
        while ((chapterMatch = chapterRegex.exec(itemXml)) !== null) {
            chapters.push({
                title: unescapeXml(chapterMatch[2]),
                startMs: parseTimeToMs(chapterMatch[1]),
            });
        }

        episodes.push({
            title: unescapeXml(getTag('title')),
            author: getTag('itunes:author') || 'Read To Me',
            summary: unescapeXml(getTag('description')),
            sourceUrl: getTag('link'),
            audioUrl: enclosureMatch ? enclosureMatch[1] : '',
            thumbnailUrl: getAttr('itunes:image', 'href'),
            audioSizeBytes: enclosureMatch ? parseInt(enclosureMatch[2], 10) : 0,
            durationMs: parseTimeToMs(getTag('itunes:duration')),
            pubDate: getTag('pubDate'),
            chapters,
        });
    }

    return episodes;
}

function generateMasterFeed(episodes: EpisodeData[]): string {
    const itemsXml = episodes.map(ep => {
        const durationFormatted = formatMs(ep.durationMs);
        const pscChapters = ep.chapters.map(c => {
            const timeFormatted = formatMs(c.startMs);
            return `            <psc:chapter start="${timeFormatted}" title="${escapeXml(c.title)}" />`;
        }).join('\n');

        return `        <item>
            <title>${escapeXml(ep.title)}</title>
            <description>${escapeXml(ep.summary)}</description>
            <link>${escapeXml(ep.sourceUrl)}</link>
            <guid isPermaLink="false">${escapeXml(ep.audioUrl)}</guid>
            <pubDate>${ep.pubDate}</pubDate>
            <enclosure url="${escapeXml(ep.audioUrl)}" length="${ep.audioSizeBytes}" type="audio/mp4" />
            <itunes:duration>${durationFormatted}</itunes:duration>
            <itunes:author>${escapeXml(ep.author)}</itunes:author>
            <itunes:summary>${escapeXml(ep.summary)}</itunes:summary>
            <itunes:image href="${escapeXml(ep.thumbnailUrl)}" />
            <psc:chapters version="1.2">
${pscChapters}
            </psc:chapters>
        </item>`;
    }).join('\n');

    return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
    xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"
    xmlns:podcast="https://podcastindex.org/namespace/1.0"
    xmlns:psc="http://podlove.org/simple-chapters">
    <channel>
        <title>Read To Me</title>
        <link>https://storage.googleapis.com/stefan-rss-feed/read-to-me/</link>
        <description>Articles converted to audio with AI-powered narration</description>
        <language>en</language>
        <itunes:author>Read To Me</itunes:author>
        <itunes:summary>Articles converted to audio with AI-powered narration</itunes:summary>
        <itunes:image href="https://storage.googleapis.com/stefan-rss-feed/read-to-me/cover.png" />
        <itunes:category text="Technology" />
        <itunes:explicit>false</itunes:explicit>
        <image>
            <url>https://storage.googleapis.com/stefan-rss-feed/read-to-me/cover.png</url>
            <title>Read To Me</title>
            <link>https://storage.googleapis.com/stefan-rss-feed/read-to-me/</link>
        </image>
${itemsXml}
    </channel>
</rss>`;
}
