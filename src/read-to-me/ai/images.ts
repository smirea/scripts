import chalk from 'chalk';
import crypto from 'crypto';
import path from 'path';
import pLimit from 'p-limit';
import { fetchWithUA } from '../../utils/fetch';
import { withRetry } from '../../utils/retry';
import { geminiTextClient } from '../clients';
import { argv } from '../cli';
import { GEMINI_CONCURRENCY, IMAGE_CACHE_DIR, IMAGE_CACHE_TTL_MS, PROMPTS_DIR } from '../constants';
import type { ExtractedContent, ImageCacheEntry, ImageDescriptionResult, ImageDescriptionResultWithCache } from '../types';

const geminiLimit = pLimit(GEMINI_CONCURRENCY);

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

async function describeImage(imageUrl: string): Promise<ImageDescriptionResultWithCache> {
    if (!geminiTextClient) {
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
        const prompt = await loadImagePrompt();
        const model = geminiTextClient.getGenerativeModel({ model: 'gemini-2.0-flash' });
        const result = await withRetry(
            () => model.generateContent([
                {
                    inlineData: {
                        mimeType: imageData.mimeType,
                        data: imageData.data,
                    },
                },
                prompt,
            ]),
            'describe image'
        );
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

export async function processImagesInContent(content: ExtractedContent): Promise<ExtractedContent> {
    if (!geminiTextClient) {
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
    const descriptionPromises = content.allImages.map((imgUrl) =>
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
