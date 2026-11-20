#!/usr/bin/env bun
import { createScript } from './utils/createScript';

import { addDays, format, isValid, parseISO } from 'date-fns';

import env from './env';
import {
	CONNECT_TOKEN_FILE,
	ConnectApi,
	PERSONAL_KEY_PAGE,
	PersonalApi,
	SWAGGER_PAGE,
	connectLoginEmail,
	loginToConnect,
	type Params,
} from './garminApi';
import { parseWellnessZip, type WellnessFitData } from './garminFit';
import { averageHeartRate, estimateStrain, strainTimeline, type HeartRatePoint } from './garminStrain';
import { formatDurationMilliseconds } from './utils/date';
import {
	OUTPUT_FORMATS,
	formatDisplayNumber,
	parseOutputFormat,
	renderCsvRecords,
	renderTableRecords,
	type CsvValue,
} from './utils/output';
import { parseWhoopRange, WhoopAppApi } from './whoopApp';

// The tightest range cap in the Personal API spec (steps and stress); sleep and Body Battery allow 31, daily summaries a year.
const MAX_RANGE_DAYS = 28;
const ACTIVITY_PAGE_SIZE = 100;
const PER_DAY_CONCURRENCY = 4;

const TABLE_COLUMNS = [
	'date',
	'sleep_score',
	'sleep_start',
	'sleep_duration',
	'restorative',
	'efficiency',
	'sleep_debt',
	'HRV',
	'RHR',
	'readiness',
	'bb_wake',
	'strain',
	'stress',
	'steps',
	'activities',
] as const;

const FULL_COLUMNS = [
	...TABLE_COLUMNS,
	'sleep_end',
	'sleep_deep',
	'sleep_light',
	'sleep_rem',
	'sleep_awake',
	'restorative_pct',
	'sleep_need',
	'next_sleep_need',
	'next_bedtime',
	'awake_count',
	'nap_duration',
	'sleep_hr',
	'sleep_respiration',
	'sleep_spo2',
	'sleep_stress',
	'HRV_7d',
	'hrv_status',
	'readiness_level',
	'acute_load',
	'load_status',
	'health_status',
	'skin_temp',
	'vo2max',
	'bb_high',
	'bb_low',
	'bb_charged',
	'bb_drained',
	'stress_max',
	'respiration',
	'spo2',
	'active_kcal',
	'total_kcal',
	'intensity_moderate',
	'intensity_vigorous',
	'floors',
] as const;

type Column = (typeof FULL_COLUMNS)[number];
type DailyRow = Record<Column, CsvValue>;

interface SleepNeed {
	actual?: number | null;
	recommendedBedtimeStartMins?: number | null;
	recommendedBedtimeEndMins?: number | null;
}

interface DailySleep {
	calendarDate: string;
	sleepTimeSeconds?: number | null;
	napTimeSeconds?: number | null;
	sleepStartTimestampGMT?: number | null;
	sleepStartTimestampLocal?: string | number | null;
	sleepEndTimestampLocal?: string | number | null;
	deepSleepSeconds?: number | null;
	lightSleepSeconds?: number | null;
	remSleepSeconds?: number | null;
	awakeSleepSeconds?: number | null;
	awakeCount?: number | null;
	avgHeartRate?: number | null;
	averageRespirationValue?: number | null;
	averageSpO2Value?: number | null;
	avgSleepStress?: number | null;
	sleepScores?: Record<string, { value?: number | null } | undefined> | null;
	sleepNeed?: SleepNeed | null;
	nextSleepNeed?: SleepNeed | null;
}

interface HrvSummary {
	calendarDate: string;
	weeklyAvg?: number | null;
	lastNightAvg?: number | null;
	status?: string | null;
}

interface DailySummary {
	calendarDate: string;
	movement?: { steps?: { value?: number | null } | null; floorsAscended?: { value?: number | null } | null } | null;
	calories?: { burnedActive?: number | null; burnedTotal?: number | null } | null;
	heartRate?: { restingValue?: number | null } | null;
	intensityMinutes?: { moderate?: number | null; vigorous?: number | null } | null;
	stress?: { avgLevel?: number | null; maxLevel?: number | null } | null;
	bodyBattery?: {
		minValue?: number | null;
		maxValue?: number | null;
		chargedValue?: number | null;
		drainedValue?: number | null;
	} | null;
	respiration?: { avgValue?: number | null } | null;
	pulseOx?: { avgValue?: number | null } | null;
}

interface UserSummary {
	calendarDate?: string | null;
	bodyBatteryAtWakeTime?: number | null;
}

interface Activity {
	activityId?: number | null;
	activityName?: string | null;
	averageHR?: number | null;
	maxHR?: number | null;
	startTimeLocal?: string | null;
	duration?: number | null;
	activityType?: { typeKey?: string | null } | null;
}

interface ConnectActivitySummary {
	activityName?: string | null;
	summaryDTO?: { startTimeLocal?: string | null; duration?: number | null } | null;
}

interface TrainingReadiness {
	calendarDate: string;
	timestamp?: string | null;
	score?: number | null;
	level?: string | null;
	inputContext?: string | null;
}

interface TrainingStatus {
	mostRecentTrainingStatus?: {
		latestTrainingStatusData?: Record<
			string,
			{
				calendarDate?: string | null;
				primaryTrainingDevice?: boolean | null;
				acuteTrainingLoadDTO?: { dailyTrainingLoadAcute?: number | null; acwrStatus?: string | null } | null;
			}
		> | null;
	} | null;
}

interface SleepStats {
	individualStats?: { calendarDate: string; values?: { skinTempC?: number | null } | null }[] | null;
}

interface MaxMetrics {
	generic?: { calendarDate?: string | null; vo2MaxPreciseValue?: number | null; vo2MaxValue?: number | null } | null;
}

interface HealthStatus {
	calendarDate: string;
	outliersCount?: number | null;
	metrics?: { type: string; status?: string | null; value?: number | null }[] | null;
}

type Range = { start: Date; end: Date };
const day = (date: Date) => format(date, 'yyyy-MM-dd');

function parseDay(value: string, flag: string): Date {
	const date = parseISO(value);
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !isValid(date))
		throw new Error(`--${flag} must be a YYYY-MM-DD date, got '${value}'.`);
	return date;
}

