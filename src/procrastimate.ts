#!/usr/bin/env bun
import { createScript } from './utils/createScript';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import env from './env';

type Named = { id: string; name: string };
type Attachment = { id: string; name?: string; bytes?: number };
type Task = {
  id: string;
  title: string;
  notes: string | null;
  projectId: string;
  sectionId: string | null;
  parentId: string | null;
  priority: number;
  labelIds: string[];
  attachments: Attachment[];
  completedAt: number | null;
};
type View = { projects: Named[]; labels: Named[]; sections: Named[]; tasks: Task[] };
type Comment = { body: string; createdAt: number; author: { name: string; kind: string } };

const repoRoot = path.resolve(import.meta.dir, '..');
const describeRequest = (method: string, pathname: string, body?: unknown) =>
  `${method} ${pathname}${body === undefined ? '' : ` ${typeof body === 'string' ? body : JSON.stringify(body)}`}`;

/** One command's session with the API. Under `dryRun`, reads still run and every write lands in `plan` instead. */
class Api {
  readonly plan: string[] = [];

  constructor(readonly dryRun = false) {}

  /** Every write asks this first: under --dry-run it records the write and answers true, so the caller skips it. */
  skip(step: string): boolean {
    if (this.dryRun) this.plan.push(step);
    return this.dryRun;
  }

  async call(method: string, pathname: string, body?: unknown): Promise<Response> {
    if (this.dryRun && method !== 'GET') throw new Error(`bug: ${describeRequest(method, pathname)} ran under --dry-run; gate it with skip()`);
    // Reads retry on transient errors; writes don't, because a retried write can land twice.
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(env.PROCRASTIMATE_API_URL + pathname, {
          method,
          headers: { Authorization: `Bearer ${env.PROCRASTIMATE_TOKEN}`, 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
        });
        if (res.ok) return res;
        const hint = res.status === 401
          ? `; the token may be stale: run \`env-manager down\` in ${repoRoot}`
          : res.status === 404 ? '; check the id with `procrastimate tasks <project>`, or the path with `procrastimate GET /docs/agent`' : '';
        const error = new Error(`${method} ${pathname}: ${res.status} ${await res.text()}${hint}`);
        if (method !== 'GET' || attempt >= 3 || res.status < 500) throw Object.assign(error, { final: true });
      } catch (error) {
        if (method !== 'GET' || attempt >= 3 || (error as { final?: boolean }).final) throw error;
      }
      await Bun.sleep(1000 * (attempt + 1));
    }
  }

  async json<T>(method: string, pathname: string, body?: unknown): Promise<T> {
    return (await this.call(method, pathname, body)).json() as Promise<T>;
  }

  view(): Promise<View> {
    return this.json<View>('GET', '/view');
  }

  async link(id: string): Promise<string> {
    const body = { target: { kind: 'task', id } };
    if (this.skip(describeRequest('POST', '/links', body))) return '<link>';
    return (await this.json<{ url: string }>('POST', '/links', body)).url;
  }

  /** Comments `comment` unless a comment already starts with `key`, then completes the task; safe to rerun. */
  async complete(task: string, comment: string, key: string) {
    if (comment) {
      const { comments } = await this.json<{ comments: Comment[] }>('GET', `/comments?id=${task}`);
      const body = { taskId: task, body: comment };
      if (!comments.some(c => c.body.startsWith(key)) && !this.skip(describeRequest('POST', '/comments', body)))
        await this.call('POST', '/comments', body);
    }
    const open = findTask(await this.view(), task).completedAt === null;
    const completion = `/tasks/complete?id=${task}`;
    if (open && !this.skip(describeRequest('POST', completion))) await this.call('POST', completion);
    if (!this.dryRun) console.log(`completed ${task}`);
  }

  report() {
    if (!this.dryRun) return;
    console.log(this.plan.length ? `dry run, would run:\n${this.plan.map(step => `  ${step}`).join('\n')}` : 'dry run: nothing to write');
  }
}

