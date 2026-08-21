#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import env from "./env";
import { stripAnsi } from "./utils/tabular";

const LEGACY_DEFAULT_AI_EMAIL = "me+ai@stefanmirea.com";
const PRIMARY_AI_NAME_KEY = "AI_COMITTER_NAME";
const PRIMARY_AI_EMAIL_KEY = "AI_COMITTER_EMAIL";

type WhoAction = { type: "print" } | { type: "set"; value: string };

interface CliOptions {
  args: string[];
  who?: WhoAction;
}

interface AiIdentity {
  name: string;
  email: string;
}

const rawArgs = process.argv.slice(2);

if (import.meta.main) {
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

    assertGeminiAvailable();
    const stagedDiff = getStagedDiff();
    if (!stagedDiff.trim()) {
      throw new Error(
        "No files staged for commit. Stage changes with `git add <files>` and retry.",
      );
    }
    console.log("\x1b[1mGenerating AI commit message...\x1b[0m");
    const prompt = buildPrompt(stagedDiff);
    const rawResponse = callGemini(prompt);
    printGreyBlock(rawResponse);
    const commitMessage = extractCommitMessage(rawResponse);
    if (!commitMessage) {
      throw new Error(
        "Failed to extract commit message from AI response. Review the output above for details.",
      );
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
}

function handleWhoAction(action: WhoAction): void {
  if (action.type === "print") {
    const currentName = resolveAiCommitterName();
    const currentEmail = resolveAiCommitterEmail();
    console.log(`${PRIMARY_AI_NAME_KEY}=${currentName}`);
    console.log(`${PRIMARY_AI_EMAIL_KEY}=${currentEmail}`);
    return;
  }
  runEnvManager(
    ["global", "set", PRIMARY_AI_NAME_KEY, action.value],
    "env-manager global set failed",
  );
  console.log(`Updated env-manager global value ${PRIMARY_AI_NAME_KEY}=${action.value}`);
  console.log("Run `env-manager ts` in the scripts repo if env key definitions changed.");
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
  return resolveValue(
    [
      env.AI_COMITTER_NAME,
      env.AI_COMMITTER_NAME,
      env.DEFAULT_AI_COMITTER_NAME,
      env.DEFAULT_AI_COMMITTER_NAME,
    ],
    "AI",
  );
}

function resolveAiCommitterEmail(): string {
  return resolveValue(
    [
      env.AI_COMITTER_EMAIL,
      env.AI_COMMITTER_EMAIL,
      env.DEFAULT_AI_COMITTER_EMAIL,
      env.DEFAULT_AI_COMMITTER_EMAIL,
    ],
    LEGACY_DEFAULT_AI_EMAIL,
  );
}

function resolveAiIdentity(): AiIdentity {
  return {
    name: resolveAiCommitterName(),
    email: resolveAiCommitterEmail(),
  };
}

function resolveValue(candidates: readonly (string | undefined)[], fallback: string): string {
  for (const candidate of candidates) {
    const value = candidate?.trim();
    if (value) {
      return value;
    }
  }
  return fallback;
}

function runEnvManager(args: string[], label: string): void {
  const result = spawnSync("env-manager", args, { encoding: "utf8" });
  if (result.error) {
    throw new Error(`${label}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").trim();
    const stdout = (result.stdout ?? "").trim();
    throw new Error(`${label}: ${stderr || stdout || `exited with status ${result.status}`}`);
  }
}

function getStagedDiff(): string {
  const result = spawnSync("git", ["diff", "--cached"], { encoding: "utf8" });
  handleSpawnErrors(result, "git diff --cached");
  return result.stdout ?? "";
}

function assertGeminiAvailable(): void {
  if (!Bun.which("gemini")) {
    throw new Error("Gemini CLI is required when no commit message is provided.");
  }
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
  const result = spawnSync("gemini", ["-y", "-m", "gemini-2.5-flash", "--prompt", prompt], {
    encoding: "utf8",
  });
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
  if (!args[0].startsWith("-")) {
    return ["-m", args.join(" ")];
  }
  return args;
}

function runGitCommit(identity: AiIdentity, args: string[]): void {
  const result = spawnSync(
    "git",
    [
      "-c",
      `user.name=${identity.name}`,
      "-c",
      `user.email=${identity.email}`,
      "commit",
      `--trailer=Co-Authored-By: stefan <steven.mirea@gmail.com>`,
      ...args,
    ],
    {
      stdio: "inherit",
    },
  );
  handleSpawnErrors(result, "git commit");
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
