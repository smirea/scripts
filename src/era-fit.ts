#!/usr/bin/env bun
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';

import { isCancel, password, text } from '@clack/prompts';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import env from './env';
import { createScript } from './utils/createScript';
import {
  OUTPUT_FORMATS,
  parseOutputFormat,
  renderCsvRecords,
  renderTableRecords,
  type CsvValue,
  type OutputFormat,
} from './utils/output';

const BASE_URL = 'https://app.erafit.com';
const SOURCE_PATH = 'api://era-fit/nutrition';
const DEFAULT_DASHBOARD_PATH = '/clients/dashboard';
const DEFAULT_DAYS = 1;
const API_RETRY_ATTEMPTS = 3;
const ENV_LOCAL_PATH = path.resolve(import.meta.dir, '..', '.env.local');
const SESSION_ENV_KEY = 'ERA_FIT_SESSION_COOKIE';
const CREDENTIALS_ENV_KEY = 'ERA_FIT_CREDENTIALS';
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MEAL_KEYS = ['breakfast', 'snack_am', 'lunch', 'snack_pm', 'dinner', 'snack_evening'] as const;
const MEAL_LABELS: Record<(typeof MEAL_KEYS)[number], string> = {
  breakfast: 'Breakfast',
  snack_am: 'AM Snack',
  lunch: 'Lunch',
  snack_pm: 'PM Snack',
  dinner: 'Dinner',
  snack_evening: 'Evening Snack',
};
const DAILY_COLUMNS = [
  'date',
  'template',
  'status',
  'calories',
  'goal_calories',
  'remaining_calories',
  'macro_calories',
  'protein',
  'goal_protein',
  'remaining_protein',
  'net_carbs',
  'goal_net_carbs',
  'remaining_net_carbs',
  'fat',
  'goal_fat',
  'remaining_fat',
  'foods_logged',
] as const;
const FOOD_COLUMNS = [
  'date',
  'time',
  'meal',
  'kind',
  'name',
  'brand',
  'serving',
  'calories',
  'protein',
  'net_carbs',
  'fat',
] as const;
const TEMPLATE_COLUMNS = [
  'id',
  'title',
  'type',
  'unit',
  'body_composition_goal',
  'calories',
  'protein',
  'net_carbs',
  'fat',
  'protein_setting',
  'net_carbs_setting',
  'fat_setting',
] as const;
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
const BODY_COMPOSITION_CALORIE_OFFSETS: Record<string, number> = {
  neg_1000: -1000,
  neg_750: -750,
  neg_500: -500,
  neg_250: -250,
  neutral: 0,
  plus_250: 250,
  plus_500: 500,
  plus_750: 750,
  plus_100: 1000,
  strong_cut: -1000,
  moderate_cut: -500,
  slight_cut: -250,
  calorically_nuetral: 0,
  slight_bulk: 250,
  moderate_bulk: 500,
  strong_bulk: 1000,
};

interface Credentials {
  email: string;
  password: string;
}

interface DashboardCheck {
  ok: boolean;
  status: number;
  location: string | null;
  title: string | null;
  reason: string;
}

interface LoginResponse {
  ret_code?: number;
  ret_msg?: string;
  ret_action?: string;
  ret_data?: false | {
    redirect?: string;
  };
}

interface CookieEntry {
  name: string;
  value: string;
}

interface EraFitAppCookie {
  id_app: string;
  biz_id: string;
  type?: string;
  account_type?: string;
  coach_id?: string;
}

interface EraFitSession {
  cookieHeader: string;
  app: EraFitAppCookie;
  dashboard: DashboardCheck;
}

interface EraFitApiResponse<T> {
  ret_code?: number;
  ret_msg?: string;
  ret_action?: string;
  ret_data?: T;
}

interface EraFitGlobalsResponse {
  target_schedule?: Record<string, unknown>;
  templates?: Record<string, unknown>;
}

interface EraFitLazyloadResponse {
  data_array_meals?: string;
}

interface EraFitTemplate {
  id: string;
  title: string;
  type: string;
  unit: string;
  body_composition_goal: string;
  protein_grams: number | null;
  protein_percent: number | null;
  net_carbs_grams: number | null;
  net_carbs_percent: number | null;
  fat_grams: number | null;
  fat_percent: number | null;
}

interface EraFitGlobals {
  targetSchedule: Record<string, string>;
  templates: Record<string, EraFitTemplate>;
}

interface EraFitDayPayload {
  meals?: Record<string, unknown>;
  profile?: Record<string, unknown>;
  total?: Record<string, unknown>;
  template_id?: unknown;
  macro_tdee?: unknown;
  status_day?: unknown;
}

interface EraFitReport {
  generatedAt: string;
  sourcePath: string;
  clientId: string;
  window: {
    start: string;
    end: string;
  };
  returnedDays: number;
  dailyOverview: EraFitDailyOverviewRecord[];
  foods: EraFitFoodRecord[];
  targetSchedule: EraFitScheduleRecord[];
  templates: EraFitTemplateSummary[];
}

interface EraFitDailyOverviewRecord {
  date: string;
  date_id: string;
  template: string;
  template_id: string;
  status: string;
  calories: number;
  goal_calories: number | null;
  remaining_calories: number | null;
  macro_calories: number | null;
  protein: number;
  goal_protein: number | null;
  remaining_protein: number | null;
  net_carbs: number;
  goal_net_carbs: number | null;
  remaining_net_carbs: number | null;
  fat: number;
  goal_fat: number | null;
  remaining_fat: number | null;
  foods_logged: number;
}

