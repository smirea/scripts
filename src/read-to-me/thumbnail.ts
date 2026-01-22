import chalk from 'chalk';
import crypto from 'crypto';
import path from 'path';
import pLimit from 'p-limit';
import sharp from 'sharp';
import { generateText } from 'ai';
import { escapeXml } from '../utils/xml';
import { fetchWithUA } from '../utils/fetch';
import { withRetry } from '../utils/retry';
import { geminiFlashModel, geminiImageGenClient } from './clients';
import { argv } from './cli';
import {
    FAVICON_BORDER_WIDTH,
    FAVICON_PADDING,
    FAVICON_SIZE,
    GEMINI_CONCURRENCY,
    IMAGE_CACHE_TTL_MS,
    THUMBNAIL_BORDER_COLOR,
    THUMBNAIL_BORDER_WIDTH,
    THUMBNAIL_CACHE_DIR,
    THUMBNAIL_SIZE,
    THUMBNAIL_TAG_COLOR,
} from './constants';
import type { ExtractedContent, ThumbnailCacheMetadata } from './types';
import { fetchImageAsBase64 } from './ai';

const aiLimit = pLimit(GEMINI_CONCURRENCY);

// =============================================================================
// Thumbnail Caching
// =============================================================================

function getThumbnailCacheKey(sourceUrl: string, content: ExtractedContent): string {
    const urlHash = crypto.createHash('sha256').update(sourceUrl).digest('hex').slice(0, 32);
    const contentToHash = `${content.title}|${content.chapters[0]?.content.slice(0, 200) || ''}`;
    const contentHash = crypto.createHash('sha256').update(contentToHash).digest('hex').slice(0, 16);
    return `${urlHash}_${contentHash}`;
}

async function getThumbnailFromCache(sourceUrl: string, content: ExtractedContent): Promise<Buffer | null> {
    if (!argv['cache-images']) return null;

    const cacheKey = getThumbnailCacheKey(sourceUrl, content);
    const imagePath = path.join(THUMBNAIL_CACHE_DIR, `${cacheKey}.png`);
    const metadataPath = path.join(THUMBNAIL_CACHE_DIR, `${cacheKey}.json`);

    try {
        const imageFile = Bun.file(imagePath);
        const metadataFile = Bun.file(metadataPath);

        if (!await imageFile.exists() || !await metadataFile.exists()) return null;

        const metadata: ThumbnailCacheMetadata = await metadataFile.json();

        if (Date.now() > metadata.expiresAt) {
            return null;
        }

        return Buffer.from(await imageFile.arrayBuffer());
    } catch {
        return null;
    }
}

async function saveThumbnailToCache(sourceUrl: string, content: ExtractedContent, thumbnail: Buffer): Promise<void> {
    if (!argv['cache-images']) return;

    const cacheKey = getThumbnailCacheKey(sourceUrl, content);
    const imagePath = path.join(THUMBNAIL_CACHE_DIR, `${cacheKey}.png`);
    const metadataPath = path.join(THUMBNAIL_CACHE_DIR, `${cacheKey}.json`);

    const contentToHash = `${content.title}|${content.chapters[0]?.content.slice(0, 200) || ''}`;
    const contentHash = crypto.createHash('sha256').update(contentToHash).digest('hex').slice(0, 16);

    const metadata: ThumbnailCacheMetadata = {
        expiresAt: Date.now() + IMAGE_CACHE_TTL_MS,
        sourceUrl,
        contentHash,
    };

    try {
        await Bun.write(path.join(THUMBNAIL_CACHE_DIR, '.gitkeep'), '');
        await Bun.write(imagePath, thumbnail);
        await Bun.write(metadataPath, JSON.stringify(metadata, null, 2));
    } catch (err) {
        console.log(chalk.yellow(`  Warning: Failed to cache thumbnail: ${(err as Error).message}`));
    }
}

// =============================================================================
// Favicon Fetching
// =============================================================================

