#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { isCancel, password, text } from '@clack/prompts';
import AnyList, { type AnyListShoppingList } from 'anylist';
import chalk from 'chalk';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import env from './env';

const ENV_LOCAL_PATH = path.resolve(import.meta.dir, '..', '.env.local');
const CREDENTIAL_KEY = 'ANYLIST_CREDENTIALS';
const require = createRequire(import.meta.url);
const FormData = require('form-data') as typeof import('form-data');
const uuid = require('anylist/lib/uuid') as () => string;
const OUTPUT_FORMATS = ['pretty', 'json'] as const;

console.info = (...args: unknown[]) => console.error(...args);

type OutputFormat = (typeof OUTPUT_FORMATS)[number];

interface InputItem {
  name: string;
  serving?: string;
  description?: string;
  categoryMatchId?: string;
}

interface PrintableItem {
  name?: string;
  quantity?: string;
  details?: string | null;
  checked?: boolean | null;
  categoryMatchId?: string | null;
}

interface PrintableList {
  id?: string;
  listId?: string;
  name?: string;
  list?: string;
  items?: PrintableItem[];
}

interface MutationResult {
  list?: string;
  added?: PrintableItem[];
  removed?: PrintableItem[] | number;
  deleted?: string;
  items?: number;
}

interface CreatedShoppingList {
  id: string;
  name: string;
  added: object[];
}

interface CreateShoppingListOptions {
  replaceExisting?: boolean;
}

interface AnyListCategory {
  identifier: string;
  name: string;
  categoryMatchId: string;
}

interface AnyListUserData {
  userCategoriesResponse?: {
    categories?: AnyListCategory[];
  };
  listSettingsResponse?: {
    settings?: Array<{
      identifier?: string;
      listId?: string | null;
      listCategoryGroupId?: string | null;
    }>;
  };
}

async function runCli(): Promise<void> {
  const cli = yargs(hideBin(process.argv))
    .scriptName('anylist')
    .strict()
    .option('format', {
      alias: 'f',
      type: 'string',
      choices: OUTPUT_FORMATS,
      default: 'pretty',
      describe: 'Output format',
    })
    .command('list [list]', 'Print every shopping list and item, or one list by id/name', builder =>
      builder.positional('list', {
        type: 'string',
        describe: 'AnyList shopping list id or name',
      }), async args => {
      const any = await login();
      try {
        const lists = await any.getLists();
        const output = args.list
          ? formatList(getListFromCache(any, args.list))
          : lists.map(formatList);
        printOutput(output, parseOutputFormat(args.format));
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
      await addFromStdin(args.list, parseOutputFormat(args.format), true);
    })
    .command('add <list>', 'Add stdin items to a shopping list', builder =>
      builder.positional('list', {
        type: 'string',
        demandOption: true,
        describe: 'AnyList shopping list name',
      }), async args => {
      await addFromStdin(args.list, parseOutputFormat(args.format));
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
        printOutput({ list: list.name, removed: existingItems.length, added }, parseOutputFormat(args.format));
      } finally {
        any.teardown();
      }
    })
    .command('delete <list>', 'Delete a shopping list', builder =>
      builder.positional('list', {
        type: 'string',
        demandOption: true,
        describe: 'AnyList shopping list name',
      }), async args => {
      const any = await login();
      try {
        const list = await getList(any, args.list);
        const deleted = await deleteList(any, list);
        printOutput(deleted, parseOutputFormat(args.format));
      } finally {
        any.teardown();
      }
    })
    .command('favorite <command>', 'Manage favorite items', builder =>
      builder
        .command('list [list]', 'Print favorite items', favoriteBuilder =>
          favoriteBuilder.positional('list', {
            type: 'string',
            describe: 'AnyList shopping list id or name',
          }), async args => {
          const any = await login();
          try {
            await any.getLists();
            const output = args.list
              ? formatFavoriteList(any, getFavoriteList(any, getListFromCache(any, args.list)))
              : any.lists.map(list => formatFavoriteList(any, getFavoriteList(any, list)));
            printOutput(output, parseOutputFormat(args.format));
          } finally {
            any.teardown();
          }
        })
        .command('set <list>', 'Replace favorite items from stdin', favoriteBuilder =>
          favoriteBuilder.positional('list', {
            type: 'string',
            demandOption: true,
            describe: 'AnyList shopping list id or name',
          }), async args => {
          const items = await readInputItems();
          const any = await login();
          try {
            await any.getLists();
            const list = getListFromCache(any, args.list);
            const favorites = getFavoriteList(any, list);
            const existingItems = favorites.items.slice();
            for (const item of existingItems) {
              await favorites.removeItem(item, true);
            }
            const added = await addItems(any, favorites, items, true);
            printOutput({ list: list.name, removed: existingItems.length, added }, parseOutputFormat(args.format));
          } finally {
            any.teardown();
          }
        })
        .command('remove <list>', 'Remove favorite items by stdin name', favoriteBuilder =>
          favoriteBuilder.positional('list', {
            type: 'string',
            demandOption: true,
            describe: 'AnyList shopping list id or name',
          }), async args => {
          const items = await readInputItems();
          const names = new Set(items.map(item => item.name));
          const any = await login();
          try {
            await any.getLists();
            const list = getListFromCache(any, args.list);
            const favorites = getFavoriteList(any, list);
            const removed = [];
            for (const item of favorites.items.slice()) {
              if (names.has(item.name)) {
                await favorites.removeItem(item, true);
                removed.push(item.toJSON());
              }
            }
            printOutput({ list: list.name, removed }, parseOutputFormat(args.format));
          } finally {
            any.teardown();
          }
        })
        .demandCommand(1),
      async () => undefined)
    .demandCommand(1)
    .help();

  await cli.parse();
}

