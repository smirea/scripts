#!/usr/bin/env bun
import { createScript } from './utils/createScript';
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
  description: string;
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
      const device = selectDevice(argv.device);
      checkPhone(device);
      for (const plan of plans) pushApp(plan, device);
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

// Everything that can reject an app runs for all apps before the first build starts.
function planApp(dir: string, options: { scheme?: string; pull: boolean; env?: string; team?: string }): AppPlan {
  const name = path.basename(dir);
  const repoRoot = gitRoot(dir);
  if (options.pull && repoRoot) fastForward(repoRoot, name);
  if (repoRoot && (existsSync(path.join(repoRoot, 'bun.lock')) || existsSync(path.join(repoRoot, 'bun.lockb')))) {
    console.log(`Installing ${name} dependencies...`);
    runOrThrow(process.execPath, ['install'], { cwd: repoRoot, error: `bun install failed in ${repoRoot}` });
  }
  const env = selectEnvironment(dir, repoRoot, options.env);
  return { dir, name, env, team: options.team, project: findProject(dir, options.scheme) };
}

function readEnvManagerInfo(dir: string, repoRoot: string | undefined): EnvManagerInfo | null {
  const result = spawnSync('env-manager', ['info'], { cwd: dir, encoding: 'utf8' });
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return null;
  if (result.status === ENV_MANAGER_NOT_INITIALIZED) return null;
  if (result.status !== 0) throw new Error(`env-manager info failed in ${dir}:\n${(result.stderr || String(result.error)).trim()}`);
  const info: EnvManagerInfo = JSON.parse(result.stdout);
  // env-manager walks up to the nearest .env, which can belong to an unrelated parent directory.
  if (repoRoot && path.relative(repoRoot, info.root).startsWith('..')) return null;
  return info;
}

