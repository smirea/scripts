interface Env {
  DB: D1Database;
  READ_TOKEN?: string;
}

interface MessageRow {
  id: string;
  received_at: string;
  sender: string;
  text: string;
  thread_key: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handle(request, env);
    } catch (ex) {
      const message = ex instanceof Error ? ex.message : String(ex);
      const status = message.startsWith('missing') || message.startsWith('expected') ? 400 : 500;
      return json({ error: message }, status);
    }
  },
} satisfies ExportedHandler<Env>;

async function handle(request: Request, env: Env): Promise<Response> {
  if (!isAuthorized(request, env)) {
    return json({ error: 'unauthorized' }, 401);
  }

  const url = new URL(request.url);

  if (request.method === 'POST' && url.pathname === '/messages') {
    const body = await readJson(request);
    const sender = asNonEmpty(body.sender, 'sender');
    const text = asNonEmpty(body.text, 'text');
    const receivedAt = asIso(body.received_at) || new Date().toISOString();
    const id = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO messages (id, received_at, sender, text, thread_key)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(id, receivedAt, sender, text, sender)
      .run();
    return json({ id, received_at: receivedAt, sender, text, thread_key: sender }, 201);
  }

  if (request.method === 'GET' && url.pathname === '/messages') {
    const limit = clampLimit(url.searchParams.get('limit'));
    const sender = url.searchParams.get('sender');
    const rows = sender
      ? await env.DB.prepare(
          `SELECT * FROM messages WHERE sender = ? ORDER BY received_at DESC LIMIT ?`,
        )
          .bind(sender, limit)
          .all<MessageRow>()
      : await env.DB.prepare(
          `SELECT * FROM messages ORDER BY received_at DESC LIMIT ?`,
        )
          .bind(limit)
          .all<MessageRow>();
    return json({ messages: rows.results });
  }

  const match = url.pathname.match(/^\/messages\/([^/]+)$/);
  if (request.method === 'GET' && match) {
    const message = await env.DB.prepare(`SELECT * FROM messages WHERE id = ?`)
      .bind(match[1])
      .first<MessageRow>();
    if (!message) return json({ error: 'not_found' }, 404);
    return json({ message });
  }

  return json({ error: 'not_found' }, 404);
}

function isAuthorized(request: Request, env: Env): boolean {
  const token = env.READ_TOKEN;
  if (!token) return false;
  const header = request.headers.get('authorization') || '';
  return header === `Bearer ${token}`;
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    if (body && typeof body === 'object') return body as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new Error('expected JSON body { sender, text }');
}

function asNonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`missing ${field}`);
  }
  return value.trim();
}

function asIso(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function clampLimit(value: string | null): number {
  const parsed = Number(value || 20);
  if (!Number.isFinite(parsed)) return 20;
  return Math.min(100, Math.max(1, Math.trunc(parsed)));
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}
