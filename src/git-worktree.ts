#!/usr/bin/env bun
import { isCancel, select, text } from "@clack/prompts";
import { spawnSync } from "node:child_process";
import type { StdioOptions } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import yargs from "yargs";
import type { Argv, ArgumentsCamelCase } from "yargs";
import { hideBin } from "yargs/helpers";

const home = requireEnv("HOME");

void runCli();

interface WorktreeEntry {
  path: string;
  head?: string;
  branchRef?: string;
  branch?: string;
  detached?: boolean;
  bare?: boolean;
  isMain?: boolean;
}

interface RepoInfo {
  currentWorktree?: string;
  currentWorktreeEntry?: WorktreeEntry;
  mainWorktree: WorktreeEntry;
  worktrees: WorktreeEntry[];
  repoName: string;
  worktreesRoot: string;
}

async function runCli(): Promise<void> {
  await yargs(hideBin(process.argv))
    .scriptName("git-worktree")
    .strict()
    .command(
      "add <branch>",
      "Add a worktree for a branch",
      (y: Argv) => y.positional("branch", { type: "string", demandOption: true }),
      (argv: ArgumentsCamelCase<{ branch: string }>) =>
        runOrExit(() => {
          const info = getRepoInfo();
          const worktreePath = addWorktree(info, argv.branch);
          console.log(`Worktree ready: ${worktreePath}`);
        })
    )
    .command(
      ["list", "ls"],
      "List worktrees",
      () => {},
      () =>
        runOrExit(() => {
          const info = getRepoInfo();
          listWorktrees(info);
        })
    )
    .command(
      ["remove [branch]", "rm [branch]"],
      "Remove a worktree",
      (y: Argv) => y.positional("branch", { type: "string" }),
      (argv: ArgumentsCamelCase<{ branch?: string }>) =>
        runOrExit(() => {
          const info = getRepoInfo();
          removeWorktree(info, argv.branch);
        })
    )
    .command(
      "cd <branch>",
      "Print worktree path for a branch",
      (y: Argv) => y.positional("branch", { type: "string", demandOption: true }),
      (argv: ArgumentsCamelCase<{ branch: string }>) =>
        runOrExit(() => {
          const info = getRepoInfo();
          const target = resolveWorktreePath(info, argv.branch);
          console.log(target);
        })
    )
    .command(
      "$0",
      "Interactively select a worktree",
      () => {},
      () =>
        runOrExit(async () => {
          const info = getRepoInfo();
          const target = await selectWorktreeInteractive(info);
          if (shouldSwitchToSelectedWorktree()) {
            switchToWorktreeShell(target);
            return;
          }
          console.log(target);
        })
    )
    .help()
    .wrap(100)
    .parseAsync();
}

async function runOrExit(fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  }
}

function getRepoInfo(): RepoInfo {
  ensureInsideGitRepository();
  const rawWorktrees = runCommand("git", ["worktree", "list", "--porcelain"]);
  const worktrees = parseWorktrees(rawWorktrees).map(entry => ({
    ...entry,
    branch: branchFromRef(entry.branchRef),
  }));
  for (const entry of worktrees) {
    entry.isMain = entry.bare || isMainWorktree(entry.path);
  }
  if (worktrees.length === 0) {
    throw new Error("No git worktrees found.");
  }
  const mainWorktree = worktrees.find(entry => entry.isMain) ?? worktrees[0];
  mainWorktree.isMain = true;
  const currentWorktreeEntry = resolveCurrentWorktreeEntry(worktrees);
  const currentWorktree = currentWorktreeEntry?.path;
  const repoName = path.basename(mainWorktree.path);
  const worktreesRoot = path.join(home, "worktrees");
  return {
    currentWorktree,
    currentWorktreeEntry,
    mainWorktree,
    worktrees,
    repoName,
    worktreesRoot,
  };
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
      continue;
    }
    if (key === "bare") {
      current.bare = true;
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

function addWorktree(
  info: RepoInfo,
  branch: string,
  options: { stdio?: "inherit" | "stderr" } = {}
): string {
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
  const stdio = options.stdio ?? "inherit";
  runCommand("git", args, { cwd: info.mainWorktree.path, stdio });
  copyEnvFiles(info.mainWorktree.path, worktreePath);
  runCommand("bun", ["install"], { cwd: worktreePath, stdio });
  return worktreePath;
}

function listWorktrees(info: RepoInfo): void {
  const rows = info.worktrees.map(entry => {
    const branch = entry.branch ?? "(detached)";
    const label = entry.isMain ? `${branch} (main)` : branch;
    return { label, path: entry.path };
  });
  const nameWidth = rows.reduce((max, row) => Math.max(max, row.label.length), 0);
  const lines = rows.map(row => `${row.label.padEnd(nameWidth + 2)}${row.path}`);
  console.log(lines.join("\n"));
}

async function selectWorktreeInteractive(info: RepoInfo): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error("Interactive mode requires a TTY. Use `git-worktree list` instead.");
  }
  const options = info.worktrees.map(entry => ({
    value: entry.path,
    label: formatWorktreeLabel(info, entry),
    hint: entry.path,
  }));
  options.push({ value: "__new__", label: "Create new worktree...", hint: "Add a new worktree" });
  const selected = await select({
    message: "Select a worktree",
    options,
    initialValue: info.currentWorktree,
    output: process.stderr,
  });
  if (isCancel(selected)) {
    process.exit(0);
  }
  if (selected === "__new__") {
    const branch = await text({
      message: "New worktree branch",
      placeholder: "feature/example",
      validate: value => (value?.trim() ? undefined : "Branch name is required."),
      output: process.stderr,
    });
    if (isCancel(branch)) {
      process.exit(0);
    }
    return addWorktree(info, branch, { stdio: "stderr" });
  }
  return resolveSelectedWorktree(info, selected);
}

