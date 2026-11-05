import { expect, test } from 'bun:test';
import { type Io, type Pr, ship, TimeoutError } from './prShip';

const HEAD = 'abc1234def';
const SUMMARY_DONE = '<!-- codex-review-state:v1 {"code_review":{"status":"completed"}} -->';

/**
 * A GitHub on a fake clock. `durations` maps a command prefix (`gh pr merge`) to how long it takes, so a test can
 * make any phase slow. Commands honor `timeoutMs` the way `run` does: they burn the timeout, then throw.
 */
function fakeGitHub({
  checksDoneAt = 0,
  codexDoneAt = 0,
  durations = {},
  mergeable = 'MERGEABLE',
}: {
  checksDoneAt?: number;
  codexDoneAt?: number;
  durations?: Record<string, number>;
  mergeable?: string;
} = {}) {
  const start = Date.parse('2026-10-31T12:00:00Z');
  let now = start;
  let state = 'OPEN';
  const calls: string[] = [];
  const elapsed = () => now - start;
  const pr = (): Pr => ({
    number: 7,
    url: 'https://github.com/smirea/procrastimate/pull/7',
    state,
    headRefOid: HEAD,
    baseRefName: 'main',
    mergeable,
    statusCheckRollup: [
      elapsed() >= checksDoneAt
        ? { __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }
        : { __typename: 'CheckRun', name: 'ci', status: 'IN_PROGRESS' },
    ],
    comments: elapsed() >= codexDoneAt ? [{ body: SUMMARY_DONE }] : [],
  });
  const answer = (cmd: string): string => {
    if (cmd === 'git rev-parse HEAD') return HEAD;
    if (cmd.startsWith('gh repo view')) return 'smirea/procrastimate';
    if (cmd.startsWith('gh pr view')) return JSON.stringify(pr());
    if (cmd.startsWith('gh api graphql'))
      return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } });
    if (cmd.startsWith('gh pr merge')) {
      state = 'MERGED';
      return '';
    }
    throw new Error(`unexpected command: ${cmd}`);
  };
  const io: Io = {
    now: () => now,
    sleep: async ms => {
      now += ms;
    },
    run: (cmd, options = {}) => {
      const line = cmd.join(' ');
      calls.push(line);
      const duration = Object.entries(durations).find(([prefix]) => line.startsWith(prefix))?.[1] ?? 1000;
      if (options.timeoutMs !== undefined && duration > options.timeoutMs) {
        now += options.timeoutMs;
        throw new TimeoutError(`\`${line}\` ran past ${options.timeoutMs}ms`);
      }
      now += duration;
      return answer(line);
    },
    log: () => {},
  };
  return { io, calls, elapsed };
}

const BUDGET_MS = 500_000;

for (const [phase, durations, checksDoneAt] of [
  ['the merge', { 'gh pr merge': 120_000 }, 470_000],
  ['a CI poll', { 'gh pr view': 90_000 }, 480_000],
  ['the review-thread poll', { 'gh api graphql': 200_000 }, 300_000],
  ['the first look at the PR', { 'gh pr view': 900_000 }, 0],
] as const) {
  test(`a slow ${phase} still exits before the budget runs out`, async () => {
    const github = fakeGitHub({ checksDoneAt, durations });
    const verdict = await ship(github.io, { merge: true, budgetMs: BUDGET_MS });
    expect(github.elapsed()).toBeLessThanOrEqual(BUDGET_MS);
    expect(verdict.code).toBe(3);
    expect(verdict.message).toContain('Rerun');
  });
}

test('merges a green PR and exits 0', async () => {
  const github = fakeGitHub({ checksDoneAt: 60_000 });
  expect(await ship(github.io, { merge: true, budgetMs: BUDGET_MS })).toEqual({
    code: 0,
    message: 'Merged: https://github.com/smirea/procrastimate/pull/7',
  });
});

test('waits while the Codex review is pending, then exits 3 to rerun', async () => {
  const github = fakeGitHub({ codexDoneAt: Infinity });
  const verdict = await ship(github.io, { merge: true, budgetMs: BUDGET_MS });
  expect(github.calls.filter(call => call.startsWith('gh pr merge'))).toEqual([]);
  expect(verdict).toEqual({ code: 3, message: 'Still waiting on Codex review. Rerun.' });
});

test('a conflict names the PR base branch and exits 2', async () => {
  const github = fakeGitHub({ mergeable: 'CONFLICTING' });
  expect(await ship(github.io, { merge: true, budgetMs: BUDGET_MS })).toEqual({
    code: 2,
    message:
      'https://github.com/smirea/procrastimate/pull/7 conflicts with main, so CI will not run. Rebase onto origin/main, push, rerun.',
  });
});
