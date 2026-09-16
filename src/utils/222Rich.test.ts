import { afterEach, expect, test } from 'bun:test';

import { inlineImage, renderRich } from './222Rich';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const people = [[
  { name: 'Alice', imageUrl: 'https://example.com/alice.png', personality: 'Searcher' },
  { name: '李明', imageUrl: 'https://example.com/missing.png' },
]];
const markdown = '# Invites\n\n## Dinner\n\n### People';

test('rich photo grid reserves space, places images below names, and handles a failed photo', async () => {
  globalThis.fetch = (async (url: string) => url.includes('alice')
    ? new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } })
    : new Response('', { status: 404 })) as typeof fetch;
  const result = await renderRich(markdown, people, { columns: 80, color: true, images: true });
  expect(result).toContain('1337;File=inline=1;size=3;width=38;height=8;preserveAspectRatio=1:AQID\x07');
  expect(result.indexOf('Alice')).toBeLessThan(result.indexOf('1337;File'));
  expect(result).toContain('\x1b[8A');
  expect(result).toContain('\x1b7\x1b[1G');
  expect(result).toContain('\x1b8');
  expect(result).toContain('No photo');
  expect(result).toContain('Searcher');
});

test('plain fallback avoids image requests and keeps narrow Unicode rows within the terminal width', async () => {
  globalThis.fetch = (() => { throw new Error('Must not download photos'); }) as unknown as typeof fetch;
  const result = await renderRich(markdown, people, { columns: 24, color: false, images: false });
  expect(result).not.toContain('\x1b');
  expect(result).toContain('李明');
  expect(result).toContain('Photo');
  for (const line of result.split('\n')) expect(Bun.stringWidth(line)).toBeLessThan(24);
});

test('large photos use bounded multipart OSC sequences without losing image bytes', () => {
  const data = new Uint8Array(800_000).fill(42);
  const output = inlineImage(data, 20, 8);
  expect(output).toContain('MultipartFile=inline=1;size=800000');
  expect(output.endsWith('\x1b]1337;FileEnd\x07')).toBe(true);
  const prefix = '\x1b]1337;FilePart=';
  const parts = output.split('\x07').filter(part => part.startsWith(prefix)).map(part => part.slice(prefix.length));
  expect(parts.every(part => part.length <= 32768)).toBe(true);
  expect(Buffer.from(parts.join(''), 'base64')).toEqual(Buffer.from(data));
});

test('S3 photos with binary content types are recognized by their PNG signature', async () => {
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  globalThis.fetch = (async () => new Response(png, { headers: { 'content-type': 'binary/octet-stream' } })) as unknown as typeof fetch;
  const output = await renderRich(markdown, people, { columns: 80, color: false, images: true });
  expect(output.split('1337;File=inline=1').length - 1).toBe(2);
  expect(output).not.toContain('No photo');
});

test('all attendees share one borderless name row even with more than four people', async () => {
  const attendees = Array.from({ length: 6 }, (_, index) => ({ name: `Person ${index + 1}` }));
  const output = await renderRich(markdown, [attendees], { columns: 100, color: false, images: false });
  const nameRows = output.split('\n').filter(line => line.includes('Person'));
  expect(nameRows).toHaveLength(1);
  expect(nameRows[0]).toContain('Person 6');
  expect(output).not.toMatch(/[│┌┐└┘]/);
});
