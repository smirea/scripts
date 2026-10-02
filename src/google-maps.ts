#!/usr/bin/env bun
import { createScript } from './utils/createScript';
import type { Argv } from 'yargs';
import { getCoreLocation, parseCoordinates } from './utils/coreLocation';

import env from './env';

const PLACES_BASE_URL = 'https://places.googleapis.com/v1';
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 20;
const DEFAULT_DISTANCE_METERS = 10_000;
const DEFAULT_SEARCH_FIELD_MASK = [
	'places.name',
	'places.id',
	'places.displayName',
	'places.formattedAddress',
	'places.location',
	'places.rating',
	'places.userRatingCount',
	'places.currentOpeningHours.openNow',
	'places.priceLevel',
	'places.primaryType',
	'places.types',
	'places.businessStatus',
	'places.googleMapsUri',
	'places.websiteUri',
	'places.nationalPhoneNumber',
].join(',');
const DEFAULT_DETAIL_FIELDS = [
	'id',
	'name',
	'displayName',
	'formattedAddress',
	'location',
	'rating',
	'userRatingCount',
	'priceLevel',
	'primaryType',
	'types',
	'businessStatus',
	'googleMapsUri',
	'websiteUri',
	'nationalPhoneNumber',
	'internationalPhoneNumber',
	'regularOpeningHours',
	'currentOpeningHours.openNow',
];

interface SearchOptions {
	limit?: number;
	near?: string;
	center?: { latitude: number; longitude: number };
	distance?: number;
	minRating?: number;
	minRatingCount?: number;
	rank?: string;
	openNow?: boolean;
	type?: string;
	strictType?: boolean;
	priceLevel?: number[] | number;
	language?: string;
}

interface DetailsOptions {
	near?: string;
	distance?: number;
	rank?: string;
	type?: string;
	strictType?: boolean;
	reviews?: boolean;
	photos?: boolean;
	fields?: string[] | string;
	language?: string;
}

interface Place {
	name?: string;
	id?: string;
	displayName?: { text?: string; languageCode?: string };
	formattedAddress?: string;
	location?: { latitude?: number; longitude?: number };
	rating?: number;
	userRatingCount?: number;
	priceLevel?: string;
	primaryType?: string;
	types?: string[];
	businessStatus?: string;
	googleMapsUri?: string;
	websiteUri?: string;
	nationalPhoneNumber?: string;
	internationalPhoneNumber?: string;
	regularOpeningHours?: unknown;
	currentOpeningHours?: { openNow?: boolean };
	photos?: unknown[];
	reviews?: unknown[];
}

interface SearchResponse {
	places?: Place[];
	nextPageToken?: string;
	searchUri?: string;
}

if (import.meta.main) {
	run().catch(error => {
		console.error(
			JSON.stringify(
				{
					error: error instanceof Error ? error.message : String(error),
				},
				null,
				2,
			),
		);
		process.exit(1);
	});
}

async function run(): Promise<void> {
	await createScript('google-maps')
		.usage('$0 <command> [options]')
		.option('format', {
			alias: 'f',
			type: 'string',
			choices: ['json', 'table', 'md'] as const,
			default: 'table',
			describe: 'Output format.',
		})
		.parserConfiguration({
			'strip-aliased': true,
			'strip-dashed': true,
		})
		.command(
			'search <query...>',
			'Run a Google Places text search.',
			command =>
				addSearchOptions(
					command.positional('query', {
						type: 'string',
						array: true,
						demandOption: true,
						describe: 'Free-form search query.',
					}),
				),
			async argv => {
				const places = await searchPlaces(joinPositionals(argv.query), argv);
				renderPlaces(places, argv.format, !argv.openNow);
			},
		)
		.command(
			'details <place...>',
			'Fetch one place by resource name, place id, or exact text query.',
			command =>
				addDetailsOptions(
					command.positional('place', {
						type: 'string',
						array: true,
						demandOption: true,
						describe: 'places/... resource name, place id, or exact text query.',
					}),
				),
			async argv => {
				const details = await placeDetails(joinPositionals(argv.place), argv);
				renderPlaces(details, argv.format);
			},
		)
		.demandCommand(1, 'Choose a command.')
		.recommendCommands()
		.parseAsync();
}

