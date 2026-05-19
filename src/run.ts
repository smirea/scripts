#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { findScriptCommand, SCRIPT_COMMANDS } from './scriptCommands';

const repoRoot = path.resolve(import.meta.dir, '..');
const envFiles = [path.join(repoRoot, '.env'), path.join(repoRoot, '.env.local')];
const [commandName, ...args] = process.argv.slice(2);

if (!commandName) {
  console.error(`Usage: run <script> [...args]\n\nAvailable scripts:\n${SCRIPT_COMMANDS.map((command) => `  ${command.name}`).join('\n')}`);
  process.exit(1);
}

const command = findScriptCommand(commandName);
if (!command) {
  console.error(`Unknown script: ${commandName}`);
  console.error(`Available scripts: ${SCRIPT_COMMANDS.map((script) => script.name).join(', ')}`);
  process.exit(1);
}

const source = path.join(repoRoot, command.source);
if (!existsSync(source)) {
  console.error(`Missing source for ${command.name}: ${source}`);
  process.exit(1);
}

const result = spawnSync('bun', ['--no-env-file', ...envFileArgs(), source, ...args], {
  cwd: process.cwd(),
  env: process.env,
  stdio: 'inherit',
});

if (result.error) {
  throw result.error;
}

if (result.signal) {
  console.error(`${command.name} exited from signal ${result.signal}`);
  process.exit(1);
}

process.exit(result.status ?? 1);

function envFileArgs(): string[] {
  return envFiles.flatMap((envFile) => ['--env-file', envFile]);
}
