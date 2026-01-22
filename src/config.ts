import { envSafe, string } from 'envsafe-lite';

export const env = envSafe({
    ANTHROPIC_API_KEY: string(),
    GEMINI_API_KEY: string(),
    GCS_BUCKET: string(),
    HOME: string(),
});

export const GCS_BASE_URL = `https://storage.googleapis.com/${env.GCS_BUCKET}`;