function resolveRange(args: { start?: string; end?: string; days: number }): Range {
	if (!Number.isInteger(args.days) || args.days < 1)
		throw new Error(`--days must be a positive integer, got ${args.days}.`);
	const end = args.end ? parseDay(args.end, 'end') : new Date();
	const start = args.start ? parseDay(args.start, 'start') : addDays(end, 1 - args.days);
	if (start > end) throw new Error(`--start ${day(start)} is after --end ${day(end)}.`);
	return { start, end };
}

function eachDay({ start, end }: Range): string[] {
	const days: string[] = [];
	for (let date = start; date <= end; date = addDays(date, 1)) days.push(day(date));
	return days;
}

function chunkRange({ start, end }: Range): [string, string][] {
	const chunks: [string, string][] = [];
	for (let from = start; from <= end; from = addDays(from, MAX_RANGE_DAYS)) {
		const to = addDays(from, MAX_RANGE_DAYS - 1);
		chunks.push([day(from), day(to > end ? end : to)]);
	}
	return chunks;
}

async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const results: R[] = [];
	for (let index = 0; index < items.length; index += limit) {
		results.push(...(await Promise.all(items.slice(index, index + limit).map(fn))));
	}
	return results;
}

async function fetchActivities(api: PersonalApi, startDate: string, endDate: string): Promise<Activity[]> {
	const activities: Activity[] = [];
	for (let start = 0; ; start += ACTIVITY_PAGE_SIZE) {
		const page = await api.get<Activity[]>('/activitylist-service/activities/search/activities', {
			start,
			limit: ACTIVITY_PAGE_SIZE,
			startDate,
			endDate,
		});
		activities.push(...page);
		if (page.length < ACTIVITY_PAGE_SIZE) return activities;
	}
}

function activityRecord(activity: Activity): Record<string, CsvValue> {
	return {
		id: activity.activityId ?? null,
		start: activity.startTimeLocal ?? null,
		name: activity.activityName ?? null,
		type: activity.activityType?.typeKey ?? null,
		duration: activity.duration == null ? null : formatDurationMilliseconds(activity.duration * 1000),
		avg_hr: activity.averageHR ?? null,
		max_hr: activity.maxHR ?? null,
	};
}

async function fetchPersonalDaily(api: PersonalApi, range: Range) {
	const chunks = await Promise.all(
		chunkRange(range).map(async ([from, to]) => {
			const [summaries, sleeps, hrv, activities] = await Promise.all([
				api.get<{ data?: DailySummary[] | null }>('/usersummary-service/v2/dailysummaries', {
					startDate: from,
					endDate: to,
				}),
				api.get<DailySleep[] | null>('/sleep-service/sleep/dailySleepSummariesByDate', {
					startDate: from,
					endDate: to,
				}),
				api.get<{ hrvSummaries?: HrvSummary[] | null } | null>(`/hrv-service/hrv/daily/${from}/${to}`),
				fetchActivities(api, from, to),
			]);
			return { summaries: summaries?.data ?? [], sleeps: sleeps ?? [], hrv: hrv?.hrvSummaries ?? [], activities };
		}),
	);
	// Body Battery at wake (the closest thing to WHOOP's Recovery before Training Readiness calibrates) is only in the per-day summary.
	const userSummaries = await mapLimited(eachDay(range), PER_DAY_CONCURRENCY, calendarDate =>
		api
			.get<UserSummary | null>('/usersummary-service/usersummary/daily', { calendarDate })
			.then(summary => ({ ...summary, calendarDate })),
	);
	// Strain runs from one sleep onset to the next, like a WHOOP cycle, so it also needs the day after the range.
	const nextDay = day(addDays(range.end, 1));
	const hasNextDay = nextDay <= day(new Date());
	const activities = chunks.flatMap(chunk => chunk.activities);
	const [heartRate, nextSleeps, activityHeartRate] = await Promise.all([
		fetchAllDayHeartRate(api, [...eachDay(range), ...(hasNextDay ? [nextDay] : [])]),
		hasNextDay
			? api.get<DailySleep[] | null>('/sleep-service/sleep/dailySleepSummariesByDate', {
					startDate: nextDay,
					endDate: nextDay,
				})
			: null,
		mapLimited(
			activities.filter(activity => activity.activityId != null),
			PER_DAY_CONCURRENCY,
			activity => fetchActivityHeartRate(api, activity.activityId!),
		),
	]);
	return {
		summaries: chunks.flatMap(chunk => chunk.summaries),
		sleeps: chunks.flatMap(chunk => chunk.sleeps),
		hrv: chunks.flatMap(chunk => chunk.hrv),
		activities,
		userSummaries,
		heartRate,
		nextSleeps: nextSleeps ?? [],
		activityHeartRate,
	};
}

/** All-day heart rate: 2-minute averages, local midnight to midnight per date. */
async function fetchAllDayHeartRate(api: PersonalApi, dates: string[]): Promise<HeartRatePoint[]> {
	const days = await mapLimited(dates, PER_DAY_CONCURRENCY, date =>
		api.get<{ heartRateValues?: (number | null)[][] | null } | null>('/wellness-service/wellness/dailyHeartRate', {
			date,
		}),
	);
	return days.flatMap(dayData =>
		(dayData?.heartRateValues ?? []).flatMap(([time, bpm]) =>
			typeof time === 'number' && typeof bpm === 'number' && bpm > 0 ? [{ time, bpm }] : [],
		),
	);
}

async function fetchActivityHeartRate(api: PersonalApi, activityId: number): Promise<HeartRatePoint[]> {
	const details = await api.get<{
		metricDescriptors?: { key: string; metricsIndex: number }[] | null;
		activityDetailMetrics?: { metrics: (number | null)[] }[] | null;
	} | null>(`/activity-service/activity/${activityId}/details`, { maxChartSize: 100_000 });
	const index = (key: string) => details?.metricDescriptors?.find(descriptor => descriptor.key === key)?.metricsIndex;
	const timeIndex = index('directTimestamp');
	const bpmIndex = index('directHeartRate');
	if (timeIndex == null || bpmIndex == null) return [];
	return (details?.activityDetailMetrics ?? []).flatMap(({ metrics }) => {
		const time = metrics[timeIndex];
		const bpm = metrics[bpmIndex];
		return time != null && bpm != null && bpm > 0 ? [{ time, bpm }] : [];
	});
}

