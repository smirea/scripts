#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import env from "./env";

const BASE_URL = "https://api.prod.whoop.com/developer/v2";
const AUTH_URL = "https://api.prod.whoop.com/oauth/oauth2/auth";
const TOKEN_URL = "https://api.prod.whoop.com/oauth/oauth2/token";
const MAX_LIMIT = 25;
const DEFAULT_DAYS = 2;
const WHOOP_SCOPE =
  "offline read:profile read:recovery read:sleep read:cycles read:workout read:body_measurement";
const WHOOP_STATE = "whooppull";
const ENV_LOCAL_PATH = path.resolve(import.meta.dir, "..", ".env.local");

const ALL_TYPES = ["profile", "body", "cycles", "recovery", "sleep", "workout"] as const;
type DataType = (typeof ALL_TYPES)[number];

const TYPE_ALIASES: Record<string, DataType> = {
  profile: "profile",
  body: "body",
  body_measurement: "body",
  measurements: "body",
  cycle: "cycles",
  cycles: "cycles",
  recovery: "recovery",
  sleep: "sleep",
  sleeps: "sleep",
  workout: "workout",
  workouts: "workout",
};

const args = await yargs(hideBin(process.argv))
  .scriptName("whoop-pull")
  .strict()
  .option("include", {
    alias: ["types", "what", "i"],
    type: "string",
    array: true,
    describe: "Data types to include (profile, body, cycles, recovery, sleep, workout)",
  })
  .option("exclude", {
    alias: ["x"],
    type: "string",
    array: true,
    describe: "Data types to exclude",
  })
  .option("days", {
    alias: ["d"],
    type: "number",
    default: DEFAULT_DAYS,
    describe: "Number of days to look back when start is not provided",
  })
  .option("start", {
    alias: ["since", "s"],
    type: "string",
    describe: "Start time (ISO 8601)",
  })
  .option("end", {
    alias: ["until", "e"],
    type: "string",
    describe: "End time (ISO 8601)",
  })
  .option("limit", {
    alias: ["l"],
    type: "number",
    default: MAX_LIMIT,
    describe: "Page size for WHOOP collection endpoints (max 25)",
  })
  .option("auth-code", {
    type: "string",
    describe: "OAuth authorization code copied from the redirect URL after approving access in your browser",
  })
  .option("redirect-uri", {
    type: "string",
    describe: "OAuth redirect URI registered in WHOOP Developer Dashboard",
  })
  .option("token", {
    type: "string",
    describe: "Manually set WHOOP_REFRESH_TOKEN in .env.local before fetching data",
  })
  .help()
  .parseAsync();

try {
  const providedToken = normalizeOptionalString(args.token);
  const types = resolveTypes(args.include, args.exclude);
  const { start, end } = resolveRange(args.start, args.end, args.days);
  const limit = resolveLimit(args.limit);

  const clientId = env.WHOOP_CLIENT_ID;
  const clientSecret = env.WHOOP_CLIENT_SECRET;
  const redirectUri = normalizeOptionalString(args["redirect-uri"]) ?? env.WHOOP_REDIRECT_URI;
  const authCode = normalizeOptionalString(args["auth-code"]);
  let bearerToken = providedToken ?? env.WHOOP_REFRESH_TOKEN;

  if (providedToken) {
    saveRefreshToken(providedToken);
  }

  if (!bearerToken) {
    if (!redirectUri) {
      throw new Error(
        "WHOOP_REFRESH_TOKEN is not set. Configure WHOOP_REDIRECT_URI in env-manager or pass --redirect-uri so the script can open the WHOOP authorization URL."
      );
    }
    if (!authCode) {
      openAuthorizationUrl(clientId, redirectUri);
      throw new Error(buildManualAuthorizationMessage(clientId, redirectUri));
    }
    const tokenResponse = await exchangeAuthCodeForTokens({
      clientId,
      clientSecret,
      authCode,
      redirectUri,
    });
    if (!tokenResponse.refresh_token) {
      throw new Error("WHOOP auth-code exchange did not return a refresh token.");
    }
    bearerToken = tokenResponse.refresh_token;
    saveRefreshToken(bearerToken);
  }

  const data: Record<string, unknown> = {};
  for (const type of types) {
    data[type] = await fetchType(type, {
      accessToken: bearerToken,
      start,
      end,
      limit,
    });
  }

  const output = {
    fetched_at: new Date().toISOString(),
    start: start.toISOString(),
    end: end.toISOString(),
    types,
    data,
  };

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}

