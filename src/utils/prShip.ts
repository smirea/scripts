import { spawnSync } from 'node:child_process';

const POLL_MS = 20_000;
const EXIT_RESERVE_MS = 2_000;

type Check = {
  __typename: string;
  name?: string;
  context?: string;
  status?: string;
  conclusion?: string;
  state?: string;
  detailsUrl?: string;
  targetUrl?: string;
};
export type Pr = {
  number: number;
  url: string;
  state: string;
  headRefOid: string;
  baseRefName: string;
  mergeable: string;
  statusCheckRollup: Check[];
  comments: { body: string }[];
};

export type Io = {
  now(): number;
  sleep(ms: number): Promise<void>;
  run(cmd: string[], options?: { timeoutMs?: number }): string;
  log(line: string): void;
};
export type Verdict = { code: 0 | 1 | 2 | 3; message: string };

export class TimeoutError extends Error {}

/** Runs a command and answers its trimmed stdout, killing it after `timeoutMs` with a `TimeoutError`. */
export function runBounded(cmd: string[], { timeoutMs }: { timeoutMs?: number } = {}): string {
  const result = spawnSync(cmd[0]!, cmd.slice(1), { encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024 });
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') throw new TimeoutError(`\`${cmd.join(' ')}\` ran past ${timeoutMs}ms`);
  if (result.status !== 0) throw new Error(`\`${cmd.join(' ')}\` failed\n${result.stderr ?? ''}${result.stdout ?? ''}`);
  return (result.stdout ?? '').trim();
}

class Exit extends Error {
  constructor(readonly verdict: Verdict) {
    super(verdict.message);
  }
}
function exit(code: Verdict['code'], message: string): never {
  throw new Exit({ code, message });
}

function checks(pr: Pr) {
  const all = pr.statusCheckRollup.map(check => ({
    name: check.name ?? check.context ?? '?',
    done: check.__typename === 'StatusContext' ? check.state !== 'PENDING' : check.status === 'COMPLETED',
    ok: ['SUCCESS', 'SKIPPED', 'NEUTRAL'].includes(check.conclusion ?? check.state ?? ''),
    url: check.detailsUrl ?? check.targetUrl ?? '',
  }));
  return { all, failed: all.filter(check => check.done && !check.ok), pending: all.filter(check => !check.done) };
}

// The summary's has_unresolved_findings never clears after the threads resolve, so findings come from the threads.
function codexRunning(pr: Pr): boolean {
  const summary = pr.comments.find(comment => comment.body.includes('codex-review-state:v1'));
  const state = summary?.body.match(/codex-review-state:v1 (\{.*?\}) -->/)?.[1];
  if (!state) return true;
  return (JSON.parse(state).code_review as { status: string | null }).status !== 'completed';
}

/**
 * Drives the current branch's open PR to a verdict. Waits for CI and for Codex's first review; Codex reviews every PR
 * on its own when it opens, so after the first review it never waits for another. The budget is a hard stop: every
 * command is killed when it would outlive it.
 */
export async function ship(io: Io, { merge, budgetMs }: { merge: boolean; budgetMs: number }): Promise<Verdict> {
  const deadline = io.now() + budgetMs;
  function bounded(cmd: string[]): string {
    const timeoutMs = deadline - EXIT_RESERVE_MS - io.now();
    const name = `\`${cmd.slice(0, 3).join(' ')}\``;
    if (timeoutMs <= 0) exit(3, `The budget ran out before ${name}. Rerun.`);
    try {
      return io.run(cmd, { timeoutMs });
    } catch (error) {
      if (error instanceof TimeoutError) exit(3, `The budget ran out during ${name}. Rerun.`);
      throw error;
    }
  }
  const gh = (args: string[]) => bounded(['gh', ...args]);

  function view(): Pr {
    try {
      return JSON.parse(gh(['pr', 'view', '--json', 'number,url,state,headRefOid,baseRefName,mergeable,statusCheckRollup,comments']));
    } catch (error) {
      if (error instanceof Error && error.message.includes('no pull requests found')) exit(1, 'This branch has no PR. Push it and open one with `gh pr create`, then rerun.');
      throw error;
    }
  }

  function unresolvedThreads(owner: string, repo: string, number: number) {
    const query = `query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:100){nodes{isResolved path line comments(first:1){nodes{author{login} body url}}}}}}}`;
    const data = JSON.parse(gh(['api', 'graphql', '-f', `query=${query}`, '-F', `owner=${owner}`, '-F', `repo=${repo}`, '-F', `number=${number}`]));
    type Thread = { isResolved: boolean; path: string; line: number | null; comments: { nodes: { author: { login: string }; body: string; url: string }[] } };
    return (data.data.repository.pullRequest.reviewThreads.nodes as Thread[])
      .filter(thread => !thread.isResolved)
      .map(thread => {
        const comment = thread.comments.nodes[0]!;
        return `- ${thread.path}:${thread.line ?? '?'} (${comment.author.login}) ${comment.body.split('\n')[0]!.slice(0, 200)}\n  ${comment.url}`;
      });
  }

  try {
    const head = bounded(['git', 'rev-parse', 'HEAD']);
    const [owner, repo] = gh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']).split('/') as [string, string];
    while (true) {
      const pr = view();
      if (pr.state === 'MERGED') exit(0, `Merged: ${pr.url}`);
      if (pr.state === 'CLOSED') exit(1, `${pr.url} is closed.`);
      if (pr.headRefOid !== head) exit(1, `The PR head is ${pr.headRefOid.slice(0, 7)} but HEAD is ${head.slice(0, 7)}. Push, then rerun.`);
      if (pr.mergeable === 'CONFLICTING') exit(2, `${pr.url} conflicts with ${pr.baseRefName}, so CI will not run. Rebase onto origin/${pr.baseRefName}, push, rerun.`);

      const { all, failed, pending } = checks(pr);
      if (failed.length) exit(1, `Failing checks:\n${failed.map(check => `- ${check.name} ${check.url}`).join('\n')}\nRead logs with \`gh run view <run id> --log-failed\`, fix the cause, push, rerun.`);
      const threads = unresolvedThreads(owner, repo, pr.number);
      if (threads.length) exit(1, `Unresolved review threads:\n${threads.join('\n')}\nFix or answer each, resolve the thread, push, rerun.`);

      const waiting = [...(all.length ? [] : ['checks to start']), ...pending.map(check => check.name), ...(codexRunning(pr) ? ['Codex review'] : [])];
      if (!waiting.length && pr.mergeable === 'MERGEABLE') {
        if (!merge) exit(0, `Ready to merge: ${pr.url}`);
        gh(['pr', 'merge', String(pr.number), '--merge']);
        continue;
      }
      if (!waiting.length) waiting.push('GitHub to compute mergeability');
      if (io.now() + POLL_MS > deadline) exit(3, `Still waiting on ${waiting.join(', ')}. Rerun.`);
      io.log(`Waiting on ${waiting.join(', ')}…`);
      await io.sleep(POLL_MS);
    }
  } catch (error) {
    if (error instanceof Exit) return error.verdict;
    throw error;
  }
}
