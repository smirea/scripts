import { Database } from 'bun:sqlite';
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import { pruneStaleT3Artifacts } from '../cron/t3Userdata';
import { freeBytes, human } from './disk';
import { checkout, git, run, type Checkout } from './shell';
import { devices, gc as simulatorGc, ownedBy, remove as removeSimulator, shutdown, status } from './simulators';
import {
	cleanIdleWorktreeCaches,
	cleanStaleRepoCaches,
	cleanWorktreeCache,
	DAY_MS,
	openFiles,
	runningT3Worktree,
} from './worktreeCache';

const T3_WORKTREES = join(homedir(), '.t3/worktrees');
const T3_DATABASE = join(homedir(), '.t3/userdata/statev2.sqlite');

/** Child output goes to stderr, so a hook's stdout carries only the summary. */
const step = (cmd: string[], cwd: string) => run(cmd, { cwd, inherit: true });

/** Written into the worktree's own git dir, so it survives `git clean` and never shows up as a file. */
type Stamp = { root: string; lockHash: string | null; created: string[]; block?: number };

const stampPath = (root: string) =>
	join(git(root, 'rev-parse', '--path-format=absolute', '--git-dir'), 'agent-t3-worktree.json');
const lockfile = (root: string) => ['bun.lock', 'bun.lockb'].map(name => join(root, name)).find(existsSync);
const lockHash = (root: string) => {
	const file = lockfile(root);
	return file ? Bun.hash(readFileSync(file)).toString(16) : null;
};
const ignored = (root: string) =>
	new Set(
		git(root, 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory').split('\n').filter(Boolean),
	);

function readStamp(root: string): Stamp | undefined {
	// A worktree whose repository dropped it still has a `.git` file, but no git dir to hold a stamp.
	const gitDir = run(['git', '-C', root, 'rev-parse', '--path-format=absolute', '--git-dir'], { allowFail: true });
	const file = gitDir && join(gitDir, 'agent-t3-worktree.json');
	return file && existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Stamp) : undefined;
}

/** Ports come from the root `.env` defaults: every `*PORT` key, and every `*_URL` on 127.0.0.1 or localhost at one of them. */
type PortPlan = {
	ports: Record<string, number>;
	urls: Record<string, { prefix: string; port: number; suffix: string }>;
	min: number;
};

