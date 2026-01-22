export const ENGLISH_DIALECTS = ['en-AU', 'en-GB', 'en-IN', 'en-US'] as const;
export type EnglishDialect = typeof ENGLISH_DIALECTS[number];

export const CHIRP3_VOICES = ['Aoede', 'Charon', 'Fenrir', 'Kore', 'Leda', 'Orus', 'Puck', 'Zephyr'] as const;
export type Voice = typeof CHIRP3_VOICES[number];

export const VOICE_GENDERS: Record<Voice, 'male' | 'female'> = {
    Aoede: 'female',
    Charon: 'male',
    Fenrir: 'male',
    Kore: 'female',
    Leda: 'female',
    Orus: 'male',
    Puck: 'male',
    Zephyr: 'female',
};

/**
 * Build narrator attribution string.
 * Format: "Read by Google Chirp 3: Zephyr en-GB"
 */
export function buildNarratorAttribution(voice: Voice, dialect: EnglishDialect): string {
    return `Read by Google Chirp 3: ${voice} ${dialect}`;
}

export type VoiceOption = Voice | 'random' | 'random-male' | 'random-female';

/**
 * Resolve a voice option to a specific voice.
 * Handles random selection for 'random', 'random-male', 'random-female'.
 */
export function resolveVoice(voice: VoiceOption): Voice {
    if (voice === 'random') {
        return CHIRP3_VOICES[Math.floor(Math.random() * CHIRP3_VOICES.length)];
    }
    if (voice === 'random-male') {
        const maleVoices = CHIRP3_VOICES.filter(v => VOICE_GENDERS[v] === 'male');
        return maleVoices[Math.floor(Math.random() * maleVoices.length)];
    }
    if (voice === 'random-female') {
        const femaleVoices = CHIRP3_VOICES.filter(v => VOICE_GENDERS[v] === 'female');
        return femaleVoices[Math.floor(Math.random() * femaleVoices.length)];
    }
    return voice;
}