interface EraFitFoodRecord {
  date: string;
  time: string | null;
  meal: string;
  meal_key: string;
  kind: string;
  name: string;
  brand: string | null;
  serving: string;
  calories: number | null;
  protein: number | null;
  net_carbs: number | null;
  fat: number | null;
}

interface EraFitScheduleRecord {
  day: string;
  template_id: string;
  template: string;
}

interface EraFitTemplateSummary {
  id: string;
  title: string;
  type: string;
  unit: string;
  body_composition_goal: string;
  calories: number | null;
  protein: number | null;
  net_carbs: number | null;
  fat: number | null;
  protein_setting: string | null;
  net_carbs_setting: string | null;
  fat_setting: string | null;
}

interface ResolvedDateWindow {
  start: Date;
  end: Date;
}

class CookieJar {
  private readonly cookies = new Map<string, string>();

  constructor(initialHeader?: string) {
    if (initialHeader) {
      this.addCookieHeader(initialHeader);
    }
  }

  addCookieHeader(header: string): void {
    for (const part of header.split(';')) {
      const trimmed = part.trim();
      const separator = trimmed.indexOf('=');
      if (separator <= 0) {
        continue;
      }
      this.cookies.set(trimmed.slice(0, separator), trimmed.slice(separator + 1));
    }
  }

  addSetCookieHeaders(headers: Headers): void {
    for (const value of readSetCookieHeaders(headers)) {
      const entry = parseSetCookie(value);
      if (entry) {
        this.cookies.set(entry.name, entry.value);
      }
    }
  }

  get(name: string): string | undefined {
    return this.cookies.get(name);
  }

  set(name: string, value: string): void {
    this.cookies.set(name, value);
  }

  toHeader(): string {
    return Array.from(this.cookies.entries())
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');
  }
}

if (import.meta.main) {
  await createScript(runCliWithErrorFormatting);
}

