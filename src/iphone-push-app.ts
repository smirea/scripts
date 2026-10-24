#!/usr/bin/env bun
import { createScript } from './utils/createScript';
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CODE_ROOT = path.join(os.homedir(), 'code');
const BUILD_ROOT = path.join(os.homedir(), 'Library/Caches/iphone-release-builds');
const PROJECT_SEARCH_SKIP = new Set(['node_modules', 'DerivedData', 'Pods', 'build', '.git']);

interface Device {
  identifier: string;
  name: string;
  udid?: string;
  physicalIOS: boolean;
  paired: boolean;
  developerModeDisabled: boolean;
}

interface XcodeProject {
  flag: '-project' | '-workspace';
  path: string;
  scheme: string;
}

if (import.meta.main) {
  void createScript('iphone-push-app')
    .command('$0 <apps..>', 'Fast-forward each app\'s git checkout, build it in Release, install it on a paired iPhone without deleting app data, and launch it', (y) => y
      .positional('apps', {
        type: 'string',
        array: true,
        demandOption: true,
        describe: `App directories; a bare name resolves to ${CODE_ROOT}/<name>`,
      })
      .option('device', { type: 'string', describe: 'Device UDID; defaults to the only paired physical iPhone' })
      .option('scheme', { type: 'string', describe: 'Xcode scheme; defaults to the scheme named like the project, or the only scheme' })
      .option('pull', { type: 'boolean', default: true, describe: 'Fast-forward the git checkout before building' }),
    async (argv) => {
      preflight();
      const dirs = argv.apps.map(resolveAppDir);
      const device = selectDevice(argv.device);
      checkPhone(device);
      for (const dir of dirs) pushApp(dir, device, { scheme: argv.scheme, pull: argv.pull });
    })
    .parseAsync();
}

function preflight() {
  if (process.platform !== 'darwin') throw new Error('Run this on a Mac with Xcode installed.');
  if (run('xcodebuild', ['-version']).status !== 0) {
    throw new Error('Xcode is not ready. Open Xcode, finish its first-run setup, and select it in Xcode > Settings > Locations > Command Line Tools.');
  }
  if (run('xcrun', ['--find', 'devicectl']).status !== 0) {
    throw new Error('The selected Xcode does not provide devicectl. Select your current Xcode in Settings > Locations.');
  }
  mkdirSync(BUILD_ROOT, { recursive: true });
}

function resolveAppDir(app: string): string {
  const dir = app.includes('/') || app.startsWith('.') ? path.resolve(app.replace(/^~(?=\/|$)/, os.homedir())) : path.join(CODE_ROOT, app);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`App directory not found: ${dir}`);
  return dir;
}

function pushApp(dir: string, device: Device, options: { scheme?: string; pull: boolean }) {
  const name = path.basename(dir);
  const buildDir = path.join(BUILD_ROOT, name);
  mkdirSync(buildDir, { recursive: true });

  const repoRoot = gitRoot(dir);
  if (options.pull && repoRoot) fastForward(repoRoot, name);
  if (repoRoot && (existsSync(path.join(repoRoot, 'bun.lock')) || existsSync(path.join(repoRoot, 'bun.lockb')))) {
    console.log(`Installing ${name} dependencies...`);
    runOrThrow(process.execPath, ['install'], { cwd: repoRoot, error: `bun install failed in ${repoRoot}` });
  }

  const project = findProject(dir, options.scheme);
  const buildLog = path.join(buildDir, 'build.log');
  console.log(`Building ${name} (${path.relative(dir, project.path) || project.path}, scheme ${project.scheme}, Release)... Log: ${buildLog}`);
  const build = runLogged('xcodebuild', [
    project.flag, project.path, '-scheme', project.scheme,
    '-configuration', 'Release', '-destination', `platform=iOS,id=${device.identifier}`,
    '-derivedDataPath', buildDir, '-allowProvisioningUpdates', 'build',
  ], buildLog);
  if (!build.ok) {
    const hint = /provision|signing|certificate|development team/i.test(build.log)
      ? 'Check your Apple account and Signing & Capabilities in Xcode; select your team and automatic signing.'
      : /destination|device.*unavailable|device.*locked/i.test(build.log)
        ? 'Reconnect and unlock your iPhone, then retry.'
        : 'Open the project in Xcode and build the Release scheme to see the compiler error.';
    throw new Error(`Build failed; see ${buildLog}. Nothing was installed for ${name}.\n${hint}`);
  }

  const appPath = findBuiltApp(path.join(buildDir, 'Build/Products/Release-iphoneos'), project.scheme);
  const bundleId = runOrThrow('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', path.join(appPath, 'Info.plist')], {
    error: `Could not read the bundle identifier of ${appPath}`,
  }).trim();

  checkPhone(device);
  console.log(`Installing ${name} (${bundleId}) on ${device.name}...`);
  const installLog = path.join(buildDir, 'install.log');
  const install = runLogged('xcrun', ['devicectl', 'device', 'install', 'app', '--device', device.identifier, '--timeout', '180', appPath], installLog);
  if (!install.ok) deviceFailure(`${name} could not be installed`, installLog, install.log);

  const launchLog = path.join(buildDir, 'launch.log');
  const launch = runLogged('xcrun', ['devicectl', 'device', 'process', 'launch', '--device', device.identifier, '--timeout', '30', '--terminate-existing', bundleId], launchLog);
  if (!launch.ok) deviceFailure(`${name} was installed, but automatic launch failed. Try opening it manually`, launchLog, launch.log);
  console.log(`${name} updated and launched.`);
}

