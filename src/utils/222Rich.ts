import { Chalk } from 'chalk';

export interface RichPerson {
  name: string;
  imageUrl?: string;
  personality?: string;
  status?: string;
}

interface RichOptions {
  columns: number;
  color: boolean;
  images: boolean;
}

const ESC = '\x1b';
const PHOTO_ROWS = 8;

export async function printRich(markdown: string, people: RichPerson[][] = []): Promise<void> {
  const output = await renderRich(markdown, people, {
    columns: process.stdout.columns || 100,
    color: Boolean(process.stdout.isTTY),
    images: Boolean(process.stdout.isTTY && (process.env.TERM_PROGRAM === 'iTerm.app' || process.env.LC_TERMINAL === 'iTerm2') && !process.env.TMUX),
  });
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(`${output}\n`, error => error ? reject(error) : resolve());
  });
}

export async function renderRich(markdown: string, people: RichPerson[][], options: RichOptions): Promise<string> {
  const style = new Chalk({ level: options.color ? 1 : 0 });
  const width = Math.max(10, options.columns - 1);
  const lines: string[] = [];
  let attendees: RichPerson[] = [];
  let eventIndex = 0;
  for (const raw of markdown.split('\n')) {
    const line = clean(raw);
    if (line.startsWith('## ')) {
      attendees = people[eventIndex++] ?? [];
      lines.push(style.cyan('─'.repeat(width)), ...wrap(plain(line.slice(3)), width).map(text => style.bold.cyan(text)));
    } else if (line.startsWith('### ')) {
      lines.push(style.bold.yellow(plain(line.slice(4))));
      if (line === '### People' && attendees.length) {
        lines.push(await peopleGrid(attendees, { ...options, columns: width }));
      }
    } else if (line.startsWith('# ')) {
      lines.push(style.bold.magenta(plain(line.slice(2))));
    } else {
      for (const part of wrap(line, width)) {
        lines.push(part.replace(/\*\*([^*]+)\*\*/g, (_, label: string) => style.bold(label))
          .replace(/\\([\\`*_[\]<>#|])/g, '$1')
          .replace(/\[([^\]]+)\]\(<?([^\s)>]+)>?\)/g, (_, label: string, url: string) => `${label}: ${style.underline.blue(url)}`));
      }
    }
  }
  return lines.join('\n');
}

async function peopleGrid(people: RichPerson[], options: RichOptions): Promise<string> {
  const style = new Chalk({ level: options.color ? 1 : 0 });
  const gap = 2;
  const cellWidth = Math.max(1, Math.floor((options.columns - gap * (people.length - 1)) / people.length));
  const cells = (values: string[], bold = false) => values.map(value => {
    const clipped = truncate(clean(value), cellWidth);
    const padded = clipped + ' '.repeat(cellWidth - Bun.stringWidth(clipped));
    return bold ? style.bold(padded) : padded;
  }).join(' '.repeat(gap)).trimEnd();
  const result = [cells(people.map(person => person.name), true)];
  if (options.images) {
    const photos = await Promise.all(people.map(person => downloadPhoto(person.imageUrl)));
    // Reserve rows before drawing so an image cannot scroll away another person's saved cursor position.
    let images = `${'\n'.repeat(PHOTO_ROWS)}${ESC}[${PHOTO_ROWS}A`;
    for (let index = 0; index < people.length; index++) {
      images += `${ESC}7${ESC}[${index * (cellWidth + gap) + 1}G`;
      const photo = photos[index];
      images += photo ? inlineImage(photo, cellWidth, PHOTO_ROWS) : style.dim(truncate('No photo', cellWidth));
      images += `${ESC}8`;
    }
    images += `${ESC}[${PHOTO_ROWS}B${ESC}[1G`;
    result.push(images + cells(people.map(person => person.personality ?? '')));
  } else {
    result.push(cells(people.map(person => person.imageUrl ? 'Photo (iTerm2)' : 'No photo')),
      cells(people.map(person => person.personality ?? '')));
  }
  result.push(cells(people.map(person => person.status ?? '')));
  return result.join('\n');
}

export function inlineImage(bytes: Uint8Array, width: number, height: number): string {
  const arguments_ = `inline=1;size=${bytes.length};width=${width};height=${height};preserveAspectRatio=1`;
  const data = Buffer.from(bytes).toString('base64');
  if (data.length < 900_000) return `${ESC}]1337;File=${arguments_}:${data}\x07`;
  const parts = data.match(/.{1,32768}/g) ?? [];
  return `${ESC}]1337;MultipartFile=${arguments_}\x07${parts.map(part => `${ESC}]1337;FilePart=${part}\x07`).join('')}${ESC}]1337;FileEnd\x07`;
}

async function downloadPhoto(url?: string): Promise<Uint8Array | undefined> {
  if (!url?.startsWith('https://')) return;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      return;
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 5_000_000) {
        await reader.cancel();
        return;
      }
      chunks.push(value);
    }
    const bytes = Buffer.concat(chunks);
    // 222's S3 profile photos are PNGs served as binary/octet-stream.
    const signature = bytes.subarray(0, 12);
    const recognized = signature.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      || (signature[0] === 255 && signature[1] === 216 && signature[2] === 255)
      || /^GIF8[79]a/.test(signature.toString('ascii'))
      || (signature.toString('ascii', 0, 4) === 'RIFF' && signature.toString('ascii', 8, 12) === 'WEBP');
    return size && (recognized || response.headers.get('content-type')?.startsWith('image/')) ? bytes : undefined;
  } catch {
    return;
  }
}

function clean(value: string): string {
  return Array.from(value).filter(char => {
    const code = char.codePointAt(0)!;
    return code >= 32 && (code < 127 || code > 159);
  }).join('');
}

function plain(value: string): string {
  return value.replace(/\\([\\`*_[\]<>#|])/g, '$1').replaceAll('**', '');
}

function truncate(value: string, width: number): string {
  if (Bun.stringWidth(value) <= width) return value;
  let result = '';
  for (const char of value) {
    if (Bun.stringWidth(result + char) > width - 1) break;
    result += char;
  }
  return `${result}…`;
}

function wrap(value: string, width: number): string[] {
  const result: string[] = [];
  let line = '';
  const indent = value.match(/^ */)?.[0] ?? '';
  for (const word of value.trimStart().split(' ')) {
    if (line.trim() && line.trim() !== '-' && Bun.stringWidth(plain(line + ' ' + word)) > width) {
      result.push(line);
      line = indent + word;
    } else {
      line = line ? `${line} ${word}` : indent + word;
    }
  }
  result.push(line);
  return result;
}
