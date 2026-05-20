import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';

import { isCancel, password, text } from '@clack/prompts';

import env from '../env';

const BASE_URL = 'https://app.erafit.com';
export const NUTRITION_SOURCE_PATH = 'api://era-fit/nutrition';
export const MEAL_PLAN_SOURCE_PATH = 'api://era-fit/meal-plan';
const DEFAULT_DASHBOARD_PATH = '/clients/dashboard';
const API_RETRY_ATTEMPTS = 3;
const ENV_LOCAL_PATH = path.resolve(import.meta.dir, '..', '..', '.env.local');
const SESSION_ENV_KEY = 'ERA_FIT_SESSION_COOKIE';
const CREDENTIALS_ENV_KEY = 'ERA_FIT_CREDENTIALS';
const FIREBASE_API_KEY_ENV = 'ERA_FIT_FIREBASE_API_KEY';
const MS_PER_DAY = 24 * 60 * 60 * 1000;
export const MEAL_KEYS = ['breakfast', 'snack_am', 'lunch', 'snack_pm', 'dinner', 'snack_evening'] as const;
export type EraFitMealKey = (typeof MEAL_KEYS)[number];
const MEAL_PLAN_MEAL_KEYS = [
  'breakfast',
  'morning_snack',
  'lunch',
  'afternoon_snack',
  'dinner',
  'evening_snack',
] as const;
export const MEAL_LABELS: Record<EraFitMealKey, string> = {
  breakfast: 'Breakfast',
  snack_am: 'AM Snack',
  lunch: 'Lunch',
  snack_pm: 'PM Snack',
  dinner: 'Dinner',
  snack_evening: 'Evening Snack',
};
const MEAL_PLAN_MEAL_LABELS: Record<(typeof MEAL_PLAN_MEAL_KEYS)[number], string> = {
  breakfast: 'Breakfast',
  morning_snack: 'Morning Snack',
  lunch: 'Lunch',
  afternoon_snack: 'Afternoon Snack',
  dinner: 'Dinner',
  evening_snack: 'Evening Snack',
};
export const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
const WEEKDAY_TAGS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] as const;
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

let runtimeCredentials: Credentials | null = null;
let runtimeFirebaseIdToken: string | null = null;
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

export interface EraFitSession {
  cookieHeader: string;
  app: EraFitAppCookie;
  dashboard: DashboardCheck;
}

export interface EraFitSessionLogger {
  loginStart?(source: 'env' | 'prompt'): void;
  sessionReady?(source: 'cookie' | 'login'): void;
}

export interface EraFitFatSecretSearchFood {
  food_id: string;
  food_name: string;
  food_type: string;
  food_url: string;
  food_description: string;
  brand_name?: string;
}

export interface EraFitFatSecretServing {
  serving_id: string;
  serving_description: string;
  serving_url?: string;
  metric_serving_amount?: string;
  metric_serving_unit?: string;
  number_of_units?: string;
  measurement_description?: string;
  calories?: string;
  carbohydrate?: string;
  protein?: string;
  fat?: string;
  saturated_fat?: string;
  trans_fat?: string;
  polyunsaturated_fat?: string;
  monounsaturated_fat?: string;
  cholesterol?: string;
  sodium?: string;
  potassium?: string;
  fiber?: string;
  sugar?: string;
  vitamin_a?: string;
  vitamin_c?: string;
  vitamin_d?: string;
  calcium?: string;
  iron?: string;
  added_sugars?: string;
}

