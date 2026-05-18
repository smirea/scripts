#!/usr/bin/env bun
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';

import { isCancel, password, text } from '@clack/prompts';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import env from './env';
import { createScript } from './utils/createScript';

const BASE_URL = 'https://app.erafit.com';
const DEFAULT_DASHBOARD_PATH = '/clients/dashboard';
const ENV_LOCAL_PATH = path.resolve(import.meta.dir, '..', '.env.local');
const SESSION_ENV_KEY = 'ERA_FIT_SESSION_COOKIE';
const CREDENTIALS_ENV_KEY = 'ERA_FIT_CREDENTIALS';

interface Credentials {
  email: string;
  password: string;
}

interface DashboardCheck {
  ok: boolean;
  status: number;
  location: string | null;
  title: string | null;
  reason: string;
}

interface LoginResponse {
  ret_code?: number;
  ret_msg?: string;
  ret_action?: string;
  ret_data?: false | {
    redirect?: string;
  };
}

interface CookieEntry {
  name: string;
  value: string;
}

class CookieJar {
  private readonly cookies = new Map<string, string>();

  constructor(initialHeader?: string) {
    if (initialHeader) {
      this.addCookieHeader(initialHeader);
    }
  }

  addCookieHeader(header: string): void {
    for (const part of header.split(';')) {
      const trimmed = part.trim();
      const separator = trimmed.indexOf('=');
      if (separator <= 0) {
        continue;
      }
      this.cookies.set(trimmed.slice(0, separator), trimmed.slice(separator + 1));
    }
  }

  addSetCookieHeaders(headers: Headers): void {
    for (const value of readSetCookieHeaders(headers)) {
      const entry = parseSetCookie(value);
      if (entry) {
        this.cookies.set(entry.name, entry.value);
      }
    }
  }

  set(name: string, value: string): void {
    this.cookies.set(name, value);
  }

  toHeader(): string {
    return Array.from(this.cookies.entries())
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');
  }
}

if (import.meta.main) {
  await createScript(runCliWithErrorFormatting);
}