function addSearchOptions<T>(argv: Argv<T>): Argv<T & SearchOptions> {
	return addLocationOptions(addLocaleOptions(argv))
		.option('limit', {
			alias: 'l',
			type: 'number',
			default: DEFAULT_LIMIT,
			describe: `Maximum results, capped at ${MAX_LIMIT}.`,
		})
		.option('min-rating', {
			alias: 'r',
			type: 'number',
			describe: 'Minimum Google rating from 0 to 5.',
		})
		.option('min-rating-count', {
			alias: 'c',
			type: 'number',
			describe: 'Minimum number of ratings; filters the returned search results locally.',
		})
		.option('rank', {
			alias: 'k',
			type: 'string',
			choices: ['relevance', 'distance', 'RELEVANCE', 'DISTANCE'] as const,
			describe: 'Text search ranking preference.',
		})
		.option('open-now', {
			alias: 'o',
			type: 'boolean',
			default: false,
			describe: 'Only include places Google reports as open now.',
		})
		.option('type', {
			alias: 't',
			type: 'string',
			describe: 'Google place type, for example lodging, restaurant, or school.',
		})
		.option('strict-type', {
			alias: 's',
			type: 'boolean',
			default: false,
			describe: 'Only return results whose type matches --type.',
		})
		.option('price-level', {
			alias: 'p',
			type: 'number',
			choices: [0, 1, 2, 3, 4] as const,
			array: true,
			describe: 'Allowed price levels from 0 (free) to 4 (very expensive).',
		});
}

function addDetailsOptions<T>(argv: Argv<T>): Argv<T & DetailsOptions> {
	return addLocationOptions(addLocaleOptions(argv))
		.option('rank', {
			alias: 'k',
			type: 'string',
			choices: ['relevance', 'distance', 'RELEVANCE', 'DISTANCE'] as const,
			describe: 'Ranking preference when resolving a text query to one place.',
		})
		.option('type', {
			alias: 't',
			type: 'string',
			describe: 'Google place type used when resolving a text query.',
		})
		.option('strict-type', {
			alias: 's',
			type: 'boolean',
			default: false,
			describe: 'Only consider matching place types when resolving a text query.',
		})
		.option('reviews', {
			alias: 'v',
			type: 'boolean',
			default: false,
			describe: 'Include Google review summaries when available.',
		})
		.option('photos', {
			alias: 'p',
			type: 'boolean',
			default: false,
			describe: 'Include Google photo references when available.',
		})
		.option('fields', {
			alias: 'F',
			type: 'string',
			array: true,
			describe: 'Exact comma-separated field mask to use instead of the default details fields.',
		});
}

function addLocationOptions<T>(argv: Argv<T>): Argv<T & Pick<SearchOptions, 'near' | 'distance'>> {
	return argv
		.option('near', {
			alias: 'n',
			type: 'string',
			describe: 'Bias search or text-query resolution around this location (defaults to device location, then an IP-based estimate).',
		})
		.option('distance', {
			alias: 'd',
			type: 'number',
			default: DEFAULT_DISTANCE_METERS,
			describe: 'Location bias distance in meters.',
		});
}

function addLocaleOptions<T>(argv: Argv<T>): Argv<T & Pick<SearchOptions, 'language'>> {
	return argv
		.option('language', {
			alias: 'L',
			type: 'string',
			describe: 'Preferred BCP-47 language code, for example en or pt-BR.',
		});
}

function joinPositionals(value: unknown): string {
	if (Array.isArray(value)) {
		return value.map(String).join(' ').trim();
	}
	return typeof value === 'string' ? value.trim() : '';
}

export async function searchPlaces(query: string, options: SearchOptions = {}): Promise<Place[]> {
	if (!query) {
		throw new Error('Missing search query.');
	}
	const minimumCount = options.minRatingCount ?? 0;
	if (!Number.isSafeInteger(minimumCount) || minimumCount < 0) {
		throw new Error('--min-rating-count must be a non-negative integer.');
	}
	const response = await placesFetch<SearchResponse>(
		'places:searchText',
		await buildTextSearchBody(query, options),
		DEFAULT_SEARCH_FIELD_MASK,
	);
	return (response.places ?? []).filter(place => (place.userRatingCount ?? 0) >= minimumCount);
}

export async function placeDetails(place: string, options: DetailsOptions = {}): Promise<Place> {
	if (!place) {
		throw new Error('details requires a places/... resource name, place id, or exact text query.');
	}
	const resourceName = await resolvePlaceResourceName(place, options);
	const params = new URLSearchParams();
	if (options.language) {
		params.set('languageCode', options.language);
	}
	return placesFetch<Place>(resourceName, undefined, getDetailFieldMask(options), params);
}

