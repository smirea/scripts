import { Storage } from '@google-cloud/storage';
import { TextToSpeechClient } from '@google-cloud/text-to-speech';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { GoogleGenAI } from '@google/genai';
import { env } from '../config';

export const GEMINI_API_KEY = env.GEMINI_API_KEY || null;

/** Gemini client for text/image analysis (vision, summarization, content filtering) */
export const geminiTextClient = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;

/** Gemini client for image generation (Gemini 2.5 Flash Image) */
export const geminiImageGenClient = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;

/** Google Cloud Text-to-Speech client */
export const ttsClient = new TextToSpeechClient();

/** Google Cloud Storage client */
export const gcsClient = new Storage();
