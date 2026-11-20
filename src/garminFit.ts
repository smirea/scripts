import { inflateRawSync } from 'node:zlib';

import { Decoder, Stream } from '@garmin/fitsdk';
import { format } from 'date-fns';

// FIT epoch is 1989-12-31T00:00:00Z.
const FIT_EPOCH_SECONDS = 631065600;
const ZIP_EOCD_SIG = 0x06054b50;
const ZIP_CD_SIG = 0x02014b50;
const ZIP_LOCAL_SIG = 0x04034b50;

export interface WellnessSample {
	time: string;
	epochMs: number;
	value: number;
}

export interface SleepLevelPoint {
	time: string;
	stage: string;
}

export interface SleepDisruptionPeriod {
	time: string;
	severity: string | null;
}

export interface WellnessFitSummary {
	resting_hr: { seven_day: number | null; current_day: number | null } | null;
	hrv: {
		last_night_avg: number | null;
		last_night_5min_high: number | null;
		weekly_avg: number | null;
		status: string | null;
	} | null;
	skin_temp_overnight: {
		nightly_c: number | null;
		deviation_c: number | null;
		seven_day_deviation_c: number | null;
	} | null;
	sleep_assessment: Record<string, number> | null;
	sleep_disruption_severity: string | null;
}

export interface WellnessFitData {
	date: string;
	files: string[];
	summary: WellnessFitSummary;
	series: {
		heart_rate: WellnessSample[];
		stress: WellnessSample[];
		body_battery: WellnessSample[];
		respiration: WellnessSample[];
		spo2: WellnessSample[];
		skin_temp_delta: WellnessSample[];
		hrv: WellnessSample[];
	};
	sleep_levels: SleepLevelPoint[];
	sleep_disruptions: SleepDisruptionPeriod[];
}

/** Minimal ZIP reader for Garmin's store/deflate FIT archives, avoiding external CLI or npm deps. */
export function unzipEntries(zip: Uint8Array): { name: string; data: Uint8Array }[] {
	const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
	let eocdOffset = -1;
	for (let i = zip.byteLength - 22; i >= Math.max(0, zip.byteLength - 65_557); i--) {
		if (view.getUint32(i, true) === ZIP_EOCD_SIG) {
			eocdOffset = i;
			break;
		}
	}
	if (eocdOffset < 0) throw new Error('Invalid ZIP archive: end-of-central-directory record not found.');

	const entryCount = view.getUint16(eocdOffset + 10, true);
	let offset = view.getUint32(eocdOffset + 16, true);
	const decoder = new TextDecoder();
	const entries: { name: string; data: Uint8Array }[] = [];

	for (let i = 0; i < entryCount; i++) {
		if (view.getUint32(offset, true) !== ZIP_CD_SIG) throw new Error('Invalid ZIP central directory header.');
		const method = view.getUint16(offset + 10, true);
		const compressedSize = view.getUint32(offset + 20, true);
		const nameLength = view.getUint16(offset + 28, true);
		const extraLength = view.getUint16(offset + 30, true);
		const commentLength = view.getUint16(offset + 32, true);
		const localHeaderOffset = view.getUint32(offset + 42, true);
		const name = decoder.decode(zip.subarray(offset + 46, offset + 46 + nameLength));

		if (view.getUint32(localHeaderOffset, true) !== ZIP_LOCAL_SIG) throw new Error(`Invalid local header for ${name}.`);
		const localNameLen = view.getUint16(localHeaderOffset + 26, true);
		const localExtraLen = view.getUint16(localHeaderOffset + 28, true);
		const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
		const compressed = zip.subarray(dataStart, dataStart + compressedSize);

		let data: Uint8Array;
		if (method === 0) data = compressed;
		else if (method === 8) data = new Uint8Array(inflateRawSync(compressed));
		else throw new Error(`Unsupported ZIP compression method ${method} for ${name}.`);

		entries.push({ name, data });
		offset += 46 + nameLength + extraLength + commentLength;
	}
	return entries;
}

const localMinute = (epochMs: number) => format(new Date(epochMs), "yyyy-MM-dd'T'HH:mm");

