#!/usr/bin/env bun
import yargs, { type Argv } from 'yargs';
import { hideBin } from 'yargs/helpers';

import env from './env';

const PLACES_BASE_URL = 'https://places.googleapis.com/v1';
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 20;
const DEFAULT_RADIUS_METERS = 10_000;
const DEFAULT_SEARCH_FIELD_MASK = [
	'places.name',
	'places.id',
	'places.displayName',
	'places.formattedAddress',
	'places.location',
	'places.rating',
	'places.userRatingCount',
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
];

interface SearchOptions {
	limit?: number;
	near?: string;
	radius?: number;
	minRating?: number;
	rank?: string;
	openNow?: boolean;
	type?: string;
	strictType?: boolean;
	priceLevel?: string[] | string;
	language?: string;
	region?: string;
}

interface DetailsOptions {
	near?: string;
	radius?: number;
	rank?: string;
	type?: string;
	strictType?: boolean;
	reviews?: boolean;
	photos?: boolean;
	fields?: string[] | string;
	language?: string;
	region?: string;
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
	await yargs(hideBin(process.argv))
		.scriptName('google-maps')
		.version(false)
		.usage('$0 <command> [options]')
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
				renderJson(places);
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
				renderJson(details);
			},
		)
		.strict()
		.demandCommand(1, 'Choose a command.')
		.recommendCommands()
		.showHelpOnFail(false)
		.wrap(process.stdout.columns || 100)
		.fail((message, error) => {
			throw error ?? new Error(message);
		})
		.help()
		.parseAsync();
}

function addSearchOptions<T>(argv: Argv<T>): Argv<T & SearchOptions> {
	return addLocationOptions(addLocaleOptions(argv))
		.option('limit', {
			type: 'number',
			default: DEFAULT_LIMIT,
			describe: `Maximum results, capped at ${MAX_LIMIT}.`,
		})
		.option('min-rating', {
			type: 'number',
			describe: 'Minimum Google rating from 0 to 5.',
		})
		.option('rank', {
			type: 'string',
			choices: ['relevance', 'distance', 'RELEVANCE', 'DISTANCE'] as const,
			describe: 'Text search ranking preference.',
		})
		.option('open-now', {
			type: 'boolean',
			default: false,
			describe: 'Only include places Google reports as open now.',
		})
		.option('type', {
			type: 'string',
			describe: 'Google place type, for example lodging, restaurant, or school.',
		})
		.option('strict-type', {
			type: 'boolean',
			default: false,
			describe: 'Only return results whose type matches --type.',
		})
		.option('price-level', {
			type: 'string',
			array: true,
			describe: 'Allowed price levels: 0/free, 1/inexpensive, 2/moderate, 3/expensive, 4/very-expensive.',
		});
}

function addDetailsOptions<T>(argv: Argv<T>): Argv<T & DetailsOptions> {
	return addLocationOptions(addLocaleOptions(argv))
		.option('rank', {
			type: 'string',
			choices: ['relevance', 'distance', 'RELEVANCE', 'DISTANCE'] as const,
			describe: 'Ranking preference when resolving a text query to one place.',
		})
		.option('type', {
			type: 'string',
			describe: 'Google place type used when resolving a text query.',
		})
		.option('strict-type', {
			type: 'boolean',
			default: false,
			describe: 'Only consider matching place types when resolving a text query.',
		})
		.option('reviews', {
			type: 'boolean',
			default: false,
			describe: 'Include Google review summaries when available.',
		})
		.option('photos', {
			type: 'boolean',
			default: false,
			describe: 'Include Google photo references when available.',
		})
		.option('fields', {
			type: 'string',
			array: true,
			describe: 'Exact comma-separated field mask to use instead of the default details fields.',
		});
}

