/**
 * Format milliseconds to HH:MM:SS string.
 */
export function formatMs(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    return `${hours}:${String(minutes % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * Parse HH:MM:SS time string to milliseconds.
 */
export function parseTimeToMs(timeStr: string): number {
    const parts = timeStr.split(':').map(Number);
    if (parts.length !== 3) return 0;
    return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
}
