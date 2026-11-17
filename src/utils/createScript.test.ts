import { expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { loadDefaults } from './defaults';
import { createScript } from './createScript';

function cli(args: string[]) {
  return createScript('222', args, {
    '222': { format: 'json', invites: { format: 'rich', limit: 7, enabled: false, tags: ['local'], city: { limit: 9 } } },
  })
    .exitProcess(false)
    .option('format', { choices: ['md', 'json', 'rich'], default: 'md', alias: 'f' })
    .command(['invites', 'i'], '', p => p
      .option('limit', { type: 'number', default: 1, alias: 'l' })
      .option('enabled', { type: 'boolean', default: true })
      .option('tags', { type: 'array', default: ['builtin'] })
      .command('city', '', c => c.option('limit', { type: 'number', default: 2 })))
    .command('events', '', p => p);
}

test('explicit flags beat the deepest command defaults, which beat parent and script defaults, which beat built-ins', async () => {
  expect(await cli(['events']).parseAsync()).toMatchObject({ format: 'json' });
  expect(await cli(['invites']).parseAsync()).toMatchObject({ format: 'rich', limit: 7, enabled: false, tags: ['local'] });
  expect(await cli(['i']).parseAsync()).toMatchObject({ format: 'rich', limit: 7 });
  expect(await cli(['invites', 'city']).parseAsync()).toMatchObject({ format: 'rich', limit: 9 });
  expect(await cli(['invites', '-f', 'md', '-l', '3', '--enabled', '--tags', 'cli']).parseAsync())
    .toMatchObject({ format: 'md', limit: 3, enabled: true, tags: ['cli'] });
  expect(await cli(['--format=json', 'invites', '--no-enabled']).parseAsync()).toMatchObject({ format: 'json', enabled: false });
});

test('a registered script alias reads the canonical script\'s defaults', () => {
  expect(createScript('git-worktree', [], { wt: { base: 'main' } }).option('base', { default: 'master' }).parseSync().base).toBe('main');
});

test('defaults.ts is created from the example once and never overwritten', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'script-defaults-'));
  const example = "export default { '222': { invites: { format: 'rich' } } };\n";
  writeFileSync(path.join(root, 'defaults.example.ts'), example);
  expect(loadDefaults(root)).toMatchObject({ '222': { invites: { format: 'rich' } } });
  writeFileSync(path.join(root, 'defaults.example.ts'), 'export default {};');
  loadDefaults(root);
  expect(readFileSync(path.join(root, 'defaults.ts'), 'utf8')).toBe(example);
});

test('unknown names in defaults.ts are ignored: they never become options or accepted flags and run no handler', async () => {
  const warn = spyOn(console, 'warn').mockImplementation(() => {});
  const local = { '222': {
    formatt: 'rich', missing: {},
    invites: { format: 'rich', limit: 7, limitt: 9, missing: {}, city: { regionn: 'west' } },
  } };
  const makeCli = (args: string[]) => createScript('222', args, local)
    .exitProcess(false)
    .option('format', { choices: ['md', 'rich'], default: 'md' })
    .command('events', '', p => p, () => {})
    .command('invites', '', p => p.option('limit', { type: 'number' })
      .command('city', '', c => c.option('region', { type: 'string' })), () => { throw new Error('Unexpected handler'); });
  try {
    const result = await makeCli(['events']).parseAsync();
    expect(result.format).toBe('md');
    expect(result).not.toHaveProperty('formatt');
    expect(() => makeCli(['events', '--formatt=rich'])
      .fail(message => { throw new Error(message); }).parseSync()).toThrow('Unknown argument: formatt');
  } finally {
    warn.mockRestore();
  }
});
