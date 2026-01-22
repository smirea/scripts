import chalk from 'chalk';
import pLimit from 'p-limit';
import { withRetry } from '../utils/retry';
import { ttsClient } from './clients';
import { TTS_CONCURRENCY } from './constants';
import type { Chapter, ChapterAudio, ExtractedContent } from './types';
import type { EnglishDialect, Voice } from './voice';

const ttsLimit = pLimit(TTS_CONCURRENCY);

// =============================================================================
// Text Chunking
// =============================================================================

/**
 * Clean up markdown for TTS (remove links, code blocks, etc.)
 */
function cleanTextForTTS(content: string): string {
    return content
        .replace(/```[\s\S]*?```/g, '') // Remove code blocks
        .replace(/`[^`]+`/g, '') // Remove inline code
        // Replace markdown links with link text (handles nested parens in URLs)
        .replace(/\[([^\]]*)\]\((?:[^()]*|\([^()]*\))*\)/g, '$1')
        .replace(/\[\]\s*/g, '') // Remove any remaining empty brackets
        .replace(/<https?:\/\/[^>]+>/g, '') // Remove autolinks <url>
        .replace(/https?:\/\/[^\s<>[\]"']+/g, '') // Remove bare URLs
        .replace(/\s+([.,!?;:])/g, '$1') // Clean up spaces before punctuation
        .replace(/[#*_~]/g, '') // Remove markdown formatting
        .replace(/\n{3,}/g, '\n\n') // Normalize multiple newlines
        .replace(/  +/g, ' ') // Normalize multiple spaces
        .trim();
}

/**
 * Split text into chunks suitable for TTS API (max ~4500 bytes per chunk).
 */
function splitTextIntoChunks(text: string): string[] {
    const MAX_BYTES = 4500;
    const MAX_SENTENCE_LENGTH = 300;
    const chunks: string[] = [];
    let currentChunk = '';

    // Function to split long text at natural break points
    function splitLongText(text: string, maxLen: number): string[] {
        const result: string[] = [];
        const parts = text.split(/(?<=[,;:)\]])\s+/);

        for (const part of parts) {
            if (part.length <= maxLen) {
                result.push(part);
            } else {
                const words = part.split(/\s+/);
                let current = '';
                for (const word of words) {
                    if ((current + ' ' + word).length <= maxLen) {
                        current = current ? current + ' ' + word : word;
                    } else {
                        if (current) result.push(current + '.');
                        current = word;
                    }
                }
                if (current) result.push(current);
            }
        }
        return result;
    }

    const sentences = text.split(/(?<=[.!?])\s+/);
    const processedSentences: string[] = [];

    for (const sentence of sentences) {
        if (sentence.length <= MAX_SENTENCE_LENGTH) {
            processedSentences.push(sentence);
        } else {
            processedSentences.push(...splitLongText(sentence, MAX_SENTENCE_LENGTH));
        }
    }

    for (const sentence of processedSentences) {
        if (Buffer.byteLength(currentChunk + sentence, 'utf-8') > MAX_BYTES) {
            if (currentChunk) chunks.push(currentChunk.trim());
            currentChunk = sentence;
        } else {
            currentChunk += ' ' + sentence;
        }
    }
    if (currentChunk.trim()) chunks.push(currentChunk.trim());

    return chunks;
}

/**
 * Split SSML content into chunks suitable for TTS API.
 */
function splitSsmlIntoChunks(ssml: string): string[] {
    const MAX_BYTES = 4500;
    const chunks: string[] = [];

    // Extract content between <speak> tags
    const speakMatch = ssml.match(/<speak>([\s\S]*)<\/speak>/);
    if (!speakMatch) {
        return splitTextIntoChunks(ssml);
    }

    const innerContent = speakMatch[1];
    const paragraphs = innerContent.split(/<\/p>\s*/);

    let currentChunk = '';
    for (const para of paragraphs) {
        const paraWithClose = para.includes('<p>') ? para + '</p>' : para;
        const wrappedPara = `<speak>${paraWithClose}</speak>`;

        if (Buffer.byteLength(wrappedPara, 'utf-8') > MAX_BYTES) {
            const sentences = para.split(/<\/s>\s*/);
            for (const sent of sentences) {
                const sentWithClose = sent.includes('<s>') ? sent + '</s>' : sent;
                const wrappedSent = `<speak>${sentWithClose}</speak>`;

                if (Buffer.byteLength(wrappedSent, 'utf-8') > MAX_BYTES) {
                    const plainText = sent.replace(/<[^>]+>/g, '').trim();
                    const textChunks = splitTextIntoChunks(plainText);
                    for (const textChunk of textChunks) {
                        if (currentChunk) {
                            chunks.push(`<speak>${currentChunk}</speak>`);
                            currentChunk = '';
                        }
                        chunks.push(textChunk);
                    }
                } else if (Buffer.byteLength(`<speak>${currentChunk}${sentWithClose}</speak>`, 'utf-8') > MAX_BYTES) {
                    if (currentChunk) chunks.push(`<speak>${currentChunk}</speak>`);
                    currentChunk = sentWithClose;
                } else {
                    currentChunk += sentWithClose;
                }
            }
        } else if (Buffer.byteLength(`<speak>${currentChunk}${paraWithClose}</speak>`, 'utf-8') > MAX_BYTES) {
            if (currentChunk) chunks.push(`<speak>${currentChunk}</speak>`);
            currentChunk = paraWithClose;
        } else {
            currentChunk += paraWithClose;
        }
    }

    if (currentChunk.trim()) {
        chunks.push(`<speak>${currentChunk}</speak>`);
    }

    if (chunks.length === 0) {
        chunks.push(ssml);
    }

    return chunks;
}

// =============================================================================
// Audio Synthesis
// =============================================================================

async function synthesizeChapter(
    chapter: Chapter,
    voice: Voice,
    dialect: EnglishDialect,
    chapterIndex: number,
    totalChapters: number,
): Promise<ChapterAudio> {
    console.log(chalk.gray(`  [${chapterIndex + 1}/${totalChapters}] Synthesizing: ${chapter.title}`));

    const isSSML = chapter.content.includes('<speak>');

    let chunks: string[];
    if (isSSML) {
        chunks = splitSsmlIntoChunks(chapter.content);
    } else {
        const text = cleanTextForTTS(chapter.content);
        chunks = splitTextIntoChunks(text);
    }

    const audioPromises = chunks.map((chunk, chunkIndex) =>
        ttsLimit(async () => {
            const chunkIsSSML = chunk.startsWith('<speak>');

            const [response] = await withRetry(
                () => ttsClient.synthesizeSpeech({
                    input: chunkIsSSML ? { ssml: chunk } : { text: chunk },
                    voice: {
                        languageCode: dialect,
                        name: `${dialect}-Chirp3-HD-${voice}`,
                    },
                    audioConfig: {
                        audioEncoding: 'MP3',
                        speakingRate: 1.0,
                    },
                }),
                'TTS synthesis'
            );

            return {
                index: chunkIndex,
                buffer: response.audioContent ? Buffer.from(response.audioContent as Uint8Array) : null,
            };
        })
    );

    const results = await Promise.all(audioPromises);

    const audioBuffers = results
        .sort((a, b) => a.index - b.index)
        .filter(r => r.buffer !== null)
        .map(r => r.buffer as Buffer);

    const audioBuffer = Buffer.concat(audioBuffers);
    const durationMs = Math.round((audioBuffer.length / 3000) * 1000);

    const ssmlTag = isSSML ? chalk.cyan(' [SSML]') : '';
    console.log(chalk.green(`    → ${(audioBuffer.length / 1024).toFixed(1)} KB, ~${(durationMs / 1000).toFixed(1)}s${ssmlTag}`));

    return {
        title: chapter.title,
        audioBuffer,
        durationMs,
    };
}

export async function synthesizeContent(
    content: ExtractedContent,
    voice: Voice,
    dialect: EnglishDialect,
): Promise<ChapterAudio[]> {
    console.log(chalk.blue(`Synthesizing ${content.chapters.length} chapters with ${voice} voice (concurrency: ${TTS_CONCURRENCY})...`));

    const results: Array<{ index: number; audio: ChapterAudio }> = [];
    for (let i = 0; i < content.chapters.length; i++) {
        const chapter = content.chapters[i];
        const audio = await synthesizeChapter(
            chapter,
            voice,
            dialect,
            i,
            content.chapters.length,
        );
        results.push({ index: i, audio });
    }

    return results.map(r => r.audio);
}
