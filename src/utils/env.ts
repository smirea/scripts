import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ENV_FILE_NAMES = [".env.local", ".env"] as const;
const SCRIPTS_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

interface EnvLookupOptions {
  includeProcessEnv?: boolean;
  startDirs?: readonly string[];
}

interface EnvFileOptions {
  startDirs?: readonly string[];
}

export function getScriptsRepoRoot(): string {
  return SCRIPTS_REPO_ROOT;
}

export function readEnvValue(name: string, options: EnvLookupOptions = {}): string | undefined {
  return readFirstEnvValue([name], options);
}

export function readFirstEnvValue(names: readonly string[], options: EnvLookupOptions = {}): string | undefined {
  if (options.includeProcessEnv !== false) {
    for (const name of names) {
      const value = readProcessEnv(name);
      if (value) {
        return value;
      }
    }
  }

  for (const envFilePath of iterateEnvFileCandidates(resolveStartDirs(options.startDirs))) {
    if (!existsSync(envFilePath)) {
      continue;
    }
    for (const name of names) {
      const value = readFromEnvFile(envFilePath, name);
      if (value) {
        return value;
      }
    }
  }

  return undefined;
}

export function findFirstEnvFile(options: EnvFileOptions = {}): string | undefined {
  for (const envFilePath of iterateEnvFileCandidates(resolveStartDirs(options.startDirs))) {
    if (existsSync(envFilePath)) {
      return envFilePath;
    }
  }
  return undefined;
}

export function setEnvVarInFile(filePath: string, key: string, value: string): void {
  const content = existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
  const lines = content.split(/\r?\n/);
  const assignmentPattern = new RegExp(`^(?:\\s*export\\s+)?${escapeRegExp(key)}\\s*=`, "i");

  let updated = false;
  for (let i = 0; i < lines.length; i += 1) {
    if (!assignmentPattern.test(lines[i])) {
      continue;
    }
    const hasExport = /^\s*export\s+/.test(lines[i]);
    const prefix = hasExport ? "export " : "";
    lines[i] = `${prefix}${key}=${quoteEnvValue(value)}`;
    updated = true;
    break;
  }

  if (!updated) {
    if (lines.length > 0 && lines[lines.length - 1] !== "") {
      lines.push("");
    }
    lines.push(`export ${key}=${quoteEnvValue(value)}`);
  }

  const output = lines.join("\n");
  writeFileSync(filePath, output.endsWith("\n") ? output : `${output}\n`);
}

function resolveStartDirs(startDirs: readonly string[] | undefined): string[] {
  const dirs = startDirs && startDirs.length > 0 ? startDirs : [SCRIPTS_REPO_ROOT];
  const resolved = new Set<string>();

  for (const dir of dirs) {
    const absolute = path.resolve(dir);
    if (existsSync(absolute)) {
      try {
        resolved.add(realpathSync(absolute));
        continue;
      } catch {
      }
    }
    resolved.add(absolute);
  }

  return Array.from(resolved);
}

function* iterateEnvFileCandidates(startDirs: readonly string[]): Generator<string> {
  const seenFiles = new Set<string>();

  for (const startDir of startDirs) {
    let currentDir = path.resolve(startDir);
    const visitedDirs = new Set<string>();

    while (!visitedDirs.has(currentDir)) {
      visitedDirs.add(currentDir);

      for (const fileName of ENV_FILE_NAMES) {
        const candidate = path.join(currentDir, fileName);
        if (seenFiles.has(candidate)) {
          continue;
        }
        seenFiles.add(candidate);
        yield candidate;
      }

      const parent = path.dirname(currentDir);
      if (parent === currentDir) {
        break;
      }
      currentDir = parent;
    }
  }
}

function readFromEnvFile(filePath: string, key: string): string | undefined {
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match || match[1] !== key) {
      continue;
    }

    const value = sanitizeEnvValue(match[2]);
    if (value) {
      return value;
    }
  }

  return undefined;
}

function sanitizeEnvValue(value: string): string | undefined {
  let trimmed = value.trim();
  const isSingleQuoted = trimmed.startsWith("'") && trimmed.endsWith("'");
  const isDoubleQuoted = trimmed.startsWith('"') && trimmed.endsWith('"');

  if (isSingleQuoted || isDoubleQuoted) {
    trimmed = trimmed.slice(1, -1);
    if (isDoubleQuoted) {
      trimmed = trimmed
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\r")
        .replace(/\\t/g, "\t")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");
    }
  } else {
    const hashIndex = trimmed.indexOf("#");
    if (hashIndex !== -1) {
      trimmed = trimmed.slice(0, hashIndex).trim();
    }
  }

  trimmed = trimmed.trim();
  return trimmed || undefined;
}

function readProcessEnv(name: string): string | undefined {
  const value = process.env[name];
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function quoteEnvValue(value: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) {
    return value;
  }
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}
