#!/usr/bin/env bun
import { createScript } from './utils/createScript';

import { createHmac, randomBytes } from 'node:crypto';

import env from './env';

const API = 'https://api.x.com/2';

const TWEET_PARAMS = {
  'tweet.fields': 'created_at,author_id,conversation_id,note_tweet,public_metrics,referenced_tweets,entities,attachments,article',
  expansions: 'author_id,attachments.media_keys,referenced_tweets.id,referenced_tweets.id.author_id',
  'media.fields': 'url,preview_image_url,type,alt_text,variants',
  'user.fields': 'username,name',
};

interface User {
  id: string;
  username: string;
  name: string;
}

interface Media {
  media_key: string;
  type: string;
  url?: string;
  preview_image_url?: string;
  alt_text?: string;
  variants?: { bit_rate?: number; content_type: string; url: string }[];
}

interface Tweet {
  id: string;
  text: string;
  author_id: string;
  created_at: string;
  conversation_id: string;
  note_tweet?: { text: string };
  article?: { title?: string; plain_text?: string };
  public_metrics?: { like_count: number; retweet_count: number; reply_count: number; quote_count: number; impression_count?: number };
  referenced_tweets?: { type: 'quoted' | 'replied_to' | 'retweeted'; id: string }[];
  entities?: { urls?: { url: string; expanded_url: string }[] };
  attachments?: { media_keys?: string[] };
}

interface Includes {
  users?: User[];
  media?: Media[];
  tweets?: Tweet[];
}

interface Page<T> {
  data?: T;
  includes?: Includes;
  meta?: { next_token?: string; result_count?: number };
  errors?: { detail?: string; title?: string }[];
}

if (import.meta.main) {
  void run();
}

async function run(): Promise<void> {
  const max = { type: 'number', default: 20, describe: 'Maximum posts to fetch. Each post read is billed (~$0.005).' } as const;

  await createScript('x')
    .usage('$0 <command> [options]\n\nRead X as your account through the official API. Every post returned is billed.')
    .option('json', { type: 'boolean', default: false, describe: 'Print raw API responses as JSON.' })
    .command(
      'read <post>',
      'Read a post (URL or id), including quoted/replied-to posts, media and long text.',
      cli => cli.positional('post', { type: 'string', demandOption: true }),
      async argv => {
        const page = await get<Tweet>(`/tweets/${postId(argv.post)}`, TWEET_PARAMS);
        if (argv.json) return printJson(page);
        print(formatTweet(page.data!, page.includes));
      },
    )
    .command(
      'thread <post>',
      'Read the conversation a post belongs to (search only covers the last 7 days).',
      cli => cli
        .positional('post', { type: 'string', demandOption: true })
        .option('author-only', { type: 'boolean', default: false, describe: "Only the original author's posts (the self-thread)." })
        .option('max', { ...max, default: 50 }),
      async argv => {
        const root = await get<Tweet>(`/tweets/${postId(argv.post)}`, TWEET_PARAMS);
        const conversation = root.data!.conversation_id;
        const head = conversation === root.data!.id ? root : await get<Tweet>(`/tweets/${conversation}`, TWEET_PARAMS);
        const author = head.includes?.users?.find(u => u.id === head.data!.author_id)?.username;
        const query = `conversation_id:${conversation}` + (argv.authorOnly && author ? ` from:${author}` : '');
        const replies = await paginate('/tweets/search/recent', { ...TWEET_PARAMS, query, sort_order: 'recency' }, argv.max, 10);
        if (argv.json) return printJson({ head, replies });
        replies.tweets.sort((a, b) => a.created_at.localeCompare(b.created_at));
        const posts = [head.data!, ...replies.tweets];
        const shown = new Set(posts.map(t => t.id));
        print(posts.map(t => formatTweet(t, merge(head.includes, replies.includes), 0, shown)).join('\n\n---\n\n'));
      },
    )
    .command(
      'user <handle>',
      "A user's recent posts.",
      cli => cli
        .positional('handle', { type: 'string', demandOption: true })
        .option('max', { ...max, default: 10 })
        .option('replies', { type: 'boolean', default: false, describe: 'Include replies.' }),
      async argv => {
        const user = await get<User & { description?: string }>(`/users/by/username/${argv.handle.replace(/^@/, '')}`, { 'user.fields': 'description,public_metrics' });
        const params: Record<string, string> = { ...TWEET_PARAMS };
        if (!argv.replies) params.exclude = 'replies';
        await printList(`/users/${user.data!.id}/tweets`, params, argv.max, 5, argv.json);
      },
    )
    .command(
      'timeline',
      'Your home timeline (Following, newest first).',
      cli => cli.option('max', max),
      argv => printList(`/users/${myId()}/timelines/reverse_chronological`, TWEET_PARAMS, argv.max, 1, argv.json),
    )
    .command(
      'bookmarks',
      'Your bookmarks.',
      cli => cli.option('max', max),
      argv => printList(`/users/${myId()}/bookmarks`, TWEET_PARAMS, argv.max, 1, argv.json),
    )
    .command(
      'search <query>',
      'Search posts from the last 7 days (X search syntax, e.g. "from:jack -is:retweet").',
      cli => cli.positional('query', { type: 'string', demandOption: true }).option('max', { ...max, default: 10 }),
      argv => printList('/tweets/search/recent', { ...TWEET_PARAMS, query: argv.query }, argv.max, 10, argv.json),
    )
    .command(
      'me',
      'Show the authenticated account.',
      cli => cli,
      async argv => {
        const page = await get<User>('/users/me', { 'user.fields': 'description,public_metrics' });
        if (argv.json) return printJson(page);
        print(`@${page.data!.username} (${page.data!.name}) id=${page.data!.id}`);
      },
    )
    .demandCommand(1, 'Choose a command.')
    .recommendCommands()
    .parseAsync();
}