export async function createShoppingList(
  listName: string,
  items: InputItem[],
  options: CreateShoppingListOptions = {}
): Promise<CreatedShoppingList> {
  const any = await login();
  try {
    await any.getLists();
    const existing = any.getListByName(listName);
    if (existing && options.replaceExisting) {
      await deleteList(any, existing);
    } else if (existing) {
      throw new Error(`AnyList list already exists: ${listName}`);
    }
    const list = await createList(any, listName);
    const added = await addItems(any, list, items.map(normalizeInputItem));
    return {
      id: list.identifier,
      name: list.name,
      added,
    };
  } finally {
    any.teardown();
  }
}

async function addFromStdin(listName: string, format: OutputFormat, createMissing = false): Promise<void> {
  const items = await readInputItems();
  const any = await login();
  try {
    const list = createMissing ? await getOrCreateList(any, listName) : await getList(any, listName);
    const added = await addItems(any, list, items);
    printOutput({ list: list.name, added }, format);
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
        categoryMatchId: record.categorymatchid || record.category,
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
    categoryMatchId: item.categoryMatchId == null ? undefined : String(item.categoryMatchId).trim(),
  };
}

async function getList(any: AnyList, name: string): Promise<AnyListShoppingList> {
  await any.getLists();
  return getListFromCache(any, name);
}

async function getOrCreateList(any: AnyList, name: string): Promise<AnyListShoppingList> {
  await any.getLists();
  return any.getListByName(name) ?? await createList(any, name);
}

function getListFromCache(any: AnyList, nameOrId: string): AnyListShoppingList {
  const list = any.lists.find(candidate => candidate.identifier === nameOrId) ?? any.getListByName(nameOrId);
  if (!list) {
    const available = any.lists.map(candidate => candidate.name).sort().join(', ');
    throw new Error(`AnyList list not found: ${nameOrId}. Available lists: ${available}`);
  }
  return list;
}

