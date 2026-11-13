import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import env from './env';

export const PERSONAL_KEY_PAGE = 'https://connect.garmin.com/app/settings/personalApiToken';
export const SWAGGER_PAGE = 'https://developer.garmin.com/gc-developer-program/personal/swagger-docs/';
export const CONNECT_TOKEN_FILE = path.join(os.homedir(), '.config', 'garmin', 'connect', 'garmin_tokens.json');

const PERSONAL_BASE_URL = 'https://personal.connectapi.garmin.com';
const PERSONAL_TOKEN_PATH = '/personalapitoken-service/personal-api/personal-api-key/token';
const CONNECT_BASE_URL = 'https://connectapi.garmin.com';
const DI_TOKEN_URL = 'https://diauth.garmin.com/di-oauth2-service/oauth/token';
const LOGIN_HELPER = path.join(import.meta.dir, 'garmin-connect-login.py');
const REFRESH_MARGIN_MS = 15 * 60_000;

export type Params = Record<string, string | number | boolean | readonly (string | number)[] | undefined>;

interface ConnectTokens {
  di_token: string;
  di_refresh_token: string;
  di_client_id: string;
}

function buildUrl(baseUrl: string, pathname: string, params: Params): URL {
  const url = new URL(pathname.startsWith('/') ? pathname : `/${pathname}`, baseUrl);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(key, String(item));
  }
  return url;
}

async function readJson<T>(res: Response, describe: string, hint: (status: number) => string): Promise<T> {
  const body = await res.text();
  if (!res.ok) throw new Error(`${describe} failed with ${res.status}: ${body.slice(0, 300)}${hint(res.status)}`);
  return (body ? JSON.parse(body) : null) as T;
}

/** Garmin's official, self-serve Personal API: stable, but limited to the paths in the Swagger docs. */
export class PersonalApi {
  private constructor(private readonly token: string) {}

  static async connect(): Promise<PersonalApi> {
    const apiKey = env.GARMIN_PERSONAL_API_KEY;
    if (!apiKey) {
      throw new Error(
        `GARMIN_PERSONAL_API_KEY is not set. Create a key at ${PERSONAL_KEY_PAGE}, add GARMIN_PERSONAL_API_KEY='<key>' to .env.local, and run \`env-manager up\`.`,
      );
    }
    const res = await fetch(PERSONAL_BASE_URL + PERSONAL_TOKEN_PATH, {
      method: 'POST',
      headers: { Accept: '*/*', Authorization: `ApiKey ${apiKey}` },
    });
    const body = await res.text();
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `Garmin rejected GARMIN_PERSONAL_API_KEY (${res.status}); it may be expired or deleted. Create a new key at ${PERSONAL_KEY_PAGE}, put it in .env.local, and run \`env-manager up\`.`,
      );
    }
    if (!res.ok) throw new Error(`POST ${PERSONAL_TOKEN_PATH} failed with ${res.status}: ${body.slice(0, 300)}`);
    return new PersonalApi(body.trim());
  }

  async get<T>(pathname: string, params: Params = {}): Promise<T> {
    const url = buildUrl(PERSONAL_BASE_URL, pathname, params);
    const res = await fetch(url, { headers: { Accept: 'application/json', Authorization: `Bearer ${this.token}` } });
    return readJson<T>(res, `GET ${url.pathname}${url.search} (Personal API)`, status =>
      status === 404
        ? ` The Personal API only serves the paths listed in ${SWAGGER_PAGE}; use --source connect for the app's other endpoints.`
        : status === 400
          ? ' Check the dates (YYYY-MM-DD) and the per-endpoint range cap in the Swagger docs.'
          : '',
    );
  }
}

/**
 * The Garmin Connect mobile app's own API, reached by logging in as the app does. Unofficial: it serves
 * everything the app shows (intraday stress, Training Readiness, Health Status, skin temp, VO2 max) but
 * can break whenever Garmin changes its login.
 */
export class ConnectApi {
  private constructor(private readonly token: string) {}

  static async connect(): Promise<ConnectApi> {
    let tokens = readConnectTokens();
    if (!tokens) {
      loginToConnect();
      tokens = readConnectTokens();
    } else if (jwtExpiresAt(tokens.di_token) - Date.now() < REFRESH_MARGIN_MS) {
      tokens = (await refreshConnectTokens(tokens)) ?? (loginToConnect(), readConnectTokens());
    }
    if (!tokens) throw new Error(`Garmin Connect login finished but wrote no tokens to ${CONNECT_TOKEN_FILE}.`);
    return new ConnectApi(tokens.di_token);
  }