async function runCliWithErrorFormatting(): Promise<void> {
  try {
    await runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

async function runCli(): Promise<void> {
  const args = await yargs(hideBin(process.argv))
    .scriptName('era-fit')
    .strict()
    .option('dashboard-path', {
      type: 'string',
      default: DEFAULT_DASHBOARD_PATH,
      describe: 'Era Fit path to use when checking whether the session is authenticated',
    })
    .option('save-session', {
      type: 'boolean',
      default: true,
      describe: 'Persist successful ERA_FIT_SESSION_COOKIE to .env.local',
    })
    .option('login', {
      type: 'boolean',
      default: true,
      describe: 'Use ERA_FIT_CREDENTIALS when the stored session is missing or invalid',
    })
    .option('prompt', {
      type: 'boolean',
      default: true,
      describe: 'Prompt for Era Fit credentials when env credentials are not set',
    })
    .option('json', {
      type: 'boolean',
      default: false,
      describe: 'Print machine-readable status',
    })
    .help()
    .parseAsync();

  const dashboardPath = normalizePath(args.dashboardPath);
  const existingSession = normalizeOptionalString(env.ERA_FIT_SESSION_COOKIE);
  if (existingSession) {
    const sessionCheck = await checkDashboard(existingSession, dashboardPath);
    if (sessionCheck.ok) {
      renderResult({
        json: args.json,
        status: 'session-valid',
        message: `${SESSION_ENV_KEY} can load ${dashboardPath} without credentials right now.`,
        dashboard: sessionCheck,
      });
      return;
    }
    if (!args.login) {
      renderResult({
        json: args.json,
        status: 'session-invalid',
        message: `${SESSION_ENV_KEY} is present but did not load ${dashboardPath}.`,
        dashboard: sessionCheck,
      });
      process.exit(1);
    }
    console.warn(`${SESSION_ENV_KEY} is present but not valid: ${sessionCheck.reason}`);
  }

  if (!args.login) {
    throw new Error(`${SESSION_ENV_KEY} is not set, so there is no stored session to test.`);
  }

  const credentials = parseOptionalCredentials(env.ERA_FIT_CREDENTIALS) ?? await promptCredentials(args.prompt);
  const loginResult = await login(credentials, dashboardPath);
  if (args['save-session']) {
    saveEnvLocalValue(SESSION_ENV_KEY, loginResult.cookieHeader);
  }
  renderResult({
    json: args.json,
    status: 'credential-login-valid',
    message: [
      `${CREDENTIALS_ENV_KEY} login succeeded and loaded ${dashboardPath}.`,
      args['save-session']
        ? `Saved ${SESSION_ENV_KEY} to .env.local. Rerun \`era-fit --no-login\` later to see whether the cookie alone is still enough.`
        : `Run again with --save-session to persist ${SESSION_ENV_KEY}.`,
    ].join(' '),
    dashboard: loginResult.dashboard,
    savedSession: args['save-session'],
  });
}

async function login(credentials: Credentials, dashboardPath: string): Promise<{
  cookieHeader: string;
  dashboard: DashboardCheck;
}> {
  const jar = new CookieJar();
  const loginPage = await fetchUrl('/login/', {
    redirect: 'manual',
  });
  jar.addSetCookieHeaders(loginPage.headers);
  jar.set('_ef_app_tz', Intl.DateTimeFormat().resolvedOptions().timeZone);

  const loginAccess = await fetchUrl('/login/access', {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: jar.toHeader(),
      Origin: BASE_URL,
      Referer: `${BASE_URL}/login/`,
    },
    body: new URLSearchParams({
      post: buildEraFitPost([
        {
          post_data: {
            email: credentials.email,
            login_password: credentials.password,
          },
        },
      ]),
    }),
  });
  jar.addSetCookieHeaders(loginAccess.headers);

  const responseText = await loginAccess.text();
  const response = parseLoginResponse(responseText);
  if (response.ret_code !== 200) {
    throw new Error(`Era Fit login failed: ${response.ret_msg ?? responseText}`);
  }

  const redirectPath =
    response.ret_action === 'redirect' && response.ret_data && typeof response.ret_data === 'object'
      ? response.ret_data.redirect
      : dashboardPath;
  const check = await checkDashboard(jar.toHeader(), normalizePath(redirectPath ?? dashboardPath));
  if (!check.ok) {
    throw new Error(`Era Fit login returned success, but the dashboard check failed: ${check.reason}`);
  }

  return {
    cookieHeader: jar.toHeader(),
    dashboard: check,
  };
}

async function checkDashboard(cookieHeader: string, dashboardPath: string): Promise<DashboardCheck> {
  const response = await fetchUrl(dashboardPath, {
    redirect: 'manual',
    headers: {
      Cookie: cookieHeader,
      Referer: `${BASE_URL}/login/`,
    },
  });
  const location = response.headers.get('location');
  const text = await response.text();
  const title = text.match(/<title>(.*?)<\/title>/i)?.[1]?.trim() ?? null;
  const isLoginPage = text.includes('id="login_form"') || text.includes('data-action="/login/access"');
  const ok = response.status === 200 && !isLoginPage;
  return {
    ok,
    status: response.status,
    location,
    title,
    reason: ok
      ? 'dashboard loaded'
      : response.status >= 300 && response.status < 400
        ? `redirected to ${location ?? 'unknown location'}`
        : isLoginPage
          ? 'received login page'
          : `unexpected HTTP ${response.status}`,
  };
}

function buildEraFitPost(formData: unknown): string {
  const h = makeEraFitHash();
  const postFields = {
    a: encryptCryptoJsPassphraseJson(formData, selectEraFitHashKey(h)),
    b: JSON.stringify({ h }),
  };
  return deflateRawSync(JSON.stringify(postFields)).toString('base64');
}

function makeEraFitHash(): string {
  return `${randomBytes(256).toString('hex')}${Math.floor(Math.random() * 15)}`;
}

function selectEraFitHashKey(hash: string): string {
  const selector = Number(hash.slice(512));
  const key = hash.slice(selector * 32, selector * 32 + 32);
  if (!Number.isInteger(selector) || selector < 0 || selector > 14 || key.length !== 32) {
    throw new Error('Failed to derive Era Fit encryption key from login hash.');
  }
  return key;
}

function encryptCryptoJsPassphraseJson(value: unknown, passphrase: string): string {
  const salt = randomBytes(8);
  const { key, iv } = evpBytesToKey(passphrase, salt, 32, 16);
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(value), 'utf8'),
    cipher.final(),
  ]);
  return JSON.stringify({
    ct: encrypted.toString('base64'),
    iv: iv.toString('hex'),
    s: salt.toString('hex'),
  });
}

