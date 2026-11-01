import { spawnSync } from 'node:child_process';

import { gitEnvironment } from './worktreeCache';

export type RunOptions = { allowFail?: boolean; cwd?: string; inherit?: boolean; env?: Record<string, string> };

/** Runs a command to completion and returns its trimmed stdout. A failure names the command and shows its output. */
export function run(cmd: string[], { allowFail = false, cwd, inherit = false, env }: RunOptions = {}): string {
  const result = spawnSync(cmd[0]!, cmd.slice(1), {
    cwd,
    encoding: 'utf8',
    env: { ...gitEnvironment(), ...env },
    maxBuffer: 64 * 1024 * 1024,
    stdio: inherit ? ['ignore', 'inherit', 'inherit'] : 'pipe',
  });
  if (result.status !== 0) {
    if (allowFail) return '';
    throw new Error(`\`${cmd.join(' ')}\` failed (exit ${result.status ?? result.signal})\n${result.stderr ?? ''}${result.stdout ?? ''}`.trim());
  }
  return (result.stdout ?? '').trim();
}

export const git = (cwd: string, ...args: string[]) => run(['git', '-C', cwd, ...args]);

export type Checkout = { root: string; main: string; linked: boolean };

/** The checkout `cwd` is in, or undefined outside a git repository. */
export function checkout(cwd: string): Checkout | undefined {
  const root = run(['git', '-C', cwd, 'rev-parse', '--show-toplevel'], { allowFail: true });
  if (!root) return undefined;
  const gitDir = git(root, 'rev-parse', '--path-format=absolute', '--git-dir');
  const commonDir = git(root, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const main = commonDir.endsWith('/.git') ? commonDir.slice(0, -'/.git'.length) : root;
  return { root, main, linked: gitDir !== commonDir };
}
