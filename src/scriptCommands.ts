export type ScriptCommand =
	| {
			name: string;
			source: string;
			/** One-sentence description for `ai-files/GLOBAL_AGENTS.md`, or `null` if the name is self-explanatory. */
			description: string | null;
			/** Left out of `ai-files/GLOBAL_AGENTS.md` so agents aren't nudged toward a script meant only for Stefan. */
			hiddenFromAgents?: true;
	  }
	| {
			name: string;
			source: string;
			aliasOf: string;
	  };

export const SCRIPT_COMMANDS = [
	{
		name: 'gai',
		source: 'src/git-commit-ai.ts',
		description: 'Generate a conventional commit message with Gemini or commit with AI attribution.',
		hiddenFromAgents: true,
	},
	{ name: 'git-ai-cim', source: 'src/git-commit-ai.ts', aliasOf: 'gai' },
	{
		name: 'git-worktree',
		source: 'src/git-worktree.ts',
		description: 'Create, list, switch, merge, and remove personal git worktrees under ~/worktrees.',
	},
	{ name: 'wt', source: 'src/git-worktree.ts', aliasOf: 'git-worktree' },
	{
		name: 'agent-t3-worktree',
		source: 'src/agent-t3-worktree.ts',
		description: 'Set up, check, settle, gc, and tear down T3 Code agent worktrees.',
	},
	{
		name: 'agent-simulator',
		source: 'src/agent-simulator.ts',
		description: 'Claim, throttle, stop, and garbage-collect per-worktree iOS simulators.',
	},
	{
		name: 'pr-ship',
		source: 'src/pr-ship.ts',
		description: "Drive the current branch's open PR through CI and Codex review to merge.",
	},
	{
		name: 'procrastimate',
		source: 'src/procrastimate.ts',
		description: 'Query and update ProcrastiMate tasks, comments, labels, and links via the agent API.',
	},
	{
		name: 'git-invite-ai-to-repos',
		source: 'src/git-invite-ai-to-repos.ts',
		description: 'Invite the AI GitHub account to owner repos, accept invites, and mute its notifications.',
	},
	{
		name: 'whoop-pull',
		source: 'src/whoop.ts',
		description: 'Export WHOOP strain, recovery, sleep, workout, and app-API metrics.',
	},
	{
		name: 'garmin',
		source: 'src/garmin.ts',
		description: 'Pull Garmin Connect daily and intraday metrics, compare strain with WHOOP, and manage activities.',
	},
	{
		name: 'macrofactor',
		source: 'src/macrofactor.ts',
		description: 'Export MacroFactor nutrition logs from the local macOS app cache.',
	},
	{
		name: 'workouts',
		source: 'src/workouts.ts',
		description: 'Export and log MacroFactor Workouts history and programs.',
	},
	{
		name: 'voice-memo-parse',
		source: 'src/voice-memo-parse.ts',
		description: 'Export Apple Voice Memos with transcripts and Gemini highlights.',
	},
	{
		name: 'anylist',
		source: 'src/anylist.ts',
		description: 'Read and edit AnyList shopping lists and favorites.',
	},
	{
		name: 'convex-manage',
		source: 'src/convex-manage.ts',
		description: 'Create, restart, open dashboards for, and delete local self-hosted Convex deployments.',
	},
	{
		name: 'google-maps',
		source: 'src/google-maps.ts',
		description: 'Search Google Places and fetch place details and reviews as JSON.',
	},
	{
		name: 'cookunity',
		source: 'src/cookunity.ts',
		description: 'Fetch CookUnity meal catalogs and macros for a delivery date.',
	},
	{
		name: '222',
		source: 'src/222.ts',
		description: 'List upcoming 222 social event invites and available events.',
	},
	{
		name: 'airbnb',
		source: 'airbnb.ts',
		description: 'Read Airbnb reservations and wishlists as Markdown.',
	},
	{
		name: 'bgstats',
		source: 'src/bgstats.ts',
		description: 'Read, record, and sync board game plays in the local BG Stats database.',
	},
	{
		name: 'clocktracker',
		source: 'src/clocktracker.ts',
		description: 'Fetch Blood on the Clocktower plays from clocktracker.app and optionally sync them to BG Stats.',
	},
	{
		name: 'cron-bgstats-sync',
		source: 'src/cron-bgstats-sync.ts',
		description: 'Daily cron job that syncs new ClockTracker plays into BG Stats.',
	},
	{
		name: 'email-inbox',
		source: 'src/email-inbox.ts',
		description: 'List and read emails saved by the email-save Worker.',
	},
	{
		name: 'sms-inbox',
		source: 'src/sms-inbox.ts',
		description: 'List and read saved SMS messages from the sms-inbox API.',
	},
	{
		name: 'iphone-deploy',
		source: 'src/iphone-deploy.ts',
		description: 'Build Release iOS apps to install on a paired iPhone or upload an install link.',
	},
	{
		name: 'x',
		source: 'src/x.ts',
		description: 'Read X posts, threads, profiles, timelines, bookmarks, and recent search via the official API.',
	},
	{
		name: 'repo-sync',
		source: 'src/repo-sync.ts',
		description: 'Sync ~/code git repos across peer Macs, register them in T3 Code, and fast-forward them.',
	},
	{
		name: 'localias-peer',
		source: 'src/localias-peer.ts',
		description: "Expose a peer Mac's localias dev servers locally over an SSH tunnel.",
	},
	{
		name: 'fork-sync',
		source: 'src/fork-sync.ts',
		description: 'Rebase configured third-party forks onto upstream, force-push, and reinstall them.',
	},
	{
		name: 'cron',
		source: 'src/cron.ts',
		description: 'Run nightly Mac cleanup (worktrees, containers, caches, Trash) and tool/CLI/skill updates.',
	},
] as const satisfies ScriptCommand[];

export function findScriptCommand(name: string): ScriptCommand | undefined {
	return SCRIPT_COMMANDS.find(command => command.name === name);
}