async function createList(any: AnyList, name: string): Promise<AnyListShoppingList> {
  const id = uuid();
  const userId = getAnyListUserId(any);
  const op = new any.protobuf.PBListOperation();
  op.setMetadata({
    operationId: uuid(),
    handlerId: 'new-shopping-list',
    userId,
    operationClass: 0,
  });
  op.setListId(id);
  op.setList({
    identifier: id,
    timestamp: Date.now() / 1000,
    name,
    items: [],
    creator: userId,
    UNUSEDATTRIBUTE: [],
    sharedUsers: [],
    notificationLocations: [],
    logicalClockTime: 1,
    allowsMultipleListCategoryGroups: true,
    listItemSortOrder: 0,
    newListItemPosition: 0,
  });

  const ops = new any.protobuf.PBListOperationList();
  ops.setOperations([op]);
  const form = new FormData();
  form.append('operations', ops.toBuffer());
  await any.client.post('data/shopping-lists/update', { body: form });

  const orderOp = new any.protobuf.PBOrderedShoppingListIDsOperation();
  orderOp.setMetadata({
    operationId: uuid(),
    handlerId: 'set-ordered-shopping-list-ids',
  });
  orderOp.setOrderedListIds([id, ...any.lists.map(list => list.identifier)]);

  const orderOps = new any.protobuf.PBOrderedShoppingListIDsOperationList();
  orderOps.setOperations([orderOp]);
  const orderForm = new FormData();
  orderForm.append('operations', orderOps.toBuffer());
  await any.client.post('data/shopping-lists/update-ordered-ids', { body: orderForm });

  await any.getLists(true);
  return getListFromCache(any, id);
}

function getAnyListUserId(any: AnyList): string {
  const token = (any as AnyList & { accessToken?: string }).accessToken;
  const payload = token?.split('.')[1];
  if (!payload) {
    throw new Error('AnyList access token did not include a user id.');
  }
  const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { sub?: string };
  if (!parsed.sub) {
    throw new Error('AnyList access token did not include a user id.');
  }
  return parsed.sub;
}

async function addItems(any: AnyList, list: AnyListShoppingList, items: InputItem[], isFavorite = false): Promise<object[]> {
  const added = [];
  const categorizedItems = items.filter(item => item.categoryMatchId);
  const categoryContext = categorizedItems.length > 0 && !isFavorite
    ? await getCategoryContext(any, list.identifier)
    : null;
  for (const input of items) {
    if (input.categoryMatchId && categoryContext) {
      const item = await addCategorizedItem(any, list, input, categoryContext);
      added.push(item);
      continue;
    }

    let item = any.createItem({
      name: input.name,
      quantity: input.serving,
      details: input.description,
    });
    item = await list.addItem(item, isFavorite);
    added.push(item.toJSON());
  }
  return added;
}

async function getCategoryContext(any: AnyList, listId: string): Promise<{
  userId: string;
  listCategoryGroupId: string;
  categories: Map<string, AnyListCategory>;
}> {
  const userData = await (any as AnyList & {
    _getUserData: (refresh?: boolean) => Promise<AnyListUserData>;
  })._getUserData(true);
  const listCategoryGroupId = userData.listSettingsResponse?.settings
    ?.find(setting => setting.listId === listId)
    ?.listCategoryGroupId;
  if (!listCategoryGroupId) {
    throw new Error(`AnyList did not return a category group for list: ${listId}`);
  }

  return {
    userId: getAnyListUserId(any),
    listCategoryGroupId,
    categories: new Map((userData.userCategoriesResponse?.categories ?? [])
      .map(category => [category.categoryMatchId, category])),
  };
}

async function addCategorizedItem(
  any: AnyList,
  list: AnyListShoppingList,
  input: InputItem,
  context: {
    userId: string;
    listCategoryGroupId: string;
    categories: Map<string, AnyListCategory>;
  }
): Promise<object> {
  const category = context.categories.get(input.categoryMatchId ?? '');
  if (!category) {
    throw new Error(`Unknown AnyList category: ${input.categoryMatchId}`);
  }

  const itemId = uuid();
  const assignmentId = uuid();
  const listItem = new (any.protobuf as typeof any.protobuf & {
    ListItem: new (item: Record<string, unknown>) => unknown;
  }).ListItem({
    identifier: itemId,
    listId: list.identifier,
    name: input.name,
    details: input.description,
    checked: false,
    category: category.categoryMatchId,
    userId: context.userId,
    categoryMatchId: category.categoryMatchId,
    categoryAssignments: [{
      identifier: assignmentId,
      categoryGroupId: context.listCategoryGroupId,
      categoryId: category.identifier,
    }],
    quantityPb: input.serving ? { amount: input.serving } : undefined,
    photoIds: [],
    storeIds: [],
    prices: [],
    ingredients: [],
  });

  const op = new any.protobuf.PBListOperation();
  op.setMetadata({
    operationId: uuid(),
    handlerId: 'add-shopping-list-item',
    userId: context.userId,
  });
  op.setListId(list.identifier);
  op.setListItemId(itemId);
  (op as typeof op & { setListItem: (item: unknown) => void }).setListItem(listItem);

  const ops = new any.protobuf.PBListOperationList();
  ops.setOperations([op]);
  const form = new FormData();
  form.append('operations', ops.toBuffer());
  await any.client.post('data/shopping-lists/update', { body: form });

  return {
    listId: list.identifier,
    identifier: itemId,
    name: input.name,
    details: input.description,
    quantity: input.serving,
    checked: false,
    categoryMatchId: category.categoryMatchId,
  };
}

