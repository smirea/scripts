#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

const BASE_URL = "https://api.prod.whoop.com/developer/v2";
const TOKEN_URL = "https://api.prod.whoop.com/oauth/oauth2/token";
const MAX_LIMIT = 25;
const DEFAULT_DAYS = 2;

const ALL_TYPES = ["profile", "body", "cycles", "recovery", "sleep", "workout"] as const;
type DataType = (typeof ALL_TYPES)[number];
type EnvSource = "process" | "env-manager";

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
  .option("save-refresh", {
    type: "boolean",
    default: true,
    describe: "Persist rotated refresh tokens with env-manager when possible",
  })
  .help()
  .parseAsync();

try {
  const types = resolveTypes(args.include, args.exclude);
  const { start, end } = resolveRange(args.start, args.end, args.days);
  const limit = resolveLimit(args.limit);

  const clientId = readRequiredEnv("WHOOP_CLIENT_ID");
  const clientSecret = readRequiredEnv("WHOOP_CLIENT_SECRET");
  const refreshToken = readRequiredEnv("WHOOP_REFRESH_TOKEN");

  const tokenResponse = await refreshAccessToken({
    clientId: clientId.value,
    clientSecret: clientSecret.value,
    refreshToken: refreshToken.value,
  });

  if (
    args["save-refresh"] &&
    tokenResponse.refresh_token &&
    tokenResponse.refresh_token !== refreshToken.value
  ) {
    if (refreshToken.source === "env-manager") {
      saveEnvManagerValue("WHOOP_REFRESH_TOKEN", tokenResponse.refresh_token);
    } else {
      console.error(
        "WHOOP refresh token rotated. Update WHOOP_REFRESH_TOKEN to keep future requests working."
      );
    }
  }

  const data: Record<string, unknown> = {};
  for (const type of types) {
    data[type] = await fetchType(type, {
      accessToken: tokenResponse.access_token,
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

function readRequiredEnv(name: string): { value: string; source: EnvSource } {
  const fromProcess = process.env[name]?.trim();
  if (fromProcess) {
    return { value: fromProcess, source: "process" };
  }
  const fromEnvManager = readEnvManagerValue(name);
  if (fromEnvManager) {
    return { value: fromEnvManager, source: "env-manager" };
  }
  throw new Error(
    `${name} is required. Set it with env-manager (env-manager global set ${name} <value>) or in the environment.`
  );
}

function readEnvManagerValue(name: string): string | undefined {
  const result = spawnSync("env-manager", ["global", "get", name], { encoding: "utf8" });
  if (result.error) {
    throw new Error(`env-manager failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    return undefined;
  }
  const output = `${result.stdout ?? ""}`.trim();
  if (!output) {
    return undefined;
  }
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^name\b/i.test(line) || /^-+$/.test(line)) {
      continue;
    }
    const parts = line.split(/\s{2,}/);
    if (parts[0] === name && parts[1]) {
      return parts[1].trim();
    }
  }
  return undefined;
}

function saveEnvManagerValue(name: string, value: string): void {
  const result = spawnSync("env-manager", ["global", "set", name, value], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    throw new Error(`env-manager failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = `${result.stderr ?? ""}`.trim();
    throw new Error(`env-manager failed to save ${name}${stderr ? `: ${stderr}` : ""}`);
  }
}

async function refreshAccessToken(params: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<{
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: params.refreshToken,
    client_id: params.clientId,
    client_secret: params.clientSecret,
    scope: "offline",
  });

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    throw new Error(`WHOOP token request failed: ${await formatError(response)}`);
  }

  const data = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    token_type?: string;
  };

  if (!data.access_token) {
    throw new Error("WHOOP token response missing access_token.");
  }

  return data as Required<typeof data> & { access_token: string };
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
  const url = new URL(path, BASE_URL);
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