function fitTimestampToMs(value: unknown): number | null {
	if (value instanceof Date) return value.getTime();
	if (typeof value === 'number' && Number.isFinite(value)) return (value + FIT_EPOCH_SECONDS) * 1000;
	return null;
}

function dedupeSeries(points: Map<number, number>): WellnessSample[] {
	return [...points.entries()]
		.toSorted(([a], [b]) => a - b)
		.map(([epochMs, value]) => ({ time: localMinute(epochMs), epochMs, value }));
}

export function parseWellnessZip(date: string, zipBytes: Uint8Array): WellnessFitData {
	const entries = unzipEntries(zipBytes)
		.filter(entry => entry.name.endsWith('.fit'))
		.toSorted((a, b) => a.name.localeCompare(b.name));

	const heartRate = new Map<number, number>();
	const stress = new Map<number, number>();
	const bodyBattery = new Map<number, number>();
	const respiration = new Map<number, number>();
	const spo2 = new Map<number, number>();
	const skinTempDelta = new Map<number, number>();
	const hrv = new Map<number, number>();
	const sleepLevels = new Map<number, string>();
	const sleepDisruptions: SleepDisruptionPeriod[] = [];

	const summary: WellnessFitSummary = {
		resting_hr: null,
		hrv: null,
		skin_temp_overnight: null,
		sleep_assessment: null,
		sleep_disruption_severity: null,
	};

	for (const entry of entries) {
		const decoder = new Decoder(Stream.fromByteArray(entry.data));
		const { messages } = decoder.read({
			expandSubFields: true,
			convertDateTimesToDates: true,
			includeUnknownData: true,
		}) as unknown as { messages: Record<string, Record<string, unknown>[]> };

		const infoTs = fitTimestampToMs(messages.monitoringInfoMesgs?.[0]?.timestamp);
		let lastTsSec = infoTs != null ? Math.floor(infoTs / 1000) : 0;

		for (const msg of messages.monitoringMesgs ?? []) {
			const fullMs = fitTimestampToMs(msg.timestamp);
			if (fullMs != null) {
				lastTsSec = Math.floor(fullMs / 1000);
			} else if (typeof msg.timestamp16 === 'number' && lastTsSec > 0) {
				const fitSec = lastTsSec - FIT_EPOCH_SECONDS;
				lastTsSec = fitSec + ((msg.timestamp16 - (fitSec & 0xffff)) & 0xffff) + FIT_EPOCH_SECONDS;
			}
			const bpm = msg.heartRate;
			if (typeof bpm === 'number' && bpm > 0 && bpm < 255 && lastTsSec > 0) {
				heartRate.set(lastTsSec * 1000, bpm);
			}
		}

		for (const msg of messages.stressLevelMesgs ?? []) {
			const ms = fitTimestampToMs(msg.stressLevelTime);
			if (ms == null) continue;
			const level = msg.stressLevelValue;
			if (typeof level === 'number' && level >= 0 && level <= 100) stress.set(ms, level);
			// Undocumented Garmin field 3 on stressLevelMesgs carries 1-minute Body Battery (0–100).
			const bb = msg['3'];
			if (typeof bb === 'number' && bb >= 0 && bb <= 100) bodyBattery.set(ms, bb);
		}

		for (const msg of messages.respirationRateMesgs ?? []) {
			const ms = fitTimestampToMs(msg.timestamp);
			const rate = msg.respirationRate;
			if (ms != null && typeof rate === 'number' && rate > 0) respiration.set(ms, Math.round(rate * 100) / 100);
		}

		for (const msg of messages.spo2DataMesgs ?? []) {
			const ms = fitTimestampToMs(msg.timestamp);
			const reading = msg.readingSpo2;
			if (ms != null && typeof reading === 'number' && reading > 0 && reading <= 100) spo2.set(ms, reading);
		}

		for (const msg of messages.monitoringHrDataMesgs ?? []) {
			summary.resting_hr = {
				seven_day: typeof msg.restingHeartRate === 'number' ? msg.restingHeartRate : null,
				current_day: typeof msg.currentDayRestingHeartRate === 'number' ? msg.currentDayRestingHeartRate : null,
			};
		}

		for (const msg of messages.hrvValueMesgs ?? []) {
			const ms = fitTimestampToMs(msg.timestamp);
			const value = msg.value;
			if (ms != null && typeof value === 'number' && value > 0) hrv.set(ms, value);
		}

		for (const msg of messages.hrvStatusSummaryMesgs ?? []) {
			summary.hrv = {
				last_night_avg: typeof msg.lastNightAverage === 'number' ? msg.lastNightAverage : null,
				last_night_5min_high: typeof msg.lastNight5MinHigh === 'number' ? msg.lastNight5MinHigh : null,
				weekly_avg: typeof msg.weeklyAverage === 'number' ? msg.weeklyAverage : null,
				status: typeof msg.status === 'string' ? msg.status : null,
			};
		}

		for (const msg of messages.skinTempOvernightMesgs ?? []) {
			summary.skin_temp_overnight = {
				nightly_c: typeof msg.nightlyValue === 'number' ? Math.round(msg.nightlyValue * 100) / 100 : null,
				deviation_c: typeof msg.averageDeviation === 'number' ? Math.round(msg.averageDeviation * 100) / 100 : null,
				seven_day_deviation_c:
					typeof msg.average7DayDeviation === 'number' ? Math.round(msg.average7DayDeviation * 100) / 100 : null,
			};
		}

		// Undocumented Garmin message 397 in *_SKIN_TEMP.fit carries 1-minute skin temp deviation (field 1, timestamp 253).
		for (const msg of messages['397'] ?? []) {
			const ms = fitTimestampToMs(msg['253']);
			const delta = msg['1'];
			if (ms != null && typeof delta === 'number' && Number.isFinite(delta)) {
				skinTempDelta.set(ms, Math.round(delta * 100) / 100);
			}
		}

		for (const msg of messages.sleepAssessmentMesgs ?? []) {
			const assessment: Record<string, number> = {};
			for (const [key, value] of Object.entries(msg)) {
				if (!/^\d+$/.test(key) && typeof value === 'number') assessment[key] = value;
			}
			summary.sleep_assessment = assessment;
		}

		for (const msg of messages.sleepLevelMesgs ?? []) {
			const ms = fitTimestampToMs(msg.timestamp);
			if (ms != null && typeof msg.sleepLevel === 'string') sleepLevels.set(ms, msg.sleepLevel);
		}

		for (const msg of messages.sleepDisruptionOvernightSeverityMesgs ?? []) {
			if (typeof msg.severity === 'string') summary.sleep_disruption_severity = msg.severity;
		}

		for (const msg of messages.sleepDisruptionSeverityPeriodMesgs ?? []) {
			const ms = fitTimestampToMs(msg.timestamp);
			if (ms != null) {
				sleepDisruptions.push({
					time: localMinute(ms),
					severity: typeof msg.severity === 'string' ? msg.severity : null,
				});
			}
		}
	}

	return {
		date,
		files: entries.map(entry => entry.name),
		summary,
		series: {
			heart_rate: dedupeSeries(heartRate),
			stress: dedupeSeries(stress),
			body_battery: dedupeSeries(bodyBattery),
			respiration: dedupeSeries(respiration),
			spo2: dedupeSeries(spo2),
			skin_temp_delta: dedupeSeries(skinTempDelta),
			hrv: dedupeSeries(hrv),
		},
		sleep_levels: [...sleepLevels.entries()]
			.toSorted(([a], [b]) => a - b)
			.map(([ms, stage]) => ({ time: localMinute(ms), stage })),
		sleep_disruptions: sleepDisruptions.toSorted((a, b) => a.time.localeCompare(b.time)),
	};
}

