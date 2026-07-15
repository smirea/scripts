#!/usr/bin/env bun
import { writeFileSync } from 'node:fs';
import path from 'node:path';

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import env from './env';
import { renderCsvRecords, renderTableRecords, type CsvValue } from './utils/output';

const API_BASE_URL = 'https://subscription.cookunity.com/sdui-service';
const API_VERSION = '1.25.0';
const SEARCH_PAGE_SIZE = 150;
const MAX_SEARCH_PAGES = 20;
const OUTPUT_FORMATS = ['csv', 'json', 'table'] as const;
const CSV_COLUMNS = [
  'sections',
  'name',
  'subtitle',
  'chef',
  'calories',
  'protein_g',
  'carbs_g',
  'fat_g',
  'price',
  'premium_fee',
  'is_premium',
  'inventory_id',
  'link',
  'api_url',
] as const;

type OutputFormat = (typeof OUTPUT_FORMATS)[number];
type JsonObject = Record<string, unknown>;

interface CatalogProduct {
  sections: string[];
  name: string;
  subtitle: string | null;
  chef: string | null;
  calories: number | null;
  proteinG: number | null;
  carbsG: number | null;
  fatG: number | null;
  price: number | null;
  premiumFee: number | null;
  isPremium: boolean | null;
  inventoryId: string;
  link: string | null;
  apiUrl: string;
}

interface CatalogArgs {
  date: string;
  details: boolean;
  concurrency: number;
  format: OutputFormat;
  output?: string;
  quiet: boolean;
}

interface LazyClusterRequest {
  path: string;
  params: JsonObject;
  sections: string[];
}

if (import.meta.main) {
  runCli().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

async function runCli(): Promise<void> {
  await yargs(hideBin(process.argv))
    .scriptName('cookunity')
    .version(false)
    .usage('$0 catalog <date> [options]')
    .command(
      'catalog <date>',
      'Fetch every available CookUnity food item and its macros from the private API.',
      command =>
        command
          .positional('date', {
            type: 'string',
            demandOption: true,
            describe: 'Delivery date in YYYY-MM-DD format.',
          })
          .option('details', {
            type: 'boolean',
            default: true,
            describe: 'Fetch each product-detail endpoint for complete macros.',
          })
          .option('concurrency', {
            alias: ['c'],
            type: 'number',
            default: 8,
            describe: 'Maximum concurrent product-detail requests.',
          })
          .option('format', {
            alias: ['f'],
            type: 'string',
            choices: OUTPUT_FORMATS,
            default: 'csv',
            describe: 'Output format.',
          })
          .option('output', {
            alias: ['o'],
            type: 'string',
            describe: 'Write output to this file instead of stdout.',
          })
          .option('quiet', {
            alias: ['q'],
            type: 'boolean',
            default: false,
            describe: 'Hide progress messages.',
          }),
      async argv => {
        await runCatalog({
          date: argv.date,
          details: argv.details,
          concurrency: argv.concurrency,
          format: parseOutputFormat(argv.format),
          output: argv.output,
          quiet: argv.quiet,
        });
      },
    )
    .strict()
    .strictCommands()
    .demandCommand(1, 'Choose a CookUnity command.')
    .recommendCommands()
    .showHelpOnFail(false)
    .wrap(process.stdout.columns || 100)
    .fail((message, error) => {
      throw error ?? new Error(message);
    })
    .help()
    .parseAsync();
}

async function runCatalog(args: CatalogArgs): Promise<void> {
  assertDate(args.date);
  if (!Number.isInteger(args.concurrency) || args.concurrency < 1 || args.concurrency > 30) {
    throw new Error('--concurrency must be an integer from 1 to 30.');
  }

  const token = env.COOKUNITY_ACCESS_TOKEN?.trim();
  if (!token) {
    throw new Error(tokenRecoveryMessage('missing'));
  }

  const client = new CookUnityClient(token);
  const products = new Map<string, CatalogProduct>();
  const menu = await client.get(`/web/view/menu/${args.date}/clustered-results`);
  collectProducts(menu, products, ['Menu'], args.date);
  const clusters = extractLazyClusters(menu);
  log(args.quiet, `Fetching ${clusters.length} menu sections...`);
  await mapConcurrent(clusters, args.concurrency, async cluster => {
    const response = await client.get(withQuery(cluster.path, cluster.params));
    collectProducts(response, products, cluster.sections, args.date);
  });
  await collectSearchPages(client, args.date, products);
  if (products.size === 0) {
    throw new Error('CookUnity returned no products. The menu API response may have changed.');
  }
  log(args.quiet, `Found ${products.size} unique items from the menu and search APIs.`);

  if (args.details) {
    log(args.quiet, `Fetching complete macros with concurrency ${args.concurrency}...`);
    await hydrateDetails(client, args.date, products, args.concurrency, args.quiet);
  }

  const sorted = [...products.values()].sort((left, right) => left.name.localeCompare(right.name));
  renderOutput(sorted, args);
  log(args.quiet, `Wrote ${sorted.length} CookUnity items.`);
}

class CookUnityClient {
  readonly authorization: string;

  constructor(token: string) {
    this.authorization = token.replace(/^Bearer\s+/i, '');
  }

  async get(requestPath: string): Promise<unknown> {
    const url = `${API_BASE_URL}${requestPath}`;
    const response = await fetch(url, {
      headers: {
        Authorization: this.authorization,
        'Content-Type': 'application/json',
        'accept-version': API_VERSION,
        platform: 'web',
      },
    });
    const text = await response.text();

    if (!response.ok) {
      const reason = apiErrorMessage(text);
      if (response.status === 401) {
        throw new Error(tokenRecoveryMessage('invalid or expired', reason));
      }
      throw new Error(`CookUnity API returned ${response.status} for ${url}. ${reason}`.trim());
    }
    if (!text.trim()) return null;

    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error(`CookUnity returned non-JSON content for ${url}.`);
    }
  }
}

