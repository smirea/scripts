#!/usr/bin/env bun
import { createScript } from './utils/createScript';
import chalk from 'chalk';
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const CODE_ROOT = path.join(os.homedir(), 'code');
const BUILD_ROOT = path.join(os.homedir(), 'Library/Caches/iphone-release-builds');
const PROJECT_SEARCH_SKIP = new Set(['node_modules', 'DerivedData', 'Pods', 'build', '.git']);
const PRODUCTION_ENVIRONMENT = /^(prod|production)$/i;
const ENV_MANAGER_NOT_INITIALIZED = 3;
// Public r2.dev bucket with a 7-day expiry rule; uploads sit under an unguessable random prefix.
const LINK_BUCKET = 'iphone-push-app';
const LINK_EXPIRY_DAYS = 7;
const LABEL_WIDTH = 9;

interface Device {
  identifier: string;
  name: string;
  udid?: string;
  physicalIOS: boolean;
  paired: boolean;
  developerModeDisabled: boolean;
}

interface EnvManagerInfo {
  root: string;
  local: boolean;
  mode: 'targets' | 'single';
  environment: { current: string; valuesLoadedFrom: string | null };
  environments: string[] | null;
  environmentsError: string | null;
  storedSchema: 'in-sync' | 'differs' | 'missing' | null;
  values: { path: string };
  outputs: { target: string | null; kind: 'values' | 'reader'; path: string }[];
}

interface EnvSelection {
  name: string;
  root: string;
  args: string[];
  restore: string[];
}

interface AppPlan {
  team?: string;
  dir: string;
  name: string;
  project: XcodeProject;
  env: EnvSelection | null;
}

interface XcodeProject {
  flag: '-project' | '-workspace';
  path: string;
  scheme: string;
}

if (import.meta.main) {
  void createScript('iphone-push-app')
    .command('$0 <apps..>', 'Fast-forward each app\'s git checkout, build it in Release, install it on a paired iPhone without deleting app data, and launch it (or upload it behind an install link with --link)', (y) => y
      .positional('apps', {
        type: 'string',
        array: true,
        demandOption: true,
        describe: `App directories; a bare name resolves to ${CODE_ROOT}/<name>`,
      })
      .option('device', { type: 'string', describe: 'Device UDID; defaults to the only paired physical iPhone' })
      .option('team', { type: 'string', describe: 'Apple development team ID for projects that do not set one; defaults to the team of your only Apple Development certificate' })
      .option('scheme', { type: 'string', describe: 'Xcode scheme; defaults to the scheme named like the project, or the only scheme' })
      .option('pull', { type: 'boolean', default: true, describe: 'Fast-forward the git checkout before building' })
      .option('env', {
        type: 'string',
        describe: 'env-manager environment to build with; defaults to prod/production, or the only stored environment',
      })
      .option('link', {
        type: 'boolean',
        default: false,
        describe: `Instead of installing over USB/network, upload a development-signed build and print an install link (works for devices registered to your team; expires after ${LINK_EXPIRY_DAYS} days)`,
      })
      .conflicts('link', 'device'),
    async (argv) => {
      preflight();
      const linkBase = argv.link ? linkBucketUrl() : undefined;
      const plans = argv.apps.map(resolveAppDir).map((dir) => planApp(dir, { scheme: argv.scheme, pull: argv.pull, env: argv.env, team: argv.team }));
      if (linkBase) {
        for (const plan of plans) publishApp(plan, linkBase);
        return;
      }
      header('iPhone');
      const device = task('device', argv.device ?? 'paired iPhone', () => selectDevice(argv.device), (d) => d.name);
      task('reach', 'lock state', () => checkPhone(device), () => 'unlocked');
      for (const plan of plans) pushApp(plan, device);
    })
    .parseAsync();
}

