import chalk from 'chalk';
import path from 'path';
import { withRetry } from '../../utils/retry';
import { geminiTextClient } from '../clients';
import { PROMPTS_DIR } from '../constants';
import type { ExtractedContent } from '../types';

async function loadPrompt(): Promise<string> {
    const promptPath = path.join(PROMPTS_DIR, 'summary.md');
    const file = Bun.file(promptPath);
    if (!await file.exists()) {
        throw new Error(`Summary prompt not found at: ${promptPath}`);
    }
    return file.text();
}

export async function generateSummary(content: ExtractedContent): Promise<string> {
    if (!geminiTextClient) {
        return `Audio version of "${content.title}"`;
    }

    console.log(chalk.blue('Generating article summary...'));

    try {
        const prompt = await loadPrompt();
        const model = geminiTextClient.getGenerativeModel({ model: 'gemini-2.0-flash' });
        const fullContent = content.chapters.map(c => c.content).join('\n\n').slice(0, 4000);

        const result = await withRetry(
            () => model.generateContent([
                prompt,
                `\n\nArticle title: ${content.title}\n${content.byline ? `Author: ${content.byline}` : ''}\n\nContent:\n${fullContent}`,
            ]),
            'generate summary'
        );

        const summary = result.response.text().trim();
        console.log(chalk.green(`  Summary: ${summary.slice(0, 80)}...`));
        return summary;
    } catch (err) {
        console.log(chalk.yellow(`  Summary generation failed: ${(err as Error).message}`));
        return `Audio version of "${content.title}"`;
    }
}
