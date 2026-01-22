export interface Chapter {
    title: string;
    content: string;
    images: string[];
    chapterImageUrl?: string;
}

export interface ImageDescription {
    url: string;
    description: string;
    context?: string;
}

export type ContentSegment =
    | { type: 'text'; content: string }
    | { type: 'image'; description: string };

export interface ChapterWithSegments {
    title: string;
    segments: ContentSegment[];
    chapterImageUrl?: string;
}

export interface TableData {
    html: string;
    cells: string[];
}

export interface ExtractedContent {
    title: string;
    byline: string | null;
    chapters: Chapter[];
    allImages: string[];
    allTables: TableData[];
}

export interface ChapterAudio {
    title: string;
    audioBuffer: Buffer;
    durationMs: number;
}

export interface ChapterMetadata {
    index: number;
    title: string;
    startMs: number;
    endMs: number;
    startFormatted: string;
}

export interface EpisodeData {
    title: string;
    author: string;
    summary: string;
    sourceUrl: string;
    audioUrl: string;
    thumbnailUrl: string;
    audioSizeBytes: number;
    durationMs: number;
    pubDate: string;
    chapters: Array<{ title: string; startMs: number; imageUrl?: string }>;
}

export type ImageDescriptionResult =
    | { type: 'description'; text: string }
    | { type: 'skipped'; reason: 'stock_photo' | 'fetch_error' | 'no_api_key' | 'api_error' };

export interface ImageDescriptionResultWithCache {
    result: ImageDescriptionResult;
    fromCache: boolean;
}

export interface ImageCacheEntry {
    result: ImageDescriptionResult;
    expiresAt: number;
    promptHash: string;
}

export interface ThumbnailCacheMetadata {
    expiresAt: number;
    sourceUrl: string;
    contentHash: string;
}

export interface RssFeedOptions {
    title: string;
    author: string;
    summary: string;
    sourceUrl: string;
    audioUrl: string;
    thumbnailUrl: string;
    audioSizeBytes: number;
    durationMs: number;
    chapters: Array<{ title: string; startMs: number; imageUrl?: string }>;
    chaptersJsonUrl?: string;
}