function addLocationOptions<T>(argv: Argv<T>): Argv<T & Pick<SearchOptions, 'near' | 'radius'>> {
	return argv
		.option('near', {
			type: 'string',
			describe: 'Bias search, or text-query resolution, around this location.',
		})
		.option('radius', {
			type: 'number',
			default: DEFAULT_RADIUS_METERS,
			describe: 'Location bias radius in meters.',
		});
}

function addLocaleOptions<T>(argv: Argv<T>): Argv<T & Pick<SearchOptions, 'language' | 'region'>> {
	return argv
		.option('language', {
			type: 'string',
			describe: 'Preferred BCP-47 language code, for example en or pt-BR.',
		})
		.option('region', {
			type: 'string',
			describe: 'Two-character CLDR region code, for example PT or US.',
		});
}

function joinPositionals(value: unknown): string {
	if (Array.isArray(value)) {
		return value.map(String).join(' ').trim();
	}
	return typeof value === 'string' ? value.trim() : '';
}

async function searchPlaces(query: string, options: SearchOptions): Promise<Place[]> {
	if (!query) {
		throw new Error('Missing search query.');
	}
	const response = await placesFetch<SearchResponse>(
		'places:searchText',
		await buildTextSearchBody(query, options),
		DEFAULT_SEARCH_FIELD_MASK,
	);
	return response.places ?? [];
}

async function placeDetails(place: string, options: DetailsOptions): Promise<Place> {
	if (!place) {
		throw new Error('details requires a places/... resource name, place id, or exact text query.');
	}
	const resourceName = await resolvePlaceResourceName(place, options);
	const params = new URLSearchParams();
	if (options.language) {
		params.set('languageCode', options.language);
	}
	if (options.region) {
		params.set('regionCode', options.region);
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
	if (options.region) {
		body.regionCode = options.region;
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

	if (options.near) {
		body.locationBias = {
			circle: {
				center: await resolveLocation(options.near),
				radius: getRadius(options),
			},
		};
	}

	return body;
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
		radius: options.radius,
		rank: options.rank,
		type: options.type,
		strictType: options.strictType,
		language: options.language,
		region: options.region,
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

async function readGoogleMapsApiKey(): Promise<string> {
	return env.GOOGLE_MAPS_API_KEY;
}

function renderJson(value: unknown): void {
	console.log(JSON.stringify(value, null, 2));
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

function getPriceLevels(value: string[] | string | undefined): string[] {
	const levels = new Map([
		['0', 'PRICE_LEVEL_FREE'],
		['free', 'PRICE_LEVEL_FREE'],
		['1', 'PRICE_LEVEL_INEXPENSIVE'],
		['inexpensive', 'PRICE_LEVEL_INEXPENSIVE'],
		['2', 'PRICE_LEVEL_MODERATE'],
		['moderate', 'PRICE_LEVEL_MODERATE'],
		['3', 'PRICE_LEVEL_EXPENSIVE'],
		['expensive', 'PRICE_LEVEL_EXPENSIVE'],
		['4', 'PRICE_LEVEL_VERY_EXPENSIVE'],
		['very-expensive', 'PRICE_LEVEL_VERY_EXPENSIVE'],
		['very_expensive', 'PRICE_LEVEL_VERY_EXPENSIVE'],
		['very expensive', 'PRICE_LEVEL_VERY_EXPENSIVE'],
	]);

	return getList(value).map(rawLevel => {
		const normalized = rawLevel.trim().toLowerCase();
		const mapped = levels.get(normalized);
		if (mapped) {
			return mapped;
		}
		const enumValue = rawLevel.trim().toUpperCase();
		if (enumValue.startsWith('PRICE_LEVEL_')) {
			return enumValue;
		}
		throw new Error(`Unsupported price level: ${rawLevel}`);
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

function getRadius(options: { radius?: number }): number {
	const requested = options.radius ?? DEFAULT_RADIUS_METERS;
	return Math.max(1, Math.trunc(requested));
}

function getMinRating(value: number): number {
	if (value < 0 || value > 5) {
		throw new Error('--min-rating must be between 0 and 5.');
	}
	return value;
}