function preflight() {
  if (process.platform !== 'darwin') throw new Error('Needs macOS with Xcode.');
  if (run('xcodebuild', ['-version']).status !== 0) {
    throw new Error('Xcode is not set up. Open it once, then select it under Settings > Locations > Command Line Tools.');
  }
  if (run('xcrun', ['--find', 'devicectl']).status !== 0) {
    throw new Error('The selected Xcode has no devicectl. Select a current Xcode under Settings > Locations.');
  }
  mkdirSync(BUILD_ROOT, { recursive: true });
}

function resolveAppDir(app: string): string {
  const dir = app.includes('/') || app.startsWith('.') ? path.resolve(app.replace(/^~(?=\/|$)/, os.homedir())) : path.join(CODE_ROOT, app);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`No app directory at ${tilde(dir)}.`);
  return dir;
}

// Everything that can reject an app runs for all apps before the first build starts.
function planApp(dir: string, options: { scheme?: string; pull: boolean; env?: string; team?: string }): AppPlan {
  const name = path.basename(dir);
  header(name, tilde(dir));
  const repoRoot = gitRoot(dir);
  if (options.pull && repoRoot) task('git', 'pull --ff-only', () => fastForward(repoRoot), (summary) => summary);
  if (repoRoot && (existsSync(path.join(repoRoot, 'bun.lock')) || existsSync(path.join(repoRoot, 'bun.lockb')))) {
    task('deps', 'bun install', () => runOrThrow(process.execPath, ['install'], { cwd: repoRoot, error: `bun install failed in ${tilde(repoRoot)}` }));
  }
  const env = selectEnvironment(dir, repoRoot, options.env);
  const project = findProject(dir, options.scheme);
  line('project', `${path.relative(dir, project.path) || project.path} ${chalk.dim('·')} scheme ${project.scheme}`);
  return { dir, name, env, team: options.team, project };
}

function readEnvManagerInfo(dir: string, repoRoot: string | undefined): EnvManagerInfo | null {
  const result = spawnSync('env-manager', ['info'], { cwd: dir, encoding: 'utf8' });
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return null;
  if (result.status === ENV_MANAGER_NOT_INITIALIZED) return null;
  if (result.status !== 0) throw new Error(`env-manager info failed in ${tilde(dir)}:\n${(result.stderr || String(result.error)).trim()}`);
  const info: EnvManagerInfo = JSON.parse(result.stdout);
  // env-manager walks up to the nearest .env, which can belong to an unrelated parent directory.
  if (repoRoot && path.relative(repoRoot, info.root).startsWith('..')) return null;
  return info;
}