function resolveTypes(include: unknown, exclude: unknown): DataType[] {
  const includeList = normalizeTypeList(include);
  const excludeList = normalizeTypeList(exclude);

  if (includeList.length > 0 && excludeList.length > 0) {
    throw new Error("Use either --include or --exclude, not both.");
  }

  const selected = includeList.length > 0 ? includeList : ALL_TYPES.filter(t => !excludeList.includes(t));
  if (selected.length === 0) {
    throw new Error("No data types selected. Provide at least one type.");
  }
  return selected;
}

function normalizeTypeList(value: unknown): DataType[] {
  const items = normalizeList(value)
    .map(item => item.toLowerCase())
    .map(item => TYPE_ALIASES[item])
    .filter(Boolean) as DataType[];

  const unknown = normalizeList(value).filter(item => !TYPE_ALIASES[item.toLowerCase()]);
  if (unknown.length > 0) {
    throw new Error(`Unknown data type(s): ${unknown.join(", ")}`);
  }

  return Array.from(new Set(items));
}

function normalizeList(value: unknown): string[] {
  if (value == null) {
    return [];
  }
  const raw = Array.isArray(value) ? value : [value];
  return raw
    .flatMap(item => String(item).split(","))
    .map(item => item.trim())
    .filter(Boolean);
}

function resolveRange(startInput?: string, endInput?: string, daysInput?: number) {
  const end = endInput ? parseDate(endInput, "end") : new Date();
  const days = daysInput ?? DEFAULT_DAYS;
  if (!Number.isFinite(days) || days <= 0) {
    throw new Error("--days must be a positive number.");
  }
  const start = startInput ? parseDate(startInput, "start") : new Date(end.getTime() - days * 86400000);
  if (start > end) {
    throw new Error("Start time must be before end time.");
  }
  return { start, end };
}

function resolveLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error("--limit must be a positive number.");
  }
  if (limit > MAX_LIMIT) {
    throw new Error(`--limit exceeds WHOOP maximum of ${MAX_LIMIT}.`);
  }
  return Math.floor(limit);
}

function parseDate(value: string, label: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid ${label} date: ${value}`);
  }
  return date;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function buildAuthUrl(clientId: string, redirectUri: string): string {
  const url = new URL(AUTH_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", WHOOP_SCOPE);
  url.searchParams.set("state", WHOOP_STATE);
  return url.toString();
}

function openAuthorizationUrl(clientId: string, redirectUri: string): void {
  const authUrl = buildAuthUrl(clientId, redirectUri);
  const result = spawnSync("open", [authUrl], { encoding: "utf8" });
  if (result.error) {
    throw new Error(`Failed to open browser for WHOOP authorization: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = `${result.stderr ?? ""}`.trim();
    const stdout = `${result.stdout ?? ""}`.trim();
    throw new Error(`Failed to open browser for WHOOP authorization: ${stderr || stdout || `exit code ${result.status}`}`);
  }
}

function buildManualAuthorizationMessage(clientId: string, redirectUri: string): string {
  const authUrl = buildAuthUrl(clientId, redirectUri);
  return [
    "WHOOP_REFRESH_TOKEN is not set.",
    "The WHOOP authorization URL has been opened in your default browser.",
    "Approve access, then copy the `code` query parameter from the redirect URL and rerun:",
    `  whoop-pull --auth-code <code>`,
    "If you already have a refresh token, save it directly with:",
    "  whoop-pull --token <refresh-token>",
    "",
    `Auth URL: ${authUrl}`,
  ].join("\n");
}

