#!/usr/bin/env bun
import { TextToSpeechClient } from '@google-cloud/text-to-speech';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { Readability } from '@mozilla/readability';
import chalk from 'chalk';
import { parseHTML } from 'linkedom';
import path from 'path';
import sharp from 'sharp';
import TurndownService from 'turndown';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import { createScript, style } from './utils/createScript';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const genAI = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;
const ttsClient = new TextToSpeechClient();

const ENGLISH_DIALECTS = [
    'en-AU', // Australia
    'en-GB', // United Kingdom
    'en-IN', // India
    'en-US', // United States
] as const;

type EnglishDialect = typeof ENGLISH_DIALECTS[number];

const CHIRP3_VOICES = [
    'Aoede', 'Charon', 'Fenrir', 'Kore', 'Leda',
    'Orus', 'Puck', 'Zephyr',
] as const;

type Voice = typeof CHIRP3_VOICES[number];

const VOICE_GENDERS: Record<Voice, 'male' | 'female'> = {
    Aoede: 'female',
    Charon: 'male',
    Fenrir: 'male',
    Kore: 'female',
    Leda: 'female',
    Orus: 'male',
    Puck: 'male',
    Zephyr: 'female',
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
        describe: 'Output file path (without extension)',
        type: 'string',
    })
    .strict()
    .help()
    .parseSync() as { url: string; voice: typeof CHIRP3_VOICES[number] | 'random' | 'random-male' | 'random-female'; dialect: EnglishDialect; output?: string };

interface Chapter {
    title: string;
    content: string;
    images: string[];
}

interface ExtractedContent {
    title: string;
    byline: string | null;
    chapters: Chapter[];
    allImages: string[];
}

async function fetchWebpage(url: string): Promise<string> {
    console.log(chalk.blue('Fetching webpage...'));
    const response = await fetch(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        },
    });
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

            // Track images in this chapter
            const mdImgRegex = /!\[.*?\]\(([^)]+)\)/g;
            let imgMatch;
            while ((imgMatch = mdImgRegex.exec(line)) !== null) {
                currentChapter.images.push(imgMatch[1]);
            }
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

    return {
        title: article.title,
        byline: article.byline,
        chapters,
        allImages,
    };
}

async function fetchImageAsBase64(imageUrl: string): Promise<{ data: string; mimeType: string } | null> {
    try {
        const response = await fetch(imageUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
            },
        });
        if (!response.ok) return null;

        const contentType = response.headers.get('content-type') || 'image/jpeg';
        const arrayBuffer = await response.arrayBuffer();
        const base64 = Buffer.from(arrayBuffer).toString('base64');
        return { data: base64, mimeType: contentType };
    } catch {
        return null;
    }
}

async function describeImage(imageUrl: string): Promise<string | null> {
    if (!genAI) {
        console.log(chalk.yellow('  Skipping image (no GEMINI_API_KEY)'));
        return null;
    }

    const imageData = await fetchImageAsBase64(imageUrl);
    if (!imageData) {
        console.log(chalk.yellow(`  Could not fetch image: ${imageUrl}`));
        return null;
    }

    try {
        const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
        const result = await model.generateContent([
            {
                inlineData: {
                    mimeType: imageData.mimeType,
                    data: imageData.data,
                },
            },
            'Describe this image in 1-2 sentences for someone listening to an audio version of an article. Be concise and descriptive.',
        ]);
        return result.response.text().trim();
    } catch (err) {
        console.log(chalk.yellow(`  Error describing image: ${(err as Error).message}`));
        return null;
    }
}