function evpBytesToKey(password: string, salt: Buffer, keyLength: number, ivLength: number): {
  key: Buffer;
  iv: Buffer;
} {
  const passwordBuffer = Buffer.from(password, 'utf8');
  let derived = Buffer.alloc(0);
  let previous = Buffer.alloc(0);
  while (derived.length < keyLength + ivLength) {
    previous = createHash('md5')
      .update(previous)
      .update(passwordBuffer)
      .update(salt)
      .digest();
    derived = Buffer.concat([derived, previous]);
  }
  return {
    key: derived.subarray(0, keyLength),
    iv: derived.subarray(keyLength, keyLength + ivLength),
  };
}

async function promptCredentials(allowPrompt: boolean): Promise<Credentials> {
  if (!allowPrompt) {
    throw new Error(`${CREDENTIALS_ENV_KEY} is not set. Expected <email>:<password>.`);
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(`${CREDENTIALS_ENV_KEY} is not set and this shell is not interactive enough to prompt.`);
  }

  const email = await text({
    message: 'Era Fit email',
    validate(value) {
      return value?.trim() ? undefined : 'Email is required.';
    },
  });
  if (isCancel(email)) {
    throw new Error('Era Fit login cancelled.');
  }
  const emailValue = email.trim();

  const passwordValue = await password({
    message: 'Era Fit password',
    validate(value) {
      return value ? undefined : 'Password is required.';
    },
  });
  if (isCancel(passwordValue)) {
    throw new Error('Era Fit login cancelled.');
  }

  return {
    email: emailValue,
    password: passwordValue,
  };
}

function parseOptionalCredentials(value: string | undefined): Credentials | null {
  const raw = normalizeOptionalString(value);
  if (!raw) {
    return null;
  }
  const separator = raw.indexOf(':');
  if (separator === -1) {
    throw new Error(`${CREDENTIALS_ENV_KEY} must use the format <email>:<password>.`);
  }
  const email = raw.slice(0, separator).trim();
  const password = raw.slice(separator + 1);
  if (!email || !password) {
    throw new Error(`${CREDENTIALS_ENV_KEY} must include both a non-empty email and password.`);
  }
  return { email, password };
}

function parseLoginResponse(text: string): LoginResponse {
  try {
    return JSON.parse(text) as LoginResponse;
  } catch {
    throw new Error(`Era Fit login returned non-JSON response: ${text.slice(0, 500)}`);
  }
}

async function fetchUrl(pathOrUrl: string, init: RequestInit): Promise<Response> {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : new URL(pathOrUrl, BASE_URL).toString();
  return fetch(url, init);
}

function normalizePath(value: string): string {
  if (value.startsWith('http')) {
    return new URL(value).pathname;
  }
  return value.startsWith('/') ? value : `/${value}`;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function readSetCookieHeaders(headers: Headers): string[] {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  if (typeof getSetCookie === 'function') {
    return getSetCookie.call(headers);
  }
  const header = headers.get('set-cookie');
  return header ? splitSetCookieHeader(header) : [];
}

function splitSetCookieHeader(header: string): string[] {
  return header.split(/,(?=\s*[^;,]+=)/g).map(value => value.trim()).filter(Boolean);
}

function parseSetCookie(value: string): CookieEntry | null {
  const pair = value.split(';', 1)[0]?.trim();
  const separator = pair.indexOf('=');
  if (!pair || separator <= 0) {
    return null;
  }
  return {
    name: pair.slice(0, separator),
    value: pair.slice(separator + 1),
  };
}

function saveEnvLocalValue(name: string, value: string): void {
  const current = existsSync(ENV_LOCAL_PATH) ? readFileSync(ENV_LOCAL_PATH, 'utf8') : '';
  const line = `${name}=${JSON.stringify(value)}`;
  const pattern = new RegExp(`^${escapeRegExp(name)}=.*$`, 'm');
  const next = pattern.test(current)
    ? current.replace(pattern, line)
    : `${current}${current && !current.endsWith('\n') ? '\n' : ''}${line}\n`;
  writeFileSync(ENV_LOCAL_PATH, next, 'utf8');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function renderResult(result: Record<string, unknown> & { json: boolean; message: string }): void {
  if (result.json) {
    process.stdout.write(`${JSON.stringify({ ...result, json: undefined }, null, 2)}\n`);
    return;
  }
  console.log(result.message);
}
