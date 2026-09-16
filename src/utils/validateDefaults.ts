import yargs, { type Argv } from 'yargs';

import type { DefaultOptions } from './defaults';

export interface DefaultCommand {
  names: string[];
  builder: any;
}

export function commandDefinition(params: any[]): DefaultCommand {
  if (typeof params[0] === 'object' && !Array.isArray(params[0])) {
    const module = params[0];
    return commandDefinition([[module.command].flat().concat(module.aliases ?? []), '', module.builder]);
  }
  return { names: [params[0]].flat().map((name: string) => name.split(' ')[0]), builder: params[2] };
}

export function validateCliDefaults(
  parser: Argv,
  scope: DefaultOptions,
  commands: DefaultCommand[],
  location: string,
  inherited = new Set<string>(),
): void | Promise<void> {
  // yargs exposes runtime option metadata, but @types/yargs does not declare it.
  const metadata = (parser as Argv & { getOptions(): { key: Record<string, unknown>; alias: Record<string, string[]> } }).getOptions();
  const options = new Set([...inherited, ...Object.keys(metadata.key), ...Object.values(metadata.alias).flat()]);
  for (const option of options) options.add(option.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase()));
  const pending: Promise<void>[] = [];
  for (const [key, value] of Object.entries(scope)) {
    if (value === undefined) continue;
    const nested = value !== null && typeof value === 'object' && !Array.isArray(value);
    const command = commands.find(command => command.names.includes(key));
    if (nested && command) {
      const childParser = yargs([]).help().version(false);
      const children: DefaultCommand[] = [];
      childParser.command = ((...params: any[]) => {
        children.push(commandDefinition(params));
        return childParser;
      }) as Argv['command'];
      const result = typeof command.builder === 'function'
        ? command.builder(childParser, true)
        : childParser.options(command.builder ?? {});
      const finish = (built: Argv | void) => validateCliDefaults(built ?? childParser, value as DefaultOptions, children, `${location}.${key}`, options);
      const validation = result instanceof Promise ? result.then(finish) : finish(result);
      if (validation instanceof Promise) pending.push(validation);
    } else if (nested || !options.has(key)) {
      console.warn(`[defaults.ts] Unknown ${nested ? 'command' : 'option'} "${location}.${key}"; ignoring it.`);
      delete scope[key];
    }
  }
  if (pending.length) return Promise.all(pending).then(() => {});
}
