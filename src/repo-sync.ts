#!/usr/bin/env bun
import { createScript } from './utils/createScript';
import { Database } from 'bun:sqlite';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';

const home = process.env.HOME;
if (!home) throw new Error('HOME is not set.');

const ROOT = path.join(home, 'code');
const T3_BIN = path.join(home, '.t3', 'bin', 't3');
const T3_DB = path.join(home, '.t3', 'userdata', 'statev2.sqlite');
const LOG_FILE = path.join(home, 'Library', 'Logs', 'repo-sync.log');
const LAUNCHD_LABEL = 'com.stefan.repo-sync';
const PLIST = path.join(home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
const INTERVAL_SECONDS = 300;
const PARALLELISM = 8;
const MACHINE = Bun.spawnSync(['scutil', '--get', 'ComputerName']).stdout.toString().trim() || hostname();

export type RepoKey = string & { readonly __brand: 'RepoKey' };
export interface Repo { name: string; path: string; key: RepoKey; cloneUrl: string }
export interface Inventory { machine: string; repos: Repo[]; remoteless: { name: string; path: string }[] }
interface Issue { repo: string; kind: string; detail: string }
interface CloneReport { cloned: string[]; registered: string[]; issues: Issue[] }

/** Normalizes a remote so ssh/https spellings and `github.com-<alias>` ssh hosts of one repo compare equal. */
export function parseRemote(url: string): { key: RepoKey; cloneUrl: string } | undefined {
  const match = url.trim().match(/^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/]+@)?([^/:]+)(?::\d+)?[:/](.+?)(?:\.git)?\/?$/i);
  if (!match) return undefined;
  const host = match[1]!.toLowerCase().replace(/^github\.com-.+$/, 'github.com');
  const repoPath = match[2]!;
  return {
    key: `${host}/${repoPath.toLowerCase()}` as RepoKey,
    cloneUrl: host === 'github.com' ? `git@github.com:${repoPath}.git` : url.trim(),
  };
}

if (import.meta.main) {
  void createScript('repo-sync')
    .usage('$0 <command>\n\nKeeps every git repo in ~/code that has a remote cloned, registered as a T3 Code project, and fast-forwarded on this machine and its peer.')
    .parserConfiguration({ 'strip-aliased': true, 'strip-dashed': true })
    .command(
      'run',
      'Exchange missing repos with --peer, register unregistered repos in T3 Code, and fast-forward repos that are behind.',
      command => command
        .option('peer', { type: 'string', describe: 'SSH host of the other machine (for example mini-ts). Omit to sync this machine only.' })
        .option('exclude', { type: 'array', string: true, default: [] as string[], describe: 'Repo folder names or keys (github.com/owner/name) never cloned to either machine.' })
        .option('dry-run', { type: 'boolean', default: false, describe: 'Read both machines and print the clones, registrations, and pulls without making them.' }),
      argv => runSync({ peer: argv.peer, exclude: argv.exclude as string[], dryRun: argv.dryRun }),
    )
    .command(
      'inventory',
      'Print this machine\'s repos as JSON (what `run --peer` reads over SSH).',
      {},
      async () => {
        process.stdout.write(`${JSON.stringify(await inventory())}\n`);
      },
    )
    .command(
      'clone',
      'Clone the repos in the JSON Repo[] on stdin into ~/code and register them in T3 Code. Prints a JSON report.',
      command => command.option('dry-run', { type: 'boolean', default: false, describe: 'Print what would be cloned without cloning.' }),
      async argv => {
        const repos = JSON.parse(await Bun.stdin.text()) as Repo[];
        process.stdout.write(`${JSON.stringify(await cloneRepos(repos, argv.dryRun))}\n`);
      },
    )
    .command(
      'install',
      `Install the launchd agent that runs \`run\` every ${INTERVAL_SECONDS / 60} minutes and on wake. Logs: ${LOG_FILE}`,
      command => command
        .option('peer', { type: 'string', describe: 'SSH host of the other machine. Set it on one machine only (the one that can SSH to the other).' })
        .option('dry-run', { type: 'boolean', default: false, describe: 'Print the plist without installing it.' }),
      argv => install(argv.peer, argv.dryRun),
    )
    .strictCommands()
    .demandCommand(1, 'Choose run, inventory, clone, or install.')
    .recommendCommands()
    .parseAsync();
}