async function runCliWithErrorFormatting(): Promise<void> {
  try {
    await runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

async function runCli(): Promise<void> {
  const args = await yargs(hideBin(process.argv))
    .scriptName('era-fit')
    .strict()
    .option('date', {
      type: 'string',
      describe: 'Local date to report, in YYYY-MM-DD format. Defaults to today when --start is not set',
    })
    .option('days', {
      alias: ['d'],
      type: 'number',
      default: DEFAULT_DAYS,
      describe: 'Lookback window in days when --start is not set',
    })
    .option('start', {
      type: 'string',
      describe: 'Start date in YYYY-MM-DD format',
    })
    .option('end', {
      type: 'string',
      describe: 'End date in YYYY-MM-DD format',
    })
    .option('limit', {
      alias: ['l'],
      type: 'number',
      describe: 'Maximum number of logged foods to return',
    })
    .option('format', {
      alias: ['f'],
      type: 'string',
      choices: OUTPUT_FORMATS,
      default: 'table',
      describe: 'Output format',
    })
    .option('output', {
      alias: ['o'],
      type: 'string',
      describe: 'Write output to this file path',
    })
    .option('pretty', {
      type: 'boolean',
      default: true,
      describe: 'Pretty-print JSON output',
    })
    .option('check-auth', {
      type: 'boolean',
      default: false,
      describe: 'Only check whether the stored session or credentials can authenticate',
    })
    .option('dashboard-path', {
      type: 'string',
      default: DEFAULT_DASHBOARD_PATH,
      describe: 'Era Fit path to use when checking whether the session is authenticated',
    })
    .option('save-session', {
      type: 'boolean',
      default: true,
      describe: `Persist successful ${SESSION_ENV_KEY} to .env.local`,
    })
    .option('login', {
      type: 'boolean',
      default: true,
      describe: `Use ${CREDENTIALS_ENV_KEY} when the stored session is missing or invalid`,
    })
    .option('prompt', {
      type: 'boolean',
      default: true,
      describe: 'Prompt for Era Fit credentials when env credentials are not set',
    })
    .help()
    .parseAsync();

  if (args.limit != null && (!Number.isFinite(args.limit) || args.limit <= 0)) {
    throw new Error('--limit must be a positive number.');
  }

  const session = await resolveSession({
    dashboardPath: normalizePath(args.dashboardPath),
    login: args.login,
    prompt: args.prompt,
    saveSession: args['save-session'],
  });

  const format = parseOutputFormat(args.format);
  if (args.checkAuth) {
    renderAuthResult({
      session,
      format,
      outputPath: args.output,
      pretty: args.pretty,
    });
    return;
  }

  const window = resolveDateWindow({
    days: args.days,
    date: args.date,
    start: args.start,
    end: args.end,
  });
  const report = await fetchEraFitReport(session, {
    window,
    limit: args.limit,
  });

  renderOutput({
    report,
    format,
    outputPath: args.output,
    pretty: args.pretty,
  });
}

async function resolveSession(options: {
  dashboardPath: string;
  login: boolean;
  prompt: boolean;
  saveSession: boolean;
}): Promise<EraFitSession> {
  const existingSession = normalizeOptionalString(env.ERA_FIT_SESSION_COOKIE);
  if (existingSession) {
    const sessionCheck = await checkDashboard(existingSession, options.dashboardPath);
    const app = parseAppCookie(existingSession);
    if (sessionCheck.ok && app) {
      return {
        cookieHeader: existingSession,
        app,
        dashboard: sessionCheck,
      };
    }
    if (!options.login) {
      const reason = !sessionCheck.ok
        ? `${SESSION_ENV_KEY} did not load ${options.dashboardPath}: ${sessionCheck.reason}`
        : `${SESSION_ENV_KEY} is missing _ef_app_ck_data, which is needed for the nutrition API.`;
      throw new Error(reason);
    }
    console.warn(`${SESSION_ENV_KEY} is present but not usable: ${sessionCheck.reason}`);
  }

  if (!options.login) {
    throw new Error(`${SESSION_ENV_KEY} is not set, so there is no stored session to test.`);
  }

  const credentials = parseOptionalCredentials(env.ERA_FIT_CREDENTIALS) ?? await promptCredentials(options.prompt);
  const loginResult = await login(credentials, options.dashboardPath);
  const app = parseAppCookie(loginResult.cookieHeader);
  if (!app) {
    throw new Error('Era Fit login succeeded, but the app cookie needed for nutrition API calls was not set.');
  }
  if (options.saveSession) {
    saveEnvLocalValue(SESSION_ENV_KEY, loginResult.cookieHeader);
  }

  return {
    cookieHeader: loginResult.cookieHeader,
    app,
    dashboard: loginResult.dashboard,
  };
}

async function fetchEraFitReport(
  session: EraFitSession,
  options: {
    window: ResolvedDateWindow;
    limit?: number;
  }
): Promise<EraFitReport> {
  const globals = await fetchMealTrackingGlobals(session);
  const dates = listDateKeysBetween(options.window.start, options.window.end);
  const dayPayloads: Array<{ date: string; dateId: string; payload: EraFitDayPayload }> = [];
  for (const date of dates) {
    dayPayloads.push({
      date,
      dateId: formatEraFitDateId(parseLocalDate(date, 'date')),
      payload: await fetchMealTrackingDay(session, date),
    });
  }
  const dailyOverview = dayPayloads
    .map(day => buildDailyOverviewRecord(day.date, day.dateId, day.payload, globals))
    .sort((a, b) => b.date.localeCompare(a.date));
  const foods = dayPayloads
    .flatMap(day => parseDayFoods(day.date, day.payload))
    .sort((a, b) => `${b.date} ${b.time ?? ''}`.localeCompare(`${a.date} ${a.time ?? ''}`));
  const limitedFoods =
    options.limit && Number.isFinite(options.limit) && options.limit > 0
      ? foods.slice(0, Math.floor(options.limit))
      : foods;

  return {
    generatedAt: formatLocalIso(new Date()),
    sourcePath: SOURCE_PATH,
    clientId: session.app.id_app,
    window: {
      start: formatDateKey(options.window.start),
      end: formatDateKey(options.window.end),
    },
    returnedDays: dailyOverview.length,
    dailyOverview,
    foods: limitedFoods,
    targetSchedule: buildScheduleRecords(globals),
    templates: Object.values(globals.templates)
      .map(template => summarizeTemplate(template, null))
      .sort((a, b) => a.title.localeCompare(b.title)),
  };
}

async function fetchMealTrackingGlobals(session: EraFitSession): Promise<EraFitGlobals> {
  const data = await postApi<EraFitGlobalsResponse>(session, '/api/list-meal-tracking-globals', {
    client_id: session.app.id_app,
    biz_id: session.app.biz_id,
  });
  const templates = parseTemplates(data.templates);
  return {
    targetSchedule: Object.fromEntries(
      Object.entries(data.target_schedule ?? {})
        .map(([key, value]) => [key, parseString(value)])
        .filter((entry): entry is [string, string] => entry[1] != null)
    ),
    templates,
  };
}

async function fetchMealTrackingDay(session: EraFitSession, date: string): Promise<EraFitDayPayload> {
  const data = await postApi<EraFitLazyloadResponse>(session, '/clients/nutrition/prepare_food_pictures_lazyload', {
    client_id: session.app.id_app,
    date_id: formatEraFitDateId(parseLocalDate(date, 'date')),
  });
  if (!data.data_array_meals) {
    throw new Error(`Era Fit did not return nutrition data for ${date}.`);
  }
  return parseBase64Json(data.data_array_meals, `nutrition data for ${date}`) as EraFitDayPayload;
}

async function postApi<T>(
  session: EraFitSession,
  apiPath: string,
  data: Record<string, string | number>
): Promise<T> {
  for (let attempt = 1; attempt <= API_RETRY_ATTEMPTS; attempt += 1) {
    const response = await fetchUrl(apiPath, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        Cookie: session.cookieHeader,
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Requested-With': 'XMLHttpRequest',
        Origin: BASE_URL,
        Referer: `${BASE_URL}/clients/nutrition/food-pictures`,
      },
      body: new URLSearchParams(Object.fromEntries(Object.entries(data).map(([key, value]) => [key, String(value)]))),
    });
    const responseText = await response.text();
    if (!response.ok) {
      if (isRetryableStatus(response.status) && attempt < API_RETRY_ATTEMPTS) {
        await delay(attempt * 750);
        continue;
      }
      throw new Error(`Era Fit API request failed: ${response.status} ${response.statusText} (${apiPath})`);
    }
    const json = parseApiResponse<T>(responseText, apiPath);
    if (json.ret_code !== 200 || json.ret_data == null) {
      throw new Error(`Era Fit API request failed: ${json.ret_msg ?? responseText.slice(0, 500)} (${apiPath})`);
    }
    return json.ret_data;
  }
  throw new Error(`Era Fit API request failed after ${API_RETRY_ATTEMPTS} attempts (${apiPath})`);
}

function isRetryableStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
}

async function delay(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

function parseApiResponse<T>(text: string, apiPath: string): EraFitApiResponse<T> {
  try {
    return JSON.parse(text) as EraFitApiResponse<T>;
  } catch {
    if (text.includes('id="login_form"') || text.includes('data-action="/login/access"')) {
      throw new Error(`Era Fit session expired while calling ${apiPath}.`);
    }
    throw new Error(`Era Fit API returned non-JSON response from ${apiPath}: ${text.slice(0, 500)}`);
  }
}

function buildDailyOverviewRecord(
  date: string,
  dateId: string,
  payload: EraFitDayPayload,
  globals: EraFitGlobals
): EraFitDailyOverviewRecord {
  const total = asRecord(payload.total);
  const template = resolveTemplate(date, payload, globals);
  const baseTdee =
    parseNumberLike(total?.tdee) ??
    parseNumberLike(payload.macro_tdee) ??
    parseNumberLike(asRecord(payload.profile)?.energy_tdee);
  const targets = computeTemplateTargets(template, baseTdee);
  const foods = parseDayFoods(date, payload);
  const consumed = {
    calories: parseNumberLike(total?.energy) ?? sumNumbers(foods.map(food => food.calories)),
    protein: parseNumberLike(total?.protein) ?? sumNumbers(foods.map(food => food.protein)),
    netCarbs: parseNumberLike(total?.net_carbs) ?? sumNumbers(foods.map(food => food.net_carbs)),
    fat: parseNumberLike(total?.fat) ?? sumNumbers(foods.map(food => food.fat)),
  };

  return {
    date,
    date_id: dateId,
    template: template.title,
    template_id: template.id,
    status: parseString(total?.status_day) ?? parseString(payload.status_day) ?? 'non_completed',
    calories: consumed.calories,
    goal_calories: targets.goalCalories,
    remaining_calories: subtractNullable(targets.goalCalories, consumed.calories),
    macro_calories: targets.macroCalories,
    protein: consumed.protein,
    goal_protein: targets.protein,
    remaining_protein: subtractNullable(targets.protein, consumed.protein),
    net_carbs: consumed.netCarbs,
    goal_net_carbs: targets.netCarbs,
    remaining_net_carbs: subtractNullable(targets.netCarbs, consumed.netCarbs),
    fat: consumed.fat,
    goal_fat: targets.fat,
    remaining_fat: subtractNullable(targets.fat, consumed.fat),
    foods_logged: foods.length,
  };
}

function parseDayFoods(date: string, payload: EraFitDayPayload): EraFitFoodRecord[] {
  const meals = asRecord(payload.meals);
  if (!meals) {
    return [];
  }

  const foods: EraFitFoodRecord[] = [];
  for (const mealKey of MEAL_KEYS) {
    const meal = asRecord(meals[mealKey]);
    const mealFoods = asRecord(meal?.foods);
    if (!mealFoods) {
      continue;
    }
    for (const rawFood of Object.values(mealFoods)) {
      const food = asRecord(rawFood);
      if (!food) {
        continue;
      }
      foods.push(parseFoodRecord(date, mealKey, food));
    }
  }
  return foods;
}

function parseFoodRecord(
  date: string,
  mealKey: (typeof MEAL_KEYS)[number],
  raw: Record<string, unknown>
): EraFitFoodRecord {
  const total = asRecord(raw.total);
  const kind = parseString(raw.type_item) ?? (total ? 'meal' : 'food');
  const totalMultiplier = total && kind === 'my_meals'
    ? parseNumberLike(raw.serving_qtd) ?? 1
    : 1;
  return {
    date,
    time: parseString(raw.time),
    meal: MEAL_LABELS[mealKey],
    meal_key: mealKey,
    kind,
    name: parseString(raw.title) ?? parseString(raw.food_name) ?? '(untitled)',
    brand: parseString(raw.brand_name),
    serving: buildServingString(raw),
    calories: scaleNullable(parseNumberLike(total?.energy), totalMultiplier) ?? parseNumberLike(raw.calories),
    protein: scaleNullable(parseNumberLike(total?.protein), totalMultiplier) ?? parseNumberLike(raw.protein),
    net_carbs:
      scaleNullable(parseNumberLike(total?.net_carbs), totalMultiplier) ??
      parseNumberLike(raw.net_carbs) ??
      parseNumberLike(raw.carbohydrate),
    fat: scaleNullable(parseNumberLike(total?.fat), totalMultiplier) ?? parseNumberLike(raw.fat),
  };
}

function resolveTemplate(date: string, payload: EraFitDayPayload, globals: EraFitGlobals): EraFitTemplate {
  const total = asRecord(payload.total);
  const totalTemplate = parseTemplate(asRecord(total?.macro_template_data));
  if (totalTemplate) {
    return totalTemplate;
  }

  const scheduledId =
    parseString(payload.template_id) ??
    parseString(total?.macro_template_id) ??
    globals.targetSchedule[`macro_target_schedule_week_day_${parseLocalDate(date, 'date').getDay() + 1}`];
  return globals.templates[scheduledId ?? ''] ?? globals.templates.default ?? fallbackTemplate();
}

function parseTemplates(value: unknown): Record<string, EraFitTemplate> {
  const rawTemplates = asRecord(value);
  const templates: Record<string, EraFitTemplate> = {};
  if (rawTemplates) {
    for (const rawTemplate of Object.values(rawTemplates)) {
      const template = parseTemplate(asRecord(rawTemplate));
      if (template) {
        templates[template.id] = template;
      }
    }
  }
  if (!templates.default) {
    templates.default = fallbackTemplate();
  }
  return templates;
}

function parseTemplate(raw: Record<string, unknown> | null): EraFitTemplate | null {
  if (!raw) {
    return null;
  }
  const id = parseString(raw.id);
  if (!id) {
    return null;
  }
  return {
    id,
    title: parseString(raw.title) ?? id,
    type: parseString(raw.type) ?? 'unknown',
    unit: parseString(raw.unit) ?? 'g',
    body_composition_goal: parseString(raw.body_composition_goal) ?? 'neutral',
    protein_grams: parseNumberLike(raw.protein_grams),
    protein_percent: parseNumberLike(raw.protein_percent),
    net_carbs_grams: parseNumberLike(raw.net_carbs_grams),
    net_carbs_percent: parseNumberLike(raw.net_carbs_percent),
    fat_grams: parseNumberLike(raw.fat_grams),
    fat_percent: parseNumberLike(raw.fat_percent),
  };
}

function fallbackTemplate(): EraFitTemplate {
  return {
    id: 'default',
    title: 'Default',
    type: 'default',
    unit: '%',
    body_composition_goal: 'neutral',
    protein_grams: null,
    protein_percent: 35,
    net_carbs_grams: null,
    net_carbs_percent: 30,
    fat_grams: null,
    fat_percent: 35,
  };
}

function computeTemplateTargets(template: EraFitTemplate, baseTdee: number | null): {
  goalCalories: number | null;
  macroCalories: number | null;
  protein: number | null;
  netCarbs: number | null;
  fat: number | null;
} {
  const goalCalories =
    baseTdee == null
      ? null
      : baseTdee + (BODY_COMPOSITION_CALORIE_OFFSETS[template.body_composition_goal] ?? 0);

  if (template.unit === '%') {
    const protein = goalCalories == null ? null : percentToMacroGrams(goalCalories, template.protein_percent, 4);
    const netCarbs = goalCalories == null ? null : percentToMacroGrams(goalCalories, template.net_carbs_percent, 4);
    const fat = goalCalories == null ? null : percentToMacroGrams(goalCalories, template.fat_percent, 9);
    return {
      goalCalories,
      macroCalories: goalCalories,
      protein,
      netCarbs,
      fat,
    };
  }

  return {
    goalCalories,
    macroCalories: macroCalories(template.protein_grams, template.net_carbs_grams, template.fat_grams),
    protein: template.protein_grams,
    netCarbs: template.net_carbs_grams,
    fat: template.fat_grams,
  };
}

function percentToMacroGrams(goalCalories: number, percent: number | null, caloriesPerGram: number): number | null {
  if (percent == null) {
    return null;
  }
  return roundNumber((goalCalories * percent / 100) / caloriesPerGram);
}

function macroCalories(protein: number | null, netCarbs: number | null, fat: number | null): number | null {
  if (protein == null && netCarbs == null && fat == null) {
    return null;
  }
  return roundNumber((protein ?? 0) * 4 + (netCarbs ?? 0) * 4 + (fat ?? 0) * 9);
}

function buildScheduleRecords(globals: EraFitGlobals): EraFitScheduleRecord[] {
  return WEEKDAY_NAMES.map((day, index) => {
    const templateId = globals.targetSchedule[`macro_target_schedule_week_day_${index + 1}`] ?? 'default';
    return {
      day,
      template_id: templateId,
      template: globals.templates[templateId]?.title ?? templateId,
    };
  });
}

function summarizeTemplate(template: EraFitTemplate, baseTdee: number | null): EraFitTemplateSummary {
  const targets = computeTemplateTargets(template, baseTdee);
  return {
    id: template.id,
    title: template.title,
    type: template.type,
    unit: template.unit,
    body_composition_goal: template.body_composition_goal,
    calories: targets.macroCalories,
    protein: targets.protein,
    net_carbs: targets.netCarbs,
    fat: targets.fat,
    protein_setting: formatTemplateMacroSetting(template.unit, template.protein_grams, template.protein_percent),
    net_carbs_setting: formatTemplateMacroSetting(template.unit, template.net_carbs_grams, template.net_carbs_percent),
    fat_setting: formatTemplateMacroSetting(template.unit, template.fat_grams, template.fat_percent),
  };
}

function formatTemplateMacroSetting(unit: string, grams: number | null, percent: number | null): string | null {
  if (unit === '%') {
    return percent == null ? null : `${formatNumber(percent)}%`;
  }
  return grams == null ? null : `${formatNumber(grams)}g`;
}

function renderOutput(options: {
  report: EraFitReport;
  format: OutputFormat;
  outputPath?: string;
  pretty: boolean;
}): void {
  if (options.format === 'table') {
    if (options.outputPath) {
      throw new Error('--output is not supported with --format=table. Use --format=csv or --format=json.');
    }
    renderTable(options.report);
    return;
  }

  const text = (() => {
    if (options.format === 'json') {
      return `${JSON.stringify(options.report, null, options.pretty ? 2 : 0)}\n`;
    }
    if (options.format === 'csv:full') {
      return renderFullCsv(options.report);
    }
    return renderCsvRecords(toDailyCsvRows(options.report), DAILY_COLUMNS);
  })();

  if (options.outputPath) {
    const outputPath = path.resolve(options.outputPath);
    writeFileSync(outputPath, text, 'utf8');
    process.stdout.write(`${outputPath}\n`);
    return;
  }
  process.stdout.write(text);
}

function renderAuthResult(options: {
  session: EraFitSession;
  format: OutputFormat;
  outputPath?: string;
  pretty: boolean;
}): void {
  const result = {
    status: 'session-valid',
    message: `${SESSION_ENV_KEY} can load ${options.session.dashboard.title ?? DEFAULT_DASHBOARD_PATH} and exposes Era Fit API client metadata.`,
    clientId: options.session.app.id_app,
    dashboard: options.session.dashboard,
  };

  if (options.format === 'json') {
    const text = `${JSON.stringify(result, null, options.pretty ? 2 : 0)}\n`;
    if (options.outputPath) {
      writeFileSync(path.resolve(options.outputPath), text, 'utf8');
      return;
    }
    process.stdout.write(text);
    return;
  }
  if (options.outputPath) {
    throw new Error('--output is only supported with --check-auth when --format=json is used.');
  }
  console.log(result.message);
}

function renderTable(report: EraFitReport): void {
  process.stdout.write('Daily Macro Overview\n');
  renderTableRecords(toDailyCsvRows(report));
  if (report.foods.length > 0) {
    process.stdout.write('\nLogged Foods\n');
    renderTableRecords(toFoodCsvRows(report));
  }
  if (report.templates.length > 0) {
    process.stdout.write('\nMacro Templates\n');
    renderTableRecords(toTemplateCsvRows(report));
  }
}

function renderFullCsv(report: EraFitReport): string {
  return [
    {
      name: 'daily_overview',
      csv: renderCsvRecords(toDailyCsvRows(report), DAILY_COLUMNS),
    },
    {
      name: 'logged_foods',
      csv: renderCsvRecords(toFoodCsvRows(report), FOOD_COLUMNS),
    },
    {
      name: 'macro_templates',
      csv: renderCsvRecords(toTemplateCsvRows(report), TEMPLATE_COLUMNS),
    },
  ].map(section => `\n==== ${section.name} ===\n${section.csv}`).join('');
}

function toDailyCsvRows(report: EraFitReport): Record<string, CsvValue>[] {
  return report.dailyOverview.map(row => ({
    date: row.date,
    template: row.template,
    status: row.status,
    calories: row.calories,
    goal_calories: row.goal_calories,
    remaining_calories: row.remaining_calories,
    macro_calories: row.macro_calories,
    protein: row.protein,
    goal_protein: row.goal_protein,
    remaining_protein: row.remaining_protein,
    net_carbs: row.net_carbs,
    goal_net_carbs: row.goal_net_carbs,
    remaining_net_carbs: row.remaining_net_carbs,
    fat: row.fat,
    goal_fat: row.goal_fat,
    remaining_fat: row.remaining_fat,
    foods_logged: row.foods_logged,
  }));
}

function toFoodCsvRows(report: EraFitReport): Record<string, CsvValue>[] {
  return report.foods.map(food => ({
    date: food.date,
    time: food.time,
    meal: food.meal,
    kind: food.kind,
    name: food.name,
    brand: food.brand,
    serving: food.serving,
    calories: food.calories,
    protein: food.protein,
    net_carbs: food.net_carbs,
    fat: food.fat,
  }));
}

function toTemplateCsvRows(report: EraFitReport): Record<string, CsvValue>[] {
  return report.templates.map(template => ({
    id: template.id,
    title: template.title,
    type: template.type,
    unit: template.unit,
    body_composition_goal: template.body_composition_goal,
    calories: template.calories,
    protein: template.protein,
    net_carbs: template.net_carbs,
    fat: template.fat,
    protein_setting: template.protein_setting,
    net_carbs_setting: template.net_carbs_setting,
    fat_setting: template.fat_setting,
  }));
}

async function login(credentials: Credentials, dashboardPath: string): Promise<{
  cookieHeader: string;
  dashboard: DashboardCheck;
}> {
  const jar = new CookieJar();
  const loginPage = await fetchUrl('/login/', {
    redirect: 'manual',
  });
  jar.addSetCookieHeaders(loginPage.headers);
  jar.set('_ef_app_tz', Intl.DateTimeFormat().resolvedOptions().timeZone);

  const loginAccess = await fetchUrl('/login/access', {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: jar.toHeader(),
      Origin: BASE_URL,
      Referer: `${BASE_URL}/login/`,
    },
    body: new URLSearchParams({
      post: buildEraFitPost([
        {
          post_data: {
            email: credentials.email,
            login_password: credentials.password,
          },
        },
      ]),
    }),
  });
  jar.addSetCookieHeaders(loginAccess.headers);

  const responseText = await loginAccess.text();
  const response = parseLoginResponse(responseText);
  if (response.ret_code !== 200) {
    throw new Error(`Era Fit login failed: ${response.ret_msg ?? responseText}`);
  }

  const redirectPath =
    response.ret_action === 'redirect' && response.ret_data && typeof response.ret_data === 'object'
      ? response.ret_data.redirect
      : dashboardPath;
  const check = await checkDashboard(jar.toHeader(), normalizePath(redirectPath ?? dashboardPath));
  if (!check.ok) {
    throw new Error(`Era Fit login returned success, but the dashboard check failed: ${check.reason}`);
  }

  return {
    cookieHeader: jar.toHeader(),
    dashboard: check,
  };
}

