import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

import { run } from './shell';

export type Device = { name: string; udid: string; state: string; dataPath: string; runtime: string };
export type Claim = { worktree: string; lastUsed: number };

export const CLAIM_FILE = 'agent-simulator-claim';
// Written by the per-repo scripts this replaced; read so their simulators still count as claimed.
const LEGACY_CLAIM_FILES = ['procrastimate-worktree', 'a-better-me-worktree'];

export const CPU_LIMIT = 70;
export const MAX_BOOTED = Number(process.env.AGENT_SIMULATOR_MAX_BOOTED ?? 4);
// Short enough that the wait plus an incremental build fits an agent's 600-second tool limit.
const WAIT_MS = 3 * 60_000;
const IDLE_MS = 15 * 60_000;

const simctl = (...args: string[]) => run(['xcrun', 'simctl', ...args]);

export function devices(): Device[] {
  const { devices } = JSON.parse(simctl('list', 'devices', '--json')) as { devices: Record<string, Omit<Device, 'runtime'>[]> };
  return Object.entries(devices).flatMap(([runtime, list]) => list.map(device => ({ ...device, runtime })));
}

const isPhone = (device: Device) => device.runtime.includes('SimRuntime.iOS');

export function owner(device: Pick<Device, 'dataPath'>): Claim | undefined {
  const claims = [CLAIM_FILE, ...LEGACY_CLAIM_FILES]
    .map(name => join(device.dataPath, name))
    .filter(file => existsSync(file))
    .map(file => ({ worktree: readFileSync(file, 'utf8').trim(), lastUsed: statSync(file).mtimeMs }));
  return claims.sort((a, b) => b.lastUsed - a.lastUsed)[0];
}

/** Rewrites the claim on every use, so its mtime is the simulator's last use. */
export function claim(device: Pick<Device, 'dataPath'>, worktree: string) {
  mkdirSync(device.dataPath, { recursive: true });
  writeFileSync(join(device.dataPath, CLAIM_FILE), worktree);
  for (const name of LEGACY_CLAIM_FILES) if (existsSync(join(device.dataPath, name))) unlinkSync(join(device.dataPath, name));
}

const namedFor = (worktree: string) => new RegExp(`^${RegExp.escape(simulatorName(worktree))}(-[\\w]+)?$`);

/** The simulators a worktree owns: claimed by it, or unclaimed and named after its directory (`<dir>`, `<dir>-<n>`). */
export function ownedBy(worktree: string, all = devices()): Device[] {
  return all.filter(device => {
    if (!isPhone(device)) return false;
    const claimed = owner(device);
    return claimed ? claimed.worktree === worktree : namedFor(worktree).test(device.name);
  });
}

function unclaim(device: Device) {
  for (const name of [CLAIM_FILE, ...LEGACY_CLAIM_FILES]) if (existsSync(join(device.dataPath, name))) unlinkSync(join(device.dataPath, name));
}

const SESSIONS = join(homedir(), '.t3/userdata/device/agent-device/sessions');

/** agent-device, which T3's `device_open` drives through, logs each request with the UDID in its session folder. */
function drivenRecently(udid: string): boolean {
  if (!existsSync(SESSIONS)) return false;
  return run(['find', SESSIONS, '-type', 'f', '-mmin', `-${IDLE_MS / 60_000}`, '-exec', 'grep', '-l', udid, '{}', '+'], { allowFail: true }) !== '';
}

export const simulatorName = (worktree: string, n?: number) => `${basename(worktree).replaceAll(/[^\w.-]/g, '-')}${n ? `-${n}` : ''}`;

export function shutdown(device: Device) {
  if (device.state !== 'Shutdown') spawnSync('xcrun', ['simctl', 'shutdown', device.udid]);
}

/** Deletes the simulator and every watch paired with it, which `simctl delete` of the phone leaves behind. */
export function remove(device: Device) {
  const { pairs } = JSON.parse(simctl('list', 'pairs', '--json')) as { pairs: Record<string, { watch: { udid: string }; phone: { udid: string } }> };
  const watches = Object.values(pairs).filter(pair => pair.phone.udid === device.udid).map(pair => pair.watch.udid);
  shutdown(device);
  for (const udid of [device.udid, ...watches]) run(['xcrun', 'simctl', 'delete', udid], { allowFail: true });
}

/** The worktree's simulator, created on the newest iOS runtime as its newest iPhone Pro when missing. */
export function ensure(worktree: string, n?: number): Device {
  const all = devices();
  const takenByOther = (device: Device) => {
    const claimed = owner(device)?.worktree;
    return Boolean(claimed && claimed !== worktree && existsSync(join(claimed, '.git')));
  };
  // Worktree directories repeat across projects (two `agent-migrate` checkouts), so a name another live worktree holds
  // gets a suffix from this worktree's path.
  let name = simulatorName(worktree, n);
  const clash = all.find(device => device.name === name && isPhone(device));
  if (clash && takenByOther(clash)) name = `${name}-${Bun.hash(worktree).toString(36).slice(0, 6)}`;
  const existing = all.find(device => device.name === name && isPhone(device) && !takenByOther(device));
  if (existing) return existing;
  const { runtimes } = JSON.parse(simctl('list', 'runtimes', '--json')) as {
    runtimes: { identifier: string; version: string; platform: string; isAvailable: boolean; supportedDeviceTypes: { identifier: string; name: string }[] }[];
  };
  const runtime = runtimes
    .filter(r => r.isAvailable && r.platform === 'iOS')
    .sort((a, b) => Bun.semver.order(`${a.version}.0`.split('.').slice(0, 3).join('.'), `${b.version}.0`.split('.').slice(0, 3).join('.')))
    .at(-1);
  if (!runtime) throw new Error('No iOS simulator runtime is installed. Add one in Xcode settings.');
  const pro = runtime.supportedDeviceTypes
    .map(type => ({ type, model: Number(type.name.match(/^iPhone (\d+) Pro$/)?.[1]) }))
    .filter(entry => entry.model)
    .sort((a, b) => a.model - b.model)
    .at(-1)?.type;
  const type = pro ?? runtime.supportedDeviceTypes.find(type => type.name.startsWith('iPhone'));
  if (!type) throw new Error(`The ${runtime.identifier} runtime has no iPhone device type.`);
  const udid = simctl('create', name, type.identifier, runtime.identifier);
  console.error(`Created simulator ${name} (${type.name}, iOS ${runtime.version}).`);
  const created = devices().find(device => device.udid === udid);
  if (!created) throw new Error(`simctl created ${name} but does not list it.`);
  return created;
}