async function runSync(options: { peer?: string; exclude: string[]; dryRun: boolean }): Promise<void> {
  requireT3();
  const prefix = options.dryRun ? '[dry-run] ' : '';
  const issues: Issue[] = [];
  const excluded = (repo: Repo) => options.exclude.includes(repo.name) || options.exclude.includes(repo.key);
  let local = await inventory();

  if (options.peer) {
    const peerInventory = await callPeer(options.peer, ['inventory']);
    if (peerInventory === 'unreachable') {
      log(`peer ${options.peer} unreachable; syncing this machine only`);
    } else if (peerInventory.code !== 0) {
      issues.push({ repo: options.peer, kind: 'peer inventory failed', detail: peerInventory.output });
    } else {
      const peer = JSON.parse(peerInventory.output) as Inventory;
      const localKeys = new Set(local.repos.map(repo => repo.key));
      const peerKeys = new Set(peer.repos.map(repo => repo.key));
      const toLocal = uniqueByKey(peer.repos.filter(repo => !localKeys.has(repo.key) && !excluded(repo)));
      const toPeer = uniqueByKey(local.repos.filter(repo => !peerKeys.has(repo.key) && !excluded(repo)));

      if (toLocal.length) {
        const report = await cloneRepos(toLocal, options.dryRun);
        for (const name of report.cloned) log(`${prefix}cloned from ${peer.machine}: ${name}`);
        issues.push(...report.issues);
        local = await inventory();
      }
      if (toPeer.length) {
        const result = await callPeer(options.peer, ['clone', ...(options.dryRun ? ['--dry-run'] : [])], JSON.stringify(toPeer));
        if (result === 'unreachable' || result.code !== 0) {
          issues.push({ repo: options.peer, kind: 'peer clone failed', detail: result === 'unreachable' ? 'unreachable' : result.output });
        } else {
          const report = JSON.parse(result.output) as CloneReport;
          for (const name of report.cloned) log(`${prefix}cloned on ${peer.machine}: ${name}`);
          issues.push(...report.issues.map(issue => ({ ...issue, repo: `${peer.machine}:${issue.repo}` })));
        }
      }
    }
  }

  const registered = await registerAll(local.repos, options.dryRun);
  for (const name of registered.registered) log(`${prefix}registered in T3: ${name}`);
  issues.push(...registered.issues);

  const pulls = await pool(local.repos, repo => fastForward(repo, options.dryRun));
  for (const pull of pulls) {
    if (pull.updated) log(`${prefix}updated ${pull.repo}: ${pull.updated}`);
    if (pull.issue) issues.push(pull.issue);
  }

  for (const issue of issues) log(`ISSUE ${issue.repo}: ${issue.kind}${issue.detail ? `\n${indent(issue.detail)}` : ''}`);
  log(`done: ${local.repos.length} repos, ${local.remoteless.length} skipped for having no remote (${local.remoteless.map(repo => repo.name).join(', ') || 'none'}), ${issues.length} issues`);
  if (issues.length) process.exitCode = 1;
}

async function inventory(): Promise<Inventory> {
  // Only ~/code: launchd jobs can't read TCC-protected folders like ~/Documents, and git calls there hang on the privacy prompt.
  const roots = readdirSync(ROOT, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(path.join(ROOT, entry.name, '.git')))
    .map(entry => path.join(ROOT, entry.name));

  const repos: Repo[] = [];
  const remoteless: Inventory['remoteless'] = [];
  await pool(roots, async root => {
    const name = path.basename(root);
    const remote = await exec(['git', '-C', root, 'remote', 'get-url', 'origin']);
    const parsed = remote.code === 0 ? parseRemote(remote.stdout) : undefined;
    if (parsed) repos.push({ name, path: root, ...parsed });
    else remoteless.push({ name, path: root });
  });
  return {
    machine: MACHINE,
    repos: repos.sort((a, b) => a.name.localeCompare(b.name)),
    remoteless: remoteless.sort((a, b) => a.name.localeCompare(b.name)),
  };
}

