#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import path from "node:path";
import { findFirstEnvFile, getScriptsRepoRoot, readFirstEnvValue, setEnvVarInFile } from "./utils/env";

const AI_NAME_KEYS = ["AI_COMITTER_NAME", "AI_COMMITTER_NAME"] as const;
const DEFAULT_AI_NAME_KEYS = ["DEFAULT_AI_COMITTER_NAME", "DEFAULT_AI_COMMITTER_NAME"] as const;
const AI_EMAIL_KEYS = ["AI_COMITTER_EMAIL", "AI_COMMITTER_EMAIL"] as const;
const DEFAULT_AI_EMAIL_KEYS = ["DEFAULT_AI_COMITTER_EMAIL", "DEFAULT_AI_COMMITTER_EMAIL"] as const;
const LEGACY_DEFAULT_AI_EMAIL = "me+ai@stefanmirea.com";
const PRIMARY_AI_NAME_KEY = AI_NAME_KEYS[0];
const PRIMARY_AI_EMAIL_KEY = AI_EMAIL_KEYS[0];

type WhoAction = { type: "print" } | { type: "set"; value: string };

interface CliOptions {
  args: string[];
  who?: WhoAction;
}

interface AiIdentity {
  authorName: string;
  email: string;
}

const rawArgs = process.argv.slice(2);
const ANSI_REGEX = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");

try {
  const { args, who } = parseCliArgs(rawArgs);

  if (who) {
    handleWhoAction(who);
    process.exit(0);
  }

  assertInsideGitWorkTree();
  const aiIdentity = resolveAiIdentity();
  if (args.length > 0) {
    runGitCommit(aiIdentity, normalizeCommitArgs(args));
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
  runGitCommit(aiIdentity, ["-m", commitMessage]);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\x1b[31m${message}\x1b[0m`);
  process.exit(1);
}

function handleWhoAction(action: WhoAction): void {
  if (action.type === "print") {
    const currentName = resolveAiCommitterName();
    const currentEmail = resolveAiCommitterEmail();
    console.log(`${PRIMARY_AI_NAME_KEY}=${currentName}`);
    console.log(`${PRIMARY_AI_EMAIL_KEY}=${currentEmail}`);
    return;
  }
  const targetFile = findFirstEnvFile() ?? path.join(getScriptsRepoRoot(), ".env.local");
  setEnvVarInFile(targetFile, PRIMARY_AI_NAME_KEY, action.value);
  console.log(`Updated ${targetFile} with ${PRIMARY_AI_NAME_KEY}=${action.value}`);
  console.log(`${PRIMARY_AI_NAME_KEY}=${action.value}`);
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
  return resolveRequiredValue(PRIMARY_AI_NAME_KEY, AI_NAME_KEYS, DEFAULT_AI_NAME_KEYS);
}

function resolveAiCommitterEmail(): string {
  return resolveRequiredValue(PRIMARY_AI_EMAIL_KEY, AI_EMAIL_KEYS, DEFAULT_AI_EMAIL_KEYS, LEGACY_DEFAULT_AI_EMAIL);
}

function resolveAiIdentity(): AiIdentity {
  const aiName = resolveAiCommitterName();
  const aiEmail = resolveAiCommitterEmail();
  const humanName = resolveGitConfigValue("user.name");
  return {
    authorName: humanName ? `${aiName} (${humanName})` : aiName,
    email: aiEmail,
  };
}

function resolveRequiredValue(
  primaryKey: string,
  directKeys: readonly string[],
  fallbackKeys: readonly string[],
  literalFallback?: string
): string {
  const direct = resolveValue(directKeys);
  if (direct) {
    return direct;
  }
  const fallback = resolveValue(fallbackKeys);
  if (fallback) {
    return fallback;
  }
  if (literalFallback) {
    return literalFallback;
  }
  throw new Error(
    `${primaryKey} is not configured. Define one of [${directKeys.join(", ")}] in the environment or scripts repo .env/.env.local, or set one of [${fallbackKeys.join(", ")}].`
  );
}

function resolveValue(keys: readonly string[]): string | undefined {
  return readFirstEnvValue(keys);
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

function normalizeCommitArgs(args: string[]): string[] {
  if (args.length === 0) {
    throw new Error("Commit arguments cannot be empty.");
  }
  if (args[0] === "--") {
    const [, ...rest] = args;
    if (rest.length === 0) {
      throw new Error("`--` must be followed by git commit arguments.");
    }
    args = rest;
  }
  if (args.some((arg) => arg === "--author" || arg.startsWith("--author="))) {
    throw new Error("Do not pass --author. This script sets author and committer identity automatically.");
  }
  if (!args[0].startsWith("-")) {
    return ["-m", args.join(" ")];
  }
  return args;
}

function runGitCommit(identity: AiIdentity, args: string[]): void {
  const author = `${identity.authorName} <${identity.email}>`;
  const result = spawnSync("git", ["commit", `--author=${author}`, ...args], {
    stdio: "inherit",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: identity.authorName,
      GIT_AUTHOR_EMAIL: identity.email,
      GIT_COMMITTER_NAME: identity.authorName,
      GIT_COMMITTER_EMAIL: identity.email,
    },
  });
  handleSpawnErrors(result, "git commit");
}

function resolveGitConfigValue(key: string): string | undefined {
  const result = spawnSync("git", ["config", "--get", key], { encoding: "utf8" });
  if (result.error) {
    throw new Error(`git config --get ${key} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    return undefined;
  }
  const value = (result.stdout ?? "").trim();
  return value || undefined;
}

function assertInsideGitWorkTree(): void {
  const result = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { encoding: "utf8" });
  if (result.error) {
    throw new Error(`git rev-parse --is-inside-work-tree failed: ${result.error.message}`);
  }
  if (result.status !== 0 || (result.stdout ?? "").trim() !== "true") {
    throw new Error("Current directory is not a git work tree.");
  }
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
