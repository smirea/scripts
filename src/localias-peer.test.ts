import { describe, expect, test } from 'bun:test';

import { parseLocaliasList, planAliasChanges, planRoutes } from './localias-peer';

const options = { name: 'mini', portOffset: 5_000 };

describe('parseLocaliasList', () => {
  test('reads `localias list` lines and strips explicit schemes', () => {
    expect(parseLocaliasList('vitals.localhost -> 6000\nhttps://secure.test -> 9000\nnoise\n')).toEqual([
      { host: 'vitals.localhost', port: 6000 },
      { host: 'secure.test', port: 9000 },
    ]);
  });
});

describe('planRoutes', () => {
  test('names peer ports after this machine\'s projects and forwards them at port + offset', () => {
    const { routes } = planRoutes(
      [{ host: 'new-you-times.localhost', port: 6060 }],
      [{ host: 'mini-new-you-times.local', port: 6060 }, { host: 'only-on-mini.test', port: 7000 }],
      options,
    );
    expect(routes).toEqual([
      { host: 'new-you-times.mini.localhost', peerPort: 6060, localPort: 11060 },
      { host: 'only-on-mini.mini.localhost', peerPort: 7000, localPort: 12000 },
    ]);
  });

  test('ignores its own aliases so routes do not feed back into themselves', () => {
    const { routes } = planRoutes([{ host: 'vitals.mini.localhost', port: 11000 }], [], options);
    expect(routes).toEqual([]);
  });

  test('skips peer ports that would overflow the port range', () => {
    const { routes, skipped } = planRoutes([{ host: 'high.localhost', port: 61_000 }], [], options);
    expect(routes).toEqual([]);
    expect(skipped).toHaveLength(1);
  });
});

describe('planAliasChanges', () => {
  test('converges: adds missing, fixes wrong ports, removes stale, leaves other aliases alone', () => {
    const current = [
      { host: 'vitals.localhost', port: 6000 },
      { host: 'vitals.mini.localhost', port: 11000 },
      { host: 'moved.mini.localhost', port: 1 },
      { host: 'stale.mini.localhost', port: 11999 },
    ];
    const routes = [
      { host: 'vitals.mini.localhost', peerPort: 6000, localPort: 11000 },
      { host: 'moved.mini.localhost', peerPort: 6010, localPort: 11010 },
      { host: 'new.mini.localhost', peerPort: 6020, localPort: 11020 },
    ];
    expect(planAliasChanges(current, routes, 'mini')).toEqual({
      remove: ['stale.mini.localhost'],
      set: [{ host: 'moved.mini.localhost', port: 11010 }, { host: 'new.mini.localhost', port: 11020 }],
    });
    expect(planAliasChanges(routes.map(route => ({ host: route.host, port: route.localPort })), routes, 'mini')).toEqual({ remove: [], set: [] });
  });
});