function selectEnvironment(dir: string, repoRoot: string | undefined, requested?: string): EnvSelection | null {
  const name = path.basename(dir);
  const info = readEnvManagerInfo(dir, repoRoot);
  if (!info) {
    if (requested) throw new Error(`--env ${requested}: ${name} has no env-manager setup (or env-manager is not installed).`);
    line('env', chalk.dim('no env-manager setup'));
    return null;
  }
  if (info.local) {
    if (requested) throw new Error(`--env ${requested}: ${name} uses env-manager local mode, which has no stored environments.`);
    line('env', `current local values ${chalk.dim('(local mode)')}`);
    return null;
  }
  if (!info.environments) throw new Error(`Can't read ${name}'s env-manager environments: ${info.environmentsError}`);
  const available = info.environments.join(', ') || 'none';
  if (requested) {
    if (!info.environments.includes(requested)) throw new Error(`Unknown environment "${requested}" for ${name}. Available: ${available}.`);
  } else if (!info.environments.length) {
    line('env', `current local values ${chalk.dim('(none stored)')}`);
    return null;
  }

  let selected = requested;
  if (!selected) {
    const production = info.environments.filter((env) => PRODUCTION_ENVIRONMENT.test(env));
    if (production.length > 1) throw new Error(`${name} has several production environments (${production.join(', ')}); pick one with --env.`);
    selected = production[0] ?? (info.environments.length === 1 ? info.environments[0] : undefined);
    if (!selected) throw new Error(`${name} has no prod environment; pick one with --env. Available: ${available}.`);
  }
  const { current, valuesLoadedFrom } = info.environment;
  const restored = chalk.dim(`(currently ${current}, restored after the build)`);
  if (info.mode === 'targets') {
    line('env', `${selected} ${restored}`);
    return {
      name: selected,
      root: info.root,
      args: ['gen', '--env', selected],
      restore: info.outputs.filter((output) => output.target && output.kind === 'values').map((output) => output.path),
    };
  }

  // Single-project values files are the build input, so they come from `down`. It also
  // replaces .env with the stored schema, which would silently regress a newer local one.
  if (info.storedSchema !== 'in-sync') {
    throw new Error([
      `${name}'s .env differs from the schema stored in AWS, so env-manager down would overwrite it.`,
      `In ${tilde(info.root)}, run env-manager up (local is newer) or env-manager down (AWS is newer), then retry.`,
    ].join('\n'));
  }
  if (current === selected && (valuesLoadedFrom ?? current) === selected) {
    line('env', selected);
    return { name: selected, root: info.root, args: ['down'], restore: [] };
  }
  line('env', `${selected} ${restored}`);
  return {
    name: selected,
    root: info.root,
    args: ['down', '--env', selected],
    restore: [...new Set([info.values.path, path.join(info.root, '.env.local')])],
  };
}

// Restoring the touched files byte for byte keeps the checkout on its selected environment
// without another AWS round trip, even if the build fails or is interrupted.
function withEnvironment<T>(env: EnvSelection, build: () => T): T {
  const snapshot = new Map(env.restore.map((file) => [file, existsSync(file) ? readFileSync(file) : null]));
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    for (const [file, content] of snapshot) {
      if (content) writeFileSync(file, content);
      else if (existsSync(file)) unlinkSync(file);
    }
  };
  const onSignal = () => {
    restore();
    process.exit(130);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    const command = `env-manager ${env.args.join(' ')}`;
    task('env', command, () => runOrThrow('env-manager', env.args, { cwd: env.root, error: `${command} failed in ${tilde(env.root)}` }));
    return build();
  } finally {
    restore();
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}

function certificateTeam(): string | undefined {
  const pem = run('security', ['find-certificate', '-a', '-c', 'Apple Development', '-p']).stdout;
  const teams = new Set<string>();
  for (const cert of pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? []) {
    const result = spawnSync('openssl', ['x509', '-noout', '-subject', '-checkend', '0'], { input: cert, encoding: 'utf8' });
    const team = result.stdout.match(/OU\s*=\s*([A-Z0-9]{10})/)?.[1];
    if (result.status === 0 && team) teams.add(team);
  }
  return teams.size === 1 ? [...teams][0] : undefined;
}

// Some projects deliberately leave DEVELOPMENT_TEAM out of version control and expect it
// per machine, so a missing team is filled in and the build retried instead of failing.
// Returns the team that was passed, if any.
function xcodebuild({ name, project, env, team: requestedTeam }: AppPlan, buildDir: string, args: string[]): string | undefined {
  const buildLog = path.join(buildDir, 'build.log');
  let team = requestedTeam;
  const runOnce = () => task('build', `Release${team ? ` ${chalk.dim('·')} team ${team}` : ''}`, () => runLogged('xcodebuild', [
    project.flag, project.path, '-scheme', project.scheme, '-configuration', 'Release',
    '-derivedDataPath', buildDir, '-allowProvisioningUpdates', ...args, ...(team ? [`DEVELOPMENT_TEAM=${team}`] : []),
  ], buildLog));
  const runBuild = () => {
    const first = runOnce();
    if (first.ok || team || !/requires a development team/i.test(first.log)) return first;
    team = certificateTeam();
    if (!team) throw new Error(`${name} sets no development team, and your Apple Development certificates don't name exactly one. Pass --team <TEAM_ID>.`);
    line('team', `${team} ${chalk.dim('(project sets none; taken from your Apple Development certificate)')}`);
    return runOnce();
  };
  const build = env ? withEnvironment(env, runBuild) : runBuild();
  if (!build.ok) {
    const hint = /provision|signing|certificate|development team/i.test(build.log)
      ? 'Check signing in Xcode: Signing & Capabilities, with your team and automatic signing.'
      : /destination|device.*unavailable|device.*locked/i.test(build.log)
        ? 'Reconnect and unlock the iPhone, then retry.'
        : 'Build the Release scheme in Xcode to see the error.';
    throw new Error(`Build failed for ${name}; nothing was installed.\nLog: ${tilde(buildLog)}\n${hint}`);
  }
  return team;
}

