import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '../..');
const DOCUMENTS = 'projects/sbs-diet-app/databases/(default)/documents';
const BUNDLE_ID = 'com.sbs.diet';

export function saveMacroFactorEnv(key: 'MACROFACTOR_API_KEY' | 'MACROFACTOR_REFRESH_TOKEN', value: string): void {
  if (!/^[A-Za-z0-9_.:/+=-]+$/.test(value)) throw new Error(`Unexpected characters in ${key}.`);
  const file = path.join(ROOT, '.env.local');
  const content = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const pattern = new RegExp(`^[ \\t]*${key}[ \\t]*=.*$`, 'm');
  const assignment = `${key}=${value}`;
  const updated = pattern.test(content) ? content.replace(pattern, () => assignment) : `${content.trimEnd()}\n${assignment}\n`;
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, updated, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, file);
}

export function extractMacroFactorApiKey(): string {
  const result = spawnSync('plutil', ['-convert', 'json', '-o', '-',
    '/Applications/MacroFactor.app/Wrapper/Runner.app/GoogleService-Info.plist'], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error('Cannot read MacroFactor app configuration. Install the app for initial setup, or configure MACROFACTOR_API_KEY in env-manager.');
  }
  const config = JSON.parse(result.stdout);
  if (config.PROJECT_ID !== 'sbs-diet-app' || config.BUNDLE_ID !== BUNDLE_ID || typeof config.API_KEY !== 'string') {
    throw new Error('Unexpected MacroFactor Firebase configuration.');
  }
  saveMacroFactorEnv('MACROFACTOR_API_KEY', config.API_KEY);
  return config.API_KEY;
}

interface AuthOptions {
  apiKey: string;
  credentials: string;
  refreshToken?: string;
  saveRefreshToken: (token: string) => void;
}

export class MacroFactorApi {
  private token = '';
  private expiresAt = 0;
  private refreshToken?: string;
  userId = '';

  private constructor(private readonly options: AuthOptions) {
    this.refreshToken = options.refreshToken;
  }

  static async connect(options: AuthOptions): Promise<MacroFactorApi> {
    const client = new MacroFactorApi(options);
    await client.authenticate();
    return client;
  }

  private async authenticate(): Promise<void> {
    const refresh = this.refreshToken;
    const separator = this.options.credentials.indexOf(':');
    if (!refresh && (separator < 1 || separator === this.options.credentials.length - 1)) {
      throw new Error('Set MACROFACTOR_CREDENTIALS to <email>:<password> in env-manager, or provide MACROFACTOR_REFRESH_TOKEN.');
    }
    const response = await request(refresh
      ? `https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(this.options.apiKey)}`
      : `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(this.options.apiKey)}`, {
      method: 'POST',
      headers: {
        'Content-Type': refresh ? 'application/x-www-form-urlencoded' : 'application/json',
        'X-Ios-Bundle-Identifier': BUNDLE_ID,
      },
      body: refresh
        ? new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh })
        : JSON.stringify({ email: this.options.credentials.slice(0, separator), password: this.options.credentials.slice(separator + 1), returnSecureToken: true }),
      signal: AbortSignal.timeout(30_000),
    });
    await checkResponse(response, 'authentication');
    const data = await response.json() as Record<string, string>;
    const token = refresh ? data.id_token : data.idToken;
    const nextRefresh = refresh ? data.refresh_token : data.refreshToken;
    const userId = refresh ? data.user_id : data.localId;
    const expiresIn = Number(refresh ? data.expires_in : data.expiresIn);
    if (!token || !nextRefresh || !userId || !Number.isFinite(expiresIn) || expiresIn <= 0) {
      throw new Error('MacroFactor authentication returned an incomplete session.');
    }
    if (nextRefresh !== this.refreshToken) this.options.saveRefreshToken(nextRefresh);
    this.token = token;
    this.refreshToken = nextRefresh;
    this.userId = userId;
    this.expiresAt = Date.now() + expiresIn * 1000;
  }

  async getDocuments(suffixes: string[]): Promise<Map<string, Record<string, unknown>>> {
    const documents = new Map<string, Record<string, unknown>>();
    const unique = [...new Set(suffixes)];
    for (let offset = 0; offset < unique.length; offset += 100) {
      if (this.expiresAt - Date.now() < 60_000) await this.authenticate();
      const prefix = `${DOCUMENTS}/users/${this.userId}/`;
      const requested = new Set(unique.slice(offset, offset + 100).map(suffix => prefix + suffix));
      const response = await request(`https://firestore.googleapis.com/v1/${DOCUMENTS}:batchGet`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ documents: [...requested] }),
        signal: AbortSignal.timeout(30_000),
      });
      await checkResponse(response, 'document read');
      const results = await response.json() as { found?: { name: string; fields?: Record<string, unknown> }; missing?: string }[];
      for (const result of results) {
        const name = result.found?.name ?? result.missing;
        if (!name || !requested.delete(name)) throw new Error('Unexpected MacroFactor document response.');
        if (result.found) documents.set(name.slice(prefix.length), decodeFields(result.found.fields ?? {}));
      }
      if (requested.size) throw new Error('MacroFactor returned an incomplete document batch.');
    }
    return documents;
  }
}

async function request(url: string, options: RequestInit): Promise<Response> {
  try {
    return await fetch(url, options);
  } catch {
    throw new Error('MacroFactor network request failed or timed out.');
  }
}

async function checkResponse(response: Response, operation: string): Promise<void> {
  if (response.ok) return;
  const body = await response.text();
  if (/app\s*check/i.test(body)) {
    throw new Error(`MacroFactor ${operation} requires a valid Firebase App Check token. The saved API key and account credentials alone are insufficient. Direct access is unavailable; use --source cache --app auto (or --app none for cached data).`);
  }
  // Never include response bodies: authentication errors can contain credentials or tokens.
  throw new Error(`MacroFactor ${operation} failed (HTTP ${response.status}).${operation === 'authentication' ? ' Check the saved credentials/refresh token in env-manager.' : ''}`);
}

function decodeFields(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, decodeValue(value)]));
}

function decodeValue(value: unknown): unknown {
  const typed = value as Record<string, any>;
  if ('mapValue' in typed) return decodeFields(typed.mapValue.fields ?? {});
  if ('arrayValue' in typed) return (typed.arrayValue.values ?? []).map(decodeValue);
  if ('integerValue' in typed) return Number(typed.integerValue);
  if ('doubleValue' in typed) return Number(typed.doubleValue);
  if ('nullValue' in typed) return null;
  return Object.values(typed)[0];
}

export async function connectMacroFactor(): Promise<MacroFactorApi> {
  const { default: env } = await import('../env');
  return MacroFactorApi.connect({
    apiKey: env.MACROFACTOR_API_KEY || extractMacroFactorApiKey(),
    credentials: env.MACROFACTOR_CREDENTIALS,
    refreshToken: env.MACROFACTOR_REFRESH_TOKEN,
    saveRefreshToken: token => saveMacroFactorEnv('MACROFACTOR_REFRESH_TOKEN', token),
  });
}
