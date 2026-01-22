import { envSafe, string } from 'envsafe-lite';

export const env = envSafe({
    GEMINI_API_KEY: string({ allowEmpty: true, default: '' }),
    GCS_BUCKET: string({ default: 'stefan-rss-feed' }),
    GCS_BASE_URL: string({ default: '' }),
    HOME: string(),
});

export const GCS_BASE_URL = env.GCS_BASE_URL || `https://storage.googleapis.com/${env.GCS_BUCKET}`;