function selectEnvironment(dir: string, repoRoot: string | undefined, requested?: string): EnvSelection | null {
  const name = path.basename(dir);
  const info = readEnvManagerInfo(dir, repoRoot);
  if (!info) {
    if (requested) throw new Error(`--env ${requested} given, but ${name} has no env-manager setup (or env-manager is not installed).`);
    return null;
  }
  if (info.local) {
    if (requested) throw new Error(`--env ${requested} given, but ${name} uses env-manager local mode, which has no stored environments.`);
    console.log(`${name}: env-manager local mode; building with the current local values.`);
    return null;
  }
  if (!info.environments) throw new Error(`Cannot read ${name}'s env-manager environments: ${info.environmentsError}`);
  const available = info.environments.join(', ') || 'none';
  if (requested) {
    if (!info.environments.includes(requested)) throw new Error(`Unknown env-manager environment "${requested}" for ${name}. Available: ${available}`);
  } else if (!info.environments.length) {
    console.log(`${name}: no stored env-manager environments; building with the current local values.`);
    return null;
  }

  let selected = requested;
  if (!selected) {
    const production = info.environments.filter((env) => PRODUCTION_ENVIRONMENT.test(env));
    if (production.length > 1) throw new Error(`${name} has several production environments (${production.join(', ')}); pass --env.`);
    selected = production[0] ?? (info.environments.length === 1 ? info.environments[0] : undefined);
    if (!selected) throw new Error(`${name} has no prod/production env-manager environment and several others (${available}); pass --env.`);
  }
  const { current, valuesLoadedFrom } = info.environment;
  if (info.mode === 'targets') {
    return {
      name: selected,
      root: info.root,
      args: ['gen', '--env', selected],
      description: `Rendering ${name} env-manager environment "${selected}" (current: "${current}", restored after the build)`,
      restore: info.outputs.filter((output) => output.target && output.kind === 'values').map((output) => output.path),
    };
  }

  // Single-project values files are the build input, so they come from `down`. It also
  // replaces .env with the stored schema, which would silently regress a newer local one.
  if (info.storedSchema !== 'in-sync') {
    throw new Error(`${name}'s .env differs from the schema stored in AWS, and env-manager down would replace it. In ${info.root}, run 'env-manager up' if the local .env is newer or 'env-manager down' if AWS is, then retry.`);
  }
  if (current === selected && (valuesLoadedFrom ?? current) === selected) {
    return { name: selected, root: info.root, args: ['down'], description: `Downloading ${name} env-manager environment "${selected}"`, restore: [] };
  }
  return {
    name: selected,
    root: info.root,
    args: ['down', '--env', selected],
    description: `Downloading ${name} env-manager environment "${selected}" (current: "${current}", restored after the build)`,
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
    console.log(`${env.description}...`);
    runOrThrow('env-manager', env.args, { cwd: env.root, error: `env-manager ${env.args.join(' ')} failed in ${env.root}` });
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
function xcodebuild({ dir, name, project, env, team: requestedTeam }: AppPlan, buildDir: string, args: string[]): string | undefined {
  const buildLog = path.join(buildDir, 'build.log');
  let team = requestedTeam;
  const runOnce = () => {
    console.log(`Building ${name} (${path.relative(dir, project.path) || project.path}, scheme ${project.scheme}, Release${team ? `, team ${team}` : ''})... Log: ${buildLog}`);
    return runLogged('xcodebuild', [
      project.flag, project.path, '-scheme', project.scheme, '-configuration', 'Release',
      '-derivedDataPath', buildDir, '-allowProvisioningUpdates', ...args, ...(team ? [`DEVELOPMENT_TEAM=${team}`] : []),
    ], buildLog);
  };
  const runBuild = () => {
    const first = runOnce();
    if (first.ok || team || !/requires a development team/i.test(first.log)) return first;
    team = certificateTeam();
    if (!team) throw new Error(`${name} does not set a development team and none could be picked from your Apple Development certificates; pass --team <TEAM_ID>.`);
    console.log(`${name} does not set a development team; using ${team} from your Apple Development certificate.`);
    return runOnce();
  };
  const build = env ? withEnvironment(env, runBuild) : runBuild();
  if (!build.ok) {
    const hint = /provision|signing|certificate|development team/i.test(build.log)
      ? 'Check your Apple account and Signing & Capabilities in Xcode; select your team and automatic signing.'
      : /destination|device.*unavailable|device.*locked/i.test(build.log)
        ? 'Reconnect and unlock your iPhone, then retry.'
        : 'Open the project in Xcode and build the Release scheme to see the compiler error.';
    throw new Error(`Build failed; see ${buildLog}. Nothing was installed for ${name}.\n${hint}`);
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
      `--link needs the public R2 bucket "${LINK_BUCKET}" (wrangler must be installed and logged in). Set it up once with:`,
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
  const team = xcodebuild(plan, buildDir, ['-destination', 'generic/platform=iOS', '-archivePath', archivePath, 'archive']);

  const optionsPath = path.join(buildDir, 'ExportOptions.plist');
  writeFileSync(optionsPath, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>method</key><string>debugging</string><key>signingStyle</key><string>automatic</string>${team ? `<key>teamID</key><string>${team}</string>` : ''}</dict></plist>
`);
  const exportLog = path.join(buildDir, 'export.log');
  console.log(`Exporting ${name}... Log: ${exportLog}`);
  const exported = runLogged('xcodebuild', ['-exportArchive', '-archivePath', archivePath, '-exportPath', exportPath, '-exportOptionsPlist', optionsPath, '-allowProvisioningUpdates'], exportLog);
  if (!exported.ok) throw new Error(`Export failed; see ${exportLog}. Check that your iPhone is registered to your team in Xcode > Settings > Accounts.`);
  const ipa = readdirSync(exportPath).find((entry) => entry.endsWith('.ipa'));
  if (!ipa) throw new Error(`No .ipa found in ${exportPath}.`);

  const appsDir = path.join(archivePath, 'Products/Applications');
  const infoPlist = path.join(findBuiltApp(appsDir, project.scheme), 'Info.plist');
  const bundleId = plistValue(infoPlist, 'CFBundleIdentifier');
  if (!bundleId) throw new Error(`Could not read the bundle identifier from ${infoPlist}`);
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

  console.log(`Uploading ${name}...`);
  for (const [file, local, contentType] of [
    ['app.ipa', path.join(exportPath, ipa), 'application/octet-stream'],
    ['manifest.plist', path.join(buildDir, 'manifest.plist'), 'text/xml'],
    ['index.html', path.join(buildDir, 'index.html'), 'text/html; charset=utf-8'],
  ] as const) {
    runOrThrow('wrangler', ['r2', 'object', 'put', `${LINK_BUCKET}/${prefix}/${file}`, '--file', local, '--content-type', contentType, '--remote'], {
      error: `Uploading ${file} to R2 failed`,
    });
  }
  console.log(`${name} (${label}) is ready to install for ${LINK_EXPIRY_DAYS} days. Open on your iPhone:\n${url('index.html')}`);
}

function pushApp(plan: AppPlan, device: Device) {
  const { name, project } = plan;
  const buildDir = path.join(BUILD_ROOT, name);
  mkdirSync(buildDir, { recursive: true });
  xcodebuild(plan, buildDir, ['-destination', `platform=iOS,id=${device.identifier}`, 'build']);

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
