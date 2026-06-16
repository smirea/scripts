#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { SCRIPT_COMMANDS } from './scriptCommands';

const home = process.env.HOME;
if (!home) {
  throw new Error('HOME is not set.');
}

const repoRoot = path.resolve(import.meta.dir, '..');
const launcher = path.join(repoRoot, 'src', 'run.ts');

const installedWrappers: string[] = [];
for (const command of SCRIPT_COMMANDS) {
  const source = path.join(repoRoot, command.source);
  const target = path.join(home, 'bin', command.name);
  if (ensureWrapper({ name: command.name, source, target })) {
    installedWrappers.push(target);
  }
}

for (const wrapper of installedWrappers) {
  console.log(`Installed ${wrapper}`);
}

const devrageRoot = path.join(home, 'code', 'devrage');
if (linkDevrageIfCheckedOut(devrageRoot)) {
  console.log(`Linked devrage globally from ${devrageRoot}`);
}

function ensureWrapper(command: { name: string; source: string; target: string }): boolean {
  if (!existsSync(command.source)) {
    throw new Error(`Missing source for ${command.name}: ${command.source}`);
  }
  if (!existsSync(launcher)) {
    throw new Error(`Missing launcher: ${launcher}`);
  }
  const targetDir = path.dirname(command.target);
  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
  }
  const wrapper = buildWrapper(command.name);
  const stat = lstatOrNull(command.target);
  if (stat?.isDirectory()) {
    throw new Error(`Refusing to replace directory at ${command.target}`);
  }
  if (stat && !stat.isSymbolicLink() && readFileSync(command.target, 'utf8') === wrapper) {
    chmodSync(command.target, 0o755);
    return false;
  }
  if (stat) {
    unlinkSync(command.target);
  }
  writeFileSync(command.target, wrapper, { encoding: 'utf8', mode: 0o755 });
  return true;
}

function linkDevrageIfCheckedOut(repoRoot: string): boolean {
  if (!existsSync(path.join(repoRoot, '.git'))) {
    return false;
  }

  const packageJsonPath = path.join(repoRoot, 'package.json');
  if (!existsSync(packageJsonPath)) {
    return false;
  }

  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { name?: unknown };
  if (packageJson.name !== 'devrage') {
    return false;
  }

  const result = spawnSync('npm', ['link', '--silent'], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`npm link failed for ${repoRoot} with exit code ${result.status ?? 'unknown'}`);
  }

  return true;
}

function buildWrapper(commandName: string): string {
  return `#!/bin/sh
exec bun --no-env-file ${shellQuote(launcher)} ${shellQuote(commandName)} "$@"
`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function lstatOrNull(target: string) {
  try {
    return lstatSync(target);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}
