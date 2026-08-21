import type { Argv } from 'yargs';

export function failWithFullHelp(message: string, error: Error, parser: Argv): never {
  parser.showHelp('error');
  throw error ?? new Error(message);
}