async function checkDashboard(cookieHeader: string, dashboardPath: string): Promise<DashboardCheck> {
  const response = await fetchUrl(dashboardPath, {
    redirect: 'manual',
    headers: {
      Cookie: cookieHeader,
      Referer: `${BASE_URL}/login/`,
    },
  });
  const location = response.headers.get('location');
  const text = await response.text();
  const title = text.match(/<title>(.*?)<\/title>/i)?.[1]?.trim() ?? null;
  const isLoginPage = text.includes('id="login_form"') || text.includes('data-action="/login/access"');
  const ok = response.status === 200 && !isLoginPage;
  return {
    ok,
    status: response.status,
    location,
    title,
    reason: ok
      ? 'dashboard loaded'
      : response.status >= 300 && response.status < 400
        ? `redirected to ${location ?? 'unknown location'}`
        : isLoginPage
          ? 'received login page'
          : `unexpected HTTP ${response.status}`,
  };
}

function buildEraFitPost(formData: unknown): string {
  const h = makeEraFitHash();
  const postFields = {
    a: encryptCryptoJsPassphraseJson(formData, selectEraFitHashKey(h)),
    b: JSON.stringify({ h }),
  };
  return deflateRawSync(JSON.stringify(postFields)).toString('base64');
}

function makeEraFitHash(): string {
  return `${randomBytes(256).toString('hex')}${Math.floor(Math.random() * 15)}`;
}