function gitRoot(dir: string): string | undefined {
  const result = run('git', ['-C', dir, 'rev-parse', '--show-toplevel']);
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function fastForward(repoRoot: string, name: string) {
  console.log(`Fast-forwarding ${name}...`);
  const result = run('git', ['-C', repoRoot, 'pull', '--ff-only']);
  if (result.status !== 0) {
    throw new Error(`git pull --ff-only failed in ${repoRoot}. Resolve it manually or pass --no-pull.\n${result.stderr.trim()}`);
  }
  console.log(result.stdout.trim());
}

function findProject(dir: string, scheme?: string): XcodeProject {
  const candidates = (base: string) => readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /\.(xcworkspace|xcodeproj)$/.test(entry.name))
    .map((entry) => path.join(base, entry.name))
    .sort((a, b) => Number(b.endsWith('.xcworkspace')) - Number(a.endsWith('.xcworkspace')));
  let found = candidates(dir);
  if (!found.length) {
    found = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !PROJECT_SEARCH_SKIP.has(entry.name))
      .flatMap((entry) => candidates(path.join(dir, entry.name)));
  }
  const projectPath = found[0];
  if (!projectPath) throw new Error(`No .xcodeproj or .xcworkspace found in ${dir} or its immediate subdirectories.`);
  if (new Set(found.map((p) => path.dirname(p))).size > 1) {
    throw new Error(`Multiple Xcode projects found; pass the directory containing the one you want:\n${found.join('\n')}`);
  }

  const flag = projectPath.endsWith('.xcworkspace') ? '-workspace' : '-project';
  if (scheme) return { flag, path: projectPath, scheme };
  const listing = JSON.parse(runOrThrow('xcodebuild', ['-list', '-json', flag, projectPath], { error: `xcodebuild -list failed for ${projectPath}` }));
  const info = listing.project ?? listing.workspace;
  const schemes: string[] = info?.schemes ?? [];
  const projectName = path.basename(projectPath).replace(/\.(xcworkspace|xcodeproj)$/, '');
  const picked = schemes.find((s) => s === (info?.name ?? projectName)) ?? (schemes.length === 1 ? schemes[0] : undefined);
  if (!picked) throw new Error(`Cannot pick a scheme for ${projectPath}; pass --scheme. Available: ${schemes.join(', ') || 'none'}`);
  return { flag, path: projectPath, scheme: picked };
}

function findBuiltApp(productsDir: string, scheme: string): string {
  const apps = existsSync(productsDir) ? readdirSync(productsDir).filter((entry) => entry.endsWith('.app')) : [];
  const app = apps.length === 1 ? apps[0] : apps.find((entry) => entry === `${scheme}.app`);
  if (!app) throw new Error(`Cannot find the built app in ${productsDir} (found: ${apps.join(', ') || 'none'}).`);
  return path.join(productsDir, app);
}

