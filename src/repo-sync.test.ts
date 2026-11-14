import { expect, test } from 'bun:test';

import { parseRemote } from './repo-sync';

test('ssh, https, and ssh-alias remotes of one GitHub repo share a key and clone over ssh', () => {
  const remotes = [
    'git@github.com:smirea/Notouroboros.git',
    'https://github.com/smirea/Notouroboros.git',
    'https://github.com/smirea/notouroboros',
    'ssh://git@github.com/smirea/Notouroboros.git',
    'git@github.com-ai:smirea/Notouroboros.git',
  ];
  for (const remote of remotes) {
    const parsed = parseRemote(remote);
    expect(parsed?.key as string | undefined).toBe('github.com/smirea/notouroboros');
    expect(parsed?.cloneUrl).toMatch(/^git@github\.com:smirea\/[Nn]otouroboros\.git$/);
  }
});

test('non-GitHub remotes keep their URL and local-path remotes are not syncable', () => {
  const gitlab = parseRemote('https://gitlab.com/group/sub/repo.git');
  expect(gitlab?.key as string | undefined).toBe('gitlab.com/group/sub/repo');
  expect(gitlab?.cloneUrl).toBe('https://gitlab.com/group/sub/repo.git');
  expect(parseRemote('/Users/stefan/code/a-better-me')).toBeUndefined();
});
