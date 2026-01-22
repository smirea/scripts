import chalk from 'chalk';
import path from 'path';
import pLimit from 'p-limit';
import { generateText } from 'ai';
import { withRetry } from '../../utils/retry';
import { claudeSonnetModel } from '../clients';
import { argv } from '../cli';
import { GEMINI_CONCURRENCY, PROMPTS_DIR } from '../constants';
import type { ExtractedContent } from '../types';

const aiLimit = pLimit(GEMINI_CONCURRENCY);

async function loadTtsOptimizerPrompt(): Promise<string> {
    const promptPath = path.join(PROMPTS_DIR, 'tts-optimizer.md');
    const file = Bun.file(promptPath);
    if (!await file.exists()) {
        throw new Error(`TTS optimizer prompt not found at: ${promptPath}`);
    }
    return file.text();
}

async function enhanceChapterForTTS(
    chapterContent: string,
    ttsPrompt: string,
    chapterIndex: number,
): Promise<string> {
    try {
        const result = await withRetry(
            async () => generateText({
                model: claudeSonnetModel,
                prompt: `${ttsPrompt}\n\n**Text to optimize:**\n\n${chapterContent}`,
            }),
            'enhance for TTS'
        );

        let ssmlOutput = result.text.trim();

        // Remove markdown code block wrapping if model added it
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

export async function enhanceContentForTTS(content: ExtractedContent): Promise<ExtractedContent> {
    if (!argv['enhance-speech']) {
        console.log(chalk.gray('Speech enhancement disabled'));
        return content;
    }

    console.log(chalk.blue(`Enhancing ${content.chapters.length} chapters for TTS with Claude Sonnet 4.5 (concurrency: ${GEMINI_CONCURRENCY})...`));

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
        aiLimit(async () => {
            const enhancedContent = await enhanceChapterForTTS(chapter.content, ttsPrompt, i);
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
        .map(({ originalIndex: _, ...chapter }) => chapter);

    const enhancedCount = enhancedChapters.filter(c => c.content.includes('<speak>')).length;
    console.log(chalk.green(`  Enhanced ${enhancedCount}/${total} chapters with SSML`));

    return { ...content, chapters: enhancedChapters };
}
