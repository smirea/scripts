import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";

const rootResult = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
if (rootResult.status !== 0) {
  throw new Error(rootResult.stderr.trim() || "Unable to determine repo root.");
}
const repoRoot = rootResult.stdout.trim();
const scriptPath = path.join(repoRoot, "src", "git-worktree.ts");
const bunPath = process.execPath;

describe("git-worktree", () => {
  it("lists worktrees for the repo", () => {
    const listResult = spawnSync(bunPath, [scriptPath, "list"], { encoding: "utf8", cwd: repoRoot });
    expect(listResult.status).toBe(0);
    expect(listResult.stdout).toContain(repoRoot);
  });

  it("supports del alias and removes the current worktree when no branch is provided", () => {
    const sandbox = createSandboxRepo();
    const result = runWorktreeScript(["del"], sandbox.featureWorktreePath, sandbox.homeDir);
    expect(result.status).toBe(0);
    expect(existsSync(sandbox.featureWorktreePath)).toBe(false);
    const worktreeList = runGit(["worktree", "list", "--porcelain"], sandbox.mainRepoPath);
    expect(worktreeList).not.toContain(sandbox.featureWorktreePath);
  });

  it("errors when rm is called without a branch from master", () => {
    const sandbox = createSandboxRepo();
    const result = runWorktreeScript(["rm"], sandbox.mainRepoPath, sandbox.homeDir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("master");
  });
});

interface SandboxRepo {
  homeDir: string;
  mainRepoPath: string;
  featureWorktreePath: string;
}

function createSandboxRepo(): SandboxRepo {
  const id = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  const safeId = id.replace(/[^a-z0-9]+/gi, "_");
  const homeDir = realpathSync(mkdtempSync(path.join(tmpdir(), "git-worktree-home-")));
  const mainRepoPath = path.join(homeDir, `repo_${safeId}`);
  const worktreesRoot = path.join(homeDir, "worktrees");
  const branchName = `feature/remove-me-${safeId}`;
  const featureWorktreePath = path.join(worktreesRoot, `repo_${safeId}__feature_remove_me_${safeId}`);
  mkdirSync(mainRepoPath, { recursive: true });
  mkdirSync(worktreesRoot, { recursive: true });

  runGit(["init", "-b", "master"], mainRepoPath);
  runGit(["config", "user.email", "test@example.com"], mainRepoPath);
  runGit(["config", "user.name", "Test User"], mainRepoPath);

  writeFileSync(path.join(mainRepoPath, "README.md"), "sandbox\n");
  runGit(["add", "README.md"], mainRepoPath);
  runGit(["commit", "--no-verify", "--allow-empty", "-m", "init"], mainRepoPath);
  runGit(["worktree", "add", "-b", branchName, featureWorktreePath], mainRepoPath);

  return { homeDir, mainRepoPath, featureWorktreePath };
}

function runGit(args: string[], cwd: string): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed.`);
  }
  return result.stdout;
}

function runWorktreeScript(args: string[], cwd: string, homeDir: string) {
  return spawnSync(bunPath, [scriptPath, ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: homeDir,
    },
  });
}
