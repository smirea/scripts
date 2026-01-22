import { envsafe, str } from 'envsafe-lite';

export const env = envsafe({
    GEMINI_API_KEY: str({ allowEmpty: true, default: '' }),
    GCS_BUCKET: str({ default: 'stefan-rss-feed' }),
    GCS_BASE_URL: str({ default: '' }),
    HOME: str(),
});

export const GCS_BASE_URL = env.GCS_BASE_URL || `https://storage.googleapis.com/${env.GCS_BUCKET}`;
