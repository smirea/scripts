import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The WHOOP app's own API, which serves what the developer API lacks: heart rate every 6 seconds, raw strain, and
 * per-cycle workouts. Unofficial. Logging in from a script doesn't work (2026-11-17): the Cognito proxy answers
 * "Incorrect username or password" to correct credentials and to refresh tokens, and id.whoop.com needs a Cloudflare
 * human check plus an SMS code. So the token comes from a browser sign-in and lasts 24 hours.
 */

export const WHOOP_APP_TOKEN_FILE = path.join(os.homedir(), '.config', 'whoop', 'app_tokens.json');

const API_BASE = 'https://api.prod.whoop.com';
const SIGN_IN_STEPS = [
	'Sign in at https://app.whoop.com (it texts a code), then in DevTools > Application > Cookies > id.whoop.com copy `whoop-auth-token`,',
	'and run `whoop-pull --app-token <token>`.',
].join(' ');

interface AppToken {
	accessToken: string;
	expiresAt: number;
	userId: number;
}

export interface WhoopHeartRateSample {
	time: number;
	bpm: number;
}

export interface WhoopWorkout {
	during: string;
	sport_id: number;
	activity_id: string;
	score: number | null;
	average_heart_rate: number | null;
}

export interface WhoopCycleDetails {
	cycle: { id: number; during: string; days: string; scaled_strain: number | null; day_avg_heart_rate: number | null };
	workouts: WhoopWorkout[];
	v2_activities: { id: string; translated_type?: string | null }[];
}

export class WhoopAppApi {
	private constructor(private readonly token: AppToken) {}

	get userId(): number {
		return this.token.userId;
	}

	static connect(): WhoopAppApi {
		if (!existsSync(WHOOP_APP_TOKEN_FILE))
			throw new Error(`No WHOOP app token in ${WHOOP_APP_TOKEN_FILE}. ${SIGN_IN_STEPS}`);
		const token = JSON.parse(readFileSync(WHOOP_APP_TOKEN_FILE, 'utf8')) as AppToken;
		if (token.expiresAt <= Date.now()) {
			throw new Error(`The WHOOP app token expired at ${new Date(token.expiresAt).toLocaleString()}. ${SIGN_IN_STEPS}`);
		}
		return new WhoopAppApi(token);
	}

	async get<T>(pathname: string, params: Record<string, string | number> = {}): Promise<T> {
		const url = new URL(pathname, API_BASE);
		for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
		url.searchParams.set('apiVersion', '7');
		const res = await fetch(url, {
			headers: { Authorization: `Bearer ${this.token.accessToken}`, 'User-Agent': 'WHOOP/4.0' },
		});
		const body = await res.text();
		if (!res.ok) {
			const hint = res.status === 401 ? ` The token was refused. ${SIGN_IN_STEPS}` : '';
			throw new Error(
				`GET ${url.pathname}${url.search} (WHOOP app) failed with ${res.status}: ${body.slice(0, 300)}${hint}`,
			);
		}
		return (body ? JSON.parse(body) : null) as T;
	}

	/** Heart rate in [start, end); WHOOP serves a step of 6, 60, or 600 seconds and a full day per request. */
	async heartRate(start: number, end: number, stepSeconds: 6 | 60 | 600 = 6): Promise<WhoopHeartRateSample[]> {
		const response = await this.get<{ values?: { time: number; data: number | null }[] }>(
			`/metrics-service/v1/metrics/user/${this.userId}`,
			{
				name: 'heart_rate',
				start: new Date(start).toISOString(),
				end: new Date(end).toISOString(),
				step: stepSeconds,
				order: 't',
			},
		);
		return (response.values ?? []).flatMap(value =>
			value.data == null ? [] : [{ time: value.time, bpm: value.data }],
		);
	}

	/** Cycles (sleep onset to sleep onset) overlapping [start, end), newest first, with their workouts. */
	async cycles(start: number, end: number): Promise<WhoopCycleDetails[]> {
		const response = await this.get<{ records?: WhoopCycleDetails[] }>('/core-details-bff/v0/cycles/details', {
			id: this.userId,
			startTime: new Date(start).toISOString(),
			endTime: new Date(end).toISOString(),
			limit: 50,
		});
		return response.records ?? [];
	}
}

/** WHOOP ranges look like "['2026-11-16T06:31:34.560Z','2026-11-17T06:08:37.500Z')"; an open cycle has no end. */
export function parseWhoopRange(range: string): { start: number; end: number | null } {
	const [start, end] = [...range.matchAll(/'([^']+)'/g)].map(match => Date.parse(match[1]!));
	if (start == null || Number.isNaN(start)) throw new Error(`Unexpected WHOOP time range: ${range}`);
	return { start, end: end == null || Number.isNaN(end) ? null : end };
}

/** Saves an access token copied from a browser session (the `whoop-auth-token` cookie on id.whoop.com). */
export async function saveWhoopAppToken(accessToken: string): Promise<{ userId: number; expiresAt: number }> {
	const claims = JSON.parse(Buffer.from(accessToken.split('.')[1] ?? '', 'base64url').toString('utf8') || '{}') as {
		exp?: number;
	};
	if (!claims.exp)
		throw new Error('That is not a WHOOP access token (no expiry claim). Copy the `whoop-auth-token` cookie value.');
	const res = await fetch(`${API_BASE}/users-service/v2/bootstrap/?accountType=users&apiVersion=7&include=profile`, {
		headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': 'WHOOP/4.0' },
	});
	if (!res.ok) throw new Error(`WHOOP refused the token (${res.status}). ${SIGN_IN_STEPS}`);
	const data = (await res.json()) as { id?: number; user?: { id?: number } };
	const userId = data.user?.id ?? data.id;
	if (typeof userId !== 'number')
		throw new Error(`WHOOP bootstrap had no user id (keys: ${Object.keys(data).join(', ')}).`);
	const token: AppToken = { accessToken, expiresAt: claims.exp * 1000, userId };
	mkdirSync(path.dirname(WHOOP_APP_TOKEN_FILE), { recursive: true, mode: 0o700 });
	const temp = `${WHOOP_APP_TOKEN_FILE}.${process.pid}.tmp`;
	writeFileSync(temp, JSON.stringify(token), { mode: 0o600 });
	chmodSync(temp, 0o600);
	renameSync(temp, WHOOP_APP_TOKEN_FILE);
	return { userId, expiresAt: token.expiresAt };
}