function selectEraFitHashKey(hash: string): string {
  const selector = Number(hash.slice(512));
  const key = hash.slice(selector * 32, selector * 32 + 32);
  if (!Number.isInteger(selector) || selector < 0 || selector > 14 || key.length !== 32) {
    throw new Error('Failed to derive Era Fit encryption key from login hash.');
  }
  return key;
}

function encryptCryptoJsPassphraseJson(value: unknown, passphrase: string): string {
  const salt = randomBytes(8);
  const { key, iv } = evpBytesToKey(passphrase, salt, 32, 16);
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(value), 'utf8'),
    cipher.final(),
  ]);
  return JSON.stringify({
    ct: encrypted.toString('base64'),
    iv: iv.toString('hex'),
    s: salt.toString('hex'),
  });
}

function evpBytesToKey(password: string, salt: Buffer, keyLength: number, ivLength: number): {
  key: Buffer;
  iv: Buffer;
} {
  const passwordBuffer = Buffer.from(password, 'utf8');
  let derived = Buffer.alloc(0);
  let previous = Buffer.alloc(0);
  while (derived.length < keyLength + ivLength) {
    previous = createHash('md5')
      .update(previous)
      .update(passwordBuffer)
      .update(salt)
      .digest();
    derived = Buffer.concat([derived, previous]);
  }
  return {
    key: derived.subarray(0, keyLength),
    iv: derived.subarray(keyLength, keyLength + ivLength),
  };
}

