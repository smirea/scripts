import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { loadDefaults } from './defaults';
import { createCli } from './yargs';

describe('local script defaults', () => {
  function cli(args: string[]) {
    return createCli('222', args, {
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

  test('scoped defaults override built-ins, including false and arrays', async () => {
    const args = await cli(['invites']).parseAsync();
    expect(args).toMatchObject({ format: 'rich', limit: 7, enabled: false, tags: ['local'] });
    expect(await cli(['events']).parseAsync()).toMatchObject({ format: 'json' });
    expect(await cli(['i']).parseAsync()).toMatchObject({ format: 'rich', limit: 7 });
  });

  test('explicit flags and aliases override local defaults', async () => {
    expect(await cli(['invites', '-f', 'md', '-l', '3', '--enabled', '--tags', 'cli']).parseAsync())
      .toMatchObject({ format: 'md', limit: 3, enabled: true, tags: ['cli'] });
    expect(await cli(['--format=json', 'invites', '--no-enabled']).parseAsync())
      .toMatchObject({ format: 'json', enabled: false });
  });

  test('nested commands inherit and override their parent defaults', async () => {
    expect(await cli(['invites', 'city']).parseAsync()).toMatchObject({ format: 'rich', limit: 9 });
  });

  test('shared factory handles object and async command builders', async () => {
    const args = await createCli('222', ['invites'], { '222': { invites: { format: 'rich' } } })
      .command({ command: 'invites', builder: async p => p.option('format', { default: 'md' }), handler: () => {} })
      .parseAsync();
    expect(args.format).toBe('rich');
  });

  test('defaults are coerced and validated before handlers run', async () => {
    let handled: unknown;
    await createCli('222', ['invites'], { '222': { invites: { limit: 7 } } })
      .command('invites', '', p => p.option('limit', { type: 'number', default: 1, coerce: n => n * 2 }), argv => { handled = argv.limit; })
      .parseAsync();
    expect(handled).toBe(14);
    expect(() => createCli('222', [], { '222': { format: 'invalid' } })
      .exitProcess(false)
      .option('format', { choices: ['md', 'rich'], default: 'md' })
      .fail(message => { throw new Error(message); })
      .parseSync()).toThrow('Invalid values');
  });

  test('built-in defaults still work without local overrides', () => {
    expect(createCli('222', [], {}).option('format', { default: 'md' }).parseSync().format).toBe('md');
  });

  test('registered script aliases share defaults', () => {
    expect(createCli('git-worktree', [], { wt: { base: 'main' } }).option('base', { default: 'master' }).parseSync().base).toBe('main');
  });

  test('initializes once from the example regardless of working directory', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'script-defaults-'));
    const example = "export default { '222': { invites: { format: 'rich' } } };\n";
    writeFileSync(path.join(root, 'defaults.example.ts'), example);
    expect(loadDefaults(root)).toMatchObject({ '222': { invites: { format: 'rich' } } });
    expect(readFileSync(path.join(root, 'defaults.ts'), 'utf8')).toBe(example);
    writeFileSync(path.join(root, 'defaults.example.ts'), 'export default {};');
    loadDefaults(root);
    expect(readFileSync(path.join(root, 'defaults.ts'), 'utf8')).toBe(example);
  });
});