const HEALTH_STATUS_FIELDS = '{ calendarDate outliersCount metrics { type status value } }';

async function fetchConnectDaily(api: ConnectApi, range: Range) {
	const chunks = await Promise.all(
		chunkRange(range).map(async ([from, to]) => {
			const days = eachDay({ start: parseISO(from), end: parseISO(to) });
			const healthQuery = `query { ${days.map((date, index) => `d${index}: healthStatusSummary(calendarDate:"${date}") ${HEALTH_STATUS_FIELDS}`).join(' ')} }`;
			const [readiness, sleepStats, maxMetrics, health] = await Promise.all([
				api.get<TrainingReadiness[] | null>(`/metrics-service/metrics/trainingreadiness/${from}/${to}`),
				api.get<SleepStats | null>(`/sleep-service/stats/sleep/daily/${from}/${to}`),
				api.get<MaxMetrics[] | null>(`/metrics-service/metrics/maxmet/daily/${from}/${to}`),
				api.graphql<Record<string, HealthStatus | null>>(healthQuery),
			]);
			return {
				readiness: readiness ?? [],
				sleepStats: sleepStats?.individualStats ?? [],
				maxMetrics: maxMetrics ?? [],
				health: Object.values(health ?? {}).filter((status): status is HealthStatus => status != null),
			};
		}),
	);
	// Training Readiness entries mostly leave acuteLoad null; the per-day training status always has it.
	const trainingStatus = await mapLimited(eachDay(range), PER_DAY_CONCURRENCY, date =>
		api.get<TrainingStatus | null>(`/metrics-service/metrics/trainingstatus/aggregated/${date}`).then(status => {
			const devices = Object.values(status?.mostRecentTrainingStatus?.latestTrainingStatusData ?? {});
			const data = devices.find(device => device.primaryTrainingDevice) ?? devices[0];
			return { date, load: data?.calendarDate === date ? data.acuteTrainingLoadDTO : null };
		}),
	);
	return {
		trainingStatus,
		readiness: chunks.flatMap(chunk => chunk.readiness),
		sleepStats: chunks.flatMap(chunk => chunk.sleepStats),
		maxMetrics: chunks.flatMap(chunk => chunk.maxMetrics),
		health: chunks.flatMap(chunk => chunk.health),
	};
}

type PersonalDaily = Awaited<ReturnType<typeof fetchPersonalDaily>>;
type ConnectDaily = Awaited<ReturnType<typeof fetchConnectDaily>>;

/** Connect data is optional: without credentials, or when Garmin breaks the unofficial login, the official columns still print. */
async function connectOrWarn(): Promise<ConnectApi | null> {
	if (!env.GARMIN_CREDENTIALS) {
		console.error(
			"Skipping Garmin Connect columns (readiness, health status, skin temp, VO2 max): GARMIN_CREDENTIALS is not set. Add GARMIN_CREDENTIALS='<email>:<password>' to .env.local.",
		);
		return null;
	}
	try {
		return await ConnectApi.connect();
	} catch (error) {
		console.error(`Skipping Garmin Connect columns: ${error instanceof Error ? error.message : String(error)}`);
		return null;
	}
}

// Garmin's "Local" sleep timestamps are epoch ms shifted by the user's UTC offset, so the UTC fields read as local wall time.
function formatLocalClock(value: string | number | null | undefined): CsvValue {
	if (value == null || value === '') return null;
	const wallClock = typeof value === 'string' ? /T(\d{2}:\d{2})/.exec(value) : null;
	if (wallClock) return wallClock[1]!;
	const date = new Date(Number(value));
	if (!isValid(date)) return null;
	return `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`;
}

const seconds = (value: number | null | undefined): CsvValue =>
	formatDurationMilliseconds(value == null ? null : value * 1000) || null;
const minutes = (value: number | null | undefined): CsvValue =>
	value == null ? null : formatDurationMilliseconds(value * 60_000) || null;