function selectDevice(requested?: string): Device {
  const output = path.join(BUILD_ROOT, 'devices.json');
  const log = path.join(BUILD_ROOT, 'device-check.log');
  console.log('Checking iPhone connection...');
  const list = runLogged('xcrun', ['devicectl', 'list', 'devices', '--timeout', '20', '--json-output', output], log);
  if (!list.ok) deviceFailure('Xcode could not list devices', log, list.log);

  const devices: Device[] = JSON.parse(readFileSync(output, 'utf8')).result.devices.map((raw: any): Device => {
    const props = raw.properties ?? {};
    const hardware = props.hardware ?? raw.hardwareProperties ?? {};
    const connection = props.connection ?? raw.connectionProperties ?? {};
    const mode = props.state?.developerModeStatus ?? raw.deviceProperties?.developerModeStatus;
    return {
      identifier: raw.identifier,
      name: raw.deviceProperties?.name ?? props.name ?? raw.identifier,
      udid: hardware.udid,
      physicalIOS: hardware.reality === 'physical' && hardware.platform === 'iOS',
      paired: connection.pairingState === 'paired',
      developerModeDisabled: mode === 'disabled',
    };
  });

  let device: Device | undefined;
  if (requested) {
    device = devices.find((d) => requested === d.identifier || requested === d.udid);
    if (!device) throw new Error(`Phone not found: ${requested}. Connect it by USB and unlock it. Run 'xcrun devicectl list devices' to check the UDID.`);
    if (!device.physicalIOS) throw new Error(`${device.name} is not a physical iOS device.`);
  } else {
    const phones = devices.filter((d) => d.physicalIOS && d.paired);
    if (phones.length !== 1) {
      throw new Error(phones.length
        ? `Multiple paired iPhones; pass --device:\n${phones.map((d) => `  ${d.udid ?? d.identifier}  ${d.name}`).join('\n')}`
        : 'No paired iPhone found. Connect it by USB, unlock it, accept Trust This Computer, and pair it in Xcode.');
    }
    device = phones[0]!;
  }
  if (!device.paired) throw new Error(`${device.name} is not paired. Connect it by USB, unlock it, accept Trust This Computer, and pair it in Xcode.`);
  if (device.developerModeDisabled) throw new Error('Enable Developer Mode in iPhone Settings > Privacy & Security, complete the restart, and retry.');
  return device;
}

function checkPhone(device: Device) {
  const output = path.join(BUILD_ROOT, 'lock-state.json');
  const log = path.join(BUILD_ROOT, 'device-check.log');
  // A disconnected tunnel in the device list can reconnect on demand, so probe the phone directly.
  const probe = runLogged('xcrun', ['devicectl', 'device', 'info', 'lockState', '--device', device.identifier, '--timeout', '20', '--json-output', output], log);
  if (!probe.ok) deviceFailure(`${device.name} is paired, but Xcode could not reach it`, log, probe.log);
  const state = JSON.parse(readFileSync(output, 'utf8')).result;
  if (!('passcodeRequired' in state) && !('unlockedSinceBoot' in state)) {
    throw new Error('Xcode returned an unknown lock status. Unlock your phone and check it in Xcode.');
  }
  if (state.passcodeRequired === true || state.unlockedSinceBoot === false) {
    throw new Error('Your iPhone needs unlocking. Enter its passcode, keep it awake, and retry.');
  }
}

function deviceFailure(stage: string, logPath: string, log: string): never {
  const hint = /locked|passcode|unlock/i.test(log)
    ? 'Unlock your iPhone with its passcode, keep it awake, and retry.'
    : /developer mode/i.test(log)
      ? 'Enable Developer Mode in iPhone Settings > Privacy & Security, complete the restart, and retry.'
      : /provision|signature|signing|certificate|integrity/i.test(log)
        ? 'Open the project in Xcode and check Signing & Capabilities: select your team and automatic signing.'
        : /space|storage/i.test(log)
          ? 'Check free storage in iPhone Settings > General > iPhone Storage.'
          : 'Connect the iPhone by USB, unlock it, and accept Trust This Computer. Check that it appears in Xcode\'s device window. Same-tailnet connectivity alone is not sufficient.';
  throw new Error(`${stage}. Details: ${logPath}\n${hint}`);
}

function run(command: string, args: string[], cwd?: string) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  return { status: result.error ? 1 : result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? String(result.error ?? '') };
}

function runOrThrow(command: string, args: string[], options: { cwd?: string; error: string }): string {
  const result = run(command, args, options.cwd);
  if (result.status !== 0) throw new Error(`${options.error}\n${result.stderr.trim()}`);
  return result.stdout;
}

function runLogged(command: string, args: string[], logPath: string) {
  const fd = openSync(logPath, 'w');
  const result = spawnSync(command, args, { stdio: ['ignore', fd, fd] });
  closeSync(fd);
  return { ok: !result.error && result.status === 0, log: readFileSync(logPath, 'utf8') };
}
