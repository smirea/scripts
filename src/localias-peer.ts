#!/usr/bin/env bun
import { createScript } from './utils/createScript';
import type { Subprocess } from 'bun';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const home = process.env.HOME;
if (!home) throw new Error('HOME is not set.');

const LOG_FILE = path.join(home, 'Library', 'Logs', 'localias-peer.log');
const LAUNCHD_LABEL = 'com.stefan.localias-peer';
const PLIST = path.join(home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
const RESYNC_MS = 15_000;
const MAX_BACKOFF_MS = 60_000;
const SSH_OPTIONS = [
	'-o',
	'RemoteCommand=none',
	'-o',
	'RequestTTY=no',
	'-o',
	'BatchMode=yes',
	'-o',
	'ConnectTimeout=10',
];
// With the default +5000 offset these land in 7000-15999, clear of project ports and agent-t3-worktree blocks; higher ports are mostly ephemeral.
const DEV_PORTS = { min: 2_000, max: 10_999 };
const PEER_STATE_COMMAND = [
	'PATH=/opt/homebrew/bin:/usr/local/bin:$PATH',
	'localias list 2>/dev/null',
	'echo "--- listeners"',
	'/usr/sbin/lsof -nP -iTCP -sTCP:LISTEN -Fpn 2>/dev/null',
	'echo "--- processes"',
	'ps -axo pid=,comm=',
].join('; ');

export interface Alias {
	host: string;
	port: number;
}
export interface Route {
	host: string;
	peerPort: number;
	localPort: number;
}
export interface PeerState {
	aliases: Alias[];
	listening: number[];
}
interface Options {
	peer: string;
	name: string;
	portOffset: number;
}

export function parseLocaliasList(output: string): Alias[] {
	return output.split('\n').flatMap(line => {
		const match = line.trim().match(/^(?:https?:\/\/)?(\S+?)\s+->\s+(\d+)$/);
		return match ? [{ host: match[1]!, port: Number(match[2]) }] : [];
	});
}

/** Peer dev servers listening on a port, from `lsof -Fpn` and `ps -axo pid=,comm=` output; macOS system services are left out. */
export function parsePeerState(output: string): PeerState {
	const [aliasText = '', rest = ''] = output.split('--- listeners\n');
	const [lsofText = '', psText = ''] = rest.split('--- processes\n');
	const commands = new Map(
		psText.split('\n').flatMap(line => {
			const match = line.trim().match(/^(\d+)\s+(.+)$/);
			return match ? [[match[1]!, match[2]!] as const] : [];
		}),
	);
	const listening = new Set<number>();
	let pid = '';
	for (const line of lsofText.split('\n')) {
		if (line.startsWith('p')) pid = line.slice(1);
		const port = line.startsWith('n') ? Number(line.slice(line.lastIndexOf(':') + 1)) : NaN;
		const command = commands.get(pid) ?? '';
		if (port >= DEV_PORTS.min && port <= DEV_PORTS.max && !/^\/(System|usr)\//.test(command)) listening.add(port);
	}
	return { aliases: parseLocaliasList(aliasText), listening: [...listening].sort((a, b) => a - b) };
}

/**
 * A `<project>` route per localias port (local names win: they follow this machine's `<project>.localhost` convention) and a
 * `<port>` route per peer dev server. Port routes outlive their server because each new alias costs a `localias reload`,
 * which restarts the daemon and drops every open connection through it, local projects' HMR sockets included.
 */
export function planRoutes(
	local: Alias[],
	peer: PeerState,
	options: Pick<Options, 'name' | 'portOffset'>,
): { routes: Route[]; skipped: string[] } {
	const suffix = `.${options.name}.localhost`;
	const names = new Map<number, string>();
	for (const alias of [...peer.aliases, ...local.filter(alias => !alias.host.endsWith(suffix))]) {
		names.set(alias.port, alias.host.includes('.') ? alias.host.slice(0, alias.host.lastIndexOf('.')) : alias.host);
	}
	const seenPorts = local
		.filter(alias => alias.host.endsWith(suffix))
		.map(alias => alias.host.slice(0, -suffix.length))
		.filter(label => /^\d+$/.test(label))
		.map(Number);
	const named = [...names].map(([port, name]) => ({ name, port }));
	const numbered = [...new Set([...peer.listening, ...seenPorts])].map(port => ({ name: String(port), port }));
	const routes: Route[] = [];
	const skipped: string[] = [];
	for (const { name, port: peerPort } of [...named, ...numbered].sort(
		(a, b) => a.port - b.port || a.name.localeCompare(b.name),
	)) {
		const localPort = peerPort + options.portOffset;
		if (localPort > 65_535)
			skipped.push(`${name}${suffix}: port ${peerPort} + offset ${options.portOffset} exceeds 65535`);
		else routes.push({ host: `${name}${suffix}`, peerPort, localPort });
	}
	return { routes, skipped };
}

export function planAliasChanges(current: Alias[], routes: Route[], name: string): { remove: string[]; set: Alias[] } {
	const suffix = `.${name}.localhost`;
	const owned = new Map(current.filter(alias => alias.host.endsWith(suffix)).map(alias => [alias.host, alias.port]));
	const desired = new Map(routes.map(route => [route.host, route.localPort]));
	return {
		remove: [...owned.keys()].filter(host => !desired.has(host)),
		set: [...desired].filter(([host, port]) => owned.get(host) !== port).map(([host, port]) => ({ host, port })),
	};
}

if (import.meta.main) {
	const peerOptions = (command: ReturnType<typeof createScript>) =>
		command
			.option('peer', {
				type: 'string',
				demandOption: true,
				describe: 'SSH host of the other machine, as in ~/.ssh/config (for example mini-ts).',
			})
			.option('name', {
				type: 'string',
				default: 'mini',
				describe: "Subdomain for the peer's routes: <project>.<name>.localhost.",
			})
			// Projects sit at 6000-6999 and agent-t3-worktree claims main + 10000 and up, so +5000 lands in the unused 11000-11999.
			.option('port-offset', {
				type: 'number',
				default: 5_000,
				describe:
					'Local port = peer port + offset. Keep it clear of project ports (6000-6999) and agent-t3-worktree blocks (16000+).',
			})
			.check(argv => {
				if (!/^[a-z0-9-]+$/.test(argv.name))
					throw new Error(`--name must be lowercase letters, digits, or dashes; got "${argv.name}".`);
				return true;
			});

	void createScript('localias-peer')
		.usage(
			`$0 <command>\n\nServes another machine's dev servers on this one as https://<project>.<name>.localhost, through this machine's localias and one SSH tunnel. Routes come from both machines' \`localias list\`, so a project at <project>.localhost -> 6060 here is also https://<project>.mini.localhost, served by port 6060 on the peer. Every dev server listening on the peer (ports ${DEV_PORTS.min}-${DEV_PORTS.max}) is also https://<port>.<name>.localhost.`,
		)
		.parserConfiguration({ 'strip-aliased': true, 'strip-dashed': true })
		.command(
			'run',
			'Keep the aliases and the tunnel in sync until stopped. Resyncs every 15 seconds and reconnects when the tunnel drops.',
			command =>
				peerOptions(command).option('dry-run', {
					type: 'boolean',
					default: false,
					describe: 'Print the routes and the localias changes once, without making them.',
				}),
			argv => run({ peer: argv.peer, name: argv.name, portOffset: argv.portOffset }, argv.dryRun),
		)
		.command(
			'install',
			`Install a launchd agent that keeps \`run\` alive. Logs: ${LOG_FILE}`,
			command =>
				peerOptions(command).option('dry-run', {
					type: 'boolean',
					default: false,
					describe: 'Print the plist without installing it.',
				}),
			argv => install({ peer: argv.peer, name: argv.name, portOffset: argv.portOffset }, argv.dryRun),
		)
		.command(
			'uninstall',
			'Remove the launchd agent and every <project>.<name>.localhost alias.',
			command =>
				command
					.option('name', { type: 'string', default: 'mini', describe: 'Subdomain whose aliases to remove.' })
					.option('dry-run', {
						type: 'boolean',
						default: false,
						describe: 'Print what would be removed without removing it.',
					}),
			argv => uninstall(argv.name, argv.dryRun),
		)
		.strictCommands()
		.demandCommand(1, 'Choose run, install, or uninstall.')
		.recommendCommands()
		.parseAsync();
}

async function run(options: Options, dryRun: boolean): Promise<void> {
	requireLocalias();
	let peerState: PeerState = { aliases: [], listening: [] };
	let peerReachable: boolean | undefined;
	let tunnel: Subprocess | undefined;
	let tunnelKey = '';
	let tunnelStartedAt = 0;
	let backoffMs = 5_000;

	const stop = () => {
		tunnel?.kill();
		process.exit(0);
	};
	process.on('SIGTERM', stop);
	process.on('SIGINT', stop);

	for (;;) {
		const peer = await readPeerState(options.peer);
		if (peer) peerState = peer;
		if ((peer !== undefined) !== peerReachable) {
			peerReachable = peer !== undefined;
			log(
				peerReachable
					? `${options.peer}: ${peer!.aliases.length} localias routes, dev servers on ${peer!.listening.join(', ') || 'no ports'}`
					: `${options.peer}: unreachable; keeping the last known peer routes`,
			);
		}

		const local = parseLocaliasList((await exec(['localias', 'list'])).stdout);
		const { routes, skipped } = planRoutes(local, peerState, options);
		const changes = planAliasChanges(local, routes, options.name);

		if (dryRun) {
			for (const route of routes)
				console.log(`https://${route.host} -> localhost:${route.localPort} -> ${options.peer}:${route.peerPort}`);
			for (const reason of skipped) console.log(`skip ${reason}`);
			for (const host of changes.remove) console.log(`[dry-run] localias rm ${host}`);
			for (const alias of changes.set) console.log(`[dry-run] localias set ${alias.host} ${alias.port}`);
			return;
		}

		if (changes.remove.length || changes.set.length) {
			for (const host of changes.remove) await mustExec(['localias', 'rm', host]);
			for (const alias of changes.set) await mustExec(['localias', 'set', alias.host, String(alias.port)]);
			await mustExec(['localias', 'reload']);
			log(
				`localias: removed ${changes.remove.length}, set ${changes.set.length}; ${routes.length} routes, ${skipped.length} skipped${skipped.length ? `\n${skipped.join('\n')}` : ''}`,
			);
		}

		const forwards = [...new Map(routes.map(route => [route.localPort, route.peerPort]))];
		const key = forwards.join(',');
		if (tunnel && tunnel.exitCode === null && key !== tunnelKey) {
			tunnel.kill();
			await tunnel.exited;
			tunnel = undefined;
		}
		if (!tunnel || tunnel.exitCode !== null) {
			tunnel = Bun.spawn(
				[
					'ssh',
					'-N',
					...SSH_OPTIONS,
					'-o',
					'ServerAliveInterval=15',
					'-o',
					'ServerAliveCountMax=3',
					...forwards.flatMap(([localPort, peerPort]) => ['-L', `${localPort}:localhost:${peerPort}`]),
					options.peer,
				],
				{
					stdin: 'ignore',
					stdout: 'inherit',
					stderr: 'inherit',
				},
			);
			tunnelKey = key;
			tunnelStartedAt = Date.now();
		}

		const exited = await Promise.race([Bun.sleep(RESYNC_MS).then(() => false), tunnel.exited.then(() => true)]);
		if (exited) {
			const ranMs = Date.now() - tunnelStartedAt;
			backoffMs = ranMs > MAX_BACKOFF_MS ? 5_000 : Math.min(backoffMs * 2, MAX_BACKOFF_MS);
			if (ranMs > MAX_BACKOFF_MS)
				log(
					`tunnel to ${options.peer} exited with ${tunnel.exitCode} after ${Math.round(ranMs / 1000)}s; reconnecting`,
				);
			await Bun.sleep(backoffMs);
		}
	}
}

async function readPeerState(peer: string): Promise<PeerState | undefined> {
	const result = await exec(['ssh', ...SSH_OPTIONS, peer, PEER_STATE_COMMAND], 30_000);
	if (result.code !== 0) return undefined;
	return parsePeerState(result.stdout);
}

async function install(options: Options, dryRun: boolean): Promise<void> {
	requireLocalias();
	const status = await exec(['localias', 'status']);
	if (!status.stdout.includes('daemon running'))
		throw new Error(
			`localias daemon is not running on this machine; start it with \`localias start\`, then rerun install.\n${status.output}`,
		);
	const bun = Bun.which('bun');
	if (!bun)
		throw new Error('`bun` is not on PATH; install it (curl -fsSL https://bun.sh/install | bash) and rerun install.');
	const pathEnv = [
		path.dirname(bun),
		path.dirname(Bun.which('localias')!),
		'/opt/homebrew/bin',
		'/usr/local/bin',
		'/usr/bin',
		'/bin',
		'/usr/sbin',
		'/sbin',
	].join(':');
	const args = [
		bun,
		'--no-env-file',
		import.meta.path,
		'run',
		'--peer',
		options.peer,
		'--name',
		options.name,
		'--port-offset',
		String(options.portOffset),
	];
	const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map(arg => `    <string>${arg}</string>`).join('\n')}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${LOG_FILE}</string>
  <key>StandardErrorPath</key>
  <string>${LOG_FILE}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${pathEnv}</string>
  </dict>
</dict>
</plist>
`;
	if (dryRun) {
		process.stdout.write(`Would write ${PLIST}:\n${plist}`);
		return;
	}
	writeFileSync(PLIST, plist);
	const domain = `gui/${process.getuid!()}`;
	await exec(['launchctl', 'bootout', `${domain}/${LAUNCHD_LABEL}`]);
	// bootout returns before the old job is gone, and bootstrapping over it fails with "5: Input/output error".
	for (let i = 0; i < 50 && (await exec(['launchctl', 'print', `${domain}/${LAUNCHD_LABEL}`])).code === 0; i++)
		await Bun.sleep(200);
	const bootstrap = await exec(['launchctl', 'bootstrap', domain, PLIST]);
	if (bootstrap.code !== 0) throw new Error(`launchctl bootstrap ${domain} ${PLIST} failed:\n${bootstrap.output}`);
	process.stdout.write(
		`Installed ${PLIST}: https://<project>.${options.name}.localhost serves ${options.peer}. Logs: ${LOG_FILE}\n`,
	);
}