async function buildTextSearchBody(query: string, options: SearchOptions): Promise<Record<string, unknown>> {
	const body: Record<string, unknown> = {
		textQuery: query,
		pageSize: getLimit(options),
	};

	if (options.language) {
		body.languageCode = options.language;
	}
	if (options.openNow) {
		body.openNow = true;
	}
	if (options.minRating !== undefined) {
		body.minRating = getMinRating(options.minRating);
	}
	if (options.rank) {
		body.rankPreference = String(options.rank).toUpperCase();
	}
	if (options.strictType && !options.type) {
		throw new Error('--strict-type requires --type.');
	}
	if (options.type) {
		body.includedType = options.type;
	}
	if (options.strictType) {
		body.strictTypeFiltering = true;
	}

	const priceLevels = getPriceLevels(options.priceLevel);
	if (priceLevels.length > 0) {
		body.priceLevels = priceLevels;
	}

	if (options.center && !parseCoordinates(options.center)) {
		throw new Error('Invalid search coordinates.');
	}
	const center = options.center ?? (options.near ? await resolveLocation(options.near) : await detectLocation());
	if (center) {
		body.locationBias = {
			circle: {
				center,
				radius: getDistance(options),
			},
		};
	}

	return body;
}

async function detectLocation(): Promise<{ latitude: number; longitude: number } | undefined> {
	const location = await getCoreLocation();
	if (location) {
		return location;
	}
	console.error('[google-maps] Device location unavailable; falling back to an approximate IP-based location.');
	return detectIpLocation();
}

async function detectIpLocation(): Promise<{ latitude: number; longitude: number } | undefined> {
	try {
		const response = await fetch('https://ipapi.co/json/', { signal: AbortSignal.timeout(2_000) });
		if (!response.ok) {
			return undefined;
		}
		return parseCoordinates(await response.json());
	} catch {
		return undefined;
	}
}

async function resolveLocation(input: string): Promise<{ latitude: number; longitude: number }> {
	const response = await placesFetch<SearchResponse>(
		'places:searchText',
		{ textQuery: input, pageSize: 1 },
		'places.location',
	);
	const location = response.places?.[0]?.location;
	if (location?.latitude === undefined || location.longitude === undefined) {
		throw new Error(`Could not resolve location: ${input}`);
	}
	return { latitude: location.latitude, longitude: location.longitude };
}

async function resolvePlaceResourceName(input: string, options: DetailsOptions): Promise<string> {
	if (input.startsWith('places/')) {
		return input;
	}
	if (looksLikePlaceId(input)) {
		return `places/${input}`;
	}

	const body = await buildTextSearchBody(input, {
		limit: 1,
		near: options.near,
		distance: options.distance,
		rank: options.rank,
		type: options.type,
		strictType: options.strictType,
		language: options.language,
	});
	const response = await placesFetch<SearchResponse>('places:searchText', body, 'places.name');
	const name = response.places?.[0]?.name;
	if (!name) {
		throw new Error(`Could not resolve place: ${input}`);
	}
	return name;
}

function looksLikePlaceId(input: string): boolean {
	return /^[A-Za-z0-9_-]{20,}$/.test(input) || /^ChI[A-Za-z0-9_-]+$/.test(input);
}