async function cloneRepos(repos: Repo[], dryRun: boolean): Promise<CloneReport> {
  requireT3();
  const report: CloneReport = { cloned: [], registered: [], issues: [] };
  const toRegister: { name: string; path: string }[] = [];
  for (const repo of repos) {
    const destination = path.join(ROOT, repo.name);
    if (existsSync(destination)) {
      const remote = await exec(['git', '-C', destination, 'remote', 'get-url', 'origin']);
      if (remote.code !== 0 || parseRemote(remote.stdout)?.key !== repo.key) {
        report.issues.push({ repo: repo.name, kind: `~/code/${repo.name} exists but is not a clone of ${repo.key}`, detail: 'Rename one of the two folders so both machines use the same name.' });
      }
      continue;
    }
    if (dryRun) {
      report.cloned.push(repo.name);
      continue;
    }
    const clone = await exec(['git', 'clone', '--quiet', repo.cloneUrl, destination], { timeoutMs: 30 * 60_000 });
    if (clone.code !== 0) {
      report.issues.push({ repo: repo.name, kind: 'clone failed', detail: clone.output });
      continue;
    }
    report.cloned.push(repo.name);
    toRegister.push({ name: repo.name, path: destination });
  }
  const registered = await registerAll(toRegister, dryRun);
  report.registered.push(...registered.registered);
  report.issues.push(...registered.issues);
  return report;
}

/** Registers each checkout T3 Code doesn't know. A checkout whose project was deleted in T3 stays unregistered. */
async function registerAll(checkouts: { name: string; path: string }[], dryRun: boolean): Promise<{ registered: string[]; issues: Issue[] }> {
  const t3 = readT3Projects();
  const result = { registered: [] as string[], issues: [] as Issue[] };
  for (const checkout of checkouts) {
    if (t3.active.has(checkout.path) || t3.deleted.has(checkout.path)) continue;
    if (dryRun) {
      result.registered.push(checkout.name);
      continue;
    }
    const added = await exec([T3_BIN, 'project', 'add', checkout.path]);
    if (added.code === 0) result.registered.push(checkout.name);
    else if (!added.output.includes('ProjectAlreadyExistsError')) {
      result.issues.push({ repo: checkout.name, kind: 'T3 registration failed', detail: added.output });
    }
  }
  return result;
}

async function fastForward(repo: Repo, dryRun: boolean): Promise<{ repo: string; updated?: string; issue?: Issue }> {
  const git = (...args: string[]) => exec(['git', '-C', repo.path, ...args]);
  const issue = (kind: string, detail = '') => ({ repo: repo.name, issue: { repo: repo.name, kind, detail } });
  if ((await git('symbolic-ref', '-q', 'HEAD')).code !== 0) return { repo: repo.name };
  if ((await git('rev-parse', '--abbrev-ref', '@{u}')).code !== 0) return { repo: repo.name };
  if (!dryRun) {
    const fetch = await git('fetch', '--prune', '--quiet');
    if (fetch.code !== 0) return issue('fetch failed', fetch.output);
  }
  const counts = await git('rev-list', '--left-right', '--count', 'HEAD...@{u}');
  const [ahead = 0, behind = 0] = counts.stdout.split(/\s+/).map(Number);
  if (behind === 0) return { repo: repo.name };
  if (ahead > 0) return issue(`diverged from upstream (${ahead} ahead, ${behind} behind)`, 'Rebase or merge by hand; repo-sync only fast-forwards.');
  if (dryRun) return { repo: repo.name, updated: `${behind} commits behind` };
  const before = (await git('rev-parse', '--short', 'HEAD')).stdout;
  const merge = await git('merge', '--ff-only', '--quiet', '@{u}');
  if (merge.code !== 0) return issue('fast-forward failed', merge.output);
  return { repo: repo.name, updated: `${before} -> ${(await git('rev-parse', '--short', 'HEAD')).stdout} (${behind} commits)` };
}

