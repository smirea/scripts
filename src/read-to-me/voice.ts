export const ENGLISH_DIALECTS = ['en-AU', 'en-GB', 'en-IN', 'en-US'] as const;
export type EnglishDialect = typeof ENGLISH_DIALECTS[number];

// https://docs.cloud.google.com/text-to-speech/docs/chirp3-hd
export const voices = [
    { name: 'Achernar', gender: 'female', style: 'Soft', description: 'Gentle, calm, and approachable.' },
    { name: 'Achird', gender: 'male', style: 'Friendly', description: 'Youthful, engaging, and conversational.' },
    { name: 'Algenib', gender: 'male', style: 'Gravelly', description: 'Lower pitch with a textured, raspy quality.' },
    { name: 'Algieba', gender: 'male', style: 'Smooth', description: 'Pleasant, polished, and easy on the ears.' },
    { name: 'Alnilam', gender: 'male', style: 'Firm', description: 'Strong, grounded, and authoritative.' },
    { name: 'Aoede', gender: 'female', style: 'Breezy', description: 'Natural, lighthearted, and airy.' },
    { name: 'Autonoe', gender: 'female', style: 'Bright', description: 'Optimistic, clear, and energetic.' },
    { name: 'Callirrhoe', gender: 'female', style: 'Easy-going', description: 'Relaxed, confident, and professional yet casual.' },
    { name: 'Charon', gender: 'male', style: 'Informative', description: 'Deep, resonant, and clear; ideal for narration.' },
    { name: 'Despina', gender: 'female', style: 'Smooth', description: 'Flowing, soft, and trustworthy.' },
    { name: 'Enceladus', gender: 'male', style: 'Breathy', description: 'Soft, airy, and intimate tone.' },
    { name: 'Erinome', gender: 'female', style: 'Clear', description: 'Precise, articulate, and professional.' },
    { name: 'Fenrir', gender: 'male', style: 'Excitable', description: 'Dynamic, enthusiastic, and fast-paced.' },
    { name: 'Gacrux', gender: 'female', style: 'Mature', description: 'Experienced, authoritative, and knowledgeable.' },
    { name: 'Iapetus', gender: 'male', style: 'Clear', description: 'Articulate, "everyman" quality, and distinct.' },
    { name: 'Kore', gender: 'female', style: 'Firm', description: 'Confident, direct, and slightly authoritative.' },
    { name: 'Laomedeia', gender: 'female', style: 'Upbeat', description: 'Lively, inquisitive, and engaging.' },
    { name: 'Leda', gender: 'female', style: 'Youthful', description: 'Energetic, higher pitch, and modern.' },
    { name: 'Orus', gender: 'male', style: 'Firm', description: 'Decisive, deep, and serious.' },
    { name: 'Puck', gender: 'male', style: 'Upbeat', description: 'Energetic, fast, and lively.' },
    { name: 'Pulcherrima', gender: 'female', style: 'Direct', description: 'Forward, expressive, and clear.' },
    { name: 'Rasalgethi', gender: 'male', style: 'Informative', description: 'Professional, neutral, and news-reader style.' },
    { name: 'Sadachbia', gender: 'male', style: 'Lively', description: 'Animated, vibrant, and expressive.' },
    { name: 'Sadaltager', gender: 'male', style: 'Knowledgeable', description: 'Authoritative, expert-like, and steady.' },
    { name: 'Schedar', gender: 'male', style: 'Even', description: 'Balanced, neutral, and steady pace.' },
    { name: 'Sulafat', gender: 'female', style: 'Warm', description: 'Welcoming, friendly, and comforting.' },
    { name: 'Umbriel', gender: 'male', style: 'Easy-going', description: 'Calm, relaxed, and casual.' },
    { name: 'Vindemiatrix', gender: 'female', style: 'Gentle', description: 'Kind, soft, and empathetic.' },
    { name: 'Zephyr', gender: 'female', style: 'Bright', description: 'Cheerful, high energy, and crisp.' },
    { name: 'Zubenelgenubi', gender: 'male', style: 'Casual', description: 'Conversational, informal, and relaxed.' },
] as const;

export type Voice = typeof voices[number]['name'];
export type Gender = typeof voices[number]['gender'];

export const VOICE_NAMES = voices.map(v => v.name) as unknown as readonly Voice[];

export const DEFAULT_VOICE: Voice = 'Callirrhoe';

/**
 * Get the gender for a given voice.
 */
export function getVoiceGender(voice: Voice): Gender {
    return voices.find(v => v.name === voice)!.gender;
}

/**
 * Get voice info by name.
 */
export function getVoiceInfo(voice: Voice) {
    return voices.find(v => v.name === voice)!;
}

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
        return voices[Math.floor(Math.random() * voices.length)].name;
    }
    if (voice === 'random-male') {
        const maleVoices = voices.filter(v => v.gender === 'male');
        return maleVoices[Math.floor(Math.random() * maleVoices.length)].name;
    }
    if (voice === 'random-female') {
        const femaleVoices = voices.filter(v => v.gender === 'female');
        return femaleVoices[Math.floor(Math.random() * femaleVoices.length)].name;
    }
    return voice;
}

/**
 * Print a table of all available voices with their details.
 */
export function printVoicesTable(): void {
    console.log(`\nAvailable voices (default: ${DEFAULT_VOICE}):\n`);
    console.table(
        voices.map(v => ({
            Voice: v.name,
            Gender: v.gender,
            Style: v.style,
            Description: v.description,
        }))
    );
}

// Legacy exports for backward compatibility
export const CHIRP3_VOICES = VOICE_NAMES;
export const VOICE_GENDERS = Object.fromEntries(
    voices.map(v => [v.name, v.gender])
) as Record<Voice, Gender>;