function portPlan(root: string): PortPlan | undefined {
	const file = join(root, '.env');
	if (!existsSync(file)) return undefined;
	const text = readFileSync(file, 'utf8');
	const ports = Object.fromEntries(
		[...text.matchAll(/^((?:[A-Z][A-Z0-9_]*_)?PORT)=(\d+)\b/gm)].map(([, key, port]) => [key!, Number(port)]),
	);
	const values = Object.values(ports);
	if (!values.length) return undefined;
	const urls = Object.fromEntries(
		[...text.matchAll(/^([A-Z][A-Z0-9_]*_URL)=(https?:\/\/(?:127\.0\.0\.1|localhost):)(\d+)([^\s#]*)/gm)]
			.filter(([, , , port]) => values.includes(Number(port)))
			.map(([, key, prefix, port, suffix]) => [key!, { prefix: prefix!, port: Number(port), suffix: suffix! }]),
	);
	return { ports, urls, min: Math.min(...values) };
}

const SLOT = 10;
const STEP = 1000;
// Apps get main ports 10 apart (setup-new-app), worktree n of an app sits at main + 10000 + (n - 1) * 1000, and the
// last block must end below 49152, where macOS's ephemeral ports begin.
const blocks = (plan: PortPlan) => {
	const first = plan.min + 10_000;
	const last = first + Math.floor((49_152 - SLOT - first) / STEP) * STEP;
	return { first, last, valid: (port: number) => port >= first && port <= last && (port - first) % STEP === 0 };
};

function blockOf(worktree: string, plan: PortPlan): number | undefined {
	const file = [OVERRIDE, VALUES].map(name => join(worktree, name)).find(existsSync);
	if (!file) return undefined;
	const key = Object.entries(plan.ports).find(([, port]) => port === plan.min)![0];
	const value = Number(readFileSync(file, 'utf8').match(new RegExp(`^${key}=(\\d+)`, 'm'))?.[1]);
	return blocks(plan).valid(value) ? value : undefined;
}

const portFree = (port: number) =>
	new Promise<boolean>(resolve => {
		const server = createServer()
			.once('error', () => resolve(false))
			.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
	});

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

async function withLock<T>(main: string, action: () => Promise<T>): Promise<T> {
	// Parallel setups would otherwise pick the same port block; mkdir is atomic, so it serves as the lock. Only a lock whose
	// holder is dead is broken, so a waiter never removes a live holder's lock.
	const lock = join(main, '.git', 'agent-t3-worktree.lock');
	for (const started = Date.now(); ; await Bun.sleep(100)) {
		try {
			mkdirSync(lock);
			writeFileSync(join(lock, 'pid'), String(process.pid));
			break;
		} catch {
			const pidFile = join(lock, 'pid');
			const holder = existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8') || 0) : 0;
			const age = Date.now() - (statSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? Date.now());
			if (holder ? !alive(holder) : age > 60_000) rmSync(lock, { recursive: true, force: true });
			if (Date.now() - started > 120_000) throw new Error(`Timed out waiting for ${lock}.`);
		}
	}
	try {
		return await action();
	} finally {
		rmSync(lock, { recursive: true, force: true });
	}
}

const OVERRIDE = '.env.override';
const VALUES = '.env.local';

/** env-manager applies `.env.override` only to target outputs; a single-project `.env` takes its values from `.env.local`. */
const portFile = (root: string) =>
	/^# env-manager target:/m.test(readFileSync(join(root, '.env'), 'utf8')) ? OVERRIDE : VALUES;

function upsert(file: string, lines: string[]) {
	const keys = new Set(lines.map(line => line.split('=')[0]));
	const kept = existsSync(file)
		? readFileSync(file, 'utf8')
				.split('\n')
				.filter(line => line && !keys.has(line.split('=')[0]!))
		: [];
	writeFileSync(file, `${[...kept, ...lines].join('\n')}\n`);
}

async function assignPorts(current: Checkout, plan: PortPlan): Promise<number> {
	const { first, last } = blocks(plan);
	return withLock(current.main, async () => {
		let base = blockOf(current.root, plan);
		if (!base) {
			const claimed = new Set(worktreeEntries(current.main).map(entry => blockOf(entry.path, plan)));
			for (let candidate = first; candidate <= last && !base; candidate += STEP) {
				if (claimed.has(candidate)) continue;
				const free = await Promise.all(Array.from({ length: SLOT }, (_, offset) => portFree(candidate + offset)));
				if (free.every(Boolean)) base = candidate;
			}
		}
		if (!base)
			throw new Error(
				`No free worktree port block between ${first} and ${last}. Run \`agent-t3-worktree gc\` to remove merged worktrees.`,
			);
		const port = (original: number) => base! + original - plan.min;
		const lines = [
			...Object.entries(plan.ports).map(([key, original]) => `${key}=${port(original)}`),
			...Object.entries(plan.urls).map(([key, url]) => `${key}=${url.prefix}${port(url.port)}${url.suffix}`),
		];
		upsert(join(current.root, portFile(current.root)), lines);
		return base;
	});
}

// Mirrors T3 Code's TEMP_WORKTREE_BRANCH_PATTERN: the placeholder branch a new worktree gets before T3 renames it.
const T3_TEMPORARY_BRANCH =
	/^(?:t3[-/][0-9a-f]{8}|t3code(?:[-/][0-9a-f]{8}|\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}))$/;

/**
 * T3 Code (0.1.7) names the branch with an LLM call it forks beside the setup script, then starts the agent once setup
 * exits without waiting for that rename, so the agent sees one branch and pushes another. Setup is the only step T3
 * blocks the agent on, so it holds here until the rename lands. A failed rename leaves the placeholder, hence the cap.
 */
async function awaitBranchName(root: string, timeoutMs: number): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	let branch = git(root, 'branch', '--show-current');
	while (T3_TEMPORARY_BRANCH.test(branch) && Date.now() < deadline) {
		await Bun.sleep(250);
		branch = git(root, 'branch', '--show-current');
	}
	return branch;
}

export async function setup(cwd: string, { resetData = false, branchTimeoutMs = 60_000 } = {}): Promise<string> {
	const current = checkout(cwd);
	if (!current) throw new Error('Not inside a git checkout.');
	if (!current.linked) return 'Main checkout: nothing to set up.';
	const { root } = current;
	const before = ignored(root);
	const summary = [`Worktree ${root} is ready.`];

	if (lockfile(root)) step(['bun', 'install', '--frozen-lockfile'], root);

	const plan = portPlan(root);
	let block: number | undefined;
	const ports = async () => {
		if (!plan) return;
		const base = (block = await assignPorts(current, plan));
		summary.push(`  ports  ${base}-${base + SLOT - 1} (${portFile(root)}: ${Object.keys(plan.ports).join(', ')})`);
	};
	const env = join(root, '.env');
	if (existsSync(env) && /^#\s*env-manager:/m.test(readFileSync(env, 'utf8'))) {
		// Offline from the schema defaults: a worktree never pulls cloud values, so it needs no AWS access.
		const gen = () => step(['env-manager', 'gen', '--local'], root);
		// Target outputs read .env.override during gen; a single-project .env.local exists only after it, and gen reruns
		// so readers see the worktree's ports.
		if (portFile(root) === OVERRIDE) {
			await ports();
			gen();
		} else {
			gen();
			await ports();
			if (plan) gen();
		}
	} else {
		await ports();
	}

	if (resetData) {
		rmSync(join(root, '.data'), { recursive: true, force: true });
		summary.push('  data   .data/ reset');
	}

	const manifest = join(root, 'package.json');
	const legacy = join(root, 'scripts/setup-worktree.ts');
	if (
		existsSync(manifest) &&
		(JSON.parse(readFileSync(manifest, 'utf8')) as { scripts?: Record<string, string> }).scripts?.['worktree:setup']
	) {
		step(['bun', 'run', 'worktree:setup'], root);
		summary.push('  repo   bun run worktree:setup');
	} else if (existsSync(legacy) && !readFileSync(legacy, 'utf8').includes('agent-t3-worktree')) {
		// TODO(2026-11): delete once procrastimate and a-better-me ship `worktree:setup`; until then their own script holds
		// repo steps (codegen, ./sim) that T3 no longer calls directly.
		step(['bun', legacy], root);
		summary.push('  repo   bun scripts/setup-worktree.ts');
	}

	const branch = await awaitBranchName(root, branchTimeoutMs);
	if (T3_TEMPORARY_BRANCH.test(branch))
		summary.push(`  branch ${branch} (T3 didn't rename it within ${branchTimeoutMs / 1000}s)`);
	else if (branch) summary.push(`  branch ${branch}`);

	const after = ignored(root);
	const stamp: Stamp = {
		root,
		lockHash: lockHash(root),
		created: [...after].filter(path => !before.has(path)).sort(),
		...(block ? { block } : {}),
	};
	const previous = readStamp(root);
	if (previous?.root === root)
		stamp.created = [...new Set([...previous.created.filter(path => after.has(path)), ...stamp.created])].sort();
	writeFileSync(stampPath(root), `${JSON.stringify(stamp, null, 2)}\n`);
	return summary.join('\n');
}

/** Worktrees agents get: T3's, and the `Agent` tool's under `.claude/worktrees`. Only these are healed or removed. */
const isAgentWorktree = (root: string) => root.startsWith(`${T3_WORKTREES}/`) || root.includes('/.claude/worktrees/');

/**
 * What is wrong with the worktree's setup; empty when it is ready, `cwd` is the main checkout, or it is a hand-made
 * worktree that setup never ran in.
 */
export function check(cwd: string): string[] {
	const current = checkout(cwd);
	if (!current?.linked) return [];
	const { root } = current;
	const stamp = readStamp(root);
	if (!stamp) return isAgentWorktree(root) ? ['setup has not run in this worktree'] : [];
	const problems: string[] = [];
	if (stamp.root !== root) problems.push(`setup ran for ${stamp.root}, not ${root}`);
	if (stamp.lockHash !== lockHash(root)) problems.push('the lockfile changed since the last install');
	if (lockfile(root) && !existsSync(join(root, 'node_modules'))) problems.push('node_modules is missing');
	for (const path of stamp.created) if (!existsSync(join(root, path))) problems.push(`${path} is missing`);
	return problems;
}

export type Entry = { path: string; head?: string; branch?: string; locked: boolean; prunable: boolean; main: boolean };

export function worktreeEntries(main: string): Entry[] {
	return git(main, 'worktree', 'list', '--porcelain')
		.split('\n\n')
		.filter(Boolean)
		.map((block, index) => {
			const line = (key: string) => block.split('\n').find(text => text === key || text.startsWith(`${key} `));
			return {
				path: line('worktree')!.slice('worktree '.length),
				head: line('HEAD')?.slice('HEAD '.length),
				branch: line('branch')?.slice('branch refs/heads/'.length),
				locked: Boolean(line('locked')),
				prunable: Boolean(line('prunable')),
				main: index === 0,
			};
		});
}

export type Pr = { number: number; headRefName: string; headRefOid: string; baseRefName: string; url: string };
type Prs = { merged: Pr[]; open: Set<string> };

/**
 * The repo's PRs merged into its default branch, and its open PR branches; undefined when `gh` can't answer either
 * list. A PR merged into another branch (a stack) doesn't count: its commits may never reach the default branch.
 */
function pullRequests(main: string): Prs | undefined {
	const list = (state: string) =>
		run(
			[
				'gh',
				'pr',
				'list',
				'--state',
				state,
				'--limit',
				'1000',
				'--json',
				'number,headRefName,headRefOid,baseRefName,url',
			],
			{ cwd: main, allowFail: true },
		);
	const merged = list('merged');
	const open = list('open');
	if (!merged || !open) return undefined;
	const base = defaultBranch(main);
	return {
		merged: (JSON.parse(merged) as Pr[]).filter(pr => pr.baseRefName === base),
		open: new Set((JSON.parse(open) as Pr[]).map(pr => pr.headRefName)),
	};
}

/** Whether a T3 thread on `root` is still open: not deleted, not archived, and not settled (or unsettled since). */
function openThread(root: string): boolean {
	if (!existsSync(T3_DATABASE)) return false;
	const db = new Database(T3_DATABASE, { readonly: true });
	try {
		return (
			db
				.query(`SELECT 1 FROM orchestration_v2_projection_threads
      WHERE json_extract(payload_json, '$.worktreePath') = ? AND deleted_at IS NULL AND archived_at IS NULL
        AND (json_extract(payload_json, '$.settledAt') IS NULL
          OR json_extract(payload_json, '$.unsettledAt') > json_extract(payload_json, '$.settledAt'))
      LIMIT 1`)
				.get(root) !== null
		);
	} finally {
		db.close();
	}
}

/** The branch T3 recorded for the thread working in `root`, which an agent's later branch switch doesn't update. */
function t3Branch(root: string): string | undefined {
	if (!existsSync(T3_DATABASE)) return undefined;
	const db = new Database(T3_DATABASE, { readonly: true });
	try {
		const row = db
			.query(`SELECT json_extract(payload_json, '$.branch') AS branch FROM orchestration_v2_projection_threads
      WHERE json_extract(payload_json, '$.worktreePath') = ? AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 1`)
			.get(root) as { branch: string | null } | null;
		return row?.branch ?? undefined;
	} finally {
		db.close();
	}
}

const succeeds = (cmd: string[]) => Bun.spawnSync(cmd, { stdout: 'ignore', stderr: 'ignore' }).exitCode === 0;
const contains = (main: string, descendant: string, commit: string) =>
	commit === descendant ||
	(succeeds(['git', '-C', main, 'cat-file', '-e', `${descendant}^{commit}`]) &&
		succeeds(['git', '-C', main, 'merge-base', '--is-ancestor', commit, descendant]));

/** The merged PR that already holds every commit of `head`, found by `head`'s own branch or T3's recorded one. */
function mergedPrFor(
	main: string,
	prs: Prs,
	head: string | undefined,
	branches: (string | undefined)[],
): Pr | undefined {
	if (!head) return undefined;
	const tip = belowEnvManagerCommits(main, head);
	const candidates = prs.merged.filter(pr => pr.headRefOid === tip || branches.includes(pr.headRefName));
	return candidates.find(pr => contains(main, pr.headRefOid, tip));
}

// After a merge, a worker uploads new settings with `env-manager up`, which commits locally and is never pushed.
function belowEnvManagerCommits(main: string, head: string): string {
	let tip = head;
	while (
		run(['git', '-C', main, 'log', '-1', '--format=%s', tip], { allowFail: true }).trim() ===
		'chore: env manager update'
	)
		tip = `${tip}^`;
	return tip === head ? head : run(['git', '-C', main, 'rev-parse', tip], { allowFail: true }).trim() || head;
}

const SHELLS = new Set(['zsh', 'bash', 'sh', 'fish']);

/**
 * The working directories of every process except this one and its ancestors, so settle can remove its own worktree.
 * `skipIdleShells` leaves out shells running nothing, such as a settled thread's terminal tab.
 */
function processCwds({ skipIdleShells = false } = {}): string[] {
	const own = new Set<string>();
	for (
		let pid = String(process.pid);
		pid && pid !== '0' && pid !== '1';
		pid = run(['ps', '-o', 'ppid=', '-p', pid], { allowFail: true }).trim()
	)
		own.add(pid);
	const parents = new Set(
		skipIdleShells
			? run(['ps', '-axo', 'ppid='])
					.split('\n')
					.map(line => line.trim())
			: [],
	);
	const cwds: string[] = [];
	let pid = '';
	let command = '';
	const listing = Bun.spawnSync(['lsof', '-a', '-d', 'cwd', '-F', 'pcn'], { stderr: 'ignore' }).stdout.toString();
	// Without the list every worktree could be in use, so gc stops instead of guessing.
	if (!listing.trim()) throw new Error('lsof listed no process working directories; not removing anything.');
	for (const line of listing.split('\n')) {
		if (line.startsWith('p')) pid = line.slice(1);
		else if (line.startsWith('c')) command = line.slice(1);
		else if (line.startsWith('n') && !own.has(pid)) {
			if (skipIdleShells && SHELLS.has(command) && !parents.has(pid)) continue;
			cwds.push(line.slice(1));
		}
	}
	return cwds;
}

/**
 * Every listener in the port block setup assigned, including ports a repo derives from it, such as e2e servers. Only an
 * assigned block counts, so a stray `*_PORT` value such as 5432 never makes it stop unrelated servers.
 */
function listeningPids(root: string): string[] {
	const plan = existsSync(root) ? portPlan(root) : undefined;
	const base = readStamp(root)?.block ?? (plan && blockOf(root, plan));
	if (!base) return [];
	const ports = Array.from({ length: SLOT }, (_, offset) => `-iTCP:${base + offset}`);
	return [
		...new Set(
			run(['lsof', '-t', '-sTCP:LISTEN', ...ports], { allowFail: true })
				.split('\n')
				.filter(Boolean),
		),
	];
}

export type Verdict = { remove: true; pr?: Pr; why: string } | { remove: false; why: string };

type Facts = {
	exists: boolean;
	agent: boolean;
	dirty: boolean;
	busy: boolean;
	running: boolean;
	open: boolean;
	pr?: Pr;
	prsKnown: boolean;
	landed: boolean;
	fresh: boolean;
};

const GONE = 'its directory is gone';

/**
 * Pure: whether gc may remove a linked worktree. Removing needs its commits safe, in a merged PR or already on the
 * default branch, and nothing in use. A delegate's branch usually lands through its parent's PR, so it has none.
 */
export function classify(entry: Entry, facts: Facts): Verdict {
	if (!facts.exists || entry.prunable) return { remove: true, why: GONE };
	if (!facts.agent) return { remove: false, why: 'not an agent worktree' };
	if (entry.locked) return { remove: false, why: 'locked' };
	if (facts.dirty) return { remove: false, why: 'uncommitted or untracked files' };
	if (facts.busy) return { remove: false, why: 'a process is running in it' };
	if (facts.running) return { remove: false, why: 'a T3 run is active in it' };
	if (facts.open) return { remove: false, why: 'a T3 thread on it is still open' };
	if (facts.pr) return { remove: true, pr: facts.pr, why: `merged in ${facts.pr.url}` };
	// A worktree T3 just made from the default branch looks landed before T3 records its thread.
	if (facts.landed && !facts.fresh) return { remove: true, why: 'the default branch holds every commit' };
	if (!facts.prsKnown) return { remove: false, why: 'gh could not list PRs' };
	return {
		remove: false,
		why: entry.branch ? `no merged PR holds ${entry.branch}` : 'detached, with no merged PR holding its HEAD',
	};
}

/**
 * Stops its servers, deletes its simulators, the worktree, and its branch locally and on origin. Without a merged PR,
 * the origin branch goes only when the default branch holds its tip, since it may carry commits pushed elsewhere.
 */
function removeWorktree(main: string, entry: Entry, deleteBranch: boolean, { merged = true } = {}) {
	for (const pid of listeningPids(entry.path)) run(['kill', pid], { allowFail: true });
	for (const device of ownedBy(entry.path)) removeSimulator(device);
	if (existsSync(entry.path))
		run(['git', '-C', main, 'worktree', 'remove', '--force', entry.path], { allowFail: true });
	run(['git', '-C', main, 'worktree', 'prune']);
	if (deleteBranch && entry.branch) {
		run(['git', '-C', main, 'branch', '-D', entry.branch], { allowFail: true });
		const remoteTip = run(['git', '-C', main, 'ls-remote', '--heads', 'origin', entry.branch], { allowFail: true })
			.split('\t')[0]
			?.trim();
		if (remoteTip && (merged || landed(main, remoteTip))) {
			run(['git', '-C', main, 'push', 'origin', '--delete', entry.branch], { allowFail: true });
		}
	}
}

/** Whether origin's default branch already holds `head`, below the local env-manager commits. */
function landed(main: string, head: string | undefined): boolean {
	if (!head) return false;
	const tip = belowEnvManagerCommits(main, head);
	return contains(main, `refs/remotes/origin/${defaultBranch(main)}`, tip);
}

function defaultBranch(main: string): string {
	const head = run(['git', '-C', main, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { allowFail: true });
	return head ? head.replace(/^origin\//, '') : 'master';
}

/**
 * Every repository gc covers: the T3 Code projects that are git checkouts. Repos outside T3, such as clones of other
 * people's projects, are never touched, so gc can't delete branches it doesn't own.
 */
export function repositories(): string[] {
	if (!existsSync(T3_DATABASE)) return [];
	const db = new Database(T3_DATABASE, { readonly: true });
	try {
		const roots = (
			db.query('SELECT workspace_root AS root FROM projection_projects WHERE deleted_at IS NULL').all() as {
				root: string;
			}[]
		).map(row => row.root);
		return [
			...new Set(
				roots
					.map(root => checkout(root))
					.filter(current => current?.root === current?.main && current)
					.map(current => current!.main),
			),
		].sort();
	} finally {
		db.close();
	}
}

/** A failing `git status`, such as one blocked by another command's index.lock, counts as dirty. */
function dirty(path: string): boolean {
	const result = Bun.spawnSync(['git', '-C', path, 'status', '--porcelain'], { stderr: 'ignore' });
	return result.exitCode !== 0 || result.stdout.toString().trim() !== '';
}

export function gc(mains: string[], { dryRun = false, includeOpenThreads = false } = {}): string[] {
	const report: string[] = [];
	const act = (message: string, action: () => void) => {
		report.push(`${dryRun ? 'would ' : ''}${message}`);
		if (!dryRun) action();
	};
	// T3 reopens a terminal tab in every thread's worktree when it restarts, settled threads included.
	const cwds = processCwds({ skipIdleShells: true });
	const registered = new Set<string>();
	for (const main of mains) {
		const entries = worktreeEntries(main);
		for (const entry of entries) registered.add(entry.path);
		const prs = pullRequests(main);
		for (const entry of entries.filter(entry => !entry.main)) {
			const exists = existsSync(entry.path);
			const verdict = classify(entry, {
				exists,
				agent: isAgentWorktree(entry.path),
				dirty: exists && dirty(entry.path),
				busy: cwds.some(path => path === entry.path || path.startsWith(`${entry.path}/`)),
				running: exists && runningT3Worktree(entry.path),
				open: !includeOpenThreads && openThread(entry.path),
				prsKnown: Boolean(prs),
				pr: prs && mergedPrFor(main, prs, entry.head, [entry.branch, t3Branch(entry.path)]),
				landed: exists && landed(main, entry.head),
				fresh: exists && Date.now() - statSync(entry.path).birthtimeMs < FRESH_MS,
			});
			if (verdict.remove)
				act(`remove ${entry.path} (${verdict.why})`, () =>
					removeWorktree(main, entry, verdict.why !== GONE && !prs?.open.has(entry.branch ?? ''), {
						merged: Boolean(verdict.pr),
					}),
				);
			else report.push(`keep ${entry.path}: ${verdict.why}`);
		}
		if (!prs) continue;

		// Branches with no worktree: gone once a merged PR holds every commit and no open PR uses the name.
		const checkedOut = new Set(worktreeEntries(main).map(entry => entry.branch));
		const keep = new Set([defaultBranch(main), ...prs.open]);
		const merged = (name: string, tip: string) =>
			!keep.has(name) && !checkedOut.has(name) && mergedPrFor(main, prs, tip, [name])?.headRefName === name;
		const local = git(main, 'for-each-ref', 'refs/heads', '--format=%(refname:short) %(objectname)')
			.split('\n')
			.filter(Boolean)
			.map(line => line.split(' ') as [string, string]);
		const stale = local.filter(([name, tip]) => merged(name, tip)).map(([name]) => name);
		if (stale.length)
			act(`delete ${stale.length} merged local branches in ${basename(main)}`, () => {
				for (const name of stale) run(['git', '-C', main, 'branch', '-D', name], { allowFail: true });
			});
		const remote = run(['git', '-C', main, 'ls-remote', '--heads', 'origin'], { allowFail: true })
			.split('\n')
			.filter(Boolean)
			.map(line => {
				const [tip, ref] = line.split('\t') as [string, string];
				return [ref.slice('refs/heads/'.length), tip] as [string, string];
			});
		const staleRemote = remote.filter(([name, tip]) => merged(name, tip)).map(([name]) => name);
		if (staleRemote.length)
			act(`delete ${staleRemote.length} merged branches on ${basename(main)}'s origin`, () =>
				run(['git', '-C', main, 'push', 'origin', '--delete', ...staleRemote], { allowFail: true }),
			);
	}

	// T3 leaves directories behind that no repository lists, such as one whose checkout failed halfway.
	for (const project of existsSync(T3_WORKTREES) ? readdirSync(T3_WORKTREES) : []) {
		for (const dir of readdirSync(join(T3_WORKTREES, project), { withFileTypes: true })) {
			const path = join(T3_WORKTREES, project, dir.name);
			if (!dir.isDirectory() || registered.has(path) || checkout(path)) continue;
			const files = readdirSync(path).filter(name => name !== '.DS_Store');
			if (files.length) report.push(`keep ${path}: not a registered worktree, but not empty`);
			else act(`remove empty ${path}`, () => rmSync(path, { recursive: true, force: true }));
		}
	}
	return report;
}

const FRESH_MS = 60 * 60_000;

/**
 * Removes every T3 worktree directory no open thread uses: a settled or archived thread's, or an orphan whose thread
 * was deleted or never recorded it. Unlike gc it needs no merged PR. Branches stay, so committed work survives;
 * uncommitted changes are deleted with the directory.
 */
export function pruneAbandoned({ dryRun = false, keep = [] }: { dryRun?: boolean; keep?: string[] } = {}): string[] {
	if (!existsSync(T3_WORKTREES)) return [];
	const preserved = new Set(
		keep.map(entry => {
			try {
				return realpathSync(entry);
			} catch {
				return resolve(entry);
			}
		}),
	);
	const report: string[] = [];
	const cwds = processCwds({ skipIdleShells: true });
	const sims = devices();
	for (const project of readdirSync(T3_WORKTREES, { withFileTypes: true }).filter(entry => entry.isDirectory())) {
		for (const dir of readdirSync(join(T3_WORKTREES, project.name), { withFileTypes: true })) {
			if (!dir.isDirectory()) continue;
			const path = join(T3_WORKTREES, project.name, dir.name);
			let real = path;
			try {
				real = realpathSync(path);
			} catch {}
			const keep = preserved.has(real)
				? 'preserved by caller'
				: openThread(path)
					? 'a T3 thread on it is still open'
					: runningT3Worktree(path)
						? 'a T3 run is active in it'
						: cwds.some(cwd => cwd === path || cwd.startsWith(`${path}/`))
							? 'a process is running in it'
							: // T3 records a thread's worktree only after creating it.
								Date.now() - statSync(path).birthtimeMs < FRESH_MS
								? 'created in the last hour'
								: undefined;
			if (keep) {
				report.push(`keep ${path}: ${keep}`);
				continue;
			}
			const current = checkout(path);
			const linked = current?.root === path && current.linked ? current : undefined;
			const why = linked
				? `no open T3 thread${dirty(path) ? ', discarding its uncommitted changes' : ''}`
				: 'not a git worktree';
			report.push(`${dryRun ? 'would remove' : 'removed'} ${path} (${why})`);
			if (dryRun) continue;
			for (const pid of listeningPids(path)) run(['kill', pid], { allowFail: true });
			for (const device of ownedBy(path, sims)) removeSimulator(device);
			rmSync(path, { recursive: true, force: true });
			if (linked) run(['git', '-C', linked.main, 'worktree', 'prune'], { allowFail: true });
		}
	}
	return report;
}

export function teardown(cwd: string, target: string, { force = false, deleteBranch = false } = {}): string {
	const current = checkout(cwd);
	if (!current) throw new Error('Not inside a git checkout.');
	const entries = worktreeEntries(current.main).filter(entry => !entry.main);
	// git lists real paths, and a path through a symlink such as macOS's /tmp would otherwise match nothing.
	const path = existsSync(target) ? realpathSync(target) : target;
	const entry = entries.find(
		entry => entry.path === path || entry.branch === target || basename(entry.path) === target,
	);
	if (!entry) throw new Error(`${target} is not a worktree of ${current.main}.`);
	const prs = pullRequests(current.main);
	const pr = prs && mergedPrFor(current.main, prs, entry.head, [entry.branch, t3Branch(entry.path)]);
	if (!pr && !force)
		throw new Error(`No merged PR holds every commit of ${entry.path}. Pass --force to tear it down anyway.`);
	removeWorktree(current.main, entry, Boolean(pr) || deleteBranch);
	const main = defaultBranch(current.main);
	if (git(current.main, 'branch', '--show-current') === main)
		run(['git', '-C', current.main, 'pull', '--ff-only', 'origin', main], { allowFail: true });
	else run(['git', '-C', current.main, 'fetch', 'origin', `${main}:${main}`], { allowFail: true });
	return `Tore down ${entry.path}${pr ? ` (${pr.url})` : ''}.`;
}

/** What a thread leaves running when it settles: its servers, simulators, and build caches; then gc its repository. */
export function settle(cwd: string, { dryRun = false } = {}): string[] {
	const current = checkout(cwd);
	if (!current) return ['Not inside a git checkout.'];
	const report: string[] = [];
	if (current.linked) {
		for (const pid of listeningPids(current.root)) {
			report.push(`${dryRun ? 'would stop' : 'stopped'} server pid ${pid}`);
			if (!dryRun) run(['kill', pid], { allowFail: true });
		}
		for (const device of ownedBy(current.root).filter(device => device.state !== 'Shutdown')) {
			report.push(`${dryRun ? 'would shut down' : 'shut down'} simulator ${device.name}`);
			if (!dryRun) shutdown(device);
		}
		try {
			report.push(...cleanWorktreeCache(current.root, { dryRun }));
		} catch (error) {
			report.push(`kept build caches: ${(error as Error).message}`);
		}
	}
	report.push(...gc([current.main], { dryRun }), ...simulatorGc({ dryRun }), status());
	return report;
}

export const DEFAULT_RECLAIM_WATERMARK_GB = 25;

export type ReclaimDiskOptions = {
	minFreeGb?: number;
	keep?: string[];
	dryRun?: boolean;
	freeSpace?: () => number;
	stages?: { name: string; run: () => string[] }[];
};

/**
 * Reclaims local build caches and idle artifacts progressively whenever free disk falls below `minFreeGb`, stopping
 * as soon as free space recovers. Uses only local checks (no GitHub API calls), so pre-build hooks stay fast offline.
 */
export function reclaimDisk(options: ReclaimDiskOptions = {}): string[] {
	const minFreeGb = options.minFreeGb ?? DEFAULT_RECLAIM_WATERMARK_GB;
	const minFreeBytes = minFreeGb * 1024 ** 3;
	const dryRun = options.dryRun ?? false;
	const keep = options.keep ?? [];
	const freeSpace = options.freeSpace ?? freeBytes;

	const before = freeSpace();
	if (before >= minFreeBytes) {
		return [`Disk space OK: ${human(before)} free (watermark ${minFreeGb} GB).`];
	}

	const report: string[] = [
		`Low disk space: ${human(before)} free (below ${minFreeGb} GB watermark); ${dryRun ? 'checking' : 'reclaiming'} idle caches…`,
	];

	const stages =
		options.stages ??
		(() => {
			const opened = openFiles();
			const openPaths = () => opened;
			return [
				{
					name: 'idle worktree build caches',
					run: () => cleanIdleWorktreeCaches({ dryRun, minAgeMs: 0, keep, openPaths }),
				},
				{ name: 'unused simulators', run: () => simulatorGc({ dryRun }) },
				{ name: 'abandoned T3 worktrees', run: () => pruneAbandoned({ dryRun, keep }) },
				{
					name: 'stale repo build caches (>24h)',
					run: () => cleanStaleRepoCaches({ dryRun, minAgeMs: DAY_MS, keep, openPaths }),
				},
				{
					name: 'stale T3 artifacts and logs (>24h)',
					run: () => pruneStaleT3Artifacts({ dryRun, minAgeMs: DAY_MS, openPaths }),
				},
			];
		})();

	for (const stage of stages) {
		try {
			for (const line of stage.run()) report.push(`  [${stage.name}] ${line}`);
		} catch (error) {
			report.push(`  [${stage.name}] skipped: ${(error as Error).message}`);
		}
		if (!dryRun && freeSpace() >= minFreeBytes) break;
	}

	const after = freeSpace();
	report.push(
		dryRun
			? `Dry run finished: ${human(before)} free now (watermark ${minFreeGb} GB).`
			: `Reclaim finished: ${human(before)} → ${human(after)} free (${human(Math.max(0, after - before))} reclaimed).`,
	);
	return report;
}
