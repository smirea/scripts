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
];

for (const link of links) {
  ensureLink(link);
}

function ensureLink(link: { name: string; source: string; target: string }): void {
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
        console.log(`Link already set: ${link.target}`);
        return;
      }
    }
    unlinkSync(link.target);
  }
  symlinkSync(link.source, link.target);
  console.log(`Linked ${link.target} -> ${link.source}`);
}