async function collectSearchPages(
  client: CookUnityClient,
  date: string,
  products: Map<string, CatalogProduct>,
): Promise<void> {
  for (let page = 1; page <= MAX_SEARCH_PAGES; page += 1) {
    const params = new URLSearchParams({
      date,
      origin: 'typing',
      page: String(page),
      limit: String(SEARCH_PAGE_SIZE),
    });
    const response = await client.get(`/view/search?${params}`);
    const count = collectProducts(response, products, ['Search'], date);
    if (count < SEARCH_PAGE_SIZE) return;
  }
}

async function hydrateDetails(
  client: CookUnityClient,
  date: string,
  products: Map<string, CatalogProduct>,
  concurrency: number,
  quiet: boolean,
): Promise<void> {
  const entries = [...products.entries()];
  await mapConcurrent(entries, concurrency, async ([inventoryId, product]) => {
    try {
      const detail = await client.get(
        `/menu/product/${encodeURIComponent(inventoryId)}?date=${encodeURIComponent(date)}`,
      );
      const hydrated = findProduct(detail, inventoryId, product.sections, date);
      if (hydrated) products.set(inventoryId, mergeProducts(product, hydrated));
    } catch (error) {
      log(quiet, `Skipped details for ${product.name}: ${errorMessage(error)}`);
    }
  });
}

function collectProducts(
  root: unknown,
  products: Map<string, CatalogProduct>,
  initialSections: string[],
  date: string,
): number {
  const found = new Set<string>();
  walkObjects(root, initialSections, (record, sections) => {
    const product = parseProduct(record, sections, date);
    if (!product) return;
    found.add(product.inventoryId);
    products.set(product.inventoryId, mergeProducts(products.get(product.inventoryId), product));
  });
  return found.size;
}

