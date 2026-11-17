import { expect, test } from 'bun:test';

import { parseLocaliasList, parsePeerState, planAliasChanges, planRoutes } from './localias-peer';

const options = { name: 'mini', portOffset: 5_000 };

test('`localias list` lines parse to host and port with any scheme stripped', () => {
	expect(parseLocaliasList('vitals.localhost -> 6000\nhttps://secure.test -> 9000\nnoise\n')).toEqual([
		{ host: 'vitals.localhost', port: 6000 },
		{ host: 'secure.test', port: 9000 },
	]);
});

test("peer ports are named after this machine's projects and forwarded at port + offset", () => {
	const { routes } = planRoutes(
		[{ host: 'new-you-times.localhost', port: 6060 }],
		{
			aliases: [
				{ host: 'mini-new-you-times.local', port: 6060 },
				{ host: 'only-on-mini.test', port: 7000 },
			],
			listening: [],
		},
		options,
	);
	expect(routes).toEqual([
		{ host: 'new-you-times.mini.localhost', peerPort: 6060, localPort: 11060 },
		{ host: 'only-on-mini.mini.localhost', peerPort: 7000, localPort: 12000 },
	]);
});

test("this machine's own peer aliases are never routed, so routes do not feed back into themselves", () => {
	const { routes } = planRoutes(
		[{ host: 'vitals.mini.localhost', port: 11000 }],
		{ aliases: [], listening: [] },
		options,
	);
	expect(routes).toEqual([]);
});

test('peer ports that would overflow the port range are skipped', () => {
	const { routes, skipped } = planRoutes(
		[{ host: 'high.localhost', port: 61_000 }],
		{ aliases: [], listening: [] },
		options,
	);
	expect(routes).toEqual([]);
	expect(skipped).toHaveLength(1);
});

test('peer dev servers get a <port> route, system services and ephemeral ports do not', () => {
	const output = [
		'mini-new-you-times.local -> 6060',
		'--- listeners',
		'p100',
		'n127.0.0.1:6230',
		'n[::1]:6231',
		'p200',
		'n*:7000',
		'p300',
		'n127.0.0.1:60785',
		'--- processes',
		'  100 bun',
		'  200 /System/Library/CoreServices/ControlCenter.app/Contents/MacOS/ControlCenter',
		'  300 node',
	].join('\n');
	expect(parsePeerState(output)).toEqual({
		aliases: [{ host: 'mini-new-you-times.local', port: 6060 }],
		listening: [6230, 6231],
	});
});

test('a running project gets both its name and its port; a port route stays after its server stops', () => {
	const running = planRoutes(
		[{ host: 'pandemic.localhost', port: 6190 }],
		{ aliases: [], listening: [6190, 6230] },
		options,
	).routes.map(route => route.host);
	expect(running).toEqual(['6190.mini.localhost', 'pandemic.mini.localhost', '6230.mini.localhost']);
	const stopped = planRoutes(
		[{ host: '6230.mini.localhost', port: 11230 }],
		{ aliases: [], listening: [] },
		options,
	).routes;
	expect(stopped).toEqual([{ host: '6230.mini.localhost', peerPort: 6230, localPort: 11230 }]);
});

test('alias changes converge: add missing, fix wrong ports, remove stale, leave other aliases alone', () => {
	const current = [
		{ host: 'vitals.localhost', port: 6000 },
		{ host: 'vitals.mini.localhost', port: 11000 },
		{ host: 'moved.mini.localhost', port: 1 },
		{ host: 'stale.mini.localhost', port: 11999 },
	];
	const routes = [
		{ host: 'vitals.mini.localhost', peerPort: 6000, localPort: 11000 },
		{ host: 'moved.mini.localhost', peerPort: 6010, localPort: 11010 },
		{ host: 'new.mini.localhost', peerPort: 6020, localPort: 11020 },
	];
	expect(planAliasChanges(current, routes, 'mini')).toEqual({
		remove: ['stale.mini.localhost'],
		set: [
			{ host: 'moved.mini.localhost', port: 11010 },
			{ host: 'new.mini.localhost', port: 11020 },
		],
	});
	expect(
		planAliasChanges(
			routes.map(route => ({ host: route.host, port: route.localPort })),
			routes,
			'mini',
		),
	).toEqual({ remove: [], set: [] });
});