const clockFromMinutes = (value: number | null | undefined): string | null =>
	value == null
		? null
		: `${String(Math.floor(value / 60) % 24).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;

function bedtimeWindow(need: SleepNeed | null | undefined): CsvValue {
	const start = clockFromMinutes(need?.recommendedBedtimeStartMins);
	const end = clockFromMinutes(need?.recommendedBedtimeEndMins);
	return start && end ? `${start}-${end}` : start;
}

function healthStatusLabel(status: HealthStatus): CsvValue {
	// Garmin reports skin temp twice (C and F); count each metric once.
	const metrics = (status.metrics ?? []).filter(metric => metric.type !== 'SKIN_TEMP_F' && metric.value != null);
	if (metrics.length === 0) return null;
	if (metrics.some(metric => metric.status === 'ONBOARDING')) return 'onboarding';
	return `${metrics.length - (status.outliersCount ?? 0)}/${metrics.length} in range`;
}

function emptyRow(date: string): DailyRow {
	return Object.fromEntries(FULL_COLUMNS.map(column => [column, column === 'date' ? date : null])) as DailyRow;
}

function buildRows(personal: PersonalDaily, connect: ConnectDaily | null, range: Range): DailyRow[] {
	const rows = new Map(eachDay(range).map(date => [date, emptyRow(date)]));
	const merge = (date: string | null | undefined, values: Partial<DailyRow>) => {
		const row = date ? rows.get(date) : undefined;
		if (row) Object.assign(row, values);
	};

	for (const sleep of personal.sleeps) {
		const sleepSeconds = sleep.sleepTimeSeconds ?? null;
		const restorativeSeconds =
			sleep.deepSleepSeconds == null && sleep.remSleepSeconds == null
				? null
				: (sleep.deepSleepSeconds ?? 0) + (sleep.remSleepSeconds ?? 0);
		const needMinutes = sleep.sleepNeed?.actual ?? null;
		merge(sleep.calendarDate, {
			sleep_score: sleep.sleepScores?.overall?.value ?? null,
			sleep_start: formatLocalClock(sleep.sleepStartTimestampLocal),
			sleep_end: formatLocalClock(sleep.sleepEndTimestampLocal),
			sleep_duration: seconds(sleepSeconds),
			sleep_deep: seconds(sleep.deepSleepSeconds),
			sleep_light: seconds(sleep.lightSleepSeconds),
			sleep_rem: seconds(sleep.remSleepSeconds),
			sleep_awake: seconds(sleep.awakeSleepSeconds),
			restorative: seconds(restorativeSeconds),
			restorative_pct:
				sleepSeconds && restorativeSeconds != null
					? formatDisplayNumber((restorativeSeconds / sleepSeconds) * 100)
					: null,
			efficiency: sleepSeconds
				? formatDisplayNumber((sleepSeconds / (sleepSeconds + (sleep.awakeSleepSeconds ?? 0))) * 100)
				: null,
			sleep_need: minutes(needMinutes),
			sleep_debt:
				needMinutes != null && sleepSeconds != null
					? (minutes(Math.max(0, needMinutes - Math.round(sleepSeconds / 60))) ?? '0m')
					: null,
			next_sleep_need: minutes(sleep.nextSleepNeed?.actual),
			next_bedtime: bedtimeWindow(sleep.nextSleepNeed),
			sleep_hr: sleep.avgHeartRate ?? null,
			sleep_respiration: sleep.averageRespirationValue ?? null,
			sleep_spo2: sleep.averageSpO2Value ?? null,
			sleep_stress: sleep.avgSleepStress ?? null,
			awake_count: sleep.awakeCount ?? null,
			nap_duration: seconds(sleep.napTimeSeconds),
		});
	}

	const sleepOnsets = new Map(
		[...personal.sleeps, ...personal.nextSleeps].flatMap(sleep =>
			sleep.sleepStartTimestampGMT ? [[sleep.calendarDate, sleep.sleepStartTimestampGMT] as const] : [],
		),
	);
	for (const date of rows.keys()) {
		const nextDate = day(addDays(parseISO(date), 1));
		const start = sleepOnsets.get(date) ?? parseISO(date).getTime();
		const end = sleepOnsets.get(nextDate) ?? Math.min(Date.now(), parseISO(nextDate).getTime());
		merge(date, { strain: estimateStrain(personal.heartRate, personal.activityHeartRate, start, end) });
	}

	for (const hrv of personal.hrv) {
		merge(hrv.calendarDate, {
			HRV: hrv.lastNightAvg ?? null,
			HRV_7d: hrv.weeklyAvg ?? null,
			hrv_status: hrv.status?.toLowerCase() ?? null,
		});
	}

	for (const summary of personal.summaries) {
		merge(summary.calendarDate, {
			RHR: summary.heartRate?.restingValue ?? null,
			bb_high: summary.bodyBattery?.maxValue ?? null,
			bb_low: summary.bodyBattery?.minValue ?? null,
			bb_charged: summary.bodyBattery?.chargedValue ?? null,
			bb_drained: summary.bodyBattery?.drainedValue ?? null,
			stress: summary.stress?.avgLevel ?? null,
			stress_max: summary.stress?.maxLevel ?? null,
			respiration: summary.respiration?.avgValue ?? null,
			spo2: summary.pulseOx?.avgValue ?? null,
			steps: summary.movement?.steps?.value ?? null,
			floors: summary.movement?.floorsAscended?.value ?? null,
			active_kcal: summary.calories?.burnedActive ?? null,
			total_kcal: summary.calories?.burnedTotal ?? null,
			intensity_moderate: summary.intensityMinutes?.moderate ?? null,
			intensity_vigorous: summary.intensityMinutes?.vigorous ?? null,
		});
	}

	for (const summary of personal.userSummaries)
		merge(summary.calendarDate, { bb_wake: summary.bodyBatteryAtWakeTime ?? null });

	const activitiesByDate = new Map<string, string[]>();
	const sortedActivities = personal.activities.toSorted((a, b) =>
		(a.startTimeLocal ?? '').localeCompare(b.startTimeLocal ?? ''),
	);
	for (const activity of sortedActivities) {
		const date = activity.startTimeLocal?.slice(0, 10);
		if (!date || !rows.has(date)) continue;
		const name = activity.activityName || activity.activityType?.typeKey || 'activity';
		const duration = seconds(activity.duration);
		activitiesByDate.set(date, [...(activitiesByDate.get(date) ?? []), duration ? `${name} (${duration})` : name]);
	}
	for (const [date, entries] of activitiesByDate) merge(date, { activities: entries.join('; ') });

	if (connect) {
		// Garmin recalculates readiness through the day; the after-wake-up entry is the morning score, like WHOOP's Recovery.
		const readinessByDate = new Map<string, TrainingReadiness>();
		for (const entry of connect.readiness.toSorted((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? ''))) {
			const current = readinessByDate.get(entry.calendarDate);
			// A wake reset can also fire at night (e.g. after an accidental activity), so the latest one wins.
			if (!current || entry.inputContext === 'AFTER_WAKEUP_RESET' || current.inputContext !== 'AFTER_WAKEUP_RESET')
				readinessByDate.set(entry.calendarDate, entry);
		}
		for (const [date, entry] of readinessByDate) {
			merge(date, {
				readiness: entry.score ?? null,
				readiness_level: entry.level && entry.level !== 'NONE' ? entry.level.toLowerCase() : null,
			});
		}
		for (const { date, load } of connect.trainingStatus) {
			merge(date, {
				acute_load: load?.dailyTrainingLoadAcute ?? null,
				load_status: load?.acwrStatus && load.acwrStatus !== 'NONE' ? load.acwrStatus.toLowerCase() : null,
			});
		}
		for (const stat of connect.sleepStats) merge(stat.calendarDate, { skin_temp: stat.values?.skinTempC ?? null });
		for (const metric of connect.maxMetrics) {
			merge(metric.generic?.calendarDate, {
				vo2max: metric.generic?.vo2MaxPreciseValue ?? metric.generic?.vo2MaxValue ?? null,
			});
		}
		for (const status of connect.health) merge(status.calendarDate, { health_status: healthStatusLabel(status) });
	}

	return [...rows.values()].toReversed();
}

interface Sample {
	time: string;
	value: number;
}

interface SleepStage {
	start: string;
	end: string;
	stage: string;
}

const SLEEP_STAGES: Record<number, string> = { 0: 'deep', 1: 'light', 2: 'rem', 3: 'awake' };
const localTime = (epochMs: number) => format(new Date(epochMs), "yyyy-MM-dd'T'HH:mm");
// Connect's GMT strings carry no zone marker.
const gmtToLocal = (value: string) => localTime(Date.parse(`${value.replace(/\.\d+$/, '')}Z`));

// Garmin pads unmeasured epochs with negative values (-1 off-wrist or too little data, -2 too much motion).
function samples(rows: unknown[][] | null | undefined, valueIndex = 1): Sample[] {
	return (rows ?? []).flatMap(row => {
		const [timestamp] = row;
		const value = row[valueIndex];
		return typeof timestamp === 'number' && typeof value === 'number' && value >= 0
			? [{ time: localTime(timestamp), value }]
			: [];
	});
}

async function fetchIntraday(personal: PersonalApi, connect: ConnectApi, date: string) {
	const [heartRate, hrv, stress, respiration, sleep] = await Promise.all([
		personal.get<{ heartRateValues?: number[][] | null } | null>('/wellness-service/wellness/dailyHeartRate', { date }),
		personal.get<{ hrvReadings?: { hrvValue: number; readingTimeLocal: string }[] | null } | null>(
			`/hrv-service/hrv/${date}`,
		),
		connect.get<{ stressValuesArray?: number[][] | null; bodyBatteryValuesArray?: unknown[][] | null } | null>(
			`/wellness-service/wellness/dailyStress/${date}`,
		),
		connect.get<{ respirationValuesArray?: number[][] | null } | null>(
			`/wellness-service/wellness/daily/respiration/${date}`,
		),
		connect.get<{
			sleepLevels?: { startGMT: string; endGMT: string; activityLevel: number }[] | null;
			wellnessEpochSPO2DataDTOList?: { epochTimestamp: string; spo2Reading?: number | null }[] | null;
		} | null>('/sleep-service/sleep/dailySleepData', {
			date,
			nonSleepBufferMinutes: 60,
		}),
	]);
	return {
		date,
		series: {
			heart_rate: samples(heartRate?.heartRateValues),
			stress: samples(stress?.stressValuesArray),
			body_battery: samples(stress?.bodyBatteryValuesArray, 2),
			respiration: samples(respiration?.respirationValuesArray),
			hrv: (hrv?.hrvReadings ?? []).map(reading => ({
				time: reading.readingTimeLocal.slice(0, 16),
				value: reading.hrvValue,
			})),
			// The CIRQA measures SpO2 only in sleep; the Personal API's spo2acclimation series stays empty.
			spo2: (sleep?.wellnessEpochSPO2DataDTOList ?? []).flatMap(epoch =>
				epoch.spo2Reading != null && epoch.spo2Reading > 0
					? [{ time: gmtToLocal(epoch.epochTimestamp), value: epoch.spo2Reading }]
					: [],
			),
		} satisfies Record<string, Sample[]>,
		sleep_stages: (sleep?.sleepLevels ?? []).map(level => ({
			start: gmtToLocal(level.startGMT),
			end: gmtToLocal(level.endGMT),
			stage: SLEEP_STAGES[level.activityLevel] ?? `level_${level.activityLevel}`,
		})) satisfies SleepStage[],
	};
}

type Intraday = Awaited<ReturnType<typeof fetchIntraday>>;

function renderIntraday(data: Intraday, outputFormat: ReturnType<typeof parseOutputFormat>): void {
	if (outputFormat === 'json') {
		process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
		return;
	}
	if (outputFormat === 'csv' || outputFormat === 'csv:full') {
		const rows: Record<string, CsvValue>[] = [
			...Object.entries(data.series).flatMap(([metric, series]) =>
				series.map(sample => ({ time: sample.time, end: null, metric, value: sample.value })),
			),
			...data.sleep_stages.map(stage => ({
				time: stage.start,
				end: stage.end,
				metric: 'sleep_stage',
				value: stage.stage,
			})),
		];
		process.stdout.write(renderCsvRecords(rows, ['time', 'end', 'metric', 'value']));
		return;
	}
	renderTableRecords(
		Object.entries(data.series).map(([metric, series]) => {
			const values = series.map(sample => sample.value);
			return {
				metric,
				samples: values.length,
				min: values.length ? Math.min(...values) : '',
				avg: values.length ? formatDisplayNumber(values.reduce((sum, value) => sum + value, 0) / values.length) : '',
				max: values.length ? Math.max(...values) : '',
				from: series[0]?.time.slice(11) ?? '',
				to: series.at(-1)?.time.slice(11) ?? '',
			};
		}),
	);
	if (data.sleep_stages.length) {
		renderTableRecords(
			data.sleep_stages.map(stage => ({ start: stage.start.slice(11), end: stage.end.slice(11), stage: stage.stage })),
		);
	}
}

function renderWellnessFit(data: WellnessFitData, outputFormat: ReturnType<typeof parseOutputFormat>): void {
	if (outputFormat === 'json') {
		writeJson(data);
		return;
	}
	if (outputFormat === 'csv' || outputFormat === 'csv:full') {
		const rows: Record<string, CsvValue>[] = [
			...Object.entries(data.series).flatMap(([metric, series]) =>
				series.map(sample => ({ time: sample.time, metric, value: sample.value })),
			),
			...data.sleep_levels.map(level => ({ time: level.time, metric: 'sleep_level', value: level.stage })),
		];
		process.stdout.write(renderCsvRecords(rows, ['time', 'metric', 'value']));
		return;
	}
	renderTableRecords(
		Object.entries(data.series).map(([metric, series]) => {
			const values = series.map(sample => sample.value);
			return {
				metric,
				samples: values.length,
				min: values.length ? Math.min(...values) : '',
				avg: values.length ? formatDisplayNumber(values.reduce((sum, value) => sum + value, 0) / values.length) : '',
				max: values.length ? Math.max(...values) : '',
				from: series[0]?.time.slice(11) ?? '',
				to: series.at(-1)?.time.slice(11) ?? '',
			};
		}),
	);
	const summaryRows: Record<string, CsvValue>[] = [];
	if (data.summary.resting_hr) {
		summaryRows.push({
			metric: 'resting_hr',
			value: `${data.summary.resting_hr.current_day ?? '?'} (7d: ${data.summary.resting_hr.seven_day ?? '?'})`,
		});
	}
	if (data.summary.hrv) {
		summaryRows.push({
			metric: 'hrv',
			value: `${data.summary.hrv.last_night_avg ?? '?'} ms (5m high: ${data.summary.hrv.last_night_5min_high ?? '?'}, 7d: ${data.summary.hrv.weekly_avg ?? '?'})`,
		});
	}
	if (data.summary.skin_temp_overnight) {
		summaryRows.push({
			metric: 'skin_temp_overnight',
			value: `${data.summary.skin_temp_overnight.nightly_c ?? '?'}°C (Δ ${data.summary.skin_temp_overnight.deviation_c ?? '?'}°C, 7d Δ ${data.summary.skin_temp_overnight.seven_day_deviation_c ?? '?'}°C)`,
		});
	}
	if (data.summary.sleep_assessment?.overallSleepScore != null) {
		summaryRows.push({
			metric: 'sleep_score',
			value: `${data.summary.sleep_assessment.overallSleepScore} (awakenings: ${data.summary.sleep_assessment.awakeningsCount ?? '?'}, disruption: ${data.summary.sleep_disruption_severity ?? 'none'})`,
		});
	}
	if (summaryRows.length) renderTableRecords(summaryRows);
}

function parseParams(pairs: string[]): Params {
	return Object.fromEntries(
		pairs.map(pair => {
			const separator = pair.indexOf('=');
			if (separator <= 0) throw new Error(`--param must look like key=value, got '${pair}'.`);
			return [pair.slice(0, separator), pair.slice(separator + 1)];
		}),
	);
}

const COMPARE_STEP_MS = 5 * 60_000;
// The shared table renderer rounds numbers >= 10 to integers, which would hide strain's decimal.
const oneDecimal = (value: CsvValue) => (typeof value === 'number' ? (value + 0).toFixed(1) : (value ?? ''));
const COMPARE_COLUMNS = [
	'date',
	'what',
	'start',
	'end',
	'whoop',
	'from_whoop_hr',
	'from_garmin_hr',
	'garmin_minus_whoop',
	'whoop_avg_hr',
	'garmin_avg_hr',
] as const;

/**
 * WHOOP's strain next to this model's estimate from WHOOP's own 6-second heart rate and from Garmin's, per WHOOP cycle
 * (labeled by its start day) and per WHOOP workout. The WHOOP-HR column separates formula error from sensor differences.
 */
async function fetchStrainComparison(personal: PersonalApi, whoop: WhoopAppApi, range: Range) {
	const cycles = (await whoop.cycles(range.start.getTime(), addDays(range.end, 1).getTime()))
		.map(details => {
			const window = parseWhoopRange(details.cycle.during);
			// WHOOP labels a cycle by its first day even when it starts the evening before (days "['2026-11-12','2026-11-13')").
			const date = details.cycle.days.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? day(new Date(window.start));
			return { details, date, start: window.start, end: window.end ?? Date.now() };
		})
		.filter(cycle => cycle.date >= day(range.start) && cycle.date <= day(range.end))
		.toSorted((a, b) => a.start - b.start);
	if (cycles.length === 0) {
		throw new Error(
			`WHOOP has no cycles starting ${day(range.start)}..${day(range.end)}; widen --days or check --start/--end.`,
		);
	}
	const dates = eachDay({ start: new Date(cycles[0]!.start), end: new Date(cycles.at(-1)!.end) });
	const [allDay, garminActivities, whoopHeartRate] = await Promise.all([
		fetchAllDayHeartRate(personal, dates),
		fetchActivities(personal, dates[0]!, dates.at(-1)!).then(activities =>
			mapLimited(
				activities.filter(activity => activity.activityId != null),
				PER_DAY_CONCURRENCY,
				activity => fetchActivityHeartRate(personal, activity.activityId!),
			),
		),
		mapLimited(cycles, 2, cycle => whoop.heartRate(cycle.start, cycle.end)),
	]);
	const whoopStreams = [whoopHeartRate.flat()];

	const rows: Record<(typeof COMPARE_COLUMNS)[number], CsvValue>[] = [];
	const timelines: { date: string; points: Record<string, number | null>[] }[] = [];
	const compare = (
		date: string,
		what: string,
		start: number,
		end: number,
		whoopStrain: number | null,
		whoopAvg: number | null,
	) => {
		const fromWhoop = estimateStrain([], whoopStreams, start, end);
		const fromGarmin = estimateStrain(allDay, garminActivities, start, end);
		rows.push({
			date,
			what,
			start: format(start, 'HH:mm'),
			end: format(end, 'HH:mm'),
			whoop: whoopStrain == null ? null : Math.round(whoopStrain * 10) / 10,
			from_whoop_hr: fromWhoop,
			from_garmin_hr: fromGarmin,
			garmin_minus_whoop:
				fromGarmin != null && whoopStrain != null ? Math.round((fromGarmin - whoopStrain) * 10) / 10 + 0 : null,
			whoop_avg_hr: whoopAvg ?? averageHeartRate([], whoopStreams, start, end),
			garmin_avg_hr: averageHeartRate(allDay, garminActivities, start, end),
		});
	};
	for (const { details, date, start, end } of cycles) {
		compare(date, 'day', start, end, details.cycle.scaled_strain, details.cycle.day_avg_heart_rate);
		for (const workout of [...details.workouts].toSorted((a, b) => a.during.localeCompare(b.during))) {
			const window = parseWhoopRange(workout.during);
			const name =
				details.v2_activities.find(activity => activity.id === workout.activity_id)?.translated_type ??
				`sport ${workout.sport_id}`;
			compare(date, name, window.start, window.end ?? end, workout.score, workout.average_heart_rate);
		}
		const fromWhoop = strainTimeline([], whoopStreams, start, end, COMPARE_STEP_MS);
		const fromGarmin = strainTimeline(allDay, garminActivities, start, end, COMPARE_STEP_MS);
		timelines.push({
			date,
			points: fromWhoop.map((point, index) => ({
				time: point.time,
				whoop_hr: point.bpm,
				garmin_hr: fromGarmin[index]!.bpm,
				strain_from_whoop_hr: point.strain,
				strain_from_garmin_hr: fromGarmin[index]!.strain,
			})),
		});
	}
	return { rows, timelines };
}

const writeJson = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);

const cli = createScript('garmin')
	.usage(
		[
			'$0 <command>',
			'',
			'Pulls your Garmin Connect data (any Garmin device, including the CIRQA band) from two sources:',
			`  personal: Garmin's official Personal API. Needs GARMIN_PERSONAL_API_KEY, created at ${PERSONAL_KEY_PAGE} (expires after 30 days to 1 year).`,
			"  connect:  the Connect app's own API, for what the Personal API lacks (intraday stress, Training Readiness, Health Status, skin temp, VO2 max).",
			`            Unofficial. Needs GARMIN_CREDENTIALS (email:password); tokens live in ${CONNECT_TOKEN_FILE} and refresh themselves.`,
		].join('\n'),
	)
	.command(
		['daily', '$0'],
		'One row per day: sleep, restorative sleep, HRV, resting HR, readiness, Body Battery, WHOOP-style strain (estimated from heart rate, sleep onset to next sleep onset), stress, steps, and activities',
		cli =>
			cli
				.option('days', {
					alias: 'd',
					type: 'number',
					default: 7,
					describe: 'Days to include, ending at --end, when --start is not given',
				})
				.option('start', { alias: ['since', 's'], type: 'string', describe: 'First day (YYYY-MM-DD)' })
				.option('end', { alias: ['until', 'e'], type: 'string', describe: 'Last day (YYYY-MM-DD), default today' })
				.option('format', {
					alias: 'f',
					type: 'string',
					choices: OUTPUT_FORMATS,
					default: 'table',
					describe:
						'table and csv show the main columns; json and csv:full add sleep stages, bedtime, health status, skin temp, VO2 max, calories, and more',
				}),
		async argv => {
			const outputFormat = parseOutputFormat(argv.format);
			const range = resolveRange(argv);
			const [personal, connect] = await Promise.all([PersonalApi.connect(), connectOrWarn()]);
			const [personalData, connectData] = await Promise.all([
				fetchPersonalDaily(personal, range),
				connect
					? fetchConnectDaily(connect, range).catch((error: unknown) => {
							console.error(
								`Skipping Garmin Connect columns: ${error instanceof Error ? error.message : String(error)}`,
							);
							return null;
						})
					: null,
			]);
			const rows = buildRows(personalData, connectData, range);
			if (outputFormat === 'table') {
				renderTableRecords(
					rows.map(row => Object.fromEntries(TABLE_COLUMNS.map(column => [column, row[column] ?? '']))),
				);
			} else if (outputFormat === 'json') {
				writeJson(rows);
			} else {
				process.stdout.write(renderCsvRecords(rows, outputFormat === 'csv:full' ? FULL_COLUMNS : TABLE_COLUMNS));
			}
		},
	)
	.command(
		'intraday [date]',
		'Time series for one day, like the WHOOP charts: heart rate (2 min), stress and Body Battery (3 min), respiration, HRV (5 min, during sleep), SpO2, and sleep stages',
		cli =>
			cli.positional('date', { type: 'string', describe: 'Day (YYYY-MM-DD), default today' }).option('format', {
				alias: 'f',
				type: 'string',
				choices: OUTPUT_FORMATS,
				default: 'table',
				describe:
					'table summarizes each series; json groups samples by metric; csv lists every sample as time,end,metric,value',
			}),
		async argv => {
			const outputFormat = parseOutputFormat(argv.format);
			const date = argv.date ? day(parseDay(argv.date, 'date')) : day(new Date());
			const [personal, connect] = await Promise.all([PersonalApi.connect(), ConnectApi.connect()]);
			renderIntraday(await fetchIntraday(personal, connect, date), outputFormat);
		},
	)
	.command(
		'wellness-fit [date]',
		'Download and decode raw daily wellness .FIT archive (1-min HR, stress, Body Battery, respiration, SpO2, skin temp delta, 5-min HRV, sleep scores & disruptions)',
		cli =>
			cli.positional('date', { type: 'string', describe: 'Day (YYYY-MM-DD), default today' }).option('format', {
				alias: 'f',
				type: 'string',
				choices: OUTPUT_FORMATS,
				default: 'table',
				describe:
					'table summarizes each 1-min series + overnight summaries; json dumps everything; csv lists every sample',
			}),
		async argv => {
			const outputFormat = parseOutputFormat(argv.format);
			const date = argv.date ? day(parseDay(argv.date, 'date')) : day(new Date());
			const connect = await ConnectApi.connect();
			const zip = await connect.getBytes(`/download-service/files/wellness/${date}`);
			renderWellnessFit(parseWellnessZip(date, zip), outputFormat);
		},
	)
	.command(
		'strain-compare',
		"WHOOP's strain next to this script's estimate from WHOOP's 6-second heart rate and from Garmin's, per WHOOP day and workout. Needs a WHOOP app token (`whoop-pull --app-token`)",
		cli =>
			cli
				.option('days', {
					alias: 'd',
					type: 'number',
					default: 7,
					describe: 'WHOOP days to include, ending at --end, when --start is not given',
				})
				.option('start', { alias: ['since', 's'], type: 'string', describe: 'First day (YYYY-MM-DD)' })
				.option('end', { alias: ['until', 'e'], type: 'string', describe: 'Last day (YYYY-MM-DD), default today' })
				.option('format', {
					alias: 'f',
					type: 'string',
					choices: OUTPUT_FORMATS,
					default: 'table',
					describe: 'json adds a 5-minute timeline per day: both heart rates and the strain built from each',
				}),
		async argv => {
			const outputFormat = parseOutputFormat(argv.format);
			const range = resolveRange(argv);
			const whoop = WhoopAppApi.connect();
			const { rows, timelines } = await fetchStrainComparison(await PersonalApi.connect(), whoop, range);
			if (outputFormat === 'json') return void writeJson({ rows, timelines });
			if (outputFormat !== 'table') return void process.stdout.write(renderCsvRecords(rows, COMPARE_COLUMNS));
			renderTableRecords(
				rows.map(row => ({
					...row,
					whoop: oneDecimal(row.whoop),
					from_whoop_hr: oneDecimal(row.from_whoop_hr),
					from_garmin_hr: oneDecimal(row.from_garmin_hr),
					garmin_minus_whoop: oneDecimal(row.garmin_minus_whoop),
					whoop_avg_hr: row.whoop_avg_hr ?? '',
					garmin_avg_hr: row.garmin_avg_hr ?? '',
				})),
			);
		},
	)
	.command(
		'raw <path>',
		'GET any endpoint and print its JSON',
		cli =>
			cli
				.positional('path', {
					type: 'string',
					demandOption: true,
					describe: 'Endpoint path, e.g. /sleep-service/sleep/dailySleep',
				})
				.option('source', {
					type: 'string',
					choices: ['personal', 'connect'] as const,
					default: 'personal',
					describe: `personal: official paths only (${SWAGGER_PAGE}); connect: any path the Connect app uses`,
				})
				.option('param', {
					alias: 'p',
					type: 'string',
					array: true,
					default: [],
					describe: 'Query parameter as key=value, repeatable (e.g. -p date=2026-11-08)',
				})
				.example(
					'$0 raw /sleep-service/sleep/dailySleep -p date=2026-11-08',
					'Sleep record with score components and sleep need',
				)
				.example(
					'$0 raw /usersummary-service/v2/dailysummaries -p startDate=2026-11-01 -p endDate=2026-11-08',
					'Daily summaries, up to a year per call',
				)
				.example('$0 raw /userprofile-service/userprofile/settings', 'Profile settings')
				.example(
					'$0 raw --source connect /sleep-service/sleep/dailySleepData -p date=2026-11-08',
					'Full night: stages, HR, HRV, stress, Body Battery, respiration, restless moments',
				)
				.example(
					'$0 raw --source connect /metrics-service/metrics/trainingreadiness/2026-11-08',
					'Training Readiness and its factors',
				)
				.example(
					'$0 raw --source connect /wellness-service/wellness/dailyStress/2026-11-08',
					'3-minute stress and Body Battery',
				)
				.example(
					'$0 raw --source connect /metrics-service/metrics/trainingstatus/aggregated/2026-11-08',
					'Training status and load',
				),
		async argv => {
			const params = parseParams(argv.param);
			const api = argv.source === 'connect' ? await ConnectApi.connect() : await PersonalApi.connect();
			writeJson(await api.get(argv.path, params));
		},
	)
	.command(
		'graphql <query>',
		"Run a query against the Connect web app's GraphQL gateway (the only route to Health Status) and print its data",
		cli =>
			cli
				.positional('query', { type: 'string', demandOption: true, describe: 'Anonymous query with inlined arguments' })
				.example(
					'$0 graphql \'query { healthStatusSummary(calendarDate:"2026-11-08") { outliersCount metrics { type status value baselineLowerLimit baselineUpperLimit } } }\'',
					'Health Status',
				)
				.example(
					'$0 graphql \'query { vo2MaxScalar(startDate:"2026-10-01", endDate:"2026-11-08") }\'',
					'VO2 max history',
				)
				.example(
					'$0 graphql \'query { epochChartScalar(date:"2026-11-08", include:["steps","stress","bodyBattery"]) }\'',
					'Intraday charts as one payload',
				),
		async argv => {
			writeJson(await (await ConnectApi.connect()).graphql(argv.query));
		},
	)
	.command(
		'activities',
		'List recorded activities with their ids (for delete-activity)',
		cli =>
			cli
				.option('days', {
					alias: 'd',
					type: 'number',
					default: 7,
					describe: 'Days to include, ending at --end, when --start is not given',
				})
				.option('start', { alias: ['since', 's'], type: 'string', describe: 'First day (YYYY-MM-DD)' })
				.option('end', { alias: ['until', 'e'], type: 'string', describe: 'Last day (YYYY-MM-DD), default today' })
				.option('format', {
					alias: 'f',
					type: 'string',
					choices: OUTPUT_FORMATS,
					default: 'table',
					describe: 'Output format',
				}),
		async argv => {
			const range = resolveRange(argv);
			const activities = await fetchActivities(await PersonalApi.connect(), day(range.start), day(range.end));
			const outputFormat = parseOutputFormat(argv.format);
			if (outputFormat === 'json') return void writeJson(activities);
			const records = activities.map(activityRecord);
			if (outputFormat === 'table' && records.length === 0) return void console.log('No activities in this range.');
			if (outputFormat === 'table') renderTableRecords(records);
			else process.stdout.write(renderCsvRecords(records, Object.keys(activityRecord({}))));
		},
	)
	.command(
		'delete-activity <ids..>',
		'Permanently delete activities from Garmin Connect (e.g. ones started by an accidental tap). Find ids with `garmin activities`',
		cli =>
			cli
				.positional('ids', {
					type: 'number',
					array: true,
					demandOption: true,
					describe: 'Activity ids from `garmin activities`',
				})
				.option('dry-run', {
					type: 'boolean',
					default: false,
					describe: 'Look up and print the activities without deleting them',
				}),
		async argv => {
			const api = await ConnectApi.connect();
			for (const id of argv.ids) {
				const activity = await api.get<ConnectActivitySummary>(`/activity-service/activity/${id}`);
				const label = `${id} ${activity.activityName ?? ''} (${activity.summaryDTO?.startTimeLocal ?? '?'}, ${formatDurationMilliseconds((activity.summaryDTO?.duration ?? 0) * 1000)})`;
				if (argv['dry-run']) {
					console.log(`Would delete ${label}`);
					continue;
				}
				await api.delete(`/activity-service/activity/${id}`);
				console.log(`Deleted ${label}`);
			}
		},
	)
	.command(
		'login',
		`Log in to Garmin Connect with GARMIN_CREDENTIALS and save tokens to ${CONNECT_TOKEN_FILE}. Other commands do this on their own; run it in a terminal when Garmin asks for an MFA code`,
		cli =>
			cli.option('dry-run', {
				type: 'boolean',
				default: false,
				describe: 'Print what would happen without logging in',
			}),
		argv => {
			const email = connectLoginEmail();
			if (argv['dry-run']) {
				console.log(`Would log in to Garmin Connect as ${email} and write tokens to ${CONNECT_TOKEN_FILE}.`);
				return;
			}
			loginToConnect();
		},
	);

await cli.parseAsync();
