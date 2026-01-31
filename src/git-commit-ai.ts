#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const AI_KEY = "AI_COMITTER_NAME";
const DEFAULT_KEY = "DEFAULT_AI_COMITTER_NAME";
const ENV_FILE_NAMES = [".env.local", ".env"] as const;

type WhoAction = { type: "print" } | { type: "set"; value: string };

interface CliOptions {
  args: string[];
  who?: WhoAction;
}

const rawArgs = process.argv.slice(2);

try {
  const { args, who } = parseCliArgs(rawArgs);

  if (who) {
    handleWhoAction(who);
    process.exit(0);
  }

  const aiCommitterName = resolveAiCommitterName();
  if (args.length > 0) {
    runGitAiCommit(aiCommitterName, args);
    process.exit(0);
  }

  const stagedDiff = getStagedDiff();
  if (!stagedDiff.trim()) {
    throw new Error("No files staged for commit. Stage changes with `git add <files>` and retry.");
  }
  console.log("\x1b[1mGenerating AI commit message...\x1b[0m");
  const prompt = buildPrompt(stagedDiff);
  const rawResponse = callGemini(prompt);
  printGreyBlock(rawResponse);
  const commitMessage = extractCommitMessage(rawResponse);
  if (!commitMessage) {
    throw new Error("Failed to extract commit message from AI response. Review the output above for details.");
  }
  console.log();
  console.log("\x1b[1mCommit message:\x1b[0m");
  console.log(commitMessage);
  console.log();
  console.log("\x1b[1mCommitting...\x1b[0m");
  runGitAiCommit(aiCommitterName, [commitMessage]);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\x1b[31m${message}\x1b[0m`);
  process.exit(1);
}

function handleWhoAction(action: WhoAction): void {
  if (action.type === "print") {
    const current = resolveAiCommitterName();
    console.log(`AI_COMITTER_NAME=${current}`);
    return;
  }
  const targetFile = findFirstEnvFile(process.cwd());
  if (!targetFile) {
    throw new Error(
      `Unable to set ${AI_KEY}. No .env.local or .env file was found while walking up from ${process.cwd()}.`
    );
  }
  setEnvVarInFile(targetFile, AI_KEY, action.value);
  console.log(`Updated ${targetFile} with ${AI_KEY}=${action.value}`);
  console.log(`AI_COMITTER_NAME=${action.value}`);
}

function parseCliArgs(rawArgs: string[]): CliOptions {
  const args: string[] = [];
  let who: WhoAction | undefined;
  for (const arg of rawArgs) {
    if (arg === "--who") {
      if (who) {
        throw new Error("Multiple --who flags are not allowed.");
      }
      who = { type: "print" };
      continue;
    }
    if (arg.startsWith("--who=")) {
      if (who) {
        throw new Error("Multiple --who flags are not allowed.");
      }
      const value = arg.slice("--who=".length).trim();
      if (!value) {
        throw new Error("--who requires a non-empty value, e.g. --who=opencode-name");
      }
      who = { type: "set", value };
      continue;
    }
    args.push(arg);
  }
  return { args, who };
}

function resolveAiCommitterName(): string {
  const direct = readEnvVar(AI_KEY);
  if (direct) {
    return direct;
  }
  const fromFiles = findEnvVarFromEnvFiles(process.cwd(), AI_KEY);
  if (fromFiles) {
    return fromFiles;
  }
  const fallback = readEnvVar(DEFAULT_KEY);
  if (fallback) {
    return fallback;
  }
  throw new Error(
    `${AI_KEY} is not configured. Define it in the environment, a .env/.env.local file, or set ${DEFAULT_KEY}.`
  );
}

function readEnvVar(name: string): string | undefined {
  const value = process.env[name];
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function findEnvVarFromEnvFiles(startDir: string, key: string): string | undefined {
  for (const candidate of iterateEnvFileCandidates(startDir)) {
    if (!existsSync(candidate)) {
      continue;
    }
    const parsed = readFromEnvFile(candidate, key);
    if (parsed) {
      return parsed;
    }
  }
  return undefined;
}

function findFirstEnvFile(startDir: string): string | undefined {
  for (const candidate of iterateEnvFileCandidates(startDir)) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function* iterateEnvFileCandidates(startDir: string): Generator<string> {
  let currentDir = path.resolve(startDir);
  const visited = new Set<string>();
  while (!visited.has(currentDir)) {
    visited.add(currentDir);
    for (const fileName of ENV_FILE_NAMES) {
      yield path.join(currentDir, fileName);
    }
    const parent = path.dirname(currentDir);
    if (parent === currentDir) {
      break;
    }
    currentDir = parent;
  }
}

function readFromEnvFile(filePath: string, key: string): string | undefined {
  const content = readFileSync(filePath, "utf8");
  const lines = content.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) {
      continue;
    }
    if (match[1] !== key) {
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

function setEnvVarInFile(filePath: string, key: string, value: string): void {
  const content = readFileSync(filePath, "utf8");
  const lines = content.split(/\r?\n/);
  const assignmentPattern = new RegExp(`^(?:s*exports+)?${key}\\s*=`, "i");
  let updated = false;
  for (let i = 0; i < lines.length; i++) {
    if (assignmentPattern.test(lines[i])) {
      const hasExport = /^\s*export\s+/.test(lines[i]);
      const prefix = hasExport ? "export " : "";
      lines[i] = `${prefix}${key}=${quoteEnvValue(value)}`;
      updated = true;
      break;
    }
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

function quoteEnvValue(value: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) {
    return value;
  }
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}

function getStagedDiff(): string {
  const result = spawnSync("git", ["diff", "--cached"], { encoding: "utf8" });
  handleSpawnErrors(result, "git diff --cached");
  return result.stdout ?? "";
}

function buildPrompt(stagedDiff: string): string {
  return `Analyze the following git diff of staged files and write a concise commit message (multi-line allowed). Use conventional commits.

DATA TO ANALYZE:
================
${stagedDiff}
================

After your analysis, output ONLY the following block and NOTHING else:

###START_COMMIT_MESSAGE###
your commit message here
###END_COMMIT_MESSAGE###`;
}

function callGemini(prompt: string): string {
  const result = spawnSync(
    "gemini",
    ["-y", "-m", "gemini-2.5-flash", "--prompt", prompt],
    { encoding: "utf8" }
  );
  handleSpawnErrors(result, "gemini -y -m gemini-2.5-flash --prompt <...>");
  const combined = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (!combined.trim()) {
    throw new Error("Gemini returned no output.");
  }
  return combined;
}

function runGitAiCommit(aiName: string, args: string[]): void {
  const result = spawnSync("git", ["ai-cim", aiName, ...args], { stdio: "inherit" });
  handleSpawnErrors(result, "git ai-cim");
}

function printGreyBlock(text: string): void {
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    console.log(`\x1b[90m> ${line}\x1b[0m`);
  }
}

function extractCommitMessage(rawResponse: string): string | null {
  const clean = stripAnsi(rawResponse).replace(/\r/g, "");
  const blockMatch = clean.match(/###START_COMMIT_MESSAGE###([\s\S]*?)###END_COMMIT_MESSAGE###/);
  if (blockMatch) {
    const trimmed = trimMessageBlock(blockMatch[1]);
    if (trimmed) {
      return trimmed;
    }
  }
  const codeBlockMatch = clean.match(/```[A-Za-z0-9_-]*\n?([\s\S]*?)```/);
  if (codeBlockMatch) {
    const trimmed = trimMessageBlock(codeBlockMatch[1]);
    if (trimmed) {
      return trimmed;
    }
  }
  return null;
}

function trimMessageBlock(value: string): string {
  const lines = value.split(/\r?\n/);
  while (lines.length && !lines[0].trim()) {
    lines.shift();
  }
  while (lines.length && !lines[lines.length - 1].trim()) {
    lines.pop();
  }
  return lines.join("\n");
}

const ANSI_REGEX = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");

function stripAnsi(value: string): string {
  return value.replace(ANSI_REGEX, "");
}

function handleSpawnErrors(result: SpawnSyncReturns<string | Buffer>, label: string): void {
  if (result.error) {
    throw new Error(`${label} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = result.stderr ? result.stderr.toString().trim() : "";
    const suffix = stderr ? `: ${stderr}` : "";
    throw new Error(`${label} exited with status ${result.status}${suffix}`);
  }
}
