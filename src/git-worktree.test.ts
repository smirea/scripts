import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "bun:test";

describe("git-worktree", () => {
  it("lists worktrees for the repo", () => {
    const rootResult = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
    expect(rootResult.status).toBe(0);
    const repoRoot = rootResult.stdout.trim();
    const scriptPath = path.join(repoRoot, "src", "git-worktree.ts");
    const bunPath = process.execPath;
    const listResult = spawnSync(bunPath, [scriptPath, "list"], { encoding: "utf8", cwd: repoRoot });
    expect(listResult.status).toBe(0);
    expect(listResult.stdout).toContain(repoRoot);
  });
});
