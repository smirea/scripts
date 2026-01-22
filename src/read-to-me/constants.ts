import path from 'path';
import { env, GCS_BASE_URL as _GCS_BASE_URL } from '../config';

// Concurrency limits
export const GEMINI_CONCURRENCY = 5;
export const TTS_CONCURRENCY = 5;
export const FETCH_CONCURRENCY = 10;

// GCS configuration
export const GCS_BUCKET = env.GCS_BUCKET;
export const GCS_BASE_URL = _GCS_BASE_URL;

// Retry configuration
export const API_RETRY_COUNT = 1;

// Thumbnail configuration
export const THUMBNAIL_SIZE = 1400;
export const THUMBNAIL_BORDER_WIDTH = 40;
export const THUMBNAIL_BORDER_COLOR = '#1E90FF';
export const THUMBNAIL_TAG_COLOR = '#FFFFFF';
export const FAVICON_SIZE = 64;
export const FAVICON_BORDER_WIDTH = 4;
export const FAVICON_PADDING = 15;

// Regex patterns
export const MD_IMAGE_REGEX = /!\[.*?\]\(([^)]+)\)/g;

// Cache configuration
export const IMAGE_CACHE_DIR = path.join(process.cwd(), '.cache', 'read-to-me', 'images');
export const THUMBNAIL_CACHE_DIR = path.join(process.cwd(), '.cache', 'read-to-me', 'thumbnails');
export const IMAGE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 1 week

// Prompt paths (relative to this module)
export const PROMPTS_DIR = path.join(import.meta.dir, 'prompts');
