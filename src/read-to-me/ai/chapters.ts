import chalk from 'chalk';
import path from 'path';
import { withRetry } from '../../utils/retry';
import { geminiTextClient } from '../clients';
import { PROMPTS_DIR } from '../constants';
import { extractImagesFromMarkdown } from '../content';
import type { Chapter, ExtractedContent } from '../types';

async function loadPrompt(): Promise<string> {
    const promptPath = path.join(PROMPTS_DIR, 'chapter-suggestion.md');
    const file = Bun.file(promptPath);
    if (!await file.exists()) {
        throw new Error(`Chapter suggestion prompt not found at: ${promptPath}`);
    }
    return file.text();
}

export async function suggestChapters(content: ExtractedContent): Promise<ExtractedContent> {
    if (!geminiTextClient) {
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
        const prompt = await loadPrompt();
        const model = geminiTextClient.getGenerativeModel({ model: 'gemini-2.0-flash' });
        const result = await withRetry(
            () => model.generateContent([
                prompt,
                `\n\nCONTENT TO ANALYZE:\n---\n${fullContent}\n---`,
            ]),
            'suggest chapters'
        );

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
