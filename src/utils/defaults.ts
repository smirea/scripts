import { constants, copyFileSync } from 'node:fs';
import path from 'node:path';

import { SCRIPT_COMMANDS } from '../scriptCommands';

type DefaultValue = string | number | boolean | readonly (string | number | boolean)[];
export type DefaultOptions = { [optionOrCommand: string]: DefaultValue | DefaultOptions | undefined };
export type ScriptDefaults = Partial<Record<typeof SCRIPT_COMMANDS[number]['name'], DefaultOptions>>;

export function loadDefaults(repoRoot = path.resolve(import.meta.dir, '../..')): ScriptDefaults {
  const file = path.join(repoRoot, 'defaults.ts');
  try {
    copyFileSync(path.join(repoRoot, 'defaults.example.ts'), file, constants.COPYFILE_EXCL);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const defaults = require(file).default;
  if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults)) {
    throw new Error(`${file} must default-export an object.`);
  }
  return defaults;
}

export function scriptDefaults(name: string, defaults: ScriptDefaults): DefaultOptions {
  const source = SCRIPT_COMMANDS.find(command => command.name === name)?.source;
  const names = SCRIPT_COMMANDS.filter(command => command.source === source).map(command => command.name);
  return Object.assign({}, ...names.filter(alias => alias !== name).map(alias => defaults[alias]), defaults[name as keyof ScriptDefaults]);
}

export const defaults = loadDefaults();
