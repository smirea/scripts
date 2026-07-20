export interface ScriptCommand {
  name: string;
  source: string;
}

export const SCRIPT_COMMANDS = [
  { name: 'gai', source: 'src/git-commit-ai.ts' },
  { name: 'git-ai-cim', source: 'src/git-commit-ai.ts' },
  { name: 'git-worktree', source: 'src/git-worktree.ts' },
  { name: 'git-invite-ai-to-repos', source: 'src/git-invite-ai-to-repos.ts' },
  { name: 'wt', source: 'src/git-worktree.ts' },
  { name: 'whoop-pull', source: 'src/whoop.ts' },
  { name: 'macrofactor', source: 'src/macrofactor.ts' },
  { name: 'era-fit', source: 'src/era-fit/index.ts' },
  { name: 'workouts', source: 'src/workouts.ts' },
  { name: 'voice-memo-parse', source: 'src/voice-memo-parse.ts' },
  { name: 'anylist', source: 'src/anylist.ts' },
  { name: 'convex-manage', source: 'src/convex-manage.ts' },
  { name: 'google-maps', source: 'src/google-maps.ts' },
  { name: 'cookunity', source: 'src/cookunity.ts' },
  { name: 'bgstats', source: 'src/bgstats.ts' },
  { name: 'clocktracker', source: 'src/clocktracker.ts' },
  { name: 'email-inbox', source: 'src/email-inbox.ts' },
] as const satisfies ScriptCommand[];

export function findScriptCommand(name: string): ScriptCommand | undefined {
  return SCRIPT_COMMANDS.find((command) => command.name === name);
}
