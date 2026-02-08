#!/usr/bin/env bun
import { existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import path from "node:path";

const home = process.env.HOME;
if (!home) {
  throw new Error("HOME is not set.");
}

const repoRoot = path.resolve(import.meta.dir, "..");
const links = [
  {
    name: "gai",
    source: path.join(repoRoot, "src", "git-commit-ai.ts"),
    target: path.join(home, "bin", "gai"),
  },
  {
    name: "git-ai-cim",
    source: path.join(repoRoot, "src", "git-commit-ai.ts"),
    target: path.join(home, "bin", "git-ai-cim"),
  },
  {
    name: "git-worktree",
    source: path.join(repoRoot, "src", "git-worktree.ts"),
    target: path.join(home, "bin", "git-worktree"),
  },
  {
    name: "wt",
    source: path.join(repoRoot, "src", "git-worktree.ts"),
    target: path.join(home, "bin", "wt"),
  },
  {
    name: "whoop-pull",
    source: path.join(repoRoot, "src", "whoop-pull.ts"),
    target: path.join(home, "bin", "whoop-pull"),
  },
  {
    name: "macrofactor",
    source: path.join(repoRoot, "src", "macrofactor.ts"),
    target: path.join(home, "bin", "macrofactor"),
  },
];

const addedLinks: string[] = [];
for (const link of links) {
  if (ensureLink(link)) {
    addedLinks.push(`${link.target} -> ${link.source}`);
  }
}

for (const added of addedLinks) {
  console.log(`Added ${added}`);
}

function ensureLink(link: { name: string; source: string; target: string }): boolean {
  if (!existsSync(link.source)) {
    throw new Error(`Missing source for ${link.name}: ${link.source}`);
  }
  const targetDir = path.dirname(link.target);
  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
  }
  if (existsSync(link.target)) {
    const stat = lstatSync(link.target);
    if (stat.isDirectory()) {
      throw new Error(`Refusing to replace directory at ${link.target}`);
    }
    if (stat.isSymbolicLink()) {
      const current = readlinkSync(link.target);
      const resolved = path.resolve(targetDir, current);
      if (resolved === path.resolve(link.source)) {
        return false;
      }
    }
    unlinkSync(link.target);
  }
  symlinkSync(link.source, link.target);
  return true;
}