async function promptCredentials(allowPrompt: boolean): Promise<Credentials> {
  if (!allowPrompt) {
    throw new Error(`${CREDENTIALS_ENV_KEY} is not set. Expected <email>:<password>.`);
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(`${CREDENTIALS_ENV_KEY} is not set and this shell is not interactive enough to prompt.`);
  }

  const email = await text({
    message: 'Era Fit email',
    validate(value) {
      return value?.trim() ? undefined : 'Email is required.';
    },
  });
  if (isCancel(email)) {
    throw new Error('Era Fit login cancelled.');
  }
  const emailValue = email.trim();

  const passwordValue = await password({
    message: 'Era Fit password',
    validate(value) {
      return value ? undefined : 'Password is required.';
    },
  });
  if (isCancel(passwordValue)) {
    throw new Error('Era Fit login cancelled.');
  }

  return {
    email: emailValue,
    password: passwordValue,
  };
}

function parseOptionalCredentials(value: string | undefined): Credentials | null {
  const raw = normalizeOptionalString(value);
  if (!raw) {
    return null;
  }
  const separator = raw.indexOf(':');
  if (separator === -1) {
    throw new Error(`${CREDENTIALS_ENV_KEY} must use the format <email>:<password>.`);
  }
  const email = raw.slice(0, separator).trim();
  const password = raw.slice(separator + 1);
  if (!email || !password) {
    throw new Error(`${CREDENTIALS_ENV_KEY} must include both a non-empty email and password.`);
  }
  return { email, password };
}

function parseLoginResponse(text: string): LoginResponse {
  try {
    return JSON.parse(text) as LoginResponse;
  } catch {
    throw new Error(`Era Fit login returned non-JSON response: ${text.slice(0, 500)}`);
  }
}

async function fetchUrl(pathOrUrl: string, init: RequestInit): Promise<Response> {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : new URL(pathOrUrl, BASE_URL).toString();
  return fetch(url, init);
}