export interface EraFitFatSecretFood {
  food_id: string;
  food_name: string;
  food_type: string;
  food_url: string;
  brand_name?: string;
  servings: Record<string, EraFitFatSecretServing>;
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

interface EraFitFatSecretSearchResponse {
  foods?: unknown;
  pagination?: unknown;
}

interface EraFitFatSecretFoodResponse {
  food?: unknown;
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

export interface EraFitReport {
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
  recipes: EraFitRecipeIngredientRecord[];
  targetSchedule: EraFitScheduleRecord[];
  templates: EraFitTemplateSummary[];
}

export interface EraFitDailyOverviewRecord {
  date: string;
  date_id: string;
  template: string;
  template_id: string;
  status: string;
  calories: number;
  goal_calories: number | null;
  protein: number;
  goal_protein: number | null;
  net_carbs: number;
  goal_net_carbs: number | null;
  fat: number;
  goal_fat: number | null;
  foods_logged: number;
}

export interface EraFitFoodRecord {
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

export interface EraFitRecipeIngredientRecord {
  date: string;
  time: string | null;
  meal: string;
  meal_key: string;
  recipe: string;
  recipe_serving: string;
  ingredient: string;
  brand: string | null;
  serving: string;
  calories: number | null;
  protein: number | null;
  net_carbs: number | null;
  fat: number | null;
}

export interface EraFitScheduleRecord {
  day: string;
  template_id: string;
  template: string;
}

export interface EraFitTemplateSummary {
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

interface EraFitMealPlanSlot {
  day_tag: string;
  hour: string | null;
  meal_type: string;
  plan_type: string;
  id: string | null;
}

export interface EraFitMealPlanReport {
  generatedAt: string;
  sourcePath: string;
  clientId: string;
  days: EraFitMealPlanDay[];
  shoppingList: EraFitShoppingListItem[];
}

export interface EraFitMealPlanDay {
  day: string;
  day_tag: string;
  template: string;
  template_id: string;
  targets: EraFitMacroTargets;
  planned: EraFitMacroTotals;
  meals: EraFitMealPlanMeal[];
}

export interface EraFitMealPlanMeal {
  meal: string;
  meal_key: string;
  time: string | null;
  recipe: string | null;
  macros: EraFitMacroTotals;
  items: EraFitMealPlanFoodItem[];
}

export interface EraFitMealPlanFoodItem {
  name: string;
  description: string | null;
  amount: number | null;
  unit: string | null;
  serving: string | null;
  calories: number | null;
  protein: number | null;
  net_carbs: number | null;
  fat: number | null;
  components?: EraFitMealPlanFoodItem[];
}

export interface EraFitShoppingListItem {
  name: string;
  quantity: string;
  meals: number;
  occurrences: number;
  servings: string[];
  variations: string[];
}

interface ShoppingFoodUse {
  food: EraFitMealPlanFoodItem;
  mealId: string;
}

export interface ShoppingMeasure {
  quantity: number;
  unit: string;
  priority: number;
}

export interface EraFitMacroTotals {
  calories: number | null;
  protein: number | null;
  net_carbs: number | null;
  fat: number | null;
}

export function parseNetCarbsValue(netCarbs: unknown, carbohydrate: unknown): number | null {
  const explicitNetCarbs = parseNumberLike(netCarbs);
  if (explicitNetCarbs != null) {
    return explicitNetCarbs;
  }
  return parseNumberLike(carbohydrate);
}

export function calculateNetCarbsFromTotalCarbs(carbohydrate: unknown, fiber: unknown = null): number | null {
  const carbs = parseNumberLike(carbohydrate);
  if (carbs == null) {
    return null;
  }
  const fiberValue = parseNumberLike(fiber) ?? 0;
  return roundNumber(Math.max(0, carbs - fiberValue));
}

interface EraFitMacroTargets extends EraFitMacroTotals {
  goal_calories: number | null;
}

export interface ResolvedDateWindow {
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

export async function resolveSession(logger: EraFitSessionLogger = {}): Promise<EraFitSession> {
  const existingSession = normalizeOptionalString(env.ERA_FIT_SESSION_COOKIE);
  if (existingSession) {
    const sessionCheck = await checkDashboard(existingSession, DEFAULT_DASHBOARD_PATH);
    const app = parseAppCookie(existingSession);
    if (sessionCheck.ok && app) {
      logger.sessionReady?.('cookie');
      return {
        cookieHeader: existingSession,
        app,
        dashboard: sessionCheck,
      };
    }
    const reason = !sessionCheck.ok
      ? sessionCheck.reason
      : 'missing _ef_app_ck_data, which is needed for the nutrition API';
    console.warn(`${SESSION_ENV_KEY} is present but not usable: ${reason}`);
  }

  const envCredentials = parseCredentialsForLogin(env.ERA_FIT_CREDENTIALS);
  if (envCredentials) {
    try {
      logger.loginStart?.('env');
      const session = await loginAndSaveSession(envCredentials);
      logger.sessionReady?.('login');
      return session;
    } catch (error) {
      console.warn(`${CREDENTIALS_ENV_KEY} did not work: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const credentials = await promptCredentials();
  logger.loginStart?.('prompt');
  const session = await loginAndSaveSession(credentials, { saveCredentials: true });
  logger.sessionReady?.('login');
  return session;
}

async function loginAndSaveSession(credentials: Credentials, options: { saveCredentials?: boolean } = {}): Promise<EraFitSession> {
  const loginResult = await login(credentials, DEFAULT_DASHBOARD_PATH);
  const app = parseAppCookie(loginResult.cookieHeader);
  if (!app) {
    throw new Error('Era Fit login succeeded, but the app cookie needed for nutrition API calls was not set.');
  }
  runtimeCredentials = credentials;
  if (options.saveCredentials) {
    saveEnvLocalValue(CREDENTIALS_ENV_KEY, formatCredentials(credentials));
  }
  saveEnvLocalValue(SESSION_ENV_KEY, loginResult.cookieHeader);

  return {
    cookieHeader: loginResult.cookieHeader,
    app,
    dashboard: loginResult.dashboard,
  };
}

export async function fetchEraFitReport(
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
  const recipes = dayPayloads
    .flatMap(day => parseDayRecipeIngredients(day.date, day.payload))
    .sort((a, b) =>
      `${b.date} ${b.time ?? ''} ${b.recipe}`.localeCompare(`${a.date} ${a.time ?? ''} ${a.recipe}`)
    );
  const limitedFoods =
    options.limit && Number.isFinite(options.limit) && options.limit > 0
      ? foods.slice(0, Math.floor(options.limit))
      : foods;

  return {
    generatedAt: formatLocalIso(new Date()),
    sourcePath: NUTRITION_SOURCE_PATH,
    clientId: session.app.id_app,
    window: {
      start: formatDateKey(options.window.start),
      end: formatDateKey(options.window.end),
    },
    returnedDays: dailyOverview.length,
    dailyOverview,
    foods: limitedFoods,
    recipes,
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

export async function searchEraFitFatSecretFoods(
  session: EraFitSession,
  search: string,
  options: { page?: number; maxResultFixed?: number | false } = {}
): Promise<EraFitFatSecretSearchFood[]> {
  const data = await postApi<EraFitFatSecretSearchResponse>(session, '/api/fatsecret_seach', {
    page: options.page ?? 0,
    search,
    max_result_fixed: options.maxResultFixed ?? false,
    method: 'food_name',
  });
  const foods = Array.isArray(data.foods) ? data.foods : Object.values(asRecord(data.foods) ?? {});
  return foods
    .map(food => parseFatSecretSearchFood(asRecord(food)))
    .filter((food): food is EraFitFatSecretSearchFood => food != null);
}

export async function fetchEraFitFatSecretFood(
  session: EraFitSession,
  foodId: string,
  servingScreen: 'meal_tracking' | 'meal_plan' = 'meal_tracking'
): Promise<EraFitFatSecretFood> {
  const data = await postApi<EraFitFatSecretFoodResponse>(session, '/api/fatsecret_seach_id', {
    code: foodId,
    method: 'food_id',
    option: 'insert',
    serving_screen: servingScreen,
  });
  const food = parseFatSecretFood(asRecord(data.food));
  if (!food) {
    throw new Error(`Era Fit did not return FatSecret details for food id ${foodId}.`);
  }
  return food;
}

export async function fetchEraFitFatSecretFoodByBarcode(
  session: EraFitSession,
  barcode: string
): Promise<EraFitFatSecretFood | null> {
  let data: EraFitFatSecretFoodResponse;
  try {
    data = await postApi<EraFitFatSecretFoodResponse>(session, '/api/fatsecret_seach_scan', {
      barcode,
      method: 'food_scan',
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes('Food ID not found for barcode')) {
      return null;
    }
    throw error;
  }
  const food = parseFatSecretFood(asRecord(data.food));
  if (!food) {
    throw new Error(`Era Fit did not return FatSecret details for barcode ${barcode}.`);
  }
  return food;
}

export async function fetchEraFitMealPlan(session: EraFitSession): Promise<EraFitMealPlanReport> {
  const [globals, slots, aiPlan, baseTdee] = await Promise.all([
    fetchMealTrackingGlobals(session),
    fetchMealPlanSlots(session),
    fetchMealPlanAiData(session),
    fetchCurrentBaseTdee(session),
  ]);
  const slotsByDayMeal = new Map<string, EraFitMealPlanSlot>();
  for (const slot of slots) {
    if (slot.plan_type === 'nutrition') {
      slotsByDayMeal.set(`${slot.day_tag}:${slot.meal_type}`, slot);
    }
  }
  const days = WEEKDAY_NAMES.map((day, index) => {
    const dayTag = WEEKDAY_TAGS[index];
    const templateId = globals.targetSchedule[`macro_target_schedule_week_day_${index + 1}`] ?? 'default';
    const template = globals.templates[templateId] ?? globals.templates.default ?? fallbackTemplate();
    const targets = toMacroTargets(computeTemplateTargets(template, baseTdee));
    const rawDay = asRecord(aiPlan[dayTag]);
    const rawMeals = asRecord(rawDay?.meal_plan);
    const meals = MEAL_PLAN_MEAL_KEYS
      .map(mealKey => {
        const meal = parseMealPlanMeal(
          mealKey,
          rawMeals?.[mealKey],
          slotsByDayMeal.get(`${dayTag}:${mealKey}`) ?? null
        );
        return meal;
      })
      .filter((meal): meal is EraFitMealPlanMeal => meal != null);
    return {
      day,
      day_tag: dayTag,
      template: template.title,
      template_id: template.id,
      targets,
      planned: sumMacroTotals(meals.map(meal => meal.macros)),
      meals,
    };
  });

  return {
    generatedAt: formatLocalIso(new Date()),
    sourcePath: MEAL_PLAN_SOURCE_PATH,
    clientId: session.app.id_app,
    days,
    shoppingList: buildShoppingList(days),
  };
}

async function fetchMealPlanSlots(session: EraFitSession): Promise<EraFitMealPlanSlot[]> {
  const response = await fetchUrl('/clients/nutrition/meal-plan', {
    redirect: 'manual',
    headers: {
      Cookie: session.cookieHeader,
      Referer: `${BASE_URL}/clients/dashboard`,
    },
  });
  const html = await response.text();
  if (!response.ok || html.includes('id="login_form"') || html.includes('data-action="/login/access"')) {
    throw new Error(`Era Fit meal-plan page failed to load: ${response.status} ${response.statusText}`);
  }
  return Array.from(html.matchAll(/data-array="([^"]+)"/g))
    .map(match => parseDataArrayAttribute(match[1]))
    .map(value => asRecord(value))
    .filter((value): value is Record<string, unknown> => value != null)
    .map(value => ({
      day_tag: parseString(value.day_week) ?? '',
      hour: parseString(value.hour),
      meal_type: parseString(value.meal_type) ?? '',
      plan_type: parseString(value.plan_type) ?? '',
      id: parseString(value.id),
    }))
    .filter(slot => slot.day_tag && slot.meal_type && slot.plan_type);
}

async function fetchMealPlanAiData(session: EraFitSession): Promise<Record<string, unknown>> {
  const token = await resolveFirebaseIdToken(session);
  const url = new URL(`https://erafit-${session.app.biz_id}.firebaseio.com/db_ai/sys_clients/${session.app.id_app}/meal_plan.json`);
  if (token) {
    url.searchParams.set('auth', token);
  }
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) {
    const authHint = token
      ? `${SESSION_ENV_KEY} loaded, but the Firebase token could not read the AI meal plan.`
      : `Era Fit stores suggested meal details in Firebase RTDB, and the web session did not return a readable Firebase auth token.`;
    throw new Error(`Era Fit meal-plan API request failed: ${response.status} ${response.statusText}. ${authHint}`);
  }
  const json = JSON.parse(text) as unknown;
  const data = asRecord(json);
  if (!data) {
    return {};
  }
  return data;
}

export async function resolveFirebaseIdToken(session: EraFitSession): Promise<string | null> {
  const token = normalizeOptionalString(env.ERA_FIT_FIREBASE_ID_TOKEN);
  if (token) {
    return token;
  }
  if (runtimeFirebaseIdToken) {
    return runtimeFirebaseIdToken;
  }
  const customToken = await fetchFirebaseCustomToken(session);
  if (customToken) {
    runtimeFirebaseIdToken = await exchangeFirebaseCustomToken(customToken);
    return runtimeFirebaseIdToken;
  }
  const credentials = runtimeCredentials ?? parseOptionalCredentials(env.ERA_FIT_CREDENTIALS);
  if (!credentials) {
    return null;
  }
  const response = await fetch(
    firebaseIdentityToolkitUrl('signInWithPassword'),
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: credentials.email,
        password: credentials.password,
        returnSecureToken: true,
      }),
    }
  );
  const json = await response.json() as { idToken?: string; error?: { message?: string } };
  if (!response.ok || !json.idToken) {
    throw new Error(`Era Fit Firebase login failed: ${json.error?.message ?? response.statusText}`);
  }
  runtimeFirebaseIdToken = json.idToken;
  return runtimeFirebaseIdToken;
}

async function fetchFirebaseCustomToken(session: EraFitSession): Promise<string | null> {
  const response = await fetchUrl('/clients/api/get_token', {
    method: 'POST',
    redirect: 'manual',
    headers: {
      Cookie: session.cookieHeader,
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Requested-With': 'XMLHttpRequest',
      Origin: BASE_URL,
      Referer: `${BASE_URL}/clients/nutrition/meal-plan`,
    },
    body: new URLSearchParams({
      biz_id: session.app.biz_id,
    }),
  });
  if (!response.ok) {
    return null;
  }
  const json = await response.json() as { status?: string; token?: string };
  return json.status === '200' ? parseString(json.token) : null;
}

async function exchangeFirebaseCustomToken(token: string): Promise<string> {
  const response = await fetch(
    firebaseIdentityToolkitUrl('signInWithCustomToken'),
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        token,
        returnSecureToken: true,
      }),
    }
  );
  const json = await response.json() as { idToken?: string; error?: { message?: string } };
  if (!response.ok || !json.idToken) {
    throw new Error(`Era Fit Firebase token exchange failed: ${json.error?.message ?? response.statusText}`);
  }
  return json.idToken;
}

function firebaseIdentityToolkitUrl(method: 'signInWithPassword' | 'signInWithCustomToken'): string {
  const apiKey = normalizeOptionalString(env.ERA_FIT_FIREBASE_API_KEY);
  if (!apiKey) {
    throw new Error(`${FIREBASE_API_KEY_ENV} is not set.`);
  }
  return `https://identitytoolkit.googleapis.com/v1/accounts:${method}?key=${encodeURIComponent(apiKey)}`;
}

async function fetchCurrentBaseTdee(session: EraFitSession): Promise<number | null> {
  try {
    const today = formatDateKey(startOfLocalDay(new Date()));
    const payload = await fetchMealTrackingDay(session, today);
    const total = asRecord(payload.total);
    return (
      parseNumberLike(total?.tdee) ??
      parseNumberLike(payload.macro_tdee) ??
      parseNumberLike(asRecord(payload.profile)?.energy_tdee)
    );
  } catch {
    return null;
  }
}

export async function postApi<T>(
  session: EraFitSession,
  apiPath: string,
  data: Record<string, string | number | boolean>
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

export async function readEraFitFirebasePath<T>(session: EraFitSession, dbPath: string): Promise<T | null> {
  const response = await firebaseRequest(session, dbPath, { method: 'GET' });
  return await response.json() as T | null;
}

export async function setEraFitFirebasePath(session: EraFitSession, dbPath: string, value: unknown): Promise<void> {
  await firebaseRequest(session, dbPath, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(value),
  });
}

export async function updateEraFitFirebasePath(
  session: EraFitSession,
  dbPath: string,
  value: Record<string, unknown>
): Promise<void> {
  await firebaseRequest(session, dbPath, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(value),
  });
}