async function deleteList(any: AnyList, list: AnyListShoppingList): Promise<object> {
  const userData = await (any as AnyList & { _getUserData: (refresh?: boolean) => Promise<{
    listFoldersResponse?: { listDataId?: string };
    listSettingsResponse?: { settings?: Array<{ identifier?: string; listId?: string | null }> };
  }> })._getUserData(true);
  const userId = getAnyListUserId(any);
  const listDataId = userData.listFoldersResponse?.listDataId;
  const settingsId = userData.listSettingsResponse?.settings?.find(setting => setting.listId === list.identifier)?.identifier;
  if (!listDataId || !settingsId) {
    throw new Error(`AnyList did not return folder/settings metadata for list: ${list.name}`);
  }

  const folderItem = new any.protobuf.PBListFolderItem({
    identifier: list.identifier,
    itemType: 0,
  });
  const folderOp = new any.protobuf.PBListFolderOperation();
  folderOp.setMetadata({
    operationId: uuid(),
    handlerId: 'delete-folder-items',
    userId,
    operationClass: 0,
  });
  folderOp.setListDataId(listDataId);
  folderOp.setFolderItems([folderItem]);
  const folderOps = new any.protobuf.PBListFolderOperationList();
  folderOps.setOperations([folderOp]);
  const folderForm = new FormData();
  folderForm.append('operations', folderOps.toBuffer());
  await any.client.post('data/list-folders/update', { body: folderForm });

  const settings = new any.protobuf.PBListSettings({
    identifier: settingsId,
    userId,
    listId: list.identifier,
  });
  const settingsOp = new any.protobuf.PBListSettingsOperation();
  settingsOp.setMetadata({
    operationId: uuid(),
    handlerId: 'remove-list-settings',
    userId,
    operationClass: 0,
  });
  settingsOp.setUpdatedSettings(settings);
  const settingsOps = new any.protobuf.PBListSettingsOperationList();
  settingsOps.setOperations([settingsOp]);
  const settingsForm = new FormData();
  settingsForm.append('operations', settingsOps.toBuffer());
  await any.client.post('data/list-settings/update', { body: settingsForm });

  await any.getLists(true);
  if (any.getListByName(list.name)) {
    throw new Error(`AnyList still returned list after deletion: ${list.name}`);
  }

  return {
    deleted: list.name,
    id: list.identifier,
    items: list.items.length,
  };
}

function formatList(list: AnyListShoppingList): object {
  return {
    id: list.identifier,
    name: list.name,
    items: list.items.map(item => item.toJSON()),
  };
}

function getFavoriteList(any: AnyList, list: AnyListShoppingList): AnyListShoppingList {
  const favorites = any.getFavoriteItemsByListId(list.identifier);
  if (!favorites) {
    throw new Error(`AnyList favorites not found for list: ${list.name}`);
  }
  return favorites;
}

function formatFavoriteList(any: AnyList, favorites: AnyListShoppingList): object {
  const parent = any.lists.find(list => list.identifier === favorites.parentId);
  return {
    listId: favorites.parentId,
    list: parent?.name ?? favorites.parentId,
    items: favorites.items.map(item => item.toJSON()),
  };
}

function parseOutputFormat(value: unknown): OutputFormat {
  if (typeof value === 'string' && (OUTPUT_FORMATS as readonly string[]).includes(value)) {
    return value as OutputFormat;
  }
  throw new Error(`Invalid output format: ${value}`);
}