function resolveDateWindow(options: {
  days: number;
  date?: string;
  start?: string;
  end?: string;
}): ResolvedDateWindow {
  if (!Number.isFinite(options.days) || options.days <= 0) {
    throw new Error('--days must be a positive number.');
  }

  const end = options.end
    ? parseLocalDate(options.end, 'end')
    : options.date
      ? parseLocalDate(options.date, 'date')
      : startOfLocalDay(new Date());
  const start = options.start
    ? parseLocalDate(options.start, 'start')
    : addDays(end, -(Math.floor(options.days) - 1));

  if (start.getTime() > end.getTime()) {
    throw new Error('Start date must be before end date.');
  }
  return { start, end };
}

function listDateKeysBetween(start: Date, end: Date): string[] {
  const dates: string[] = [];
  for (let current = startOfLocalDay(start); current.getTime() <= end.getTime(); current = addDays(current, 1)) {
    dates.push(formatDateKey(current));
  }
  return dates;
}

function parseLocalDate(value: string, label: string): Date {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    throw new Error(`Invalid ${label} date: ${value}. Expected YYYY-MM-DD.`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    throw new Error(`Invalid ${label} date: ${value}.`);
  }
  return date;
}

function startOfLocalDay(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

function addDays(value: Date, days: number): Date {
  const next = new Date(value);
  next.setDate(next.getDate() + days);
  return next;
}

function formatDateKey(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatLocalIso(value: Date): string {
  const offsetMs = value.getTimezoneOffset() * 60 * 1000;
  return new Date(value.getTime() - offsetMs).toISOString().replace('Z', '');
}

function formatEraFitDateId(date: Date): string {
  const dayOfYearZeroBased = Math.floor(
    (Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) - Date.UTC(date.getFullYear(), 0, 1)) / MS_PER_DAY
  );
  return `${date.getFullYear()}${dayOfYearZeroBased}`;
}

function parseAppCookie(cookieHeader: string): EraFitAppCookie | null {
  const jar = new CookieJar(cookieHeader);
  const value = jar.get('_ef_app_ck_data');
  if (!value) {
    return null;
  }
  const decoded = parseBase64Json(decodeURIComponent(value), '_ef_app_ck_data');
  const record = asRecord(decoded);
  const idApp = parseString(record?.id_app);
  const bizId = parseString(record?.biz_id);
  if (!idApp || !bizId) {
    return null;
  }
  return {
    id_app: idApp,
    biz_id: bizId,
    type: parseString(record?.type) ?? undefined,
    account_type: parseString(record?.account_type) ?? undefined,
    coach_id: parseString(record?.coach_id) ?? undefined,
  };
}

function parseBase64Json(value: string, label: string): unknown {
  try {
    return JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
  } catch (error) {
    throw new Error(`Failed to decode Era Fit ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function buildServingString(raw: Record<string, unknown>): string {
  const description = parseString(raw.serving_description);
  const quantity = parseNumberLike(raw.serving_qtd) ?? parseNumberLike(raw.quantity);
  const unit = parseString(raw.serving_unit) ?? parseString(raw.measurement_description);
  if (description) {
    return quantity != null && unit && unit !== 'fatsecret'
      ? `${formatNumber(quantity)} ${unit} (${description})`
      : description;
  }
  if (quantity != null && unit) {
    return `${formatNumber(quantity)} ${unit}`;
  }
  if (quantity != null) {
    return `${formatNumber(quantity)} serving`;
  }
  return '';
}

function subtractNullable(target: number | null, value: number): number | null {
  return target == null ? null : roundNumber(target - value);
}

function scaleNullable(value: number | null, multiplier: number): number | null {
  return value == null ? null : roundNumber(value * multiplier);
}

function sumNumbers(values: Array<number | null>): number {
  return values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3)));
}

function roundNumber(value: number): number {
  return Number(value.toFixed(3));
}

function parseNumberLike(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function parseString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function normalizePath(value: string): string {
  if (value.startsWith('http')) {
    return new URL(value).pathname;
  }
  return value.startsWith('/') ? value : `/${value}`;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function readSetCookieHeaders(headers: Headers): string[] {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  if (typeof getSetCookie === 'function') {
    return getSetCookie.call(headers);
  }
  const header = headers.get('set-cookie');
  return header ? splitSetCookieHeader(header) : [];
}

function splitSetCookieHeader(header: string): string[] {
  return header.split(/,(?=\s*[^;,]+=)/g).map(value => value.trim()).filter(Boolean);
}

function parseSetCookie(value: string): CookieEntry | null {
  const pair = value.split(';', 1)[0]?.trim();
  const separator = pair.indexOf('=');
  if (!pair || separator <= 0) {
    return null;
  }
  return {
    name: pair.slice(0, separator),
    value: pair.slice(separator + 1),
  };
}

function saveEnvLocalValue(name: string, value: string): void {
  const current = existsSync(ENV_LOCAL_PATH) ? readFileSync(ENV_LOCAL_PATH, 'utf8') : '';
  const line = `${name}=${JSON.stringify(value)}`;
  const pattern = new RegExp(`^${escapeRegExp(name)}=.*$`, 'm');
  const next = pattern.test(current)
    ? current.replace(pattern, line)
    : `${current}${current && !current.endsWith('\n') ? '\n' : ''}${line}\n`;
  writeFileSync(ENV_LOCAL_PATH, next, 'utf8');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
