import chalk from 'chalk';
import path from 'path';
import pLimit from 'p-limit';
import { generateText } from 'ai';
import { withRetry } from '../../utils/retry';
import { geminiFlashModel } from '../clients';
import { GEMINI_CONCURRENCY, PROMPTS_DIR } from '../constants';
import type { ExtractedContent } from '../types';

const aiLimit = pLimit(GEMINI_CONCURRENCY);

async function loadPrompt(): Promise<string> {
    const promptPath = path.join(PROMPTS_DIR, 'table-description.md');
    const file = Bun.file(promptPath);
    if (!await file.exists()) {
        throw new Error(`Table description prompt not found at: ${promptPath}`);
    }
    return file.text();
}

async function describeTable(tableHtml: string): Promise<string | null> {
    try {
        const prompt = await loadPrompt();
        const result = await withRetry(
            async () => generateText({
                model: geminiFlashModel,
                prompt: `${prompt}\n\nHTML TABLE:\n${tableHtml}`,
            }),
            'describe table'
        );
        return result.text.trim();
    } catch (err) {
        console.log(chalk.yellow(`  Error describing table: ${(err as Error).message}`));
        return null;
    }
}

export async function processTablesInContent(content: ExtractedContent): Promise<ExtractedContent> {
    if (content.allTables.length === 0) {
        return content;
    }

    console.log(chalk.blue(`Processing ${content.allTables.length} table(s) with Gemini 3 Flash (concurrency: ${GEMINI_CONCURRENCY})...`));

    const tableResults: Array<{ cells: string[]; description: string }> = [];
    let completed = 0;
    const total = content.allTables.length;

    // Process tables in parallel with concurrency limit
    const descriptionPromises = content.allTables.map((table) =>
        aiLimit(async () => {
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