function projectId(view: View, nameOrId: string): string {
  const matches = view.projects.filter(p => p.id === nameOrId || p.name === nameOrId);
  if (matches.length !== 1)
    throw new Error(`expected one project named ${nameOrId}, found ${matches.length}; projects: ${view.projects.map(p => p.name).join(', ')}`);
  return matches[0]!.id;
}

function openTasks(view: View, project: string): Task[] {
  const pid = projectId(view, project);
  return view.tasks.filter(t => t.projectId === pid && t.completedAt === null);
}

function findTask(view: View, id: string): Task {
  const task = view.tasks.find(t => t.id === id);
  if (!task) throw new Error(`no task ${id}; \`procrastimate tasks <project>\` lists open task ids`);
  return task;
}

function labelId(view: View, name: string): string {
  const label = view.labels.find(l => l.name === name);
  if (!label)
    throw new Error(`no label '${name}'; labels: ${view.labels.map(l => l.name).join(', ')}. The AI account can't create labels, so ask Stefan to`);
  return label.id;
}

const dryRun = {
  type: 'boolean',
  default: false,
  describe: 'Do the reads, then print the writes it would make instead of making them.',
} as const;

const cli = createScript('procrastimate');
cli
  .usage(`$0 <command>

ProcrastiMate's agent API as the AI account, with PROCRASTIMATE_TOKEN from env-manager project \`scripts\`.
\`procrastimate GET /docs/agent\` is the full API guide.`)
  .command(
    'tasks <project>',
    'Open tasks with section, parent, priority, label names, and notes.',
    command => command.positional('project', { type: 'string', demandOption: true, describe: 'Project name or id.' }),
    async argv => {
      const view = await new Api().view();
      const names = (list: Named[]) => new Map(list.map(x => [x.id, x.name]));
      const labels = names(view.labels);
      const sections = names(view.sections);
      for (const t of openTasks(view, argv.project)) {
        console.log(
          `${t.id} p${t.priority} section=${sections.get(t.sectionId ?? '') ?? '-'} parent=${t.parentId ?? '-'}`
            + ` labels=${t.labelIds.map(id => labels.get(id)).join(',')} attachments=${t.attachments.length}`,
        );
        console.log(`  ${t.title}`);
        if (t.notes) console.log(`  ${t.notes.replaceAll('\n', '\n  ')}`);
      }
    },
  )
  .command(
    'new <project> <file>',
    "Open task ids whose first 8 characters the file doesn't mention, such as tasks a session log hasn't seen.",
    command => command
      .positional('project', { type: 'string', demandOption: true, describe: 'Project name or id.' })
      .positional('file', { type: 'string', demandOption: true, describe: 'File to search for known task ids.' }),
    async argv => {
      const known = readFileSync(argv.file, 'utf8');
      for (const t of openTasks(await new Api().view(), argv.project)) if (!known.includes(t.id.slice(0, 8))) console.log(t.id);
    },
  )
  .command(
    'comments <task>',
    "The task's comments, oldest first.",
    command => command.positional('task', { type: 'string', demandOption: true, describe: 'Task id.' }),
    async argv => {
      const { comments } = await new Api().json<{ comments: Comment[] }>('GET', `/comments?id=${argv.task}`);
      for (const c of comments.toSorted((a, b) => a.createdAt - b.createdAt))
        console.log(`[${new Date(c.createdAt).toISOString().slice(0, 19)}Z ${c.author.name} (${c.author.kind})] ${c.body}`);
    },
  )
  .command(
    'images <task> <dir>',
    "Download the task's images as <dir>/<task>-<n>.<ext> and its files as <dir>/<task>-<name>, and print their paths.",
    command => command
      .positional('task', { type: 'string', demandOption: true, describe: 'Task id.' })
      .positional('dir', { type: 'string', demandOption: true, describe: 'Output directory, created if missing.' }),
    async argv => {
      const api = new Api();
      const { attachments } = findTask(await api.view(), argv.task);
      mkdirSync(argv.dir, { recursive: true });
      let n = 0;
      for (const { id, name, bytes = 0 } of attachments) {
        if (!name) {
          const res = await api.call('GET', `/images?id=${id}&size=full`);
          const ext = (res.headers.get('content-type') ?? 'image/jpeg').replace('image/', '').replace('jpeg', 'jpg');
          const out = path.join(argv.dir, `${argv.task}-${++n}.${ext}`);
          await Bun.write(out, res);
          console.log(out);
          continue;
        }
        const parts: ArrayBuffer[] = [];
        for (let size = 0, part = 0; size < bytes; part++) {
          const chunk = await (await api.call('GET', `/images?id=${id}&size=part${part}`)).arrayBuffer();
          if (chunk.byteLength === 0) throw new Error(`attachment ${id} ended at ${size} of ${bytes} bytes; rerun to download it again`);
          parts.push(chunk);
          size += chunk.byteLength;
        }
        const out = path.join(argv.dir, `${argv.task}-${name}`);
        await Bun.write(out, new Blob(parts));
        console.log(out);
      }
    },
  )
  .command(
    'link <tasks..>',
    'Print "<id> <public read-only link>" for each task.',
    command => command
      .positional('tasks', { type: 'string', array: true, demandOption: true, describe: 'Task ids.' })
      .option('dry-run', dryRun),
    async argv => {
      const api = new Api(argv.dryRun);
      for (const task of argv.tasks) console.log(`${task} ${await api.link(task)}`);
      api.report();
    },
  )
  .command(
    'label <task>',
    'Add or remove labels by name, keeping the others.',
    command => command
      .positional('task', { type: 'string', demandOption: true, describe: 'Task id.' })
      .option('add', { type: 'string', array: true, default: [] as string[], describe: 'Label names to add.' })
      .option('remove', { type: 'string', array: true, default: [] as string[], describe: 'Label names to remove.' })
      .option('dry-run', dryRun)
      .check(argv => {
        if (argv.add.length + argv.remove.length === 0) throw new Error('Pass --add or --remove with a label name.');
        return true;
      }),
    async argv => {
      const api = new Api(argv.dryRun);
      const view = await api.view();
      const ids = new Set(findTask(view, argv.task).labelIds);
      for (const name of argv.add) ids.add(labelId(view, name));
      for (const name of argv.remove) ids.delete(labelId(view, name));
      const body = { labelIds: [...ids] };
      const target = `/tasks?id=${argv.task}`;
      if (!api.skip(describeRequest('PATCH', target, body))) {
        const updated = await api.json<Task>('PATCH', target, body);
        console.log(JSON.stringify({ id: updated.id, labelIds: updated.labelIds }));
      }
      api.report();
    },
  )
  .command(
    'file <project> <title> [notes]',
    'Add a task unless an open one in the project has this title, and print "<id> <public link>"; safe to rerun.',
    command => command
      .positional('project', { type: 'string', demandOption: true, describe: 'Project name or id.' })
      .positional('title', { type: 'string', demandOption: true })
      .positional('notes', { type: 'string' })
      .option('section', { type: 'string', describe: 'Section id.' })
      .option('parent', { type: 'string', describe: 'Parent task id.' })
      .option('dry-run', dryRun),
    async argv => {
      const api = new Api(argv.dryRun);
      const pid = projectId(await api.view(), argv.project);
      const find = async () =>
        (await api.view()).tasks.find(t => t.projectId === pid && t.title === argv.title && t.completedAt === null)?.id;
      const body = {
        projectId: pid,
        title: argv.title,
        ...(argv.notes && { notes: argv.notes }),
        ...(argv.section && { sectionId: argv.section }),
        ...(argv.parent && { parentId: argv.parent }),
      };
      const existing = await find();
      if (!existing && api.skip(describeRequest('POST', '/tasks', body))) {
        await api.link('<new task id>');
      } else {
        const post = async () => (await api.json<{ id: string }>('POST', '/tasks', body)).id;
        // A failed POST may still have created the task, so look again before the one retry.
        const id = existing ?? (await post().catch(find)) ?? (await post());
        console.log(`${id} ${await api.link(id)}`);
      }
      api.report();
    },
  )
  .command(
    'complete <tasks..>',
    'Comment "<pr>\\n<note>" on each task unless a comment already starts with the PR, then complete it; safe to rerun.',
    command => command
      .positional('tasks', { type: 'string', array: true, demandOption: true, describe: 'Task ids.' })
      .option('pr', { type: 'string', describe: 'PR url, the first line of the comment.' })
      .option('note', { type: 'string', describe: 'One line after the PR.' })
      .option('dry-run', dryRun),
    async argv => {
      const api = new Api(argv.dryRun);
      const comment = [argv.pr, argv.note].filter(Boolean).join('\n');
      for (const task of argv.tasks) await api.complete(task, comment, argv.pr ?? comment);
      api.report();
    },
  )
  .command(
    'webhook',
    'Webhooks that POST to a URL when a human adds a task or comments. `procrastimate webhook <command> --help`.',
    command => command
      .command(
        'register <url> [projects..]',
        'Register the URL, or register it again, and print it as JSON with its signing `secret`. A disabled hook turns back on from now; safe to rerun.',
        sub => sub
          .positional('url', { type: 'string', demandOption: true, describe: 'HTTPS URL to POST to, such as a T3 webhook task\'s webhookUrl.' })
          .positional('projects', { type: 'string', array: true, default: [] as string[], describe: 'Project names or ids to watch; none watches the whole space.' })
          .option('dry-run', dryRun),
        async argv => {
          const api = new Api(argv.dryRun);
          const view = await api.view();
          const body = { url: argv.url, projectIds: argv.projects.map(p => projectId(view, p)) };
          if (!api.skip(describeRequest('POST', '/webhooks', body)))
            console.log(JSON.stringify(await api.json('POST', '/webhooks', body), null, 2));
          api.report();
        },
      )
      .command(
        'list',
        'The space\'s webhooks with their delivery state: `disabledAt` and `lastError` say why one stopped.',
        sub => sub,
        async () => console.log(JSON.stringify((await new Api().json<{ webhooks: unknown[] }>('GET', '/webhooks')).webhooks, null, 2)),
      )
      .command(
        'delete <id>',
        'Delete a webhook by id, from `procrastimate webhook list`.',
        sub => sub
          .positional('id', { type: 'string', demandOption: true })
          .option('dry-run', dryRun),
        async argv => {
          const api = new Api(argv.dryRun);
          const target = `/webhooks?id=${argv.id}`;
          if (!api.skip(describeRequest('DELETE', target))) {
            await api.call('DELETE', target);
            console.log(`deleted ${argv.id}`);
          }
          api.report();
        },
      )
      .demandCommand(1, 'Choose a webhook command: register, list, or delete.'),
    () => {},
  );

for (const method of ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'] as const) {
  cli.command(
    `${method} <path> [body]`,
    `Raw ${method} call, printing the response body.`,
    command => {
      const raw = command
        .positional('path', { type: 'string', demandOption: true, describe: 'API path, such as /view.' })
        .positional('body', { type: 'string', describe: 'JSON body, or - to read it from stdin.' });
      return method === 'GET' ? raw : raw.option('dry-run', dryRun);
    },
    async argv => {
      const api = new Api(method !== 'GET' && argv.dryRun === true);
      const body = argv.body === '-' ? await Bun.stdin.text() : argv.body;
      if (method !== 'GET' && api.skip(describeRequest(method, argv.path, body))) return api.report();
      process.stdout.write(await (await api.call(method, argv.path, body)).text());
    },
  );
}

await cli.demandCommand(1, 'Choose a command.').recommendCommands().parseAsync();
