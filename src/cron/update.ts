import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { run } from '../utils/shell';
import { exec, type Step } from './steps';

const home = homedir();
const BREW_ENV = { HOMEBREW_NO_AUTO_UPDATE: '1', HOMEBREW_NO_ENV_HINTS: '1', HOMEBREW_NO_INSTALL_CLEANUP: '1' };
const TAILSCALE_SERVICE = 'system/homebrew.mxcl.tailscale';
const CODEX_APP = '/Applications/Codex.app';
const SKILLS_SETUP = path.join(home, 'code/ai-files/setup-skills.ts');

/**
 * A global `bun` package links over ~/.bun/bin/bun, the binary launchd starts this job with. On 2026-11-22 its
 * postinstall failed inside `bun update --global`, deleted that binary, and launchd silently stopped running the job.
 */
function assertNoGlobalBunPackage() {
	const manifest = path.join(home, '.bun/install/global/package.json');
	if (!existsSync(manifest)) return;
	const { dependencies = {} } = JSON.parse(readFileSync(manifest, 'utf8')) as { dependencies?: Record<string, string> };
	if ('bun' in dependencies)
		throw new Error(
			'`bun` is a global package, which replaces ~/.bun/bin/bun; run `bun remove --global bun`, reinstall bun with `curl -fsSL https://bun.sh/install | bash`, then `cron install`.',
		);
}

/** Formulae `brew upgrade` must not touch: each needs a restart the bulk upgrade doesn't do. */
const HELD: Record<string, string> = {
	tailscale: 'the tailscale step upgrades it and restarts its daemon',
	container:
		'upgrading restarts the home-mac apps; run `brew upgrade container && brew services restart container`, then `setup-repo-container start --name <app>` for each',
};

export const UPDATE_STEPS: Step[] = [
	{ name: 'homebrew', action: homebrew },
	{ name: 'tailscale', action: tailscale },
	{
		name: 'bun',
		action: dryRun => {
			assertNoGlobalBunPackage();
			exec(['bun', 'upgrade'], dryRun);
			exec(['bun', 'update', '--global', '--latest'], dryRun);
		},
	},
	// devrage is `npm link`ed from ~/code/devrage, so only the package managers are named.
	{
		name: 'npm globals',
		action: dryRun => exec(['npm', 'install', '--global', '--allow-scripts=pnpm', 'npm@latest', 'pnpm@latest'], dryRun),
	},
	{
		name: 'agent CLIs',
		action: dryRun => {
			exec(['claude', 'update'], dryRun);
			exec(['cursor-agent', 'update'], dryRun);
			exec(['grok', 'update'], dryRun);
			exec(['cua-driver', 'update', '--apply'], dryRun);
		},
	},
	{ name: 'codex app', action: codexApp },
	{ name: 'uv tools', action: dryRun => exec(['uv', 'tool', 'upgrade', '--all'], dryRun) },
	{ name: 'app store', action: dryRun => exec(['mas', 'upgrade'], dryRun) },
	{ name: 'skills and plugins', action: dryRun => exec([SKILLS_SETUP, ...(dryRun ? ['--dry-run'] : [])], false) },
];

function homebrew(dryRun: boolean): string[] {
	exec(['brew', 'update'], dryRun, BREW_ENV);
	const outdated = run(['brew', 'outdated', '--quiet'], { env: BREW_ENV }).split('\n').filter(Boolean);
	const upgrade = outdated.filter(name => !HELD[name]);
	if (upgrade.length) exec(['brew', 'upgrade', ...upgrade], dryRun, BREW_ENV);
	try {
		exec(['brew', 'cleanup', '--prune=all'], dryRun, BREW_ENV);
	} catch (error) {
		// tailscaled runs as root, so every replaced tailscale keg holds a root-owned binary brew can't delete.
		const kegs = (error as Error).message.match(/^\s+\/opt\/homebrew\/Cellar\/\S+$/gm);
		if (!kegs) throw error;
		console.log(
			`warning: brew can't delete root-owned old kegs; run \`sudo rm -rf ${kegs.map(keg => keg.trim()).join(' ')}\``,
		);
	}
	return outdated.filter(name => HELD[name]).map(name => `held ${name}: ${HELD[name]}`);
}

const tailscaleStatus = () =>
	JSON.parse(run(['/opt/homebrew/bin/tailscale', 'status', '--json'])) as {
		Version: string;
		BackendState: string;
		Self?: { ExitNodeOption?: boolean };
	};

// The daemon keeps running the old binary until it restarts, and this Mac is an exit node, so it has to come back.
function tailscale(dryRun: boolean): string[] {
	const check = Bun.spawnSync(['sudo', '-n', '-l', '/bin/launchctl', 'kickstart', '-k', TAILSCALE_SERVICE]);
	if (check.exitCode !== 0)
		throw new Error(
			`Restarting tailscale needs a passwordless sudo rule for \`/bin/launchctl kickstart -k ${TAILSCALE_SERVICE}\` (add it with \`sudo visudo -f /etc/sudoers.d/tailscale\`).`,
		);
	const running = tailscaleStatus().Version.split('-t')[0]!;
	exec(['brew', 'upgrade', '--formula', 'tailscale'], dryRun, BREW_ENV);
	if (dryRun) return [];
	const installed = run(['/opt/homebrew/bin/tailscale', 'version']).split('\n')[0]!;
	if (installed === running) return [`tailscale already running ${installed}`];
	run(['sudo', '-n', '/bin/launchctl', 'kickstart', '-k', TAILSCALE_SERVICE]);
	for (let attempt = 0; attempt < 30; attempt++) {
		Bun.sleepSync(2000);
		try {
			const status = tailscaleStatus();
			if (status.BackendState === 'Running' && status.Version.startsWith(installed) && status.Self?.ExitNodeOption)
				return [`tailscale ${running} → ${installed}; exit node online`];
		} catch {}
	}
	throw new Error(`tailscale ${installed} did not come back as an exit node within a minute of restarting`);
}

// The app updates itself through Sparkle, which only checks while the app runs.
function codexApp(dryRun: boolean): string[] {
	if (!existsSync(CODEX_APP)) return [`${CODEX_APP} is not installed`];
	const version = () =>
		run(['/usr/libexec/PlistBuddy', '-c', 'Print :CFBundleShortVersionString', `${CODEX_APP}/Contents/Info.plist`], {
			allowFail: true,
		});
	const before = version();
	if (dryRun) return [`would let Codex ${before} check for an update`];
	run(['defaults', 'write', 'com.openai.codex', 'SUEnableAutomaticChecks', '-bool', 'true']);
	run(['defaults', 'write', 'com.openai.codex', 'SUAutomaticallyUpdate', '-bool', 'true']);
	if (Bun.spawnSync(['pgrep', '-x', 'Codex']).exitCode === 0)
		return [`Codex ${before} is running, so Sparkle updates it on its own`];
	run(['open', '-gj', CODEX_APP]);
	Bun.sleepSync(120_000);
	run(['osascript', '-e', 'tell application id "com.openai.codex" to quit'], { allowFail: true });
	const after = version();
	return [after === before ? `Codex ${before} is current` : `Codex ${before} → ${after}`];
}