async function processImagesInContent(content: ExtractedContent): Promise<ExtractedContent> {
    if (!genAI) {
        console.log(chalk.yellow('Skipping image processing (no GEMINI_API_KEY)'));
        return content;
    }

    console.log(chalk.blue(`Processing ${content.allImages.length} images with Gemini...`));

    const imageDescriptions = new Map<string, string>();

    for (let i = 0; i < content.allImages.length; i++) {
        const imgUrl = content.allImages[i];
        console.log(chalk.gray(`  [${i + 1}/${content.allImages.length}] ${imgUrl.slice(0, 60)}...`));
        const description = await describeImage(imgUrl);
        if (description) {
            imageDescriptions.set(imgUrl, description);
            console.log(chalk.green(`    → ${description.slice(0, 80)}...`));
        }
    }

    // Replace image references in chapter content with descriptions
    const updatedChapters = content.chapters.map(chapter => {
        let updatedContent = chapter.content;
        for (const [imgUrl, description] of imageDescriptions) {
            // Replace markdown image syntax with description
            const mdImgRegex = new RegExp(`!\\[.*?\\]\\(${imgUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`, 'g');
            updatedContent = updatedContent.replace(mdImgRegex, `[Image: ${description}]`);
        }
        return { ...chapter, content: updatedContent };
    });

    return { ...content, chapters: updatedChapters };
}

