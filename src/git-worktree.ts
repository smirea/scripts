#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";

const home = requireEnv("HOME");

const rawArgs = process.argv.slice(2);
if (rawArgs.length === 0 || rawArgs[0] === "help" || rawArgs[0] === "--help") {
  printUsage();
  process.exit(0);
}

const [command, ...rest] = rawArgs;

try {
  const info = getRepoInfo();

  switch (command) {
    case "add": {
      const branch = requireBranch(rest);
      addWorktree(info, branch);
      break;
    }
    case "list": {
      ensureNoExtraArgs(rest, command);
      listWorktrees(info);
      break;
    }
    case "remove": {
      const branch = requireBranch(rest);
      removeWorktree(info, branch);
      break;
    }
    case "cd": {
      const branch = requireBranch(rest);
      const target = resolveWorktreePath(info, branch);
      console.log(target);
      break;
    }
    default:
      throw new Error(`Unknown command: ${command}`);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}

interface WorktreeEntry {
  path: string;
  head?: string;
  branchRef?: string;
  branch?: string;
  detached?: boolean;
  isMain?: boolean;
}

interface RepoInfo {
  currentWorktree: string;
  mainWorktree: WorktreeEntry;
  worktrees: WorktreeEntry[];
  repoName: string;
  worktreesRoot: string;
}

function printUsage(): void {
  console.log("Usage: git-worktree <add|list|remove|cd> [branch]");
}

function requireBranch(args: string[]): string {
  if (args.length !== 1) {
    throw new Error("Branch name is required.");
  }
  const branch = args[0].trim();
  if (!branch) {
    throw new Error("Branch name is required.");
  }
  return branch;
}

function ensureNoExtraArgs(args: string[], cmd: string): void {
  if (args.length > 0) {
    throw new Error(`Unexpected arguments for ${cmd}.`);
  }
}

function getRepoInfo(): RepoInfo {
  const currentWorktree = runCommand("git", ["rev-parse", "--show-toplevel"]).trim();
  if (!currentWorktree) {
    throw new Error("Unable to determine git root.");
  }
  const rawWorktrees = runCommand("git", ["worktree", "list", "--porcelain"]);
  const worktrees = parseWorktrees(rawWorktrees).map(entry => ({
    ...entry,
    branch: branchFromRef(entry.branchRef),
  }));
  for (const entry of worktrees) {
    entry.isMain = isMainWorktree(entry.path);
  }
  if (worktrees.length === 0) {
    throw new Error("No git worktrees found.");
  }
  const mainWorktree = worktrees.find(entry => entry.isMain) ?? worktrees[0];
  const repoName = path.basename(mainWorktree.path);
  const worktreesRoot = path.join(home, "worktrees");
  return { currentWorktree, mainWorktree, worktrees, repoName, worktreesRoot };
}

function parseWorktrees(raw: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | null = null;
  for (const line of raw.split(/\r?\n/)) {
    if (!line) {
      continue;
    }
    const [key, ...rest] = line.split(" ");
    const value = rest.join(" ");
    if (key === "worktree") {
      if (current) {
        entries.push(current);
      }
      current = { path: value };
      continue;
    }
    if (!current) {
      continue;
    }
    if (key === "HEAD") {
      current.head = value;
      continue;
    }
    if (key === "branch") {
      current.branchRef = value;
      continue;
    }
    if (key === "detached") {
      current.detached = true;
    }
  }
  if (current) {
    entries.push(current);
  }
  return entries;
}

function branchFromRef(ref?: string): string | undefined {
  if (!ref) {
    return undefined;
  }
  const prefix = "refs/heads/";
  return ref.startsWith(prefix) ? ref.slice(prefix.length) : ref;
}

function isMainWorktree(worktreePath: string): boolean {
  try {
    const gitPath = path.join(worktreePath, ".git");
    if (!existsSync(gitPath)) {
      return false;
    }
    return lstatSync(gitPath).isDirectory();
  } catch {
    return false;
  }
}

function addWorktree(info: RepoInfo, branch: string): void {
  const safeBranch = normalizeBranch(branch);
  const worktreePath = path.join(info.worktreesRoot, `${info.repoName}__${safeBranch}`);
  if (!isSafeWorktreePath(info.worktreesRoot, worktreePath)) {
    throw new Error(`Invalid branch name: ${branch}`);
  }
  if (existsSync(worktreePath)) {
    throw new Error(`Worktree path already exists: ${worktreePath}`);
  }
  const existing = findWorktreeByBranch(info, branch);
  if (existing) {
    throw new Error(`Branch ${branch} is already checked out at ${existing.path}.`);
  }
  mkdirSync(path.dirname(worktreePath), { recursive: true });
  const hasBranch = branchExists(info, branch);
  const args = hasBranch
    ? ["worktree", "add", worktreePath, branch]
    : ["worktree", "add", "-b", branch, worktreePath];
  runCommand("git", args, { cwd: info.mainWorktree.path, stdio: "inherit" });
  copyEnvFiles(info.mainWorktree.path, worktreePath);
  runCommand("bun", ["install"], { cwd: worktreePath, stdio: "inherit" });
  console.log(`Worktree ready: ${worktreePath}`);
}

function listWorktrees(info: RepoInfo): void {
  const lines = info.worktrees.map(entry => {
    const branch = entry.branch ?? "(detached)";
    const label = entry.isMain ? `${branch} (main)` : branch;
    return `${label}\t${entry.path}`;
  });
  console.log(lines.join("\n"));
}

function removeWorktree(info: RepoInfo, branch: string): void {
  const entry = findWorktreeByBranch(info, branch);
  if (!entry) {
    throw new Error(`No worktree found for branch ${branch}.`);
  }
  if (entry.isMain) {
    throw new Error(`Refusing to remove main worktree at ${entry.path}.`);
  }
  if (!isSafeWorktreePath(info.worktreesRoot, entry.path)) {
    throw new Error(`Worktree for ${branch} is outside ${info.worktreesRoot}.`);
  }
  runCommand("git", ["worktree", "remove", entry.path], { cwd: info.mainWorktree.path, stdio: "inherit" });
}

function resolveWorktreePath(info: RepoInfo, branch: string): string {
  const entry = findWorktreeByBranch(info, branch);
  if (entry) {
    if (!entry.isMain && !isSafeWorktreePath(info.worktreesRoot, entry.path)) {
      throw new Error(`Worktree for ${branch} is outside ${info.worktreesRoot}.`);
    }
    return entry.path;
  }
  throw new Error(`No worktree found for branch ${branch}.`);
}

function findWorktreeByBranch(info: RepoInfo, branch: string): WorktreeEntry | undefined {
  return info.worktrees.find(entry => entry.branch === branch);
}

function branchExists(info: RepoInfo, branch: string): boolean {
  const result = spawnSync("git", ["show-ref", "--verify", `refs/heads/${branch}`], {
    cwd: info.mainWorktree.path,
    encoding: "utf8",
  });
  if (result.error) {
    throw result.error;
  }
  return result.status === 0;
}

function normalizeBranch(branch: string): string {
  const trimmed = branch.trim();
  if (!trimmed) {
    throw new Error("Branch name is required.");
  }
  const sanitized = trimmed.replace(/[^A-Za-z0-9._-]+/g, "_");
  if (!sanitized || sanitized === "." || sanitized === "..") {
    throw new Error(`Invalid branch name: ${branch}`);
  }
  return sanitized;
}

function isSafeWorktreePath(root: string, target: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(resolvedRoot + path.sep);
}

function copyEnvFiles(fromDir: string, toDir: string): void {
  const entries = readdirSync(fromDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    if (!entry.name.startsWith(".env")) {
      continue;
    }
    const src = path.join(fromDir, entry.name);
    const dest = path.join(toDir, entry.name);
    copyFileSync(src, dest);
  }
}

function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; stdio?: "inherit" | "pipe" } = {}
): string {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: options.stdio ?? "pipe",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const stderr = result.stderr ? result.stderr.toString().trim() : "";
    throw new Error(stderr || `${command} ${args.join(" ")} failed.`);
  }
  return result.stdout?.toString() ?? "";
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set.`);
  }
  return value;
}