async function firebaseRequest(session: EraFitSession, dbPath: string, init: RequestInit): Promise<Response> {
  const token = await resolveFirebaseIdToken(session);
  if (!token) {
    throw new Error(`${FIREBASE_API_KEY_ENV} and ${CREDENTIALS_ENV_KEY} are required for Era Fit Firebase writes.`);
  }
  const url = new URL(`https://erafit-${session.app.biz_id}.firebaseio.com/${dbPath.replace(/^\/+/, '')}.json`);
  url.searchParams.set('auth', token);
  const response = await fetch(url, init);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Era Fit Firebase request failed: ${response.status} ${response.statusText} (${dbPath}) ${text.slice(0, 500)}`);
  }
  return response;
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
    calories: targets.macroCalories ?? targets.goalCalories ?? consumed.calories,
    goal_calories: targets.goalCalories,
    protein: consumed.protein,
    goal_protein: targets.protein,
    net_carbs: consumed.netCarbs,
    goal_net_carbs: targets.netCarbs,
    fat: consumed.fat,
    goal_fat: targets.fat,
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

function parseDayRecipeIngredients(date: string, payload: EraFitDayPayload): EraFitRecipeIngredientRecord[] {
  const meals = asRecord(payload.meals);
  if (!meals) {
    return [];
  }

  const ingredients: EraFitRecipeIngredientRecord[] = [];
  for (const mealKey of MEAL_KEYS) {
    const meal = asRecord(meals[mealKey]);
    const mealFoods = asRecord(meal?.foods);
    if (!mealFoods) {
      continue;
    }
    for (const rawFood of Object.values(mealFoods)) {
      const recipe = asRecord(rawFood);
      if (!recipe || parseString(recipe.type_item) !== 'my_meals') {
        continue;
      }
      const recipeFoods = asRecord(recipe.foods);
      if (!recipeFoods) {
        continue;
      }
      const multiplier = parseNumberLike(recipe.serving_qtd) ?? 1;
      for (const rawIngredient of Object.values(recipeFoods)) {
        const ingredient = asRecord(rawIngredient);
        if (!ingredient) {
          continue;
        }
        ingredients.push(parseRecipeIngredientRecord(date, mealKey, recipe, ingredient, multiplier));
      }
    }
  }
  return ingredients;
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
      parseNetCarbsValue(raw.net_carbs, raw.carbohydrate),
    fat: scaleNullable(parseNumberLike(total?.fat), totalMultiplier) ?? parseNumberLike(raw.fat),
  };
}

function parseRecipeIngredientRecord(
  date: string,
  mealKey: (typeof MEAL_KEYS)[number],
  recipe: Record<string, unknown>,
  ingredient: Record<string, unknown>,
  multiplier: number
): EraFitRecipeIngredientRecord {
  return {
    date,
    time: parseString(recipe.time),
    meal: MEAL_LABELS[mealKey],
    meal_key: mealKey,
    recipe: parseString(recipe.title) ?? '(untitled)',
    recipe_serving: buildServingString(recipe),
    ingredient: parseString(ingredient.title) ?? parseString(ingredient.food_name) ?? '(untitled)',
    brand: parseString(ingredient.brand_name),
    serving: buildServingString(ingredient),
    calories: scaleNullable(parseNumberLike(ingredient.calories), multiplier),
    protein: scaleNullable(parseNumberLike(ingredient.protein), multiplier),
    net_carbs:
      scaleNullable(parseNumberLike(ingredient.net_carbs), multiplier) ??
      scaleNullable(parseNetCarbsValue(ingredient.net_carbs, ingredient.carbohydrate), multiplier),
    fat: scaleNullable(parseNumberLike(ingredient.fat), multiplier),
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

function parseFatSecretSearchFood(raw: Record<string, unknown> | null): EraFitFatSecretSearchFood | null {
  const foodId = parseString(raw?.food_id);
  const foodName = parseString(raw?.food_name);
  const foodType = parseString(raw?.food_type);
  const foodUrl = parseString(raw?.food_url);
  const foodDescription = parseString(raw?.food_description);
  if (!foodId || !foodName || !foodType || !foodUrl || !foodDescription) {
    return null;
  }
  return {
    food_id: foodId,
    food_name: foodName,
    food_type: foodType,
    food_url: foodUrl,
    food_description: foodDescription,
    brand_name: parseString(raw?.brand_name) ?? undefined,
  };
}

function parseFatSecretFood(raw: Record<string, unknown> | null): EraFitFatSecretFood | null {
  const foodId = parseString(raw?.food_id);
  const foodName = parseString(raw?.food_name);
  const foodType = parseString(raw?.food_type);
  const foodUrl = parseString(raw?.food_url);
  const servings = asRecord(raw?.servings);
  if (!foodId || !foodName || !foodType || !foodUrl || !servings) {
    return null;
  }
  return {
    food_id: foodId,
    food_name: foodName,
    food_type: foodType,
    food_url: foodUrl,
    brand_name: parseString(raw?.brand_name) ?? undefined,
    servings: Object.fromEntries(
      Object.entries(servings)
        .map(([key, value]) => {
          const serving = parseFatSecretServing(asRecord(value));
          return serving ? [serving.serving_id || key, serving] : null;
        })
        .filter((entry): entry is [string, EraFitFatSecretServing] => entry != null)
    ),
  };
}

function parseFatSecretServing(raw: Record<string, unknown> | null): EraFitFatSecretServing | null {
  const servingId = parseString(raw?.serving_id);
  const servingDescription = parseString(raw?.serving_description);
  if (!servingId || !servingDescription) {
    return null;
  }
  return Object.fromEntries(
    Object.entries({
      serving_id: servingId,
      serving_description: servingDescription,
      serving_url: parseString(raw?.serving_url),
      metric_serving_amount: parseString(raw?.metric_serving_amount),
      metric_serving_unit: parseString(raw?.metric_serving_unit),
      number_of_units: parseString(raw?.number_of_units),
      measurement_description: parseString(raw?.measurement_description),
      calories: parseString(raw?.calories),
      carbohydrate: parseString(raw?.carbohydrate),
      protein: parseString(raw?.protein),
      fat: parseString(raw?.fat),
      saturated_fat: parseString(raw?.saturated_fat),
      trans_fat: parseString(raw?.trans_fat),
      polyunsaturated_fat: parseString(raw?.polyunsaturated_fat),
      monounsaturated_fat: parseString(raw?.monounsaturated_fat),
      cholesterol: parseString(raw?.cholesterol),
      sodium: parseString(raw?.sodium),
      potassium: parseString(raw?.potassium),
      fiber: parseString(raw?.fiber),
      sugar: parseString(raw?.sugar),
      vitamin_a: parseString(raw?.vitamin_a),
      vitamin_c: parseString(raw?.vitamin_c),
      vitamin_d: parseString(raw?.vitamin_d),
      calcium: parseString(raw?.calcium),
      iron: parseString(raw?.iron),
      added_sugars: parseString(raw?.added_sugars),
    }).filter((entry): entry is [string, string] => entry[1] != null)
  ) as unknown as EraFitFatSecretServing;
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

function parseMealPlanMeal(
  mealKey: (typeof MEAL_PLAN_MEAL_KEYS)[number],
  value: unknown,
  slot: EraFitMealPlanSlot | null
): EraFitMealPlanMeal | null {
  const raw = asRecord(value);
  if (!raw && !slot) {
    return null;
  }
  const total = asRecord(raw?.total_meal_macros) ?? asRecord(raw?.meal_macros_sum);
  const foodItems = Array.isArray(raw?.foods)
    ? raw.foods
    : Array.isArray(raw)
      ? raw
      : Object.entries(asRecord(raw?.foods) ?? raw ?? {})
        .filter(([key]) => key !== 'meal_macros_sum' && key !== 'total_meal_macros' && key !== 'meal_recipe')
        .map(([, item]) => item);
  const items = foodItems
    .map(item => parseMealPlanFoodItem(item))
    .filter((item): item is EraFitMealPlanFoodItem => item != null);
  const macros = {
    calories: parseNumberLike(total?.calories) ?? sumNumbers(items.map(item => item.calories)),
    protein: parseNumberLike(total?.protein_g) ?? parseNumberLike(total?.protein) ?? sumNumbers(items.map(item => item.protein)),
    net_carbs: parseNetCarbsValue(total?.net_carbs, parseNumberLike(total?.carbs_g) ?? total?.carbs) ??
      sumNumbers(items.map(item => item.net_carbs)),
    fat: parseNumberLike(total?.fat_g) ?? parseNumberLike(total?.fat) ?? sumNumbers(items.map(item => item.fat)),
  };
  return {
    meal: MEAL_PLAN_MEAL_LABELS[mealKey],
    meal_key: mealKey,
    time: slot?.hour ?? null,
    recipe: parseString(raw?.meal_recipe),
    macros,
    items,
  };
}

function parseMealPlanFoodItem(value: unknown): EraFitMealPlanFoodItem | null {
  const raw = asRecord(value);
  if (!raw) {
    return null;
  }
  const description = parseString(raw.description);
  const rawName =
    parseString(raw.name) ??
    parseString(raw.tag) ??
    parseString(raw.title) ??
    parseString(raw.food_name);
  const name = rawName ?? parseFoodNameFromDescription(description);
  if (!name) {
    return null;
  }
  const serving = parseServingFromDescription(description) ?? buildServingString(raw);
  const amount =
    parseNumberLike(raw.amount_g) ??
    parseNumberLike(raw.amount) ??
    parseNumberLike(raw.quantity) ??
    parseNumberLike(raw.serving_qtd);
  const unit =
    parseNumberLike(raw.amount_g) != null
      ? 'g'
      : parseString(raw.unit) ?? parseString(raw.serving_unit) ?? parseString(raw.metric_serving_unit);
  const components = parseMealPlanFoodComponents(raw);
  return {
    name,
    description,
    amount,
    unit,
    serving: serving || null,
    calories: parseNumberLike(raw.calories),
    protein: parseNumberLike(raw.protein_g) ?? parseNumberLike(raw.protein),
    net_carbs: parseNetCarbsValue(raw.net_carbs, parseNumberLike(raw.carbs_g) ?? raw.carbs),
    fat: parseNumberLike(raw.fat_g) ?? parseNumberLike(raw.fat),
    ...(components.length > 0 ? { components } : {}),
  };
}

function parseMealPlanFoodComponents(raw: Record<string, unknown>): EraFitMealPlanFoodItem[] {
  for (const value of [raw.foods, raw.ingredients, raw.components, raw.recipe_items]) {
    const components = mealPlanFoodComponentValues(value)
      .map(component => parseMealPlanFoodItem(component))
      .filter((component): component is EraFitMealPlanFoodItem => component != null);
    if (components.length > 0) {
      return components;
    }
  }
  return [];
}

function mealPlanFoodComponentValues(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  const record = asRecord(value);
  if (!record) {
    return [];
  }
  return Object.entries(record)
    .filter(([key]) => key !== 'meal_macros_sum' && key !== 'total_meal_macros' && key !== 'meal_recipe' && key !== 'total')
    .map(([, component]) => component);
}

function parseFoodNameFromDescription(value: string | null): string | null {
  if (!value) {
    return null;
  }
  return value
    .replace(/^\s*(?:\d+(?:\.\d+)?|\d+\/\d+)\s*(?:(?:large|medium|small)\s+)?(?:g|oz|cup|cups|tbsp|tsp|serving|servings|slice|slices|piece|pieces|scoop|scoops|spear|spears|packet|packets)?\s+/i, '')
    .replace(/\s*\([^)]*\)\s*$/, '')
    .trim() || null;
}

function parseServingFromDescription(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const match = value.match(/^\s*((?:\d+(?:\.\d+)?|\d+\/\d+)\s*(?:g|oz|cup|cups|tbsp|tsp|serving|servings|slice|slices|piece|pieces)\b)/i);
  return match?.[1] ?? null;
}

function toMacroTargets(targets: ReturnType<typeof computeTemplateTargets>): EraFitMacroTargets {
  return {
    calories: targets.macroCalories ?? targets.goalCalories,
    goal_calories: targets.goalCalories,
    protein: targets.protein,
    net_carbs: targets.netCarbs,
    fat: targets.fat,
  };
}

function sumMacroTotals(values: EraFitMacroTotals[]): EraFitMacroTotals {
  return {
    calories: sumNumbers(values.map(value => value.calories)),
    protein: sumNumbers(values.map(value => value.protein)),
    net_carbs: sumNumbers(values.map(value => value.net_carbs)),
    fat: sumNumbers(values.map(value => value.fat)),
  };
}

function buildShoppingList(days: EraFitMealPlanDay[]): EraFitShoppingListItem[] {
  const grouped = new Map<string, ShoppingFoodUse[]>();
  for (const day of days) {
    for (const meal of day.meals) {
      const mealId = `${day.day_tag}:${meal.meal_key}`;
      for (const food of meal.items) {
        const key = normalizeShoppingName(food.name);
        grouped.set(key, [...(grouped.get(key) ?? []), { food, mealId }]);
      }
    }
  }

  return Array.from(grouped.values())
    .map(uses => {
      const servings = uniqueStrings(uses.map(use => use.food.serving).filter((value): value is string => value != null));
      const displayName = chooseShoppingDisplayName(uses);
      return {
        name: displayName,
        quantity: formatShoppingQuantity(uses),
        meals: new Set(uses.map(use => use.mealId)).size,
        occurrences: uses.length,
        servings,
        variations: shoppingVariationNames(uses, displayName),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function normalizeShoppingName(value: string): string {
  let normalized = value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/sautéed/g, 'sauteed')
    .replace(/[^a-z0-9%]+/g, ' ')
    .trim();

  normalized = normalized
    .replace(/\b(?:large|medium|small)\b/g, ' ')
    .replace(/\b(?:sliced|diced|cubed|cubes|toasted)\b/g, ' ')
    .replace(/\b(?:fillet|patty|stand in)\b/g, ' ')
    .replace(/\b(?:dry cooked|cooked dry)\b/g, 'dry')
    .replace(/\b(?:grilled|scrambled|sauteed|steamed|roasted|cooked|raw)\b/g, ' ')
    .replace(/\beggs\b/g, 'egg')
    .replace(/\bwhites\b/g, 'white')
    .replace(/\bscoops\b/g, 'scoop')
    .replace(/\bspears\b/g, 'spear')
    .replace(/\bpackets\b/g, 'packet')
    .replace(/\bcups\b/g, 'cup')
    .replace(/\bslices\b/g, 'slice')
    .replace(/\bbananas\b/g, 'banana')
    .replace(/\bstrawberries\b/g, 'strawberry')
    .replace(/\bblackberries\b/g, 'blackberry')
    .replace(/\bblueberries\b/g, 'blueberry')
    .replace(/\bavocados\b/g, 'avocado')
    .replace(/\s+/g, ' ')
    .trim();

  return normalized;
}

function chooseShoppingDisplayName(uses: ShoppingFoodUse[]): string {
  return uses
    .map(use => cleanSimpleShoppingName(use.food.name))
    .sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
}

function cleanSimpleShoppingName(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/^\s*(?:large|medium|small|scoop|scoops|spear|spears)\s+/i, '')
    .replace(/\b(?:sliced|diced|cubed|cubes|toasted|fillet|patty|grilled|scrambled|sauteed|steamed|roasted|cooked|raw)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function shoppingVariationNames(uses: ShoppingFoodUse[], displayName: string): string[] {
  const seen = new Set<string>();
  const displayKey = normalizeVariationName(displayName);
  const variations: string[] = [];
  for (const use of uses) {
    const variation = parseFoodNameFromDescription(use.food.description) ?? use.food.name;
    const key = normalizeVariationName(variation);
    if (!key || key === displayKey || seen.has(key)) {
      continue;
    }
    seen.add(key);
    variations.push(variation);
  }
  return variations.sort((a, b) => a.localeCompare(b));
}

function normalizeVariationName(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9%]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatShoppingQuantity(uses: ShoppingFoodUse[]): string {
  const inferred = inferShoppingMeasures(uses);
  const best = chooseBestShoppingMeasure(inferred);
  if (best) {
    return formatShoppingMeasure(best);
  }
  const grams = sumNumbers(uses.map(use => use.food.unit === 'g' ? use.food.amount : null));
  return grams > 0 ? `${formatNumber(grams)} g` : `${uses.length}x`;
}

function inferShoppingMeasures(uses: ShoppingFoodUse[]): ShoppingMeasure[] {
  const parsedMeasures = uses.map(use => ({
    use,
    measure: parseShoppingMeasure(use.food),
  }));
  const ratioByGram = new Map<string, ShoppingMeasure>();
  for (const { use, measure } of parsedMeasures) {
    if (!measure || use.food.amount == null || use.food.unit !== 'g' || use.food.amount <= 0) {
      continue;
    }
    const key = `${use.food.amount}:${use.food.unit}`;
    if (!ratioByGram.has(key) || measure.priority < ratioByGram.get(key)!.priority) {
      ratioByGram.set(key, measure);
    }
  }
  return parsedMeasures.map(({ use, measure }) => {
    if (use.food.amount != null && use.food.unit === 'g') {
      const inferred = ratioByGram.get(`${use.food.amount}:${use.food.unit}`);
      if (inferred && (!measure || inferred.priority < measure.priority)) {
        return inferred;
      }
    }
    if (measure) {
      return measure;
    }
    if (use.food.amount != null && use.food.unit === 'g') {
      return {
        quantity: use.food.amount,
        unit: 'g',
        priority: 50,
      };
    }
    return null;
  }).filter((measure): measure is ShoppingMeasure => measure != null);
}

function parseShoppingMeasure(food: EraFitMealPlanFoodItem): ShoppingMeasure | null {
  const candidates = [food.serving, food.description, food.description?.split(':').at(-1) ?? null]
    .filter((value): value is string => value != null);
  for (const value of candidates) {
    const measure = parseShoppingMeasureText(value, food.name);
    if (measure) {
      return measure;
    }
  }
  return null;
}

function parseShoppingMeasureText(value: string, foodName: string): ShoppingMeasure | null {
  const match = value.trim().match(/^(\d+\s*\/\s*\d+|\d+(?:\.\d+)?)\s*([A-Za-z%]+)?/);
  if (!match) {
    return null;
  }
  const quantity = parseQuantity(match[1]);
  if (quantity == null) {
    return null;
  }
  const rest = value.trim().slice(match[0].length).trim();
  const unit = canonicalShoppingUnit(match[2], rest, foodName);
  if (!unit) {
    return null;
  }
  return {
    quantity,
    unit,
    priority: shoppingUnitPriority(unit),
  };
}

export function canonicalShoppingUnit(rawUnit: string | undefined, rest: string, foodName: string): string | null {
  const unit = rawUnit?.toLowerCase();
  if (unit && ['g', 'gram', 'grams'].includes(unit)) {
    return 'g';
  }
  if (unit && ['oz', 'ounce', 'ounces'].includes(unit)) {
    return 'oz';
  }
  if (unit && ['cup', 'cups'].includes(unit)) {
    return 'cups';
  }
  if (unit && ['tbsp', 'tablespoon', 'tablespoons'].includes(unit)) {
    return 'tbsp';
  }
  if (unit && ['tsp', 'teaspoon', 'teaspoons'].includes(unit)) {
    return 'tsp';
  }
  if (unit && ['slice', 'slices'].includes(unit)) {
    return 'slices';
  }
  if (unit && ['scoop', 'scoops'].includes(unit)) {
    return 'scoops';
  }
  if (unit && ['packet', 'packets'].includes(unit)) {
    return 'packets';
  }
  if (unit && ['spear', 'spears'].includes(unit)) {
    return 'spears';
  }
  const restLower = `${unit ?? ''} ${rest}`.trim().toLowerCase();
  const nameLower = foodName.toLowerCase();
  if (/^(large|medium|small)\s+/.test(restLower)) {
    if (nameLower.includes('egg white')) {
      return 'egg whites';
    }
    if (nameLower.includes('egg')) {
      return 'eggs';
    }
    if (nameLower.includes('banana')) {
      return 'bananas';
    }
    if (nameLower.includes('avocado')) {
      return 'avocados';
    }
  }
  return null;
}

export function shoppingUnitPriority(unit: string): number {
  if (['eggs', 'egg whites', 'bananas', 'avocados', 'slices', 'spears', 'scoops', 'packets'].includes(unit)) {
    return 10;
  }
  if (['cups', 'tbsp', 'tsp', 'oz'].includes(unit)) {
    return 20;
  }
  return 50;
}

function chooseBestShoppingMeasure(measures: ShoppingMeasure[]): ShoppingMeasure | null {
  if (measures.length === 0) {
    return null;
  }
  const normalized = measures.map(normalizeShoppingMeasureUnit);
  const bestUnit = normalized.reduce((best, measure) => measure.priority < best.priority ? measure : best).unit;
  const matching = normalized.filter(measure => measure.unit === bestUnit);
  return {
    quantity: roundNumber(sumNumbers(matching.map(measure => measure.quantity))),
    unit: bestUnit,
    priority: matching[0].priority,
  };
}

function normalizeShoppingMeasureUnit(measure: ShoppingMeasure): ShoppingMeasure {
  if (measure.unit === 'tsp') {
    return {
      quantity: measure.quantity / 3,
      unit: 'tbsp',
      priority: shoppingUnitPriority('tbsp'),
    };
  }
  return measure;
}

function formatShoppingMeasure(measure: ShoppingMeasure): string {
  const unit = measure.unit === 'g' || measure.unit === 'oz' || measure.quantity !== 1
    ? measure.unit
    : singularShoppingUnit(measure.unit);
  return `${formatNumber(roundNumber(measure.quantity))} ${unit}`;
}

function singularShoppingUnit(unit: string): string {
  const singulars: Record<string, string> = {
    eggs: 'egg',
    'egg whites': 'egg white',
    bananas: 'banana',
    avocados: 'avocado',
    slices: 'slice',
    spears: 'spear',
    scoops: 'scoop',
    packets: 'packet',
    cups: 'cup',
  };
  return singulars[unit] ?? unit;
}

export function parseQuantity(value: string): number | null {
  const normalized = value.replace(/\s+/g, '');
  if (normalized.includes('/')) {
    const [numerator, denominator] = normalized.split('/').map(Number);
    return Number.isFinite(numerator) && Number.isFinite(denominator) && denominator !== 0
      ? numerator / denominator
      : null;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

export function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function parseDataArrayAttribute(value: string): unknown | null {
  for (const raw of [value, decodeURIComponent(value)]) {
    try {
      return JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    } catch {}
    try {
      return JSON.parse(decodeURIComponent(Buffer.from(raw, 'base64').toString('utf8')));
    } catch {}
  }
  return null;
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

async function promptCredentials(): Promise<Credentials> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(`Era Fit needs ${CREDENTIALS_ENV_KEY}=<email>:<password> in .env.local, but this shell is not interactive enough to prompt.`);
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

function parseCredentialsForLogin(value: string | undefined): Credentials | null {
  try {
    return parseOptionalCredentials(value);
  } catch (error) {
    console.warn(`${CREDENTIALS_ENV_KEY} is not usable: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
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

function formatCredentials(credentials: Credentials): string {
  return `${credentials.email}:${credentials.password}`;
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

export function resolveDateWindow(options: {
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

export function parseLocalDate(value: string, label: string): Date {
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

export function startOfLocalDay(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

function addDays(value: Date, days: number): Date {
  const next = new Date(value);
  next.setDate(next.getDate() + days);
  return next;
}

export function formatDateKey(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatLocalIso(value: Date): string {
  const offsetMs = value.getTimezoneOffset() * 60 * 1000;
  return new Date(value.getTime() - offsetMs).toISOString().replace('Z', '');
}

export function formatLongDate(value: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(value);
}

export function formatEraFitDateId(date: Date): string {
  const dayOfYearZeroBased = Math.floor(
    (Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) - Date.UTC(date.getFullYear(), 0, 1)) / MS_PER_DAY
  );
  return `${date.getFullYear()}${dayOfYearZeroBased}`;
}

export function isEraFitMealKey(value: string): value is EraFitMealKey {
  return (MEAL_KEYS as readonly string[]).includes(value);
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

function scaleNullable(value: number | null, multiplier: number): number | null {
  return value == null ? null : roundNumber(value * multiplier);
}

function sumNumbers(values: Array<number | null>): number {
  return values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}

export function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3)));
}

export function roundNumber(value: number): number {
  return Number(value.toFixed(3));
}

export function parseNumberLike(value: unknown): number | null {
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
