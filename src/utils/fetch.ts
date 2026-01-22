const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

/**
 * Fetch a URL with a standard browser User-Agent header.
 */
export async function fetchWithUA(url: string): Promise<Response> {
    return fetch(url, { headers: { 'User-Agent': USER_AGENT } });
}
