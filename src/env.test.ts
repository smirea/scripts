import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'bun:test';

const envModuleUrl = pathToFileURL(path.join(import.meta.dir, 'env.ts')).href;

function runEnvSnippet(snippet: string, env: NodeJS.ProcessEnv) {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'env-test-'));
  const scriptPath = path.join(tempDir, 'snippet.ts');

  writeFileSync(
    scriptPath,
    `
      const { default: env, readEnv } = await import(${JSON.stringify(envModuleUrl)});
      ${snippet}
    `
  );

  const result = spawnSync('bun', [scriptPath], {
    cwd: tempDir,
    encoding: 'utf8',
    env,
  });

  unlinkSync(scriptPath);
  rmdirSync(tempDir);
  return result;
}

describe('env proxy', () => {
  it('allows reading a single optional key without validating unrelated required keys', () => {
    const result = runEnvSnippet('console.log(env.AI_COMITTER_NAME ?? "unset");', {
      PATH: process.env.PATH,
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('unset');
  });

  it('still validates required keys when that key is accessed', () => {
    const result = runEnvSnippet('console.log(env.GEMINI_API_KEY);', {
      PATH: process.env.PATH,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('GEMINI_API_KEY');
  });

  it('keeps full-schema validation in readEnv', () => {
    const result = runEnvSnippet('readEnv();', {
      PATH: process.env.PATH,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('WHOOP_CLIENT_ID');
    expect(result.stderr).toContain('GEMINI_API_KEY');
  });
});