async function exchangeAuthCodeForTokens(params: {
  clientId: string;
  clientSecret: string;
  authCode: string;
  redirectUri: string;
}): Promise<{
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.authCode,
    redirect_uri: params.redirectUri,
    client_id: params.clientId,
    client_secret: params.clientSecret,
    scope: WHOOP_SCOPE,
  });

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    throw new Error(`WHOOP auth-code token request failed: ${await formatError(response)}`);
  }

  const data = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    token_type?: string;
  };

  if (!data.access_token) {
    throw new Error("WHOOP auth-code token response missing access_token.");
  }
  if (!data.refresh_token) {
    throw new Error("WHOOP auth-code token response missing refresh_token. Make sure the app requests offline scope.");
  }

  return data as Required<typeof data> & { access_token: string; refresh_token: string };
}

function saveRefreshToken(refreshToken: string): void {
  const assignment = `WHOOP_REFRESH_TOKEN=${quoteEnvValue(refreshToken)} # {optional string}`;
  const current = existsSync(ENV_LOCAL_PATH) ? readFileSync(ENV_LOCAL_PATH, "utf8") : "";
  const lines = current === "" ? [] : current.split(/\r?\n/);
  const index = lines.findIndex(line => /^\s*WHOOP_REFRESH_TOKEN\s*=/.test(line));

  if (index === -1) {
    if (lines.length > 0 && lines[lines.length - 1] !== "") {
      lines.push("");
    }
    lines.push(assignment);
  } else {
    lines[index] = assignment;
  }
  const next = lines.join("\n").replace(/\n*$/, "\n");
  writeFileSync(ENV_LOCAL_PATH, next, "utf8");
  process.env.WHOOP_REFRESH_TOKEN = refreshToken;
}

function quoteEnvValue(value: string): string {
  if (/^[A-Za-z0-9._:/=-]+$/.test(value)) {
    return value;
  }
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

async function fetchType(
  type: DataType,
  options: { accessToken: string; start: Date; end: Date; limit: number }
): Promise<unknown> {
  switch (type) {
    case "profile":
      return fetchJson("/user/profile/basic", options.accessToken);
    case "body":
      return fetchJson("/user/measurement/body", options.accessToken);
    case "cycles":
      return fetchCollection("/cycle", options);
    case "recovery":
      return fetchCollection("/recovery", options);
    case "sleep":
      return fetchCollection("/activity/sleep", options);
    case "workout":
      return fetchCollection("/activity/workout", options);
  }
}

async function fetchCollection(
  path: string,
  options: { accessToken: string; start: Date; end: Date; limit: number }
): Promise<unknown[]> {
  const records: unknown[] = [];
  let nextToken: string | undefined;
  do {
    const url = buildUrl(path, {
      start: options.start.toISOString(),
      end: options.end.toISOString(),
      limit: options.limit,
      nextToken: nextToken,
    });
    const page = (await fetchJson(url, options.accessToken)) as {
      records?: unknown[];
      next_token?: string;
      nextToken?: string;
    };
    if (Array.isArray(page.records)) {
      records.push(...page.records);
    }
    nextToken = page.next_token ?? page.nextToken;
  } while (nextToken);
  return records;
}

async function fetchJson(pathOrUrl: string, accessToken: string): Promise<unknown> {
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${BASE_URL}${pathOrUrl}`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`WHOOP request failed: ${await formatError(response)}`);
  }
  return response.json();
}

function buildUrl(path: string, params: Record<string, string | number | undefined>): string {
  const url = new URL(path.startsWith("http") ? path : `${BASE_URL}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value == null || value === "") {
      continue;
    }
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

async function formatError(response: Response): Promise<string> {
  const body = await response.text();
  const snippet = body.trim().slice(0, 500);
  return `${response.status} ${response.statusText}${snippet ? `: ${snippet}` : ""}`;
}
