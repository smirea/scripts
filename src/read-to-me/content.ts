import chalk from 'chalk';
import path from 'path';
import pLimit from 'p-limit';
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';
import { fetchWithUA } from '../utils/fetch';
import { withRetry } from '../utils/retry';
import { geminiTextClient } from './clients';
import { GEMINI_CONCURRENCY, MD_IMAGE_REGEX, PROMPTS_DIR } from './constants';
import type { Chapter, ExtractedContent, TableData } from './types';

const geminiLimit = pLimit(GEMINI_CONCURRENCY);

// =============================================================================
// Content Extraction
// =============================================================================

export function extractImagesFromMarkdown(content: string): string[] {
    const images: string[] = [];
    let match;
    const regex = new RegExp(MD_IMAGE_REGEX.source, 'g');
    while ((match = regex.exec(content)) !== null) {
        images.push(match[1]);
    }
    return images;
}

export async function fetchWebpage(url: string): Promise<string> {
    console.log(chalk.blue('Fetching webpage...'));
    const response = await fetchWithUA(url);
    if (!response.ok) {
        throw new Error(`Failed to fetch: ${response.status} ${response.statusText}`);
    }
    return response.text();
}

export function extractContent(html: string, url: string): ExtractedContent {
    console.log(chalk.blue('Extracting main content...'));

    const { document } = parseHTML(html);
    const reader = new Readability(document as any, { charThreshold: 100 });
    const article = reader.parse();

    if (!article || !article.content) {
        throw new Error('Failed to extract article content');
    }

    const articleContent = article.content;
    const articleTitle = article.title || 'Untitled';
    const articleByline = article.byline ?? null;

    const turndown = new TurndownService({
        headingStyle: 'atx',
        codeBlockStyle: 'fenced',
    });

    const markdown = turndown.turndown(articleContent);

    // Extract images from the original content
    const imgRegex = /<img[^>]+src=["']([^"']+)["']/gi;
    const allImages: string[] = [];
    let match;
    while ((match = imgRegex.exec(articleContent)) !== null) {
        const imgUrl = new URL(match[1], url).href;
        allImages.push(imgUrl);
    }

    // Extract tables from the original HTML content
    const tableRegex = /<table[\s\S]*?<\/table>/gi;
    const allTables: TableData[] = [];
    let tableMatch;
    while ((tableMatch = tableRegex.exec(articleContent)) !== null) {
        const tableHtml = tableMatch[0];
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

    if (chapters.length === 0) {
        chapters.push({
            title: articleTitle || 'Content',
            content: markdown,
            images: allImages,
        });
    }

    console.log(chalk.green(`  Extracted ${chapters.length} chapter(s)`));
    console.log(chalk.green(`  Found ${allImages.length} image(s)`));
    console.log(chalk.green(`  Found ${allTables.length} table(s)`));

    return {
        title: articleTitle,
        byline: articleByline,
        chapters,
        allImages,
        allTables,
    };
}

// =============================================================================
// Content Filtering
// =============================================================================

async function loadPrompt(filename: string): Promise<string> {
    const promptPath = path.join(PROMPTS_DIR, filename);
    const file = Bun.file(promptPath);
    if (!await file.exists()) {
        throw new Error(`Prompt not found at: ${promptPath}`);
    }
    return file.text();
}

async function filterChapterContent(chapter: Chapter): Promise<Chapter> {
    if (!geminiTextClient) {
        return chapter;
    }

    if (chapter.content.length < 200) {
        return chapter;
    }

    try {
        const prompt = await loadPrompt('content-filter.md');
        const model = geminiTextClient.getGenerativeModel({ model: 'gemini-2.0-flash' });
        const result = await withRetry(
            () => model.generateContent([
                prompt,
                `\n\nCONTENT TO FILTER:\n---\n${chapter.content}\n---`,
            ]),
            'filter chapter'
        );

        let filteredContent = result.response.text().trim();
        filteredContent = filteredContent.replace(/^```(?:markdown)?\n?/, '').replace(/\n?```$/, '');

        if (filteredContent === 'EMPTY_CHAPTER' || filteredContent.length < 10) {
            console.log(chalk.yellow(`    → Chapter filtered out (non-article content)`));
            return { ...chapter, content: '' };
        }

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

export async function filterContentWithAI(content: ExtractedContent): Promise<ExtractedContent> {
    if (!geminiTextClient) {
        console.log(chalk.yellow('Skipping content filtering (no GEMINI_API_KEY)'));
        return content;
    }

    console.log(chalk.blue(`Filtering ${content.chapters.length} chapters to remove ads/comments (concurrency: ${GEMINI_CONCURRENCY})...`));

    let completed = 0;
    const total = content.chapters.length;

    const filterPromises = content.chapters.map((chapter, i) =>
        geminiLimit(async () => {
            const filteredChapter = await filterChapterContent(chapter);
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

    const filteredChapters = results
        .sort((a, b) => a.originalIndex - b.originalIndex)
        .filter(r => r.hasContent)
        .map(r => r.filteredChapter);

    if (filteredChapters.length === 0 && content.chapters.length > 0) {
        console.log(chalk.yellow('  Warning: All chapters filtered, keeping first chapter'));
        filteredChapters.push(content.chapters[0]);
    }

    console.log(chalk.green(`  Kept ${filteredChapters.length}/${content.chapters.length} chapters after filtering`));

    return { ...content, chapters: filteredChapters };
}
