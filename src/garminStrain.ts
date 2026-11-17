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

interface WeightedSample {
	time: number;
	bpm: number;
	minutes: number;
}

/**
 * Samples in [start, end) with the minutes each stands for: all-day 2-minute samples, with each per-second stream (a
 * recorded activity, or WHOOP's 6-second heart rate) swapped in where it has data.
 */
function weightedSamples(
	allDay: HeartRatePoint[],
	streams: HeartRatePoint[][],
	start: number,
	end: number,
): WeightedSample[] {
	const inWindow = (point: HeartRatePoint) => point.time >= start && point.time < end;
	const spans = streams
		.filter(points => points.length > 1)
		.map(points => [points[0]!.time, points.at(-1)!.time] as const);
	const covered = (time: number) => spans.some(([from, to]) => time >= from && time <= to);

	const samples = allDay
		.filter(point => inWindow(point) && !covered(point.time))
		.map(point => ({ ...point, minutes: ALL_DAY_SAMPLE_MINUTES }));
	for (const points of streams) {
		points.forEach((point, index) => {
			if (!inWindow(point)) return;
			const next = points[index + 1];
			const gapSeconds = next ? Math.min((next.time - point.time) / 1000, MAX_ACTIVITY_GAP_SECONDS) : 1;
			samples.push({ ...point, minutes: gapSeconds / 60 });
		});
	}
	return samples.toSorted((a, b) => a.time - b.time);
}

const roundStrain = (load: number) => Math.round(strainFromLoad(load) * 10) / 10;
const totalLoad = (samples: WeightedSample[]) =>
	samples.reduce((sum, sample) => sum + sampleLoad(sample.bpm, sample.minutes), 0);

/** Strain for [start, end), or null without heart rate in the window. */
export function estimateStrain(
	allDay: HeartRatePoint[],
	streams: HeartRatePoint[][],
	start: number,
	end: number,
): number | null {
	const samples = weightedSamples(allDay, streams, start, end);
	return samples.length === 0 ? null : roundStrain(totalLoad(samples));
}

/** Time-weighted average heart rate for [start, end), from the same samples the strain uses. */
export function averageHeartRate(
	allDay: HeartRatePoint[],
	streams: HeartRatePoint[][],
	start: number,
	end: number,
): number | null {
	const samples = weightedSamples(allDay, streams, start, end);
	const minutes = samples.reduce((sum, sample) => sum + sample.minutes, 0);
	return minutes === 0
		? null
		: Math.round(samples.reduce((sum, sample) => sum + sample.bpm * sample.minutes, 0) / minutes);
}

/** Per step from start: average heart rate in the step and strain accumulated up to its end, for charting a day. */
export function strainTimeline(
	allDay: HeartRatePoint[],
	streams: HeartRatePoint[][],
	start: number,
	end: number,
	stepMs: number,
): { time: number; bpm: number | null; strain: number }[] {
	const samples = weightedSamples(allDay, streams, start, end);
	const timeline: { time: number; bpm: number | null; strain: number }[] = [];
	let load = 0;
	let index = 0;
	for (let stepStart = start; stepStart < end; stepStart += stepMs) {
		const stepEnd = Math.min(stepStart + stepMs, end);
		let minutes = 0;
		let beats = 0;
		for (; index < samples.length && samples[index]!.time < stepEnd; index++) {
			const sample = samples[index]!;
			load += sampleLoad(sample.bpm, sample.minutes);
			minutes += sample.minutes;
			beats += sample.bpm * sample.minutes;
		}
		timeline.push({
			time: stepEnd,
			bpm: minutes === 0 ? null : Math.round(beats / minutes),
			strain: roundStrain(load),
		});
	}
	return timeline;
}