async function uninstall(name: string, dryRun: boolean): Promise<void> {
	requireLocalias();
	const { remove } = planAliasChanges(parseLocaliasList((await exec(['localias', 'list'])).stdout), [], name);
	const domain = `gui/${process.getuid!()}`;
	if (dryRun) {
		console.log(`[dry-run] launchctl bootout ${domain}/${LAUNCHD_LABEL} and delete ${PLIST}`);
		for (const host of remove) console.log(`[dry-run] localias rm ${host}`);
		return;
	}
	await exec(['launchctl', 'bootout', `${domain}/${LAUNCHD_LABEL}`]);
	await exec(['trash', PLIST]);
	for (const host of remove) await mustExec(['localias', 'rm', host]);
	if (remove.length) await mustExec(['localias', 'reload']);
	console.log(`Removed the launchd agent and ${remove.length} aliases.`);
}

function requireLocalias(): void {
	if (!Bun.which('localias'))
		throw new Error('`localias` is not on PATH; install it with `brew install peterldowns/tap/localias`.');
}

async function mustExec(cmd: string[]): Promise<void> {
	const result = await exec(cmd);
	if (result.code !== 0) throw new Error(`\`${cmd.join(' ')}\` failed:\n${result.output}`);
}

async function exec(cmd: string[], timeoutMs = 60_000) {
	const proc = Bun.spawn(cmd, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: timeoutMs });
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, stdout: stdout.trim(), output: [stdout.trim(), stderr.trim()].filter(Boolean).join('\n') };
}

function log(message: string): void {
	process.stderr.write(`${new Date().toISOString()} ${message}\n`);
}