function plistValue(plist: string, key: string): string | undefined {
  const result = run('plutil', ['-extract', key, 'raw', '-o', '-', plist]);
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function linkBucketUrl(): string {
  const result = run('wrangler', ['r2', 'bucket', 'dev-url', 'get', LINK_BUCKET]);
  const url = result.stdout.match(/https:\/\/pub-[a-z0-9]+\.r2\.dev/)?.[0];
  if (result.status !== 0 || !url) {
    throw new Error([
      `--link needs the public R2 bucket "${LINK_BUCKET}" and a logged-in wrangler. One-time setup:`,
      `  wrangler r2 bucket create ${LINK_BUCKET}`,
      `  wrangler r2 bucket dev-url enable ${LINK_BUCKET} --force`,
      `  wrangler r2 bucket lifecycle add ${LINK_BUCKET} expire-builds --expire-days ${LINK_EXPIRY_DAYS} --force`,
      (result.stderr || result.stdout).trim(),
    ].join('\n'));
  }
  return url;
}

function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/g, (char) => `&#${char.charCodeAt(0)};`);
}

// Over-the-air install: iOS fetches the manifest from an itms-services:// link, which only
// works from a tapped link in Safari, hence the HTML page. Development signing limits
// installs to devices in the team's provisioning profile.
function publishApp(plan: AppPlan, linkBase: string) {
  const { name, project } = plan;
  const buildDir = path.join(BUILD_ROOT, `${name}-link`);
  const archivePath = path.join(buildDir, `${project.scheme}.xcarchive`);
  const exportPath = path.join(buildDir, 'export');
  mkdirSync(buildDir, { recursive: true });
  header(name, 'install link');
  const team = xcodebuild(plan, buildDir, ['-destination', 'generic/platform=iOS', '-archivePath', archivePath, 'archive']);

  const optionsPath = path.join(buildDir, 'ExportOptions.plist');
  writeFileSync(optionsPath, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>method</key><string>debugging</string><key>signingStyle</key><string>automatic</string>${team ? `<key>teamID</key><string>${team}</string>` : ''}</dict></plist>
`);
  const exportLog = path.join(buildDir, 'export.log');
  const exported = task('export', 'development .ipa', () => runLogged('xcodebuild', ['-exportArchive', '-archivePath', archivePath, '-exportPath', exportPath, '-exportOptionsPlist', optionsPath, '-allowProvisioningUpdates'], exportLog));
  if (!exported.ok) throw new Error(`Export failed for ${name}.\nLog: ${tilde(exportLog)}\nCheck that the iPhone is registered to your team (Xcode > Settings > Accounts).`);
  const ipa = readdirSync(exportPath).find((entry) => entry.endsWith('.ipa'));
  if (!ipa) throw new Error(`Export produced no .ipa in ${tilde(exportPath)}.`);

  const appsDir = path.join(archivePath, 'Products/Applications');
  const infoPlist = path.join(findBuiltApp(appsDir, project.scheme), 'Info.plist');
  const bundleId = plistValue(infoPlist, 'CFBundleIdentifier');
  if (!bundleId) throw new Error(`No bundle identifier in ${tilde(infoPlist)}.`);
  const version = plistValue(infoPlist, 'CFBundleShortVersionString') ?? '1.0';
  const build = plistValue(infoPlist, 'CFBundleVersion');
  const title = plistValue(infoPlist, 'CFBundleDisplayName') ?? plistValue(infoPlist, 'CFBundleName') ?? name;

  const prefix = `${randomBytes(16).toString('hex')}/${name}`;
  const url = (file: string) => `${linkBase}/${prefix}/${file}`;
  const manifest = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>items</key><array><dict>
<key>assets</key><array><dict><key>kind</key><string>software-package</string><key>url</key><string>${escapeXml(url('app.ipa'))}</string></dict></array>
<key>metadata</key><dict><key>bundle-identifier</key><string>${escapeXml(bundleId)}</string><key>bundle-version</key><string>${escapeXml(version)}</string><key>kind</key><string>software</string><key>title</key><string>${escapeXml(title)}</string></dict>
</dict></array></dict></plist>
`;
  const installHref = `itms-services://?action=download-manifest&url=${encodeURIComponent(url('manifest.plist'))}`;
  const label = `${title} ${version}${build ? ` (${build})` : ''}${plan.env ? ` · ${plan.env.name}` : ''}`;
  const page = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Install ${escapeXml(title)}</title>
<style>body{font:17px -apple-system,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;text-align:center}a{display:inline-block;margin-top:16px;padding:14px 28px;border-radius:12px;background:#007aff;color:#fff;text-decoration:none;font-weight:600}p{color:#666}</style></head>
<body><div><h1>${escapeXml(title)}</h1><p>${escapeXml(label)}<br>Built ${escapeXml(new Date().toLocaleString())}</p><a href="${escapeXml(installHref)}">Install</a></div></body></html>
`;
  writeFileSync(path.join(buildDir, 'manifest.plist'), manifest);
  writeFileSync(path.join(buildDir, 'index.html'), page);

  const uploads = [
    ['app.ipa', path.join(exportPath, ipa), 'application/octet-stream'],
    ['manifest.plist', path.join(buildDir, 'manifest.plist'), 'text/xml'],
    ['index.html', path.join(buildDir, 'index.html'), 'text/html; charset=utf-8'],
  ] as const;
  task('upload', `R2 bucket ${LINK_BUCKET}`, () => {
    for (const [file, local, contentType] of uploads) {
      runOrThrow('wrangler', ['r2', 'object', 'put', `${LINK_BUCKET}/${prefix}/${file}`, '--file', local, '--content-type', contentType, '--remote'], {
        error: `Uploading ${file} to R2 failed.`,
      });
    }
  });
  line('ready', `${label} ${chalk.dim(`· expires in ${LINK_EXPIRY_DAYS} days`)}`);
  line('', chalk.bold.underline(url('index.html')));
}

function pushApp(plan: AppPlan, device: Device) {
  const { name, project } = plan;
  const buildDir = path.join(BUILD_ROOT, name);
  mkdirSync(buildDir, { recursive: true });
  header(name, device.name);
  xcodebuild(plan, buildDir, ['-destination', `platform=iOS,id=${device.identifier}`, 'build']);

  const appPath = findBuiltApp(path.join(buildDir, 'Build/Products/Release-iphoneos'), project.scheme);
  const bundleId = runOrThrow('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', path.join(appPath, 'Info.plist')], {
    error: `No bundle identifier in ${tilde(appPath)}.`,
  }).trim();

  const installLog = path.join(buildDir, 'install.log');
  const install = task('install', bundleId, () => {
    checkPhone(device);
    return runLogged('xcrun', ['devicectl', 'device', 'install', 'app', '--device', device.identifier, '--timeout', '180', appPath], installLog);
  });
  if (!install.ok) deviceFailure(`Install failed for ${name}`, installLog, install.log);

  const launchLog = path.join(buildDir, 'launch.log');
  const launch = task('launch', bundleId, () => runLogged('xcrun', ['devicectl', 'device', 'process', 'launch', '--device', device.identifier, '--timeout', '30', '--terminate-existing', bundleId], launchLog));
  if (!launch.ok) deviceFailure(`${name} is installed, but launching it failed; open it manually`, launchLog, launch.log);
}

function gitRoot(dir: string): string | undefined {
  const result = run('git', ['-C', dir, 'rev-parse', '--show-toplevel']);
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function fastForward(repoRoot: string): string {
  const head = () => run('git', ['-C', repoRoot, 'rev-parse', '--short', 'HEAD']).stdout.trim();
  const before = head();
  const result = run('git', ['-C', repoRoot, 'pull', '--ff-only']);
  if (result.status !== 0) {
    throw new Error(`git pull --ff-only failed in ${tilde(repoRoot)}. Resolve it, or pass --no-pull.\n${result.stderr.trim()}`);
  }
  const after = head();
  if (before === after) return 'up to date';
  const count = Number(run('git', ['-C', repoRoot, 'rev-list', '--count', `${before}..${after}`]).stdout.trim());
  return `${count} new commit${count === 1 ? '' : 's'} (${before}..${after})`;
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
  if (!projectPath) throw new Error(`No .xcodeproj or .xcworkspace in ${tilde(dir)} or one level down.`);
  if (new Set(found.map((p) => path.dirname(p))).size > 1) {
    throw new Error(`Several Xcode projects found; pass the directory of the one you want:\n${found.map((p) => `  ${tilde(p)}`).join('\n')}`);
  }

  const flag = projectPath.endsWith('.xcworkspace') ? '-workspace' : '-project';
  if (scheme) return { flag, path: projectPath, scheme };
  const listing = JSON.parse(runOrThrow('xcodebuild', ['-list', '-json', flag, projectPath], { error: `xcodebuild -list failed for ${projectPath}` }));
  const info = listing.project ?? listing.workspace;
  const schemes: string[] = info?.schemes ?? [];
  const projectName = path.basename(projectPath).replace(/\.(xcworkspace|xcodeproj)$/, '');
  const picked = schemes.find((s) => s === (info?.name ?? projectName)) ?? (schemes.length === 1 ? schemes[0] : undefined);
  if (!picked) throw new Error(`Can't pick a scheme for ${tilde(projectPath)}; pass --scheme. Available: ${schemes.join(', ') || 'none'}.`);
  return { flag, path: projectPath, scheme: picked };
}

function findBuiltApp(productsDir: string, scheme: string): string {
  const apps = existsSync(productsDir) ? readdirSync(productsDir).filter((entry) => entry.endsWith('.app')) : [];
  const app = apps.length === 1 ? apps[0] : apps.find((entry) => entry === `${scheme}.app`);
  if (!app) throw new Error(`No built app in ${tilde(productsDir)} (found: ${apps.join(', ') || 'none'}).`);
  return path.join(productsDir, app);
}

function selectDevice(requested?: string): Device {
  const output = path.join(BUILD_ROOT, 'devices.json');
  const log = path.join(BUILD_ROOT, 'device-check.log');
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
    if (!device) throw new Error(`No device ${requested}. Connect it by USB and unlock it; list UDIDs with xcrun devicectl list devices.`);
    if (!device.physicalIOS) throw new Error(`${device.name} is not a physical iOS device.`);
  } else {
    const phones = devices.filter((d) => d.physicalIOS && d.paired);
    if (phones.length !== 1) {
      const ids = phones.map((d) => d.udid ?? d.identifier);
      const width = Math.max(0, ...ids.map((id) => id.length));
      throw new Error(phones.length
        ? `Several paired iPhones; pick one with --device:\n${phones.map((d, i) => `  ${ids[i]!.padEnd(width)}  ${d.name}`).join('\n')}`
        : 'No paired iPhone. Connect it by USB, unlock it, tap Trust, and pair it in Xcode.');
    }
    device = phones[0]!;
  }
  if (!device.paired) throw new Error(`${device.name} is not paired. Connect it by USB, unlock it, tap Trust, and pair it in Xcode.`);
  if (device.developerModeDisabled) throw new Error('Developer Mode is off. Turn it on in Settings > Privacy & Security, restart the iPhone, and retry.');
  return device;
}

function checkPhone(device: Device) {
  const output = path.join(BUILD_ROOT, 'lock-state.json');
  const log = path.join(BUILD_ROOT, 'device-check.log');
  // A disconnected tunnel in the device list can reconnect on demand, so probe the phone directly.
  const probe = runLogged('xcrun', ['devicectl', 'device', 'info', 'lockState', '--device', device.identifier, '--timeout', '20', '--json-output', output], log);
  if (!probe.ok) deviceFailure(`${device.name} is paired but unreachable`, log, probe.log);
  const state = JSON.parse(readFileSync(output, 'utf8')).result;
  if (!('passcodeRequired' in state) && !('unlockedSinceBoot' in state)) {
    throw new Error('Xcode reported an unknown lock state. Unlock the iPhone and check it in Xcode.');
  }
  if (state.passcodeRequired === true || state.unlockedSinceBoot === false) {
    throw new Error('The iPhone is locked. Unlock it, keep it awake, and retry.');
  }
}

function deviceFailure(stage: string, logPath: string, log: string): never {
  const hint = /locked|passcode|unlock/i.test(log)
    ? 'Unlock the iPhone, keep it awake, and retry.'
    : /developer mode/i.test(log)
      ? 'Turn on Developer Mode in Settings > Privacy & Security, restart the iPhone, and retry.'
      : /provision|signature|signing|certificate|integrity/i.test(log)
        ? 'Check signing in Xcode: Signing & Capabilities, with your team and automatic signing.'
        : /space|storage/i.test(log)
          ? 'Free up storage under Settings > General > iPhone Storage.'
          : 'Connect the iPhone by USB, unlock it, and tap Trust; it must show up in Xcode > Devices. Being on the same tailnet is not enough.';
  throw new Error(`${stage}.\nLog: ${tilde(logPath)}\n${hint}`);
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

function tilde(file: string): string {
  return file.startsWith(os.homedir()) ? `~${file.slice(os.homedir().length)}` : file;
}

function header(title: string, detail?: string) {
  console.log(`\n${chalk.bold(title)}${detail ? chalk.dim(` ${detail}`) : ''}`);
}

function labelled(label: string, detail: string): string {
  return `  ${chalk.cyan(label.padEnd(LABEL_WIDTH))}${detail}`;
}

function line(label: string, detail: string) {
  console.log(labelled(label, detail));
}

function elapsed(since: number): string {
  const seconds = (Date.now() - since) / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  return `${Math.floor(seconds / 60)}m${String(Math.round(seconds % 60)).padStart(2, '0')}s`;
}

// Prints the step up front so long builds show what is running, then appends the outcome
// on the same line; work must not log. A `{ ok: false }` result counts as a failure.
function task<T>(label: string, detail: string, work: () => T, summarize?: (result: T) => string): T {
  process.stdout.write(`${labelled(label, detail)}  `);
  const started = Date.now();
  const finish = (ok: boolean, note?: string) => {
    const mark = ok ? chalk.green('✓') : chalk.red('✗');
    process.stdout.write(`${mark}${note ? ` ${note}` : ''} ${chalk.dim(elapsed(started))}\n`);
  };
  try {
    const result = work();
    const ok = (result as { ok?: boolean } | undefined)?.ok !== false;
    finish(ok, ok && summarize ? summarize(result) : undefined);
    return result;
  } catch (error) {
    finish(false);
    throw error;
  }
}