/** Total CPU use across all cores, in percent, from the second of two `top` samples (the first covers all uptime). */
export function cpuUsage(): number {
  const samples = [...run(['top', '-l', '2', '-n', '0', '-s', '1']).matchAll(/CPU usage:.*?([\d.]+)% idle/g)];
  const idle = samples.at(-1)?.[1];
  if (!idle) throw new Error('`top` printed no CPU usage line.');
  return Math.round(100 - Number(idle));
}

const bootedPhones = () => devices().filter(device => device.state === 'Booted' && isPhone(device));

/**
 * Every booted simulator slows every other agent's build, so an agent boots one only while the Mac has room: total CPU
 * at or under CPU_LIMIT and fewer than MAX_BOOTED iPhone simulators running. After three minutes it exits 3, the code
 * agents treat as "rerun", so a tool call never hits the 600-second limit.
 */
export async function waitForRoom(what: string) {
  const blocked = () => {
    const booted = bootedPhones().length;
    if (booted >= MAX_BOOTED) return `${booted} simulators are booted (limit ${MAX_BOOTED})`;
    const usage = cpuUsage();
    return usage > CPU_LIMIT ? `CPU is at ${usage}% (limit ${CPU_LIMIT}%)` : undefined;
  };
  let reason = blocked();
  if (!reason) return;
  const deadline = Date.now() + WAIT_MS;
  console.error(`${reason}, so ${what} waits…`);
  while (reason) {
    if (Date.now() > deadline) {
      console.error(`Still waiting after 3 minutes: ${reason}. Rerun the same command to keep waiting.`);
      process.exit(3);
    }
    await Bun.sleep(20_000);
    reason = blocked();
    if (reason) console.error(`${reason}.`);
  }
}

export function status(): string {
  const booted = bootedPhones().map(device => device.name);
  const load = run(['sysctl', '-n', 'vm.loadavg'], { allowFail: true }).replaceAll(/[{}]/g, '').trim();
  return `CPU ${cpuUsage()}% (boots wait above ${CPU_LIMIT}%); load ${load} on ${navigator.hardwareConcurrency} cores; ${booted.length}/${MAX_BOOTED} booted simulators${booted.length ? ` (${booted.join(', ')})` : ''}.`;
}

/**
 * Deletes simulators whose claiming worktree is gone, shuts down claimed ones idle for 15 minutes that no running process
 * names, and deletes Xcode DerivedData whose workspace no longer exists.
 */
export function gc({ dryRun = false } = {}): string[] {
  const messages: string[] = [];
  const act = (message: string, action: () => void) => {
    messages.push(`${dryRun ? 'Would: ' : ''}${message}`);
    if (!dryRun) action();
  };
  // A booted simulator's own processes carry its UDID in their paths, so only processes outside CoreSimulator count.
  const processes = run(['ps', '-axww', '-o', 'command='], { allowFail: true }).split('\n').filter(line => !line.includes('/CoreSimulator/'));
  for (const device of devices()) {
    const claimed = owner(device);
    if (!claimed) continue;
    const inUse = processes.some(line => line.includes(device.udid)) || drivenRecently(device.udid);
    if (!existsSync(join(claimed.worktree, '.git'))) {
      // Only a simulator made for that worktree is deleted; a stock one it borrowed just loses the claim.
      if (!namedFor(claimed.worktree).test(device.name)) act(`release ${device.name}, claimed by the removed ${claimed.worktree}`, () => unclaim(device));
      else if (device.state !== 'Shutdown' || inUse) messages.push(`keep ${device.name}: booted or in use, though its worktree ${claimed.worktree} is gone`);
      else act(`delete simulator ${device.name}; its worktree ${claimed.worktree} is gone`, () => remove(device));
    } else if (device.state === 'Booted' && Date.now() - claimed.lastUsed > IDLE_MS && !inUse) {
      act(`shut down ${device.name}, idle ${Math.round((Date.now() - claimed.lastUsed) / 60_000)} minutes`, () => shutdown(device));
    }
  }
  const derivedData = join(homedir(), 'Library/Developer/Xcode/DerivedData');
  for (const entry of existsSync(derivedData) ? readdirSync(derivedData) : []) {
    const info = join(derivedData, entry, 'info.plist');
    if (!existsSync(info)) continue;
    const workspace = run(['plutil', '-extract', 'WorkspacePath', 'raw', info], { allowFail: true });
    if (!workspace || existsSync(workspace)) continue;
    act(`delete DerivedData ${entry} of the removed ${workspace}`, () => rmSync(join(derivedData, entry), { recursive: true, force: true }));
  }
  return messages;
}