function findProduct(
  root: unknown,
  inventoryId: string,
  sections: string[],
  date: string,
): CatalogProduct | null {
  let match: CatalogProduct | null = null;
  walkObjects(root, sections, record => {
    if (readString(record.inventoryId) !== inventoryId) return;
    match = parseProduct(record, sections, date);
  });
  return match;
}

function extractLazyClusters(root: unknown): LazyClusterRequest[] {
  const body = asObject(root)?.body;
  if (!Array.isArray(body)) return [];

  const requests: LazyClusterRequest[] = [];
  let sectionTitle: string | null = null;
  for (const item of body) {
    const attributes = asObject(asObject(item)?.attributes);
    const header = asObject(asObject(attributes?.fullMenuHeader)?.attributes);
    sectionTitle = readText(header?.title) ?? sectionTitle;
    const anchor = readText(header?.anchor);
    const lazy = asObject(asObject(attributes?.lazyCluster)?.attributes);
    const path = readString(lazy?.path);
    const params = asObject(lazy?.params);
    if (!path || !params) continue;

    requests.push({
      path,
      params,
      sections: unique(['Menu', sectionTitle, anchor]),
    });
  }
  return requests;
}

function walkObjects(
  root: unknown,
  initialSections: string[],
  callback: (record: JsonObject, sections: string[]) => void,
): void {
  const seen = new Set<object>();
  const visit = (value: unknown, sections: string[]): void => {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item, sections);
      return;
    }

    const record = value as JsonObject;
    callback(record, sections);
    const nextSections = addSectionNames(sections, record);
    for (const child of Object.values(record)) visit(child, nextSections);
  };
  visit(root, initialSections);
}

function parseProduct(record: JsonObject, sections: string[], date: string): CatalogProduct | null {
  const inventoryId = readString(record.inventoryId);
  const name = readString(record.name);
  if (!inventoryId || !name) return null;

  const nutrition = asObject(record.nutritionalInfo);
  const chef = asObject(record.chef);
  const chefName = [readString(chef?.firstname), readString(chef?.lastname)].filter(Boolean).join(' ') || null;
  const publicUrl = readString(record.publicUrl);

  return {
    sections: unique(sections),
    name,
    subtitle: readString(record.shortDescription) ?? readString(record.description),
    chef: chefName,
    calories: readNumber(record.calories) ?? readNumber(nutrition?.calories),
    proteinG: readNumber(nutrition?.protein),
    carbsG: readNumber(nutrition?.carbs),
    fatG: readNumber(nutrition?.fat),
    price: readNumber(record.finalPrice) ?? readNumber(record.price),
    premiumFee: readNumber(record.premiumFee),
    isPremium: readBoolean(record.isPremiumMeal),
    inventoryId,
    link: publicUrl ? new URL(publicUrl, 'https://subscription.cookunity.com').toString() : null,
    apiUrl: `${API_BASE_URL}/menu/product/${encodeURIComponent(inventoryId)}?date=${encodeURIComponent(date)}`,
  };
}

function mergeProducts(current: CatalogProduct | undefined, incoming: CatalogProduct): CatalogProduct {
  if (!current) return incoming;
  return {
    sections: unique([...current.sections, ...incoming.sections]),
    name: incoming.name,
    subtitle: incoming.subtitle ?? current.subtitle,
    chef: incoming.chef ?? current.chef,
    calories: incoming.calories ?? current.calories,
    proteinG: incoming.proteinG ?? current.proteinG,
    carbsG: incoming.carbsG ?? current.carbsG,
    fatG: incoming.fatG ?? current.fatG,
    price: incoming.price ?? current.price,
    premiumFee: incoming.premiumFee ?? current.premiumFee,
    isPremium: incoming.isPremium ?? current.isPremium,
    inventoryId: incoming.inventoryId,
    link: incoming.link ?? current.link,
    apiUrl: incoming.apiUrl,
  };
}