async function printList(path: string, params: Record<string, string>, max: number, minPage: number, json: boolean): Promise<void> {
  const result = await paginate(path, params, max, minPage);
  if (json) return printJson(result);
  print(result.tweets.map(t => formatTweet(t, result.includes)).join('\n\n---\n\n') || '(no posts)');
}

async function paginate(path: string, params: Record<string, string>, max: number, minPage: number) {
  const tweets: Tweet[] = [];
  let includes: Includes = {};
  let next: string | undefined;
  const tokenKey = path.includes('/search/') ? 'next_token' : 'pagination_token';
  do {
    const pageSize = Math.min(100, Math.max(minPage, max - tweets.length));
    const page = await get<Tweet[]>(path, { ...params, max_results: String(pageSize), ...(next && { [tokenKey]: next }) });
    tweets.push(...(page.data ?? []));
    includes = merge(includes, page.includes);
    next = page.meta?.next_token;
  } while (next && tweets.length < max);
  return { tweets: tweets.slice(0, max), includes };
}

async function get<T>(path: string, query: Record<string, string>): Promise<Page<T>> {
  const url = `${API}${path}`;
  const response = await fetch(`${url}?${new URLSearchParams(query)}`, {
    headers: { authorization: oauth1Header('GET', url, query) },
  });
  const body = await response.json() as Page<T> & { detail?: string; title?: string };
  if (!response.ok || (!body.data && body.errors?.length)) {
    const detail = body.errors?.map(e => e.detail ?? e.title).join('; ') ?? body.detail ?? body.title;
    throw new Error(`X API ${path} failed (${response.status}): ${detail ?? JSON.stringify(body)}`);
  }
  return body;
}