async function placesFetch<T>(
	endpoint: string,
	body: unknown,
	fieldMask: string,
	params = new URLSearchParams(),
): Promise<T> {
	const apiKey = await readGoogleMapsApiKey();
	const url = new URL(`${PLACES_BASE_URL}/${endpoint}`);
	for (const [name, value] of params) {
		url.searchParams.set(name, value);
	}

	const response = await fetch(url, {
		signal: AbortSignal.timeout(20_000),
		method: body === undefined ? 'GET' : 'POST',
		headers: {
			'Content-Type': 'application/json',
			'X-Goog-Api-Key': apiKey,
			'X-Goog-FieldMask': fieldMask,
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});

	const text = await response.text();
	if (!response.ok) {
		throw new Error(`Google Places API ${response.status}: ${text}`);
	}
	return JSON.parse(text) as T;
}

export async function placePhoto(name: string, maxWidthPx = 1200): Promise<Response> {
	if (!/^places\/[A-Za-z0-9_-]+\/photos\/[A-Za-z0-9_-]+$/.test(name)) {
		throw new Error('Invalid Google Places photo resource.');
	}
	if (!Number.isInteger(maxWidthPx) || maxWidthPx < 1 || maxWidthPx > 4800) {
		throw new Error('Photo width must be between 1 and 4800 pixels.');
	}
	const url = new URL(`${PLACES_BASE_URL}/${name}/media`);
	url.searchParams.set('maxWidthPx', String(maxWidthPx));
	const response = await fetch(url, {
		headers: { 'X-Goog-Api-Key': await readGoogleMapsApiKey() },
		signal: AbortSignal.timeout(20_000),
	});
	if (!response.ok) {
		throw new Error(`Google Places photo request failed (${response.status}).`);
	}
	return response;
}

async function readGoogleMapsApiKey(): Promise<string> {
	return env.GOOGLE_MAPS_API_KEY;
}

function renderPlaces(value: Place | Place[], format: string, showOpen = true): void {
	const openStatus = (place: Place) => place.currentOpeningHours?.openNow === undefined
		? 'unknown' : place.currentOpeningHours.openNow ? 'yes' : 'no';
	if (format === 'json') {
		console.log(JSON.stringify(showOpen
			? Array.isArray(value) ? value.map(place => ({ ...place, open: openStatus(place) })) : { ...value, open: openStatus(value) }
			: value, null, 2));
		return;
	}

	const rows = (Array.isArray(value) ? value : [value]).map(place => ({
		id: place.id ?? place.name?.replace(/^places\//, '') ?? '',
		name: place.displayName?.text ?? '',
		rating: place.rating === undefined ? '' : `${place.rating.toFixed(1)} (${place.userRatingCount ?? 0})`,
		type: place.primaryType ?? place.types?.[0] ?? '',
		...(showOpen ? { open: openStatus(place) } : {}),
		url: format === 'table' ? tableMapsUrl(place.googleMapsUri) : place.googleMapsUri ?? '',
	}));

	if (format === 'table') {
		console.table(Object.fromEntries(rows.map(({ id, ...row }) => [id, row])));
		return;
	}

	const columns = ['id', 'name', 'rating', 'type', ...(showOpen ? ['open'] : []), 'url'];
	const escapeCell = (cell: string) => cell.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;').replaceAll('\\', '\\\\').replaceAll('|', '\\|').replaceAll(/\r\n|\r|\n/g, '<br>');
	const line = (cells: string[]) => `| ${cells.map(escapeCell).join(' | ')} |`;
	console.log([
		line(columns),
		line(columns.map(() => '---')),
		...rows.map(row => line(Object.values(row))),
	].join('\n'));
}

function tableMapsUrl(value: string | undefined): string {
	if (!value) {
		return '';
	}
	try {
		const url = new URL(value);
		url.searchParams.delete('g_mp');
		return url.toString();
	} catch {
		return value;
	}
}

function getDetailFieldMask(options: DetailsOptions): string {
	const customFields = getList(options.fields);
	if (customFields.length > 0) {
		return customFields.join(',');
	}

	const fields = new Set(DEFAULT_DETAIL_FIELDS);
	if (options.photos) {
		fields.add('photos');
	}
	if (options.reviews) {
		fields.add('reviews');
	}
	return [...fields].join(',');
}

function getPriceLevels(value: number[] | number | undefined): string[] {
	const levels = ['PRICE_LEVEL_FREE', 'PRICE_LEVEL_INEXPENSIVE', 'PRICE_LEVEL_MODERATE', 'PRICE_LEVEL_EXPENSIVE', 'PRICE_LEVEL_VERY_EXPENSIVE'];
	return (Array.isArray(value) ? value : value === undefined ? [] : [value]).map(level => {
		if (!Number.isInteger(level) || level < 0 || level > 4) {
			throw new Error('--price-level must be an integer from 0 to 4.');
		}
		return levels[level];
	});
}

function getList(value: string[] | string | undefined): string[] {
	const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
	return values.flatMap(item => item.split(',').map(part => part.trim())).filter(Boolean);
}

function getLimit(options: { limit?: number }): number {
	const requested = options.limit ?? DEFAULT_LIMIT;
	return Math.max(1, Math.min(MAX_LIMIT, Math.trunc(requested)));
}

function getDistance(options: { distance?: number }): number {
	const requested = options.distance ?? DEFAULT_DISTANCE_METERS;
	return Math.max(1, Math.trunc(requested));
}

function getMinRating(value: number): number {
	if (value < 0 || value > 5) {
		throw new Error('--min-rating must be between 0 and 5.');
	}
	return value;
}
