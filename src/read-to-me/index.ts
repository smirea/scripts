#!/usr/bin/env bun
import chalk from 'chalk';
import { unlink, rename } from 'fs/promises';
import path from 'path';
import pLimit from 'p-limit';

import { createScript, style } from '../utils/createScript';
import { fetchWithUA } from '../utils/fetch';
import { formatMs } from '../utils/time';

import { argv } from './cli';
import { FETCH_CONCURRENCY, GCS_BASE_URL, GCS_BUCKET } from './constants';
import type { ChapterMetadata, EpisodeData } from './types';
import { buildNarratorAttribution, resolveVoice, VOICE_GENDERS, type EnglishDialect } from './voice';

// Content
import { extractContent, fetchWebpage, filterContentWithAI } from './content';

// AI Processing
import {
    enhanceContentForTTS,
    generateSummary,
    processImagesInContent,
    processTablesInContent,
    suggestChapters,
} from './ai';

// Audio
import { synthesizeContent } from './audio';

// Thumbnail
import { generateThumbnail } from './thumbnail';

// Output
import { generateFfmetadata, generateMarkdown, generateRssFeed, updateMasterFeed } from './output';

// Upload
import { uploadToGCS } from './upload';

const fetchLimit = pLimit(FETCH_CONCURRENCY);

void createScript(async () => {
    const url = argv.url as string;
    const voice = resolveVoice(argv.voice);
    const dialect = argv.dialect as EnglishDialect;
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
    const baseSummary = await generateSummary(content);

    // Build narrator attribution and prepend to summary
    const narrator = buildNarratorAttribution(voice, dialect);
    const summary = `${narrator}. ${baseSummary}`;

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
    for (let i = 0; i < chapterAudios.length; i++) {
        const audio = chapterAudios[i];
        const filename = `${String(i + 1).padStart(2, '0')}-${audio.title.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase()}.mp3`;
        const filepath = path.join(outputDir, filename);
        await Bun.write(filepath, audio.audioBuffer);
        console.log(chalk.green(`  ✓ ${filename}`));
    }

    // Create combined audio file with embedded chapter metadata (M4A format)
    const combinedBuffer = Buffer.concat(chapterAudios.map(a => a.audioBuffer));
    const tempMp3Path = path.join(outputDir, `${outputBase}.temp.mp3`);
    await Bun.write(tempMp3Path, combinedBuffer);

    // Calculate chapter timestamps
    let currentTime = 0;
    const chapters: ChapterMetadata[] = chapterAudios.map((audio, i) => {
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
    const ffmetadataContent = generateFfmetadata(content, chapters, currentTime, summary, narrator, url);
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
        await rename(tempMp3Path, mp3Path);
    } else {
        // Clean up temp files
        await unlink(tempMp3Path);
        await unlink(ffmetadataPath);
        console.log(chalk.green.bold(`  ✓ ${outputBase}.m4a (combined with chapters)`));
    }

    // Generate chapter metadata JSON file
    const metadataPath = path.join(outputDir, 'chapters.json');
    await Bun.write(metadataPath, JSON.stringify({
        title: content.title,
        author: content.byline,
        narrator,
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
    await generateThumbnail(content, thumbnailPath, url);
    console.log(chalk.green(`  ✓ thumbnail.png`));

    // Step 9: Upload to GCS and generate RSS feed (unless --skip-upload)
    let podcastUrl: string | null = null;
    if (!noUpload) {
        console.log();
        console.log(style.header('Uploading to GCS'));

        const gcsPath = `read-to-me/${titleSlug}`;

        // Upload M4A audio file
        console.log(chalk.gray(`  Uploading audio file...`));
        await uploadToGCS(combinedPath, `${GCS_BUCKET}/${gcsPath}/${outputBase}.m4a`, 'audio/mp4');
        console.log(chalk.green(`  ✓ ${outputBase}.m4a`));

        // Upload thumbnail
        console.log(chalk.gray(`  Uploading thumbnail...`));
        await uploadToGCS(thumbnailPath, `${GCS_BUCKET}/${gcsPath}/thumbnail.png`, 'image/png');
        console.log(chalk.green(`  ✓ thumbnail.png`));

        // Generate and upload RSS feed
        console.log(chalk.gray(`  Generating RSS feed...`));
        const audioUrl = `${GCS_BASE_URL}/${gcsPath}/${outputBase}.m4a`;
        const thumbnailUrl = `${GCS_BASE_URL}/${gcsPath}/thumbnail.png`;

        // Get audio file size for enclosure
        const audioStats = Bun.file(combinedPath).size;

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

        // Upload RSS feed with correct content type
        await uploadToGCS(rssFeedPath, `${GCS_BUCKET}/${gcsPath}/feed.xml`, 'application/rss+xml');
        console.log(chalk.green(`  ✓ feed.xml (uploaded)`));

        // Update master feed with all episodes
        console.log(chalk.gray(`  Updating master feed...`));
        const masterFeedUrl = `${GCS_BASE_URL}/read-to-me/feed.xml`;

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

        // Upload master feed with correct content type
        await uploadToGCS(masterFeedPath, `${GCS_BUCKET}/read-to-me/feed.xml`, 'application/rss+xml');
        console.log(chalk.green(`  ✓ master feed.xml (uploaded)`));

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