async function filterChapterContent(chapter: Chapter, chapterIndex: number, totalChapters: number): Promise<Chapter> {
    if (!genAI) {
        return chapter;
    }

    // Skip filtering for very short content (likely already clean)
    if (chapter.content.length < 200) {
        return chapter;
    }

    try {
        const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
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

async function filterContentWithAI(content: ExtractedContent): Promise<ExtractedContent> {
    if (!genAI) {
        console.log(chalk.yellow('Skipping content filtering (no GEMINI_API_KEY)'));
        return content;
    }

    console.log(chalk.blue(`Filtering ${content.chapters.length} chapters to remove ads/comments...`));

    const filteredChapters: Chapter[] = [];

    for (let i = 0; i < content.chapters.length; i++) {
        const chapter = content.chapters[i];
        console.log(chalk.gray(`  [${i + 1}/${content.chapters.length}] Filtering: ${chapter.title}`));
        const filteredChapter = await filterChapterContent(chapter, i, content.chapters.length);

        // Only include chapters that have content after filtering
        if (filteredChapter.content.trim().length > 0) {
            filteredChapters.push(filteredChapter);
        } else {
            console.log(chalk.yellow(`    → Removed empty chapter: ${chapter.title}`));
        }
    }

    // If all chapters were filtered out, keep at least the first original chapter
    if (filteredChapters.length === 0 && content.chapters.length > 0) {
        console.log(chalk.yellow('  Warning: All chapters filtered, keeping first chapter'));
        filteredChapters.push(content.chapters[0]);
    }

    console.log(chalk.green(`  Kept ${filteredChapters.length}/${content.chapters.length} chapters after filtering`));

    return { ...content, chapters: filteredChapters };
}

interface ChapterAudio {
    title: string;
    audioBuffer: Buffer;
    durationMs: number;
}

async function synthesizeChapter(
    chapter: Chapter,
    voice: Voice,
    dialect: EnglishDialect,
    chapterIndex: number,
    totalChapters: number,
): Promise<ChapterAudio> {
    console.log(chalk.gray(`  [${chapterIndex + 1}/${totalChapters}] Synthesizing: ${chapter.title}`));

    // Clean up markdown for TTS (remove links, code blocks, etc.)
    let text = chapter.content
        .replace(/```[\s\S]*?```/g, '') // Remove code blocks
        .replace(/`[^`]+`/g, '') // Remove inline code
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // Replace links with just text
        .replace(/[#*_~]/g, '') // Remove markdown formatting
        .replace(/\n{3,}/g, '\n\n') // Normalize multiple newlines
        .trim();

    // Add chapter title at the beginning
    text = `Chapter: ${chapter.title}.\n\n${text}`;

    // Google TTS has a 5000 byte limit per request and individual sentence limits
    const MAX_BYTES = 4500;
    const MAX_SENTENCE_LENGTH = 300; // TTS has strict limits on individual sentence length
    const chunks: string[] = [];
    let currentChunk = '';

    // Function to split long text at natural break points
    function splitLongText(text: string, maxLen: number): string[] {
        const result: string[] = [];
        // Try splitting at natural break points (commas, semicolons, parentheses)
        const parts = text.split(/(?<=[,;:\)\]])\s+/);

        for (const part of parts) {
            if (part.length <= maxLen) {
                result.push(part);
            } else {
                // Force split at word boundaries if still too long
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

    // Split into sentences, then further split long sentences
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

    const audioBuffers: Buffer[] = [];

    for (const chunk of chunks) {
        const [response] = await ttsClient.synthesizeSpeech({
            input: { text: chunk },
            voice: {
                languageCode: dialect,
                name: `${dialect.toLowerCase()}-Chirp3-HD-${voice}`,
            },
            audioConfig: {
                audioEncoding: 'MP3',
                speakingRate: 1.0,
            },
        });

        if (response.audioContent) {
            audioBuffers.push(Buffer.from(response.audioContent as Uint8Array));
        }
    }

    // Concatenate all audio buffers
    const audioBuffer = Buffer.concat(audioBuffers);

    // Estimate duration (rough: MP3 at 24kbps is ~3KB per second)
    const durationMs = Math.round((audioBuffer.length / 3000) * 1000);

    console.log(chalk.green(`    → ${(audioBuffer.length / 1024).toFixed(1)} KB, ~${(durationMs / 1000).toFixed(1)}s`));

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
    console.log(chalk.blue(`Synthesizing ${content.chapters.length} chapters with ${voice} voice...`));

    const chapterAudios: ChapterAudio[] = [];

    for (let i = 0; i < content.chapters.length; i++) {
        const audio = await synthesizeChapter(
            content.chapters[i],
            voice,
            dialect,
            i,
            content.chapters.length,
        );
        chapterAudios.push(audio);
    }

    return chapterAudios;
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

    console.log(style.header('Read To Me'));
    console.log('Configuration:');
    console.log(`  URL: ${url}`);
    console.log(`  Voice: ${dialect.toLowerCase()}-Chirp3-HD-${voice} (${VOICE_GENDERS[voice]})`);
    console.log(`  Dialect: ${dialect}`);
    console.log(`  Output: ${output || '(auto)'}`);
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

    // Update summary after filtering
    console.log();
    console.log(style.header('Content After Filtering'));
    console.log(`  Chapters: ${content.chapters.length}`);
    for (const chapter of content.chapters) {
        console.log(`    - ${chapter.title} (${chapter.content.length} chars)`);
    }

    // Step 3: Process images with Gemini
    if (content.allImages.length > 0) {
        console.log();
        content = await processImagesInContent(content);
    }

    // Step 4: Synthesize audio with Google Chirp 3
    console.log();
    const chapterAudios = await synthesizeContent(content, voice, dialect);

    // Step 5: Save individual chapter files and generate output
    const outputBase = output || content.title.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
    const outputDir = path.join(process.cwd(), 'output', outputBase);
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

    // Create combined audio file
    const combinedBuffer = Buffer.concat(chapterAudios.map(a => a.audioBuffer));
    const combinedPath = path.join(outputDir, `${outputBase}.mp3`);
    await Bun.write(combinedPath, combinedBuffer);
    console.log(chalk.green.bold(`  ✓ ${outputBase}.mp3 (combined)`));

    // Generate chapter metadata file
    let currentTime = 0;
    const chapters = chapterAudios.map((audio, i) => {
        const chapter = {
            index: i + 1,
            title: audio.title,
            startMs: currentTime,
            startFormatted: formatMs(currentTime),
        };
        currentTime += audio.durationMs;
        return chapter;
    });

    const metadataPath = path.join(outputDir, 'chapters.json');
    await Bun.write(metadataPath, JSON.stringify({
        title: content.title,
        author: content.byline,
        voice,
        dialect,
        sourceUrl: url,
        totalDurationMs: currentTime,
        totalDurationFormatted: formatMs(currentTime),
        chapters,
    }, null, 2));
    console.log(chalk.green(`  ✓ chapters.json`));

    // Step 6: Generate thumbnail
    console.log();
    console.log(style.header('Generating Thumbnail'));
    const thumbnailPath = path.join(outputDir, 'thumbnail.png');
    await generateThumbnail(content, thumbnailPath);
    console.log(chalk.green(`  ✓ thumbnail.png`));

    console.log();
    console.log(style.header('Done!'));
    console.log(`  Total duration: ${formatMs(currentTime)}`);
    console.log(`  Output: ${combinedPath}`);
});

async function generateThumbnail(content: ExtractedContent, outputPath: string): Promise<void> {
    const THUMBNAIL_SIZE = 1400; // Standard podcast cover size
    const BORDER_WIDTH = 40;
    const BORDER_COLOR = '#1E90FF'; // Dodger blue - stylish standard blue

    // Try to use an image from the article as base
    let baseImage: Buffer | null = null;

    if (content.allImages.length > 0 && genAI) {
        // Try to find the best image using AI
        console.log(chalk.gray('  Finding best cover image...'));
        try {
            const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

            // Score each image for thumbnail suitability
            let bestImage: string | null = null;
            let bestScore = -1;

            for (const imgUrl of content.allImages.slice(0, 5)) { // Check first 5 images
                const imageData = await fetchImageAsBase64(imgUrl);
                if (!imageData) continue;

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
                    if (!isNaN(score) && score > bestScore) {
                        bestScore = score;
                        bestImage = imgUrl;
                    }
                } catch {
                    // Skip images that fail to process
                }
            }

            if (bestImage) {
                const imageData = await fetchImageAsBase64(bestImage);
                if (imageData) {
                    baseImage = Buffer.from(imageData.data, 'base64');
                    console.log(chalk.gray(`  Using article image (score: ${bestScore}/10)`));
                }
            }
        } catch (err) {
            console.log(chalk.yellow(`  Could not select image with AI: ${(err as Error).message}`));
        }
    }

    // Generate the thumbnail
    if (baseImage) {
        // Process existing image: resize and add border
        const innerSize = THUMBNAIL_SIZE - (BORDER_WIDTH * 2);

        const resizedImage = await sharp(baseImage)
            .resize(innerSize, innerSize, { fit: 'cover' })
            .toBuffer();

        // Create thumbnail with border
        const thumbnail = await sharp({
            create: {
                width: THUMBNAIL_SIZE,
                height: THUMBNAIL_SIZE,
                channels: 4,
                background: BORDER_COLOR,
            },
        })
            .composite([
                {
                    input: resizedImage,
                    top: BORDER_WIDTH,
                    left: BORDER_WIDTH,
                },
            ])
            .png()
            .toBuffer();

        await Bun.write(outputPath, thumbnail);
    } else {
        // Generate a simple placeholder thumbnail with title
        console.log(chalk.gray('  Generating placeholder thumbnail...'));

        // Create a gradient-like background with the title
        const svg = `
            <svg width="${THUMBNAIL_SIZE}" height="${THUMBNAIL_SIZE}" xmlns="http://www.w3.org/2000/svg">
                <defs>
                    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
                        <stop offset="0%" style="stop-color:#1a1a2e;stop-opacity:1" />
                        <stop offset="100%" style="stop-color:#16213e;stop-opacity:1" />
                    </linearGradient>
                </defs>
                <rect width="100%" height="100%" fill="url(#bg)"/>
                <rect x="${BORDER_WIDTH / 2}" y="${BORDER_WIDTH / 2}"
                      width="${THUMBNAIL_SIZE - BORDER_WIDTH}" height="${THUMBNAIL_SIZE - BORDER_WIDTH}"
                      fill="none" stroke="${BORDER_COLOR}" stroke-width="${BORDER_WIDTH}"/>
                <text x="50%" y="45%" font-family="Arial, sans-serif" font-size="72"
                      fill="white" text-anchor="middle" font-weight="bold">
                    ${escapeXml(content.title.slice(0, 30))}${content.title.length > 30 ? '...' : ''}
                </text>
                <text x="50%" y="55%" font-family="Arial, sans-serif" font-size="36"
                      fill="#888888" text-anchor="middle">
                    🎧 Audio Article
                </text>
            </svg>
        `;

        const thumbnail = await sharp(Buffer.from(svg))
            .png()
            .toBuffer();

        await Bun.write(outputPath, thumbnail);
    }
}

function escapeXml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function formatMs(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    return `${hours}:${String(minutes % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