function readT3Projects(): { active: Set<string>; deleted: Set<string> } {
  const db = new Database(T3_DB, { readonly: true });
  try {
    const rows = db.query('select workspace_root as root, deleted_at as deletedAt from projection_projects').all() as { root: string; deletedAt: string | null }[];
    const active = new Set(rows.filter(row => !row.deletedAt).map(row => row.root));
    const deleted = new Set(rows.filter(row => row.deletedAt && !active.has(row.root)).map(row => row.root));
    return { active, deleted };
  } catch (error) {
    throw new Error(`Could not read T3 Code projects from ${T3_DB} (did the T3 schema change?): ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    db.close();
  }
}

function requireT3(): void {
  for (const required of [T3_BIN, T3_DB]) {
    if (!existsSync(required)) throw new Error(`${required} is missing; install T3 Code and launch it once on this machine.`);
  }
}

type PeerResult = { code: number; output: string } | 'unreachable';

async function callPeer(peer: string, args: string[], input?: string): Promise<PeerResult> {
  const remote = `"$HOME/.bun/bin/bun" --no-env-file "$HOME/code/scripts/src/repo-sync.ts" ${args.join(' ')}`;
  const result = await exec(
    ['ssh', '-o', 'RemoteCommand=none', '-o', 'RequestTTY=no', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', peer, remote],
    { input, timeoutMs: 60 * 60_000 },
  );
  if (result.code === 255) return 'unreachable';
  return { code: result.code, output: result.code === 0 ? result.stdout : result.output };
}

async function install(peer: string | undefined, dryRun: boolean): Promise<void> {
  requireT3();
  // process.execPath can be bun's internal bun.exe, which leaves `bun` off PATH for the ~/bin wrappers the job runs.
  const bun = Bun.which('bun');
  if (!bun) throw new Error('`bun` is not on PATH; install it (curl -fsSL https://bun.sh/install | bash) and rerun install.');
  const pathEnv = [path.dirname(bun), path.join(home!, 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
  const args = [bun, '--no-env-file', import.meta.path, 'run', ...(peer ? ['--peer', peer] : [])];
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
  <key>WorkingDirectory</key>
  <string>${ROOT}</string>
  <key>StartInterval</key>
  <integer>${INTERVAL_SECONDS}</integer>
  <key>RunAtLoad</key>
  <true/>
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
  const bootstrap = await exec(['launchctl', 'bootstrap', domain, PLIST]);
  if (bootstrap.code !== 0) throw new Error(`launchctl bootstrap ${domain} ${PLIST} failed:\n${bootstrap.output}`);
  process.stdout.write(`Installed ${PLIST} (every ${INTERVAL_SECONDS / 60} min${peer ? `, peer ${peer}` : ''}). Logs: ${LOG_FILE}\n`);
}

async function exec(cmd: string[], options: { cwd?: string; input?: string; timeoutMs?: number } = {}) {
  const proc = Bun.spawn(cmd, {
    cwd: options.cwd,
    stdin: options.input === undefined ? 'ignore' : new TextEncoder().encode(options.input),
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: options.timeoutMs ?? 120_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o ConnectTimeout=15' },
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout: stdout.trim(), stderr: stderr.trim(), output: [stdout.trim(), stderr.trim()].filter(Boolean).join('\n') };
}

async function pool<T, R>(items: T[], worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(PARALLELISM, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index]!);
    }
  }));
  return results;
}

function uniqueByKey(repos: Repo[]): Repo[] {
  return [...new Map(repos.map(repo => [repo.key, repo])).values()];
}

function log(message: string): void {
  process.stderr.write(`${new Date().toISOString()} ${message}\n`);
}

function indent(text: string): string {
  return text.split('\n').map(line => `    ${line}`).join('\n');
}