function oauth1Header(method: string, url: string, query: Record<string, string>): string {
  const oauth: Record<string, string> = {
    oauth_consumer_key: env.X_CONSUMER_KEY,
    oauth_nonce: randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: env.X_ACCESS_TOKEN,
    oauth_version: '1.0',
  };
  const params = Object.entries({ ...query, ...oauth })
    .map(([k, v]) => [encode(k), encode(v)])
    .sort(([a, x], [b, y]) => a === b ? x!.localeCompare(y!) : a!.localeCompare(b!))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const base = [method, encode(url), encode(params)].join('&');
  const key = `${encode(env.X_CONSUMER_SECRET)}&${encode(env.X_ACCESS_TOKEN_SECRET)}`;
  oauth.oauth_signature = createHmac('sha1', key).update(base).digest('base64');
  return 'OAuth ' + Object.entries(oauth).map(([k, v]) => `${encode(k)}="${encode(v)}"`).join(', ');
}

// RFC 3986 encoding; encodeURIComponent leaves !'()* unescaped, which breaks OAuth1 signatures.
function encode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

// OAuth1 access tokens are prefixed with the account's numeric id, which saves a billed /users/me call.
function myId(): string {
  return env.X_ACCESS_TOKEN.split('-')[0]!;
}

function postId(input: string): string {
  const id = input.match(/status(?:es)?\/(\d+)/)?.[1] ?? input.match(/^\d+$/)?.[0];
  if (!id) throw new Error(`Not a post URL or id: ${input}`);
  return id;
}

function formatTweet(tweet: Tweet, includes: Includes = {}, depth = 0, shown = new Set<string>()): string {
  const author = includes.users?.find(u => u.id === tweet.author_id);
  const repost = tweet.referenced_tweets?.find(r => r.type === 'retweeted');
  const original = repost && includes.tweets?.find(t => t.id === repost.id);
  if (original) return `@${author?.username ?? tweet.author_id} reposted:\n${formatTweet(original, includes, depth, shown)}`;
  const m = tweet.public_metrics;
  const lines = [
    `@${author?.username ?? tweet.author_id} (${author?.name ?? '?'}) · ${tweet.created_at} · https://x.com/${author?.username ?? 'i'}/status/${tweet.id}`,
  ];
  if (m && depth === 0) lines.push(`${m.like_count} likes · ${m.retweet_count} reposts · ${m.reply_count} replies · ${m.quote_count} quotes`);
  lines.push('', expandUrls(tweet.note_tweet?.text ?? tweet.text, tweet));
  if (tweet.article?.title) lines.push('', `Article: ${tweet.article.title}`, tweet.article.plain_text ?? '');
  for (const key of tweet.attachments?.media_keys ?? []) {
    const media = includes.media?.find(x => x.media_key === key);
    if (!media) continue;
    const video = media.variants?.filter(v => v.content_type === 'video/mp4').sort((a, b) => (b.bit_rate ?? 0) - (a.bit_rate ?? 0))[0];
    lines.push(`[${media.type}] ${video?.url ?? media.url ?? media.preview_image_url ?? ''}${media.alt_text ? ` alt: ${media.alt_text}` : ''}`);
  }
  for (const ref of depth < 2 ? tweet.referenced_tweets ?? [] : []) {
    if (shown.has(ref.id)) continue;
    const referenced = includes.tweets?.find(t => t.id === ref.id);
    const label = { quoted: 'Quoting', replied_to: 'Replying to', retweeted: 'Reposting' }[ref.type];
    lines.push('', referenced
      ? `${label}:\n${formatTweet(referenced, includes, depth + 1, shown).replace(/^/gm, '> ')}`
      : `${label}: https://x.com/i/status/${ref.id}`);
  }
  return lines.join('\n');
}

function expandUrls(text: string, tweet: Tweet): string {
  return (tweet.entities?.urls ?? [])
    .reduce((acc, u) => acc.replaceAll(u.url, u.expanded_url), text)
    .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
}

function merge(a: Includes = {}, b: Includes = {}): Includes {
  return {
    users: [...(a.users ?? []), ...(b.users ?? [])],
    media: [...(a.media ?? []), ...(b.media ?? [])],
    tweets: [...(a.tweets ?? []), ...(b.tweets ?? [])],
  };
}

function print(text: string): void {
  process.stdout.write(`${text}\n`);
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