  async get<T>(pathname: string, params: Params = {}): Promise<T> {
    const url = buildUrl(CONNECT_BASE_URL, pathname, params);
    const res = await fetch(url, { headers: { Accept: 'application/json', Authorization: `Bearer ${this.token}` } });
    return readJson<T>(res, `GET ${url.pathname}${url.search} (Garmin Connect)`, connectHint);
  }

  async delete(pathname: string): Promise<void> {
    const url = buildUrl(CONNECT_BASE_URL, pathname, {});
    const res = await fetch(url, { method: 'DELETE', headers: { Accept: 'application/json', Authorization: `Bearer ${this.token}` } });
    await readJson(res, `DELETE ${url.pathname} (Garmin Connect)`, connectHint);
  }

  /** The web app's GraphQL gateway; the only route to Health Status. Queries are anonymous with inlined literals. */
  async graphql<T>(query: string): Promise<T> {
    const res = await fetch(`${CONNECT_BASE_URL}/graphql-gateway/graphql`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
      body: JSON.stringify({ query }),
    });
    const body = await readJson<{ data?: T; errors?: { message?: string }[] }>(res, 'POST /graphql-gateway/graphql', connectHint);
    if (body.errors?.length) throw new Error(`Garmin GraphQL query failed: ${body.errors.map(error => error.message).join('; ')}`);
    return body.data as T;
  }
}

function connectHint(status: number): string {
  if (status === 401) return ' The Connect token was refused; run `garmin login` to log in again.';
  if (status === 403) return ' Garmin may be blocking this client or network rather than the token; retry later or run `garmin login`.';
  return '';
}

function readConnectTokens(): ConnectTokens | null {
  if (!existsSync(CONNECT_TOKEN_FILE)) return null;
  const tokens = JSON.parse(readFileSync(CONNECT_TOKEN_FILE, 'utf8')) as Partial<ConnectTokens>;
  if (!tokens.di_token || !tokens.di_refresh_token || !tokens.di_client_id) return null;
  return tokens as ConnectTokens;
}

function writeConnectTokens(tokens: ConnectTokens): void {
  mkdirSync(path.dirname(CONNECT_TOKEN_FILE), { recursive: true, mode: 0o700 });
  const temp = `${CONNECT_TOKEN_FILE}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(tokens), { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, CONNECT_TOKEN_FILE);
}

function jwtExpiresAt(token: string): number {
  const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { exp?: number };
  return (payload.exp ?? 0) * 1000;
}

// Each refresh returns a new refresh token valid for 30 days, so regular use never needs the password again.
async function refreshConnectTokens(tokens: ConnectTokens): Promise<ConnectTokens | null> {
  const res = await fetch(DI_TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${tokens.di_client_id}:`).toString('base64')}`,
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: tokens.di_client_id, refresh_token: tokens.di_refresh_token }),
  });
  if (!res.ok) {
    console.error(`Garmin Connect token refresh failed with ${res.status}; logging in again.`);
    return null;
  }
  const data = (await res.json()) as { access_token: string; refresh_token?: string };
  const refreshed = { ...tokens, di_token: data.access_token, di_refresh_token: data.refresh_token ?? tokens.di_refresh_token };
  writeConnectTokens(refreshed);
  return refreshed;
}

export function connectLoginEmail(): string {
  const credentials = env.GARMIN_CREDENTIALS;
  if (!credentials) {
    throw new Error(
      "GARMIN_CREDENTIALS is not set. Add GARMIN_CREDENTIALS='<email>:<password>' (your Garmin Connect login) to .env.local and run `env-manager up`.",
    );
  }
  return credentials.slice(0, credentials.indexOf(':'));
}

export function loginToConnect(): void {
  connectLoginEmail();
  // The helper's stdout goes to our stderr so `garmin ... -f json` output stays parseable.
  const result = spawnSync('uv', ['run', '--quiet', '--script', LOGIN_HELPER, path.dirname(CONNECT_TOKEN_FILE)], {
    env: { ...process.env, GARMIN_CREDENTIALS: env.GARMIN_CREDENTIALS },
    stdio: ['inherit', 2, 2],
  });
  if (result.error) throw new Error(`Could not run uv for the Garmin Connect login (${result.error.message}). Install it with \`brew install uv\`.`);
  if (result.status !== 0) {
    throw new Error(
      `Garmin Connect login failed (exit ${result.status}). Check GARMIN_CREDENTIALS in .env.local, then run \`garmin login\` in a terminal to see Garmin's error or enter an MFA code.`,
    );
  }
}