export interface ActivityFitRecord {
	time: string;
	epochMs: number;
	heart_rate: number | null;
	distance_m: number | null;
	speed_mps: number | null;
	cadence: number | null;
	altitude_m: number | null;
	power_w: number | null;
}

export interface ActivityFitZone {
	zone: number;
	seconds: number;
	high_bpm: number | null;
}

export interface ActivityFitData {
	activity_id: number;
	file: string;
	session: {
		sport: string | null;
		sub_sport: string | null;
		name: string | null;
		start_time: string | null;
		elapsed_seconds: number | null;
		timer_seconds: number | null;
		calories: number | null;
		distance_m: number | null;
		avg_hr: number | null;
		max_hr: number | null;
	} | null;
	hr_zones: ActivityFitZone[];
	laps: {
		start_time: string | null;
		elapsed_seconds: number | null;
		timer_seconds: number | null;
		calories: number | null;
		distance_m: number | null;
		avg_hr: number | null;
		max_hr: number | null;
	}[];
	records: ActivityFitRecord[];
}

const localSecond = (epochMs: number) => format(new Date(epochMs), "yyyy-MM-dd'T'HH:mm:ss");
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const str = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);

export function parseActivityZip(activityId: number, zipBytes: Uint8Array): ActivityFitData {
	const entry = unzipEntries(zipBytes).find(file => file.name.endsWith('.fit'));
	if (!entry) throw new Error(`No .fit file found in activity ${activityId} archive.`);

	const decoder = new Decoder(Stream.fromByteArray(entry.data));
	const { messages } = decoder.read({
		expandSubFields: true,
		convertDateTimesToDates: true,
		includeUnknownData: false,
	}) as unknown as { messages: Record<string, Record<string, unknown>[]> };

	const rawSession = messages.sessionMesgs?.[0];
	const sessionStartMs = rawSession ? fitTimestampToMs(rawSession.startTime) : null;
	const session = rawSession
		? {
				sport: str(rawSession.sport),
				sub_sport: str(rawSession.subSport),
				name: str(rawSession.sportProfileName),
				start_time: sessionStartMs != null ? localSecond(sessionStartMs) : null,
				elapsed_seconds: num(rawSession.totalElapsedTime),
				timer_seconds: num(rawSession.totalTimerTime),
				calories: num(rawSession.totalCalories),
				distance_m: num(rawSession.totalDistance),
				avg_hr: num(rawSession.avgHeartRate),
				max_hr: num(rawSession.maxHeartRate),
			}
		: null;

	// timeInZoneMesgs can hold both session and lap entries; prefer the session-level one.
	const tzMesg =
		(messages.timeInZoneMesgs ?? []).find(m => m.referenceMesg === 'session') ?? messages.timeInZoneMesgs?.[0];
	const times = Array.isArray(tzMesg?.timeInHrZone) ? (tzMesg.timeInHrZone as unknown[]) : [];
	const highs = Array.isArray(tzMesg?.hrZoneHighBoundary) ? (tzMesg.hrZoneHighBoundary as unknown[]) : [];
	const hr_zones: ActivityFitZone[] = times
		.map((seconds, index) => ({
			zone: index,
			seconds: num(seconds) ?? 0,
			high_bpm: num(highs[index]),
		}))
		.filter(z => z.seconds > 0 || z.high_bpm != null);

	const laps = (messages.lapMesgs ?? []).map(lap => {
		const startMs = fitTimestampToMs(lap.startTime);
		return {
			start_time: startMs != null ? localSecond(startMs) : null,
			elapsed_seconds: num(lap.totalElapsedTime),
			timer_seconds: num(lap.totalTimerTime),
			calories: num(lap.totalCalories),
			distance_m: num(lap.totalDistance),
			avg_hr: num(lap.avgHeartRate),
			max_hr: num(lap.maxHeartRate),
		};
	});

	const records: ActivityFitRecord[] = [];
	for (const rec of messages.recordMesgs ?? []) {
		const ms = fitTimestampToMs(rec.timestamp);
		if (ms == null) continue;
		const hr = num(rec.heartRate);
		records.push({
			time: localSecond(ms),
			epochMs: ms,
			heart_rate: hr != null && hr > 0 && hr < 255 ? hr : null,
			distance_m: num(rec.distance),
			speed_mps: num(rec.enhancedSpeed ?? rec.speed),
			cadence: num(rec.cadence),
			altitude_m: num(rec.enhancedAltitude ?? rec.altitude),
			power_w: num(rec.power),
		});
	}

	return { activity_id: activityId, file: entry.name, session, hr_zones, laps, records };
}
