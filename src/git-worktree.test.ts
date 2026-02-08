import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";

const bunPath = process.execPath;
const scriptPath = path.join(import.meta.dir, "git-worktree.ts");

interface RepoFixture {
  repoDir: string;
  linkedWorktreeDir: string;
  homeDir: string;
}

function sanitizedEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_COMMON_DIR;
  delete env.GIT_INDEX_FILE;
  return env;
}

function runGit(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: sanitizedEnv() });
  if (result.error) {
    throw result.error;
  }
  expect(result.status).toBe(0);
  return result.stdout.trim();
}

function runScript(args: string[], cwd: string, homeDir: string) {
  return spawnSync(bunPath, [scriptPath, ...args], {
    cwd,
    encoding: "utf8",
    env: sanitizedEnv({ HOME: homeDir }),
  });
}

function createRepoFixture(): RepoFixture {
  const rootDir = mkdtempSync(path.join(tmpdir(), "git-worktree-test-"));
  const repoDir = path.join(rootDir, "repo");
  const homeDir = path.join(rootDir, "home");
  const linkedWorktreeDir = path.join(homeDir, "worktrees", "repo__feature_test");

  mkdirSync(repoDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });

  runGit(repoDir, ["init", "-q"]);
  runGit(repoDir, ["config", "user.email", "test@example.com"]);
  runGit(repoDir, ["config", "user.name", "Test User"]);
  writeFileSync(path.join(repoDir, "README.md"), "hello\n");
  runGit(repoDir, ["add", "README.md"]);
  runGit(repoDir, ["commit", "-q", "-m", "init"]);
  runGit(repoDir, ["worktree", "add", "-q", linkedWorktreeDir, "-b", "feature/test"]);

  return { repoDir, linkedWorktreeDir, homeDir };
}

describe("git-worktree", () => {
  it("lists worktrees when the main repo is configured as bare", () => {
    const fixture = createRepoFixture();
    runGit(fixture.repoDir, ["config", "core.bare", "true"]);

    const listResult = runScript(["list"], fixture.repoDir, fixture.homeDir);
    expect(listResult.status).toBe(0);
    expect(listResult.stdout).toContain(fixture.repoDir);
  });

  it("fails outside a git repository", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "git-worktree-no-repo-"));
    const listResult = runScript(["list"], dir, dir);

    expect(listResult.status).not.toBe(0);
    expect(listResult.stderr).toContain("Current directory is not inside a git repository.");
  });

  it("fails rm without a branch in the main worktree", () => {
    const fixture = createRepoFixture();

    const removeResult = runScript(["rm"], fixture.repoDir, fixture.homeDir);
    expect(removeResult.status).not.toBe(0);
    expect(removeResult.stderr).toContain(
      "Branch name is required when current directory is not a linked worktree."
    );
  });

  it("removes the current linked worktree when rm is called without a branch", () => {
    const fixture = createRepoFixture();

    const removeResult = runScript(["rm"], fixture.linkedWorktreeDir, fixture.homeDir);
    expect(removeResult.status).toBe(0);

    const listOutput = runGit(fixture.repoDir, ["worktree", "list", "--porcelain"]);
    expect(listOutput).not.toContain(fixture.linkedWorktreeDir);
  });
});