async function fetchFavicon(sourceUrl: string): Promise<Buffer | null> {
    try {
        const urlObj = new URL(sourceUrl);
        const origin = urlObj.origin;

        const faviconUrls = [
            `${origin}/favicon.ico`,
            `${origin}/favicon.png`,
            `${origin}/apple-touch-icon.png`,
            `${origin}/apple-touch-icon-precomposed.png`,
        ];

        for (const faviconUrl of faviconUrls) {
            try {
                const response = await fetchWithUA(faviconUrl);
                if (response.ok) {
                    const contentType = response.headers.get('content-type') || '';
                    if (contentType.includes('image') || faviconUrl.endsWith('.ico') || faviconUrl.endsWith('.png')) {
                        const buffer = Buffer.from(await response.arrayBuffer());
                        try {
                            await sharp(buffer).metadata();
                            return buffer;
                        } catch {
                            continue;
                        }
                    }
                }
            } catch {
                continue;
            }
        }

        const googleFaviconUrl = `https://www.google.com/s2/favicons?domain=${urlObj.hostname}&sz=128`;
        const googleResponse = await fetchWithUA(googleFaviconUrl);
        if (googleResponse.ok) {
            const buffer = Buffer.from(await googleResponse.arrayBuffer());
            try {
                await sharp(buffer).metadata();
                return buffer;
            } catch {
                return null;
            }
        }

        return null;
    } catch {
        return null;
    }
}

// =============================================================================
// Favicon Overlay
// =============================================================================

async function createFaviconOverlay(faviconBuffer: Buffer | null): Promise<sharp.OverlayOptions | null> {
    if (!faviconBuffer) return null;

    const faviconTotalSize = FAVICON_SIZE + FAVICON_BORDER_WIDTH * 2;

    const processedFavicon = await sharp(faviconBuffer)
        .resize(FAVICON_SIZE, FAVICON_SIZE, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } })
        .png()
        .toBuffer();

    const faviconContainerSvg = Buffer.from(`
        <svg width="${faviconTotalSize}" height="${faviconTotalSize}" xmlns="http://www.w3.org/2000/svg">
            <defs>
                <linearGradient id="faviconBorderGradient" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" style="stop-color:#1E90FF;stop-opacity:1" />
                    <stop offset="50%" style="stop-color:#4169E1;stop-opacity:1" />
                    <stop offset="100%" style="stop-color:#1E90FF;stop-opacity:1" />
                </linearGradient>
            </defs>
            <rect x="0" y="0" width="${faviconTotalSize}" height="${faviconTotalSize}" rx="12" ry="12" fill="url(#faviconBorderGradient)"/>
        </svg>
    `);

    const faviconWithBorder = await sharp(faviconContainerSvg)
        .composite([
            {
                input: await sharp(processedFavicon)
                    .extend({
                        top: 0,
                        bottom: 0,
                        left: 0,
                        right: 0,
                        background: { r: 0, g: 0, b: 0, alpha: 0 }
                    })
                    .toBuffer(),
                top: FAVICON_BORDER_WIDTH,
                left: FAVICON_BORDER_WIDTH,
            },
        ])
        .png()
        .toBuffer();

    return {
        input: faviconWithBorder,
        top: THUMBNAIL_SIZE - THUMBNAIL_BORDER_WIDTH - faviconTotalSize - FAVICON_PADDING,
        left: THUMBNAIL_SIZE - THUMBNAIL_BORDER_WIDTH - faviconTotalSize - FAVICON_PADDING,
    };
}

// =============================================================================
// Thumbnail Generation
// =============================================================================

