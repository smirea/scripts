import { afterEach, expect, test } from 'bun:test';
import { MacroFactorApi } from './macrofactorApi';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function respond(handler: (url: string, init?: RequestInit) => Response) {
  globalThis.fetch = (async (url, init) => handler(String(url), init)) as typeof fetch;
}

test('signs in, saves the refresh token, and decodes unordered found/missing documents', async () => {
  const saved: string[] = [];
  respond((url, init) => {
    if (url.includes('signInWithPassword')) {
      expect(JSON.parse(String(init?.body))).toEqual({ email: 'user@example.test', password: 'password:with:colons', returnSecureToken: true });
      return Response.json({ idToken: 'id-token', refreshToken: 'refresh-token', localId: 'user', expiresIn: '3600' });
    }
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer id-token');
    const { documents } = JSON.parse(String(init?.body));
    expect(documents).toHaveLength(2);
    return Response.json([
      { missing: documents[1] },
      { found: { name: documents[0], fields: {
        food: { mapValue: { fields: { calories: { doubleValue: 12.5 }, count: { integerValue: '2' }, name: { stringValue: 'meal' } } } },
        values: { arrayValue: { values: [{ booleanValue: true }, { nullValue: null }] } },
        empty: { mapValue: {} },
      } } },
    ]);
  });
  const api = await MacroFactorApi.connect({ apiKey: 'key', credentials: 'user@example.test:password:with:colons', saveRefreshToken: token => { saved.push(token); } });
  const docs = await api.getDocuments(['food/2026-05-01', 'food/2026-05-02', 'food/2026-05-01']);
  expect(saved).toEqual(['refresh-token']);
  expect(docs.size).toBe(1);
  expect(docs.get('food/2026-05-01')).toEqual({ food: { calories: 12.5, count: 2, name: 'meal' }, values: [true, null], empty: {} });
});

test('uses a saved session without password sign-in and persists rotated refresh tokens', async () => {
  const saved: string[] = [];
  let refreshes = 0;
  respond((url, init) => {
    if (url.includes('securetoken.googleapis.com')) {
      refreshes++;
      expect(new URLSearchParams(String(init?.body)).get('refresh_token')).toBe(refreshes === 1 ? 'saved' : 'rotated-1');
      return Response.json({ id_token: `id-${refreshes}`, refresh_token: `rotated-${refreshes}`, user_id: 'user', expires_in: refreshes === 1 ? '30' : '3600' });
    }
    expect(url).toContain(':batchGet');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer id-2');
    return Response.json(JSON.parse(String(init?.body)).documents.map((missing: string) => ({ missing })));
  });
  const api = await MacroFactorApi.connect({ apiKey: 'key', credentials: '', refreshToken: 'saved', saveRefreshToken: token => { saved.push(token); } });
  await api.getDocuments(['food/2026-05-01']);
  expect(saved).toEqual(['rotated-1', 'rotated-2']);
});

test('reports App Check failures without exposing response bodies or saving a failed session', async () => {
  respond(() => Response.json({ error: { message: 'Firebase App Check token is invalid. sensitive-value' } }, { status: 401 }));
  let saved = false;
  const failure = MacroFactorApi.connect({ apiKey: 'key', credentials: 'user@example.test:password', saveRefreshToken: () => { saved = true; } });
  await expect(failure).rejects.toThrow('requires a valid Firebase App Check token');
  await expect(failure).rejects.not.toThrow('sensitive-value');
  expect(saved).toBe(false);
});

test('permission failures and incomplete batches never appear as empty food logs', async () => {
  let mode = 'login';
  respond(() => {
    if (mode === 'login') return Response.json({ idToken: 'id', refreshToken: 'refresh', localId: 'user', expiresIn: '3600' });
    if (mode === 'denied') return Response.json({ error: 'sensitive-value' }, { status: 403 });
    return Response.json([]);
  });
  const api = await MacroFactorApi.connect({ apiKey: 'key', credentials: 'user@example.test:password', saveRefreshToken: () => {} });
  mode = 'denied';
  await expect(api.getDocuments(['food/2026-05-01'])).rejects.toThrow('HTTP 403');
  mode = 'incomplete';
  await expect(api.getDocuments(['food/2026-05-01'])).rejects.toThrow('incomplete document batch');
});

test('large ranges use bounded document batches and network errors redact request URLs', async () => {
  const sizes: number[] = [];
  respond((url, init) => {
    if (url.includes('signInWithPassword')) return Response.json({ idToken: 'id', refreshToken: 'refresh', localId: 'user', expiresIn: '3600' });
    const { documents } = JSON.parse(String(init?.body));
    sizes.push(documents.length);
    return Response.json(documents.map((missing: string) => ({ missing })));
  });
  const api = await MacroFactorApi.connect({ apiKey: 'sensitive-key', credentials: 'user@example.test:password', saveRefreshToken: () => {} });
  await api.getDocuments(Array.from({ length: 205 }, (_, index) => `customFoods/${index}`));
  expect(sizes).toEqual([100, 100, 5]);
  respond(url => { throw new Error(url); });
  await expect(MacroFactorApi.connect({ apiKey: 'sensitive-key', credentials: 'user@example.test:password', saveRefreshToken: () => {} })).rejects.toThrow('MacroFactor network request failed or timed out.');
});
