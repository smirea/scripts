#!/usr/bin/env bun
import { createScript } from './utils/createScript';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const home = process.env.HOME;
if (!home) throw new Error('HOME is not set.');

const LOG_FILE = path.join(home, 'Library', 'Logs', 'tinybar-peer.log');
const LAUNCHD_LABEL = 'com.stefan.tinybar-peer';
const PLIST = path.join(home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
const RSYNC = '/usr/bin/rsync';
const SSH = 'ssh -o RemoteCommand=none -o RequestTTY=no -o BatchMode=yes -o ConnectTimeout=10';

interface Options { peer: string; name: string }

/**
 * Tinybar reads logs from every `~/.claude*` folder's `projects` and every `~/.codex*` folder's `sessions` without being
 * told, so a mirror named like that is counted as if the sessions ran here. Archived Codex logs are zstd, which Tinybar
 * can't read, so only `.jsonl` is copied.
 */
export function mirrors(options: Options): { from: string; to: string }[] {
  return [
    { from: '.claude/projects/', to: path.join(home!, `.claude-${options.name}`, 'projects/') },
    { from: '.codex/sessions/', to: path.join(home!, `.codex-${options.name}`, 'sessions/') },
  ];
}

/**
 * `--inplace` keeps each log's inode while it grows: Tinybar resumes a log from its cursor only for the same inode, and a
 * new one makes it reread the file. `--delete` mirrors the peer's own log cleanup; Tinybar keeps daily totals after a log goes.
 */
export function rsyncArgs(peer: string, from: string, to: string, dryRun: boolean): string[] {
  return [
    RSYNC, '-rt', '--inplace', '--delete', '--prune-empty-dirs', '-e', SSH,
    '--include=*/', '--include=*.jsonl', '--exclude=*',
    ...(dryRun ? ['--dry-run', '--itemize-changes'] : []),
    `${peer}:${from}`, to,
  ];
}

if (import.meta.main) {
  const peerOptions = (command: ReturnType<typeof createScript>) => command
    .option('peer', { type: 'string', demandOption: true, describe: 'SSH host of the other machine, as in ~/.ssh/config (for example mini-ts).' })
    .option('name', { type: 'string', default: 'mini', describe: 'Suffix of the local mirrors: ~/.claude-<name> and ~/.codex-<name>.' })
    .check(argv => {
      if (!/^[a-z0-9-]+$/.test(argv.name)) throw new Error(`--name must be lowercase letters, digits, or dashes; got "${argv.name}".`);
      return true;
    });

  void createScript('tinybar-peer')
    .usage(`$0 <command>\n\nCounts another machine's Claude Code and Codex usage in this machine's Tinybar. Tinybar's limits already come from the account, but its tokens, cost and stats come only from logs on this machine, so this mirrors the peer's ~/.claude/projects and ~/.codex/sessions into ~/.claude-<name>/projects and ~/.codex-<name>/sessions, which Tinybar reads on its own.`)
    .parserConfiguration({ 'strip-aliased': true, 'strip-dashed': true })
    .command(
      'pull',
      'Mirror the peer\'s logs once.',
      command => peerOptions(command).option('dry-run', { type: 'boolean', default: false, describe: 'List the files that would change, without copying.' }),
      argv => pull({ peer: argv.peer, name: argv.name }, argv.dryRun),
    )
    .command(
      'install',
      `Install a launchd agent that runs \`pull\` every 10 minutes. Logs: ${LOG_FILE}`,
      command => peerOptions(command).option('dry-run', { type: 'boolean', default: false, describe: 'Print the plist without installing it.' }),
      argv => install({ peer: argv.peer, name: argv.name }, argv.dryRun),
    )
    .command(
      'uninstall',
      'Remove the launchd agent. The mirrors stay; trash ~/.claude-<name> and ~/.codex-<name> to stop Tinybar reading them.',
      command => command.option('dry-run', { type: 'boolean', default: false, describe: 'Print what would be removed without removing it.' }),
      argv => uninstall(argv.dryRun),
    )
    .strictCommands()
    .demandCommand(1, 'Choose pull, install, or uninstall.')
    .recommendCommands()
    .parseAsync();
}

async function pull(options: Options, dryRun: boolean): Promise<void> {
  const failures: string[] = [];
  for (const { from, to } of mirrors(options)) {
    if (!dryRun) mkdirSync(to, { recursive: true });
    const result = await exec(rsyncArgs(options.peer, from, to, dryRun), 30 * 60_000);
    if (dryRun) console.log(`${options.peer}:${from} -> ${to}\n${result.output || '(up to date)'}`);
    if (result.code !== 0) failures.push(`${options.peer}:${from} -> ${to} (rsync exit ${result.code}):\n${result.output}`);
  }
  if (failures.length) throw new Error(`Could not mirror from ${options.peer}. Check that \`ssh -o RemoteCommand=none ${options.peer} true\` works without a prompt.\n${failures.join('\n')}`);
  if (!dryRun) log(`pulled ${options.peer}`);
}

async function install(options: Options, dryRun: boolean): Promise<void> {
  const bun = Bun.which('bun');
  if (!bun) throw new Error('`bun` is not on PATH; install it (curl -fsSL https://bun.sh/install | bash) and rerun install.');
  const args = [bun, '--no-env-file', import.meta.path, 'pull', '--peer', options.peer, '--name', options.name];
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
  <key>StartInterval</key>
  <integer>600</integer>
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
    <string>${path.dirname(bun)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
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
  for (let i = 0; i < 50 && (await exec(['launchctl', 'print', `${domain}/${LAUNCHD_LABEL}`])).code === 0; i++) await Bun.sleep(200);
  const bootstrap = await exec(['launchctl', 'bootstrap', domain, PLIST]);
  if (bootstrap.code !== 0) throw new Error(`launchctl bootstrap ${domain} ${PLIST} failed:\n${bootstrap.output}`);
  process.stdout.write(`Installed ${PLIST}: pulls ${options.peer}'s logs into ~/.claude-${options.name} and ~/.codex-${options.name} every 10 minutes. Logs: ${LOG_FILE}\n`);
}

async function uninstall(dryRun: boolean): Promise<void> {
  const domain = `gui/${process.getuid!()}`;
  if (dryRun) {
    console.log(`[dry-run] launchctl bootout ${domain}/${LAUNCHD_LABEL} and trash ${PLIST}`);
    return;
  }
  await exec(['launchctl', 'bootout', `${domain}/${LAUNCHD_LABEL}`]);
  await exec(['trash', PLIST]);
  console.log('Removed the launchd agent.');
}

async function exec(cmd: string[], timeoutMs = 60_000) {
  const proc = Bun.spawn(cmd, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: timeoutMs });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, output: [stdout.trim(), stderr.trim()].filter(Boolean).join('\n') };
}

function log(message: string): void {
  process.stderr.write(`${new Date().toISOString()} ${message}\n`);
}