function addSectionNames(sections: string[], record: JsonObject): string[] {
  if (!['body', 'content', 'items', 'products', 'children', 'categories'].some(key => Array.isArray(record[key]))) {
    return sections;
  }
  const metadata = asObject(record.metadata);
  const labels = [
    readText(record.title),
    readText(record.header),
    readString(metadata?.categoryName),
    readString(metadata?.subcategoryName),
  ].filter((value): value is string => Boolean(value && value.length <= 100));
  return unique([...sections, ...labels]);
}

function renderOutput(products: CatalogProduct[], args: CatalogArgs): void {
  if (args.format === 'table') {
    if (args.output) throw new Error('--output is not supported with --format=table.');
    renderTableRecords(products.map(toDisplayRow));
    return;
  }

  const text =
    args.format === 'json'
      ? `${JSON.stringify({ date: args.date, count: products.length, products }, null, 2)}\n`
      : renderCsvRecords(products.map(toCsvRow), CSV_COLUMNS, {
          valueFormatters: {
            price: value => value,
            premium_fee: value => value,
          },
        });
  if (args.output) {
    const outputPath = path.resolve(args.output);
    writeFileSync(outputPath, text, 'utf8');
    process.stdout.write(`${outputPath}\n`);
    return;
  }
  process.stdout.write(text);
}

function toDisplayRow(product: CatalogProduct): object {
  return {
    name: product.name,
    calories: product.calories,
    protein: product.proteinG,
    carbs: product.carbsG,
    fat: product.fatG,
    premium: product.isPremium,
    sections: product.sections.join('; '),
  };
}

function toCsvRow(product: CatalogProduct): Record<string, CsvValue> {
  return {
    sections: product.sections.join('; '),
    name: product.name,
    subtitle: product.subtitle,
    chef: product.chef,
    calories: product.calories,
    protein_g: product.proteinG,
    carbs_g: product.carbsG,
    fat_g: product.fatG,
    price: product.price,
    premium_fee: product.premiumFee,
    is_premium: product.isPremium == null ? null : String(product.isPremium),
    inventory_id: product.inventoryId,
    link: product.link,
    api_url: product.apiUrl,
  };
}

async function mapConcurrent<T>(
  values: T[],
  concurrency: number,
  callback: (value: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (nextIndex < values.length) {
        const value = values[nextIndex];
        nextIndex += 1;
        if (value !== undefined) await callback(value);
      }
    }),
  );
}

function readText(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  const record = asObject(value);
  if (!record) return null;
  return (
    readString(record.value) ??
    readText(record.text) ??
    readText(record.title) ??
    readText(record.attributes)
  );
}

function readString(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function readNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const match = value.replaceAll(',', '').match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function readBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : null;
}

function unique(values: Array<string | null>): string[] {
  return [...new Set(values.map(value => value?.trim()).filter((value): value is string => Boolean(value)))];
}

function withQuery(pathname: string, params: JsonObject): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      query.set(key, String(value));
    }
  }
  return `${pathname}?${query}`;
}

function parseOutputFormat(value: string): OutputFormat {
  if ((OUTPUT_FORMATS as readonly string[]).includes(value)) return value as OutputFormat;
  throw new Error(`Invalid output format: ${value}`);
}

function apiErrorMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as JsonObject;
    return readString(parsed.message) ?? readString(parsed.reason) ?? '';
  } catch {
    return body.trim().slice(0, 300);
  }
}

function tokenRecoveryMessage(status: string, reason = ''): string {
  const detail = reason ? ` (${reason})` : '';
  return `CookUnity access token is ${status}${detail}.

Refresh it with the signed-in CookUnity Chrome tab:
1. Run /Users/stefan/code/chrome-browsergate/scripts/invoke get-session https://subscription.cookunity.com/menu --json
2. Copy the token field into COOKUNITY_ACCESS_TOKEN in /Users/stefan/code/scripts/.env.local.
3. Run the command again.`;
}

function assertDate(value: string): void {
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00Z`) : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error('Date must use YYYY-MM-DD format.');
  }
}

function log(quiet: boolean, message: string): void {
  if (!quiet) console.error(message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
