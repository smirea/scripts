/**
 * A WHOOP-style 0–21 strain estimate from Garmin heart rate. WHOOP doesn't publish its formula; this one was fit on
 * 2026-11-17 to Stefan's own WHOOP data: 167 heart-rate-only WHOOP workouts (by zone) plus 6 days with the CIRQA and
 * WHOOP worn on the same arm. Leave-one-day-out error is ~1.3 strain on days without weightlifting (WHOOP adds a
 * muscular load for lifting that heart rate can't see).
 *
 * Garmin's all-day heart rate is a 2-minute average that flattens peaks, so a hard effort reads 2–3 low unless the band
 * recorded it as an activity, whose per-second heart rate replaces the 2-minute samples (a 43-minute walk: 5.1 here,
 * 5.1 on WHOOP; 4.5 from the 2-minute samples alone).
 */

// WHOOP's resting and max HR at fit time. The constants below absorb them, so Garmin's lower RHR must not replace them.
const RESTING_HR = 66;
const MAX_HR = 194;
const INTENSITY_EXPONENT = 9.1804;
const LOAD_SCALE = 31925.877;
const CURVE_EXPONENT = 0.3594;
const ALL_DAY_SAMPLE_MINUTES = 2;
const MAX_ACTIVITY_GAP_SECONDS = 10;

export interface HeartRatePoint {
	time: number;
	bpm: number;
}

function sampleLoad(bpm: number, minutes: number): number {
	const reserve = Math.min(1, Math.max(0, (bpm - RESTING_HR) / (MAX_HR - RESTING_HR)));
	return minutes * reserve * Math.exp(INTENSITY_EXPONENT * reserve);
}

function strainFromLoad(load: number): number {
	return 21 * (1 - Math.exp(-((load / LOAD_SCALE) ** CURVE_EXPONENT)));
}

/** Strain for [start, end): all-day 2-minute samples, with each recorded activity's per-second samples swapped in. */
export function estimateStrain(
	allDay: HeartRatePoint[],
	activities: HeartRatePoint[][],
	start: number,
	end: number,
): number | null {
	const inWindow = (point: HeartRatePoint) => point.time >= start && point.time < end;
	const spans = activities
		.filter(points => points.length > 1)
		.map(points => [points[0]!.time, points.at(-1)!.time] as const);
	const covered = (time: number) => spans.some(([from, to]) => time >= from && time <= to);

	const dayPoints = allDay.filter(point => inWindow(point) && !covered(point.time));
	let load = dayPoints.reduce((sum, point) => sum + sampleLoad(point.bpm, ALL_DAY_SAMPLE_MINUTES), 0);
	let sampled = dayPoints.length;
	for (const points of activities) {
		points.forEach((point, index) => {
			if (!inWindow(point)) return;
			const next = points[index + 1];
			const gapSeconds = next ? Math.min((next.time - point.time) / 1000, MAX_ACTIVITY_GAP_SECONDS) : 1;
			load += sampleLoad(point.bpm, gapSeconds / 60);
			sampled++;
		});
	}
	return sampled === 0 ? null : Math.round(strainFromLoad(load) * 10) / 10;
}