export async function generateThumbnail(content: ExtractedContent, outputPath: string, sourceUrl: string): Promise<void> {
    const cachedThumbnail = await getThumbnailFromCache(sourceUrl, content);
    if (cachedThumbnail) {
        console.log(chalk.gray('  Using cached thumbnail'));
        await Bun.write(outputPath, cachedThumbnail);
        return;
    }

    let baseImage: Buffer | null = null;
    let faviconBuffer: Buffer | null = null;

    const faviconPromise = fetchFavicon(sourceUrl).catch(() => null);

    // Try to generate an AI thumbnail
    if (geminiImageGenClient) {
        console.log(chalk.gray('  Generating AI thumbnail with Gemini...'));
        try {
            const titleSummary = content.title.slice(0, 100);
            const contentPreview = content.chapters[0]?.content.slice(0, 200) || '';

            const prompt = `Create a visually striking podcast cover art thumbnail for an article titled "${titleSummary}".
The image should be artistic, professional, and suitable as a podcast cover.
Use bold colors and an eye-catching composition that captures the essence of the topic.
Do NOT include any text in the image.
Article context: ${contentPreview}`;

            const response = await withRetry(
                () => geminiImageGenClient!.models.generateContent({
                    model: 'gemini-2.5-flash-image',
                    contents: prompt,
                    config: {
                        responseModalities: ['IMAGE'],
                    },
                }),
                'generate thumbnail'
            );

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

    // Fall back to using an article image
    if (!baseImage && content.allImages.length > 0) {
        console.log(chalk.gray('  Falling back to article image (rating with Gemini 3 Flash)...'));
        try {
            const imagesToRate = content.allImages.slice(0, 5);

            const ratingPromises = imagesToRate.map((imgUrl) =>
                aiLimit(async () => {
                    const imageData = await fetchImageAsBase64(imgUrl);
                    if (!imageData) return { imgUrl, score: -1, imageData: null };

                    try {
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
                                            text: 'Rate this image from 0-10 for use as a podcast thumbnail. Consider: visual appeal, relevance, composition. Reply with just a number.',
                                        },
                                    ],
                                }],
                            }),
                            'rate image'
                        );
                        const score = parseInt(result.text.trim(), 10);
                        return { imgUrl, score: isNaN(score) ? -1 : score, imageData };
                    } catch {
                        return { imgUrl, score: -1, imageData: null };
                    }
                })
            );

            const ratings = await Promise.all(ratingPromises);

            const bestRating = ratings.reduce((best, current) =>
                current.score > best.score ? current : best,
                { imgUrl: null as string | null, score: -1, imageData: null as { data: string; mimeType: string } | null }
            );

            if (bestRating.imgUrl && bestRating.score >= 0 && bestRating.imageData) {
                baseImage = Buffer.from(bestRating.imageData.data, 'base64');
                console.log(chalk.gray(`  Using article image (score: ${bestRating.score}/10)`));
            }
        } catch (err) {
            console.log(chalk.yellow(`  Could not select image with AI: ${(err as Error).message}`));
        }
    }

    faviconBuffer = await faviconPromise;

    if (baseImage) {
        const resizedImage = await sharp(baseImage)
            .resize(THUMBNAIL_SIZE, THUMBNAIL_SIZE, { fit: 'cover' })
            .toBuffer();

        const borderSvg = Buffer.from(`
            <svg width="${THUMBNAIL_SIZE}" height="${THUMBNAIL_SIZE}" xmlns="http://www.w3.org/2000/svg">
                <defs>
                    <mask id="borderMask">
                        <rect width="100%" height="100%" fill="white"/>
                        <rect x="${THUMBNAIL_BORDER_WIDTH}" y="${THUMBNAIL_BORDER_WIDTH}"
                              width="${THUMBNAIL_SIZE - THUMBNAIL_BORDER_WIDTH * 2}"
                              height="${THUMBNAIL_SIZE - THUMBNAIL_BORDER_WIDTH * 2}" fill="black"/>
                    </mask>
                </defs>
                <rect width="100%" height="100%" fill="${THUMBNAIL_BORDER_COLOR}" mask="url(#borderMask)"/>
            </svg>
        `);

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

        const faviconOverlay = await createFaviconOverlay(faviconBuffer);

        const thumbnail = await sharp(resizedImage)
            .composite([
                {
                    input: borderSvg,
                    top: 0,
                    left: 0,
                },
                {
                    input: tagSvg,
                    top: THUMBNAIL_BORDER_WIDTH + tagPadding,
                    left: THUMBNAIL_SIZE - THUMBNAIL_BORDER_WIDTH - tagWidth - tagPadding,
                },
                ...(faviconOverlay ? [faviconOverlay] : []),
            ])
            .png()
            .toBuffer();

        await Bun.write(outputPath, thumbnail);
        await saveThumbnailToCache(sourceUrl, content, thumbnail);
    } else {
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

        const placeholderFaviconOverlay = await createFaviconOverlay(faviconBuffer);

        const thumbnail = await sharp(Buffer.from(svg))
            .composite(placeholderFaviconOverlay ? [placeholderFaviconOverlay] : [])
            .png()
            .toBuffer();

        await Bun.write(outputPath, thumbnail);
        await saveThumbnailToCache(sourceUrl, content, thumbnail);
    }
}
