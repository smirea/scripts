import chalk from 'chalk';
import crypto from 'crypto';
import path from 'path';
import pLimit from 'p-limit';
import { generateText } from 'ai';
import { fetchWithUA } from '../../utils/fetch';
import { withRetry } from '../../utils/retry';
import { geminiFlashModel } from '../clients';
import { argv } from '../cli';
import { GEMINI_CONCURRENCY, IMAGE_CACHE_DIR, IMAGE_CACHE_TTL_MS, PROMPTS_DIR } from '../constants';
import type { ExtractedContent, ImageCacheEntry, ImageDescriptionResult, ImageDescriptionResultWithCache } from '../types';

const aiLimit = pLimit(GEMINI_CONCURRENCY);

let IMAGE_DESCRIPTION_PROMPT: string | null = null;
let IMAGE_PROMPT_HASH: string | null = null;

async function loadImagePrompt(): Promise<string> {
    if (IMAGE_DESCRIPTION_PROMPT) return IMAGE_DESCRIPTION_PROMPT;

    const promptPath = path.join(PROMPTS_DIR, 'image-description.md');
    const file = Bun.file(promptPath);
    if (!await file.exists()) {
        throw new Error(`Image description prompt not found at: ${promptPath}`);
    }
    IMAGE_DESCRIPTION_PROMPT = await file.text();
    IMAGE_PROMPT_HASH = crypto.createHash('sha256').update(IMAGE_DESCRIPTION_PROMPT).digest('hex').slice(0, 16);
    return IMAGE_DESCRIPTION_PROMPT;
}

function getImageCacheKey(imageUrl: string): string {
    const urlHash = crypto.createHash('sha256').update(imageUrl).digest('hex').slice(0, 32);
    return `${urlHash}_${IMAGE_PROMPT_HASH}`;
}

async function getImageFromCache(imageUrl: string): Promise<ImageDescriptionResult | null> {
    if (!argv['cache-images']) return null;
    if (!IMAGE_PROMPT_HASH) await loadImagePrompt();

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
    if (!IMAGE_PROMPT_HASH) await loadImagePrompt();

    const cacheKey = getImageCacheKey(imageUrl);
    const cachePath = path.join(IMAGE_CACHE_DIR, `${cacheKey}.json`);

    const entry: ImageCacheEntry = {
        result,
        expiresAt: Date.now() + IMAGE_CACHE_TTL_MS,
        promptHash: IMAGE_PROMPT_HASH!,
    };

    try {
        // Ensure cache directory exists
        await Bun.write(path.join(IMAGE_CACHE_DIR, '.gitkeep'), '');
        await Bun.write(cachePath, JSON.stringify(entry, null, 2));
    } catch (err) {
        console.log(chalk.yellow(`  Warning: Failed to cache image result: ${(err as Error).message}`));
    }
}

export async function fetchImageAsBase64(imageUrl: string): Promise<{ data: string; mimeType: string } | null> {
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

async function describeImage(imageUrl: string, context?: string): Promise<ImageDescriptionResultWithCache> {
    // Check cache first (context not included in cache key for now)
    const cachedResult = await getImageFromCache(imageUrl);
    if (cachedResult) {
        return { result: cachedResult, fromCache: true };
    }

    const imageData = await fetchImageAsBase64(imageUrl);
    if (!imageData) {
        return { result: { type: 'skipped', reason: 'fetch_error' }, fromCache: false };
    }

    try {
        const basePrompt = await loadImagePrompt();

        // Add context to the prompt if available
        let fullPrompt = basePrompt;
        if (context) {
            fullPrompt += `\n\n## Context from the article\n\nThe surrounding text discusses:\n"${context}"\n\nUse this context to make your description more relevant and connected to the article's discussion.`;
        }

        const result = await withRetry(
            async () => generateText({
                model: geminiFlashModel,
                messages: [{
                    role: 'user',
                    content: [
                        {
                            type: 'image',
                            image: `data:${imageData.mimeType};base64,${imageData.data}`,
                        },
                        {
                            type: 'text',
                            text: fullPrompt,
                        },
                    ],
                }],
            }),
            'describe image'
        );
        const response = result.text.trim();

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

function extractContextForImage(content: string, imageUrl: string, charsBefore = 300, charsAfter = 150): string | undefined {
    const escapedUrl = imageUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const imgRegex = new RegExp(`!\\[.*?\\]\\(${escapedUrl}\\)`);
    const match = imgRegex.exec(content);

    if (!match) return undefined;

    const imgIndex = match.index;
    const start = Math.max(0, imgIndex - charsBefore);
    const end = Math.min(content.length, imgIndex + match[0].length + charsAfter);

    let context = content.slice(start, imgIndex).trim();
    const afterText = content.slice(imgIndex + match[0].length, end).trim();

    if (afterText) {
        context += ' [...] ' + afterText;
    }

    // Clean up markdown formatting for context
    context = context
        .replace(/!\[.*?\]\([^)]+\)/g, '') // Remove other images
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // Convert links to text
        .replace(/[#*_~`]/g, '') // Remove markdown formatting
        .replace(/\s+/g, ' ') // Normalize whitespace
        .trim();

    return context.length > 50 ? context : undefined;
}

export async function processImagesInContent(content: ExtractedContent): Promise<ExtractedContent> {
    const cacheInfo = argv['cache-images'] ? ' (cache enabled)' : '';
    console.log(chalk.blue(`Processing ${content.allImages.length} images with Gemini 3 Flash (concurrency: ${GEMINI_CONCURRENCY})${cacheInfo}...`));

    const imageDescriptions = new Map<string, string>();
    let completed = 0;
    let cacheHits = 0;
    const total = content.allImages.length;
    const skippedImages = new Set<string>();

    // Build a map of image URL to chapter content for context extraction
    const imageToChapterContent = new Map<string, string>();
    for (const chapter of content.chapters) {
        for (const imgUrl of chapter.images) {
            if (!imageToChapterContent.has(imgUrl)) {
                imageToChapterContent.set(imgUrl, chapter.content);
            }
        }
    }

    // Process images in parallel with concurrency limit
    const descriptionPromises = content.allImages.map((imgUrl) =>
        aiLimit(async () => {
            // Extract context from the chapter where this image appears
            const chapterContent = imageToChapterContent.get(imgUrl);
            const context = chapterContent ? extractContextForImage(chapterContent, imgUrl) : undefined;

            const { result, fromCache } = await describeImage(imgUrl, context);
            completed++;
            if (fromCache) cacheHits++;
            const cacheTag = fromCache ? chalk.cyan('[cached] ') : '';
            if (result.type === 'description') {
                imageDescriptions.set(imgUrl, result.text);
                const preview = result.text.length > 80 ? result.text.slice(0, 77) + '...' : result.text;
                console.log(chalk.green(`  [${completed}/${total}] ${cacheTag}${imgUrl.slice(0, 40)}...`));
                console.log(chalk.gray(`    → ${preview}`));
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
    // Also track the first described image per chapter for Podcasting 2.0 chapter artwork
    const updatedChapters = content.chapters.map(chapter => {
        let updatedContent = chapter.content;
        let chapterImageUrl: string | undefined;

        // Find the first described image in this chapter (for chapter artwork)
        for (const imgUrl of chapter.images) {
            if (imageDescriptions.has(imgUrl) && !chapterImageUrl) {
                chapterImageUrl = imgUrl;
                break;
            }
        }

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

        return { ...chapter, content: updatedContent, chapterImageUrl };
    });

    return { ...content, chapters: updatedChapters };
}