function printOutput(value: unknown, format: OutputFormat): void {
  if (format === 'json') {
    console.log(JSON.stringify(value));
    return;
  }

  console.log(formatPretty(value));
}

function formatPretty(value: unknown): string {
  if (Array.isArray(value) && value.every(isPrintableList)) {
    return value.map(formatPrettyList).join('\n\n');
  }
  if (isPrintableList(value)) {
    return formatPrettyList(value);
  }
  if (isMutationResult(value)) {
    return formatMutationResult(value);
  }
  return JSON.stringify(value, null, 2);
}

function isPrintableList(value: unknown): value is PrintableList {
  return !!value
    && typeof value === 'object'
    && Array.isArray((value as PrintableList).items)
    && (typeof (value as PrintableList).name === 'string' || typeof (value as PrintableList).list === 'string');
}

function formatPrettyList(list: PrintableList): string {
  const items = list.items ?? [];
  const unchecked = items.filter(item => item.checked !== true);
  const checkedCount = items.length - unchecked.length;
  const lines = [formatPrettyListHeader(list)];
  const categories = groupItemsByCategory(unchecked);

  if (categories.size > 1) {
    for (const [category, categoryItems] of categories) {
      lines.push(`  ${chalk.bold(formatCategoryName(category))}`);
      for (const item of categoryItems) {
        lines.push(`    ${formatPrettyItem(item)}`);
      }
    }
  } else {
    for (const item of unchecked) {
      lines.push(`  ${formatPrettyItem(item)}`);
    }
  }

  if (checkedCount > 0) {
    lines.push(chalk.gray(`  + ${checkedCount} checked items`));
  }

  return lines.join('\n');
}

function formatPrettyListHeader(list: PrintableList): string {
  const name = chalk.bold(list.name ?? list.list ?? 'Unnamed List');
  const id = list.id ?? list.listId;
  return id ? `${name} ${chalk.gray(id)}` : name;
}

function groupItemsByCategory(items: PrintableItem[]): Map<string, PrintableItem[]> {
  const categories = new Map<string, PrintableItem[]>();
  for (const item of items) {
    const category = item.categoryMatchId?.trim() || 'uncategorized';
    const categoryItems = categories.get(category) ?? [];
    categoryItems.push(item);
    categories.set(category, categoryItems);
  }
  return categories;
}

function formatCategoryName(category: string): string {
  if (category === 'uncategorized') {
    return 'Uncategorized';
  }
  return category
    .split('-')
    .filter(Boolean)
    .map(word => word[0].toUpperCase() + word.slice(1))
    .join(' ');
}

function formatPrettyItem(item: PrintableItem): string {
  const parts = [item.name ?? 'Unnamed Item'];
  if (item.quantity) {
    parts.push(`(${item.quantity})`);
  }
  if (item.details) {
    parts.push(`- ${item.details}`);
  }
  return parts.join(' ');
}

function isMutationResult(value: unknown): value is MutationResult {
  return !!value && typeof value === 'object';
}

function formatMutationResult(value: MutationResult): string {
  if (value.deleted) {
    return `Deleted ${chalk.bold(value.deleted)}${typeof value.items === 'number' ? ` (${value.items} items)` : ''}`;
  }

  const lines = value.list ? [chalk.bold(value.list)] : [];
  if (Array.isArray(value.added) && value.added.length > 0) {
    lines.push(...value.added.map(item => `  ${formatPrettyItem(item)}`));
  }
  if (Array.isArray(value.removed) && value.removed.length > 0) {
    lines.push(chalk.gray(`  - ${value.removed.length} removed ${value.removed.length === 1 ? 'item' : 'items'}`));
  } else if (typeof value.removed === 'number' && value.removed > 0) {
    lines.push(chalk.gray(`  - ${value.removed} removed ${value.removed === 1 ? 'item' : 'items'}`));
  }

  return lines.length > 0 ? lines.join('\n') : JSON.stringify(value, null, 2);
}

if (import.meta.main) {
  runCli().catch(error => {
    console.error(error);
    process.exit(1);
  });
}
