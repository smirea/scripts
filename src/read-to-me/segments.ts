import type { Chapter, ChapterWithSegments, ContentSegment, ExtractedContent } from './types';

const IMAGE_MARKER_REGEX = /\[Image:\s*([\s\S]*?)\]/g;

export function parseContentIntoSegments(content: string): ContentSegment[] {
    const segments: ContentSegment[] = [];
    let lastIndex = 0;

    const regex = new RegExp(IMAGE_MARKER_REGEX.source, 'g');
    let match;

    while ((match = regex.exec(content)) !== null) {
        // Add text before this image marker
        if (match.index > lastIndex) {
            const textContent = content.slice(lastIndex, match.index).trim();
            if (textContent) {
                segments.push({ type: 'text', content: textContent });
            }
        }

        // Add image segment
        const description = match[1].trim();
        if (description) {
            segments.push({ type: 'image', description });
        }

        lastIndex = regex.lastIndex;
    }

    // Add remaining text after last image
    if (lastIndex < content.length) {
        const textContent = content.slice(lastIndex).trim();
        if (textContent) {
            segments.push({ type: 'text', content: textContent });
        }
    }

    // If no segments found, treat entire content as text
    if (segments.length === 0 && content.trim()) {
        segments.push({ type: 'text', content: content.trim() });
    }

    return segments;
}

export function parseChapterIntoSegments(chapter: Chapter): ChapterWithSegments {
    return {
        title: chapter.title,
        segments: parseContentIntoSegments(chapter.content),
        chapterImageUrl: chapter.chapterImageUrl,
    };
}

export function parseContentWithSegments(content: ExtractedContent): {
    content: ExtractedContent;
    chaptersWithSegments: ChapterWithSegments[];
} {
    const chaptersWithSegments = content.chapters.map(parseChapterIntoSegments);
    return { content, chaptersWithSegments };
}

export function countImageSegments(chapters: ChapterWithSegments[]): number {
    return chapters.reduce(
        (count, chapter) => count + chapter.segments.filter(s => s.type === 'image').length,
        0
    );
}