function shouldSwitchToSelectedWorktree(): boolean {
  return process.stdin.isTTY && process.stdout.isTTY;
}

function switchToWorktreeShell(worktreePath: string): void {
  const shell = requireEnv("SHELL");
  const result = spawnSync(shell, { cwd: worktreePath, stdio: "inherit" });
  if (result.error) {
    throw result.error;
  }
  if (result.signal) {
    throw new Error(`${path.basename(shell)} exited due to signal ${result.signal}.`);
  }
  if (result.status !== 0) {
    throw new Error(`${path.basename(shell)} exited with status ${result.status}.`);
  }
}

function removeWorktree(info: RepoInfo, branch?: string): void {
  const normalizedBranch = branch?.trim();
  if (!normalizedBranch) {
    const current = info.currentWorktreeEntry;
    if (!current || current.isMain) {
      throw new Error("Branch name is required when current directory is not a linked worktree.");
    }
    if (!isSafeWorktreePath(info.worktreesRoot, current.path)) {
      const label = current.branch ?? current.path;
      throw new Error(`Worktree for ${label} is outside ${info.worktreesRoot}.`);
    }
    runCommand("git", ["worktree", "remove", current.path], {
      cwd: info.mainWorktree.path,
      stdio: "inherit",
    });
    return;
  }
  const entry = findWorktreeByBranch(info, normalizedBranch);
  if (!entry) {
    throw new Error(`No worktree found for branch ${normalizedBranch}.`);
  }
  if (entry.isMain) {
    throw new Error(`Refusing to remove main worktree at ${entry.path}.`);
  }
  if (!isSafeWorktreePath(info.worktreesRoot, entry.path)) {
    throw new Error(`Worktree for ${normalizedBranch} is outside ${info.worktreesRoot}.`);
  }
  runCommand("git", ["worktree", "remove", entry.path], { cwd: info.mainWorktree.path, stdio: "inherit" });
}

function resolveWorktreePath(info: RepoInfo, branch: string): string {
  const entry = findWorktreeByBranch(info, branch);
  if (entry) {
    return entry.path;
  }
  throw new Error(`No worktree found for branch ${branch}.`);
}

function findWorktreeByBranch(info: RepoInfo, branch: string): WorktreeEntry | undefined {
  return info.worktrees.find(entry => entry.branch === branch);
}

function resolveSelectedWorktree(info: RepoInfo, selection: string): string {
  const entry = info.worktrees.find(item => item.path === selection);
  if (!entry) {
    throw new Error(`Unknown worktree selection: ${selection}`);
  }
  if (entry.branch) {
    return resolveWorktreePath(info, entry.branch);
  }
  return entry.path;
}

function formatWorktreeLabel(info: RepoInfo, entry: WorktreeEntry): string {
  const branch = entry.branch ?? "(detached)";
  const tags: string[] = [];
  if (entry.isMain) {
    tags.push("main");
  }
  if (entry.path === info.currentWorktree) {
    tags.push("current");
  }
  if (tags.length === 0) {
    return branch;
  }
  return `${branch} (${tags.join(", ")})`;
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
  const resolvedRoot = canonicalizePath(root);
  const resolvedTarget = canonicalizePath(target);
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(resolvedRoot + path.sep);
}

function canonicalizePath(value: string): string {
  const resolved = path.resolve(value);
  if (existsSync(resolved)) {
    return realpathSync(resolved);
  }
  const parent = path.dirname(resolved);
  if (parent === resolved) {
    return resolved;
  }
  return path.join(canonicalizePath(parent), path.basename(resolved));
}

function ensureInsideGitRepository(): void {
  const result = spawnSync("git", ["rev-parse", "--absolute-git-dir"], { encoding: "utf8" });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error("Current directory is not inside a git repository.");
  }
}

function resolveCurrentWorktreeEntry(worktrees: WorktreeEntry[]): WorktreeEntry | undefined {
  const gitTopLevel = getCurrentWorktreeFromGit();
  if (gitTopLevel) {
    return worktrees.find(entry => canonicalizePath(entry.path) === canonicalizePath(gitTopLevel));
  }
  const cwd = path.resolve(process.cwd());
  const candidates = worktrees
    .filter(entry => isSafeWorktreePath(entry.path, cwd))
    .sort((a, b) => path.resolve(b.path).length - path.resolve(a.path).length);
  return candidates[0];
}

function getCurrentWorktreeFromGit(): string | undefined {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    return undefined;
  }
  const value = result.stdout?.toString().trim();
  return value || undefined;
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
  options: { cwd?: string; stdio?: "inherit" | "pipe" | "stderr" } = {}
): string {
  const stdio: StdioOptions =
    options.stdio === "stderr" ? ["inherit", process.stderr, process.stderr] : options.stdio ?? "pipe";
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: stdio ?? "pipe",
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
