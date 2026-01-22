import { Storage } from '@google-cloud/storage';
import { TextToSpeechClient } from '@google-cloud/text-to-speech';
import { GoogleGenAI } from '@google/genai';
import { anthropic } from '@ai-sdk/anthropic';
import { google } from '@ai-sdk/google';
import { env } from '../config';

/** Claude Sonnet 4.5 model for TTS enhancement */
export const claudeSonnetModel = anthropic('claude-sonnet-4-5');

/** Gemini 3 Flash model for image description, chapters, tables, summary, content filtering */
export const geminiFlashModel = google('gemini-3-flash');

/** Gemini client for image generation (Gemini 2.5 Flash Image) */
export const geminiImageGenClient = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });

/** Google Cloud Text-to-Speech client */
export const ttsClient = new TextToSpeechClient();

/** Google Cloud Storage client */
export const gcsClient = new Storage();
