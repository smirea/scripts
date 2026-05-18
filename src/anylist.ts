#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { isCancel, password, text } from '@clack/prompts';
import AnyList, { type AnyListShoppingList } from 'anylist';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import env from './env';

const ENV_LOCAL_PATH = path.resolve(import.meta.dir, '..', '.env.local');
const CREDENTIAL_KEY = 'ANYLIST_CREDENTIALS';

console.info = (...args: unknown[]) => console.error(...args);

interface InputItem {
  name: string;
  serving?: string;
  description?: string;
}

async function runCli(): Promise<void> {
  const cli = yargs(hideBin(process.argv))
    .scriptName('anylist')
    .strict()
    .command('list', 'Print every shopping list and item', builder =>
      builder.option('pretty', {
        type: 'boolean',
        default: true,
        describe: 'Pretty-print JSON output',
      }), async args => {
      const any = await login();
      try {
        const lists = await any.getLists();
        printJson(lists.map(formatList), Boolean(args.pretty));
      } finally {
        any.teardown();
      }
    })
    .command('create [list]', 'Create items from stdin, optionally adding them to a list', builder =>
      builder.positional('list', {
        type: 'string',
        describe: 'AnyList shopping list name to add items to',
      }), async args => {
      if (!args.list) {
        throw new Error('The anylist package only creates items inside a list. Pass `create <list>` or use `add <list>`.');
      }
      await addFromStdin(args.list);
    })
    .command('add <list>', 'Add stdin items to a shopping list', builder =>
      builder.positional('list', {
        type: 'string',
        demandOption: true,
        describe: 'AnyList shopping list name',
      }), async args => {
      await addFromStdin(args.list);
    })
    .command('set <list>', 'Replace a shopping list with stdin items', builder =>
      builder.positional('list', {
        type: 'string',
        demandOption: true,
        describe: 'AnyList shopping list name',
      }), async args => {
      const items = await readInputItems();
      const any = await login();
      try {
        const list = await getList(any, args.list);
        const existingItems = list.items.slice();
        for (const item of existingItems) {
          await list.removeItem(item);
        }
        const added = await addItems(any, list, items);
        printJson({ list: list.name, removed: existingItems.length, added });
      } finally {
        any.teardown();
      }
    })
    .demandCommand(1)
    .help();

  await cli.parse();
}

async function addFromStdin(listName: string): Promise<void> {
  const items = await readInputItems();
  const any = await login();
  try {
    const list = await getList(any, listName);
    const added = await addItems(any, list, items);
    printJson({ list: list.name, added });
  } finally {
    any.teardown();
  }
}

async function login(): Promise<AnyList> {
  const credentials = env.ANYLIST_CREDENTIALS ?? await promptAndSaveCredentials();
  const separatorIndex = credentials.indexOf(':');
  if (separatorIndex === -1) {
    throw new Error(`${CREDENTIAL_KEY} must be formatted as email:password`);
  }

  const any = new AnyList({
    email: credentials.slice(0, separatorIndex),
    password: credentials.slice(separatorIndex + 1),
    credentialsFile: path.join(process.env.HOME ?? '.', '.anylist_credentials'),
  });
  await any.login(false);
  return any;
}

async function promptAndSaveCredentials(): Promise<string> {
  const email = await text({
    message: 'AnyList email',
    validate: value => value?.includes('@') ? undefined : 'Enter an email address.',
  });
  if (isCancel(email)) {
    throw new Error('Cancelled.');
  }

  const passwordValue = await password({
    message: 'AnyList password',
    validate: value => value && value.length > 0 ? undefined : 'Enter a password.',
  });
  if (isCancel(passwordValue)) {
    throw new Error('Cancelled.');
  }

  const credentials = `${email}:${passwordValue}`;
  setEnvLocalValue(CREDENTIAL_KEY, credentials);
  runEnvManagerTs();
  return credentials;
}

function setEnvLocalValue(key: string, value: string): void {
  const line = `${key}=${quoteEnvValue(value)}`;
  const content = existsSync(ENV_LOCAL_PATH) ? readFileSync(ENV_LOCAL_PATH, 'utf8') : '';
  const lines = content.split(/\r?\n/);
  const index = lines.findIndex(existing => existing.trimStart().startsWith(`${key}=`));
  if (index === -1) {
    const next = content.trimEnd();
    writeFileSync(ENV_LOCAL_PATH, `${next}${next ? '\n' : ''}${line}\n`);
    return;
  }

  lines[index] = line;
  writeFileSync(ENV_LOCAL_PATH, `${lines.join('\n').replace(/\n*$/, '')}\n`);
}

function quoteEnvValue(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function runEnvManagerTs(): void {
  const result = spawnSync('env-manager', ['ts'], {
    cwd: path.resolve(import.meta.dir, '..'),
    encoding: 'utf8',
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error('env-manager ts failed after saving AnyList credentials.');
  }
}

async function readInputItems(): Promise<InputItem[]> {
  const raw = await Bun.stdin.text();
  if (raw.trim() === '') {
    throw new Error('Expected CSV or JSON on stdin with name, serving, description.');
  }

  const items = raw.trimStart().startsWith('[') || raw.trimStart().startsWith('{')
    ? parseJsonItems(raw)
    : parseCsvItems(raw);
  if (items.length === 0) {
    throw new Error('No items found in stdin.');
  }
  return items.map(normalizeInputItem);
}

function parseJsonItems(raw: string): InputItem[] {
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function parseCsvItems(raw: string): InputItem[] {
  const rows = parseCsvRows(raw);
  if (rows.length < 2) {
    throw new Error('CSV input needs a header row and at least one item row.');
  }

  const headers = rows[0].map(cell => cell.trim().toLowerCase());
  return rows.slice(1)
    .filter(row => row.some(cell => cell.trim() !== ''))
    .map(row => {
      const record = Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ''])) as Record<string, string>;
      return {
        name: record.name ?? '',
        serving: record.serving,
        description: record.description,
      };
    });
}

function parseCsvRows(raw: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    const next = raw[i + 1];
    if (quoted) {
      if (char === '"' && next === '"') {
        cell += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n') {
      row.push(cell.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }

  row.push(cell.replace(/\r$/, ''));
  rows.push(row);
  return rows;
}

function normalizeInputItem(item: InputItem): InputItem {
  const name = String(item.name ?? '').trim();
  if (!name) {
    throw new Error(`Invalid item without name: ${JSON.stringify(item)}`);
  }

  return {
    name,
    serving: item.serving == null ? undefined : String(item.serving).trim(),
    description: item.description == null ? undefined : String(item.description).trim(),
  };
}

async function getList(any: AnyList, name: string): Promise<AnyListShoppingList> {
  await any.getLists();
  const list = any.getListByName(name);
  if (!list) {
    const available = any.lists.map(candidate => candidate.name).sort().join(', ');
    throw new Error(`AnyList list not found: ${name}. Available lists: ${available}`);
  }
  return list;
}

async function addItems(any: AnyList, list: AnyListShoppingList, items: InputItem[]): Promise<object[]> {
  const added = [];
  for (const input of items) {
    let item = any.createItem({
      name: input.name,
      quantity: input.serving,
      details: input.description,
    });
    item = await list.addItem(item);
    added.push(item.toJSON());
  }
  return added;
}

function formatList(list: AnyListShoppingList): object {
  return {
    id: list.identifier,
    name: list.name,
    items: list.items.map(item => item.toJSON()),
  };
}

function printJson(value: unknown, pretty = true): void {
  console.log(JSON.stringify(value, null, pretty ? 2 : 0));
}

if (import.meta.main) {
  runCli().catch(error => {
    console.error(error);
    process.exit(1);
  });
}
