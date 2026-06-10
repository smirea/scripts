#!/usr/bin/env bun
import { access, chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import yargs from "yargs";
import type { Argv, ArgumentsCamelCase } from "yargs";
import { hideBin } from "yargs/helpers";

const composeFile = `services:
  backend:
    image: ghcr.io/get-convex/convex-backend:latest
    stop_grace_period: 10s
    stop_signal: SIGINT
    ports:
      - "\${PORT}:3210"
      - "\${SITE_PROXY_PORT}:3211"
    volumes:
      - data:/convex/data
    environment:
      - ACTIONS_USER_TIMEOUT_SECS
      - APPLICATION_MAX_CONCURRENT_MUTATIONS=\${APPLICATION_MAX_CONCURRENT_MUTATIONS:-16}
      - APPLICATION_MAX_CONCURRENT_NODE_ACTIONS=\${APPLICATION_MAX_CONCURRENT_NODE_ACTIONS:-16}
      - APPLICATION_MAX_CONCURRENT_QUERIES=\${APPLICATION_MAX_CONCURRENT_QUERIES:-16}
      - APPLICATION_MAX_CONCURRENT_V8_ACTIONS=\${APPLICATION_MAX_CONCURRENT_V8_ACTIONS:-16}
      - CONVEX_CLOUD_ORIGIN=\${CONVEX_CLOUD_ORIGIN}
      - CONVEX_SITE_ORIGIN=\${CONVEX_SITE_ORIGIN}
      - DATABASE_URL
      - DISABLE_METRICS_ENDPOINT=\${DISABLE_METRICS_ENDPOINT:-true}
      - DOCUMENT_RETENTION_DELAY=\${DOCUMENT_RETENTION_DELAY:-172800}
      - DO_NOT_REQUIRE_SSL
      - INSTANCE_NAME=\${INSTANCE_NAME}
      - INSTANCE_SECRET
      - MYSQL_URL
      - POSTGRES_URL
      - REDACT_LOGS_TO_CLIENT
      - RUST_BACKTRACE
      - RUST_LOG=\${RUST_LOG:-info}
    healthcheck:
      test: curl -f http://localhost:3210/version
      interval: 5s
      start_period: 10s
  dashboard:
    image: ghcr.io/get-convex/convex-dashboard:latest
    stop_grace_period: 10s
    stop_signal: SIGINT
    ports:
      - "\${DASHBOARD_PORT}:6791"
    environment:
      - NEXT_PUBLIC_DEPLOYMENT_URL=\${NEXT_PUBLIC_DEPLOYMENT_URL}
      - NEXT_PUBLIC_LOAD_MONACO_INTERNALLY
    depends_on:
      backend:
        condition: service_healthy
volumes:
  data:
`;

const knownEnvKeys = [
  "COMPOSE_PROJECT_NAME",
  "INSTANCE_NAME",
  "PORT",
  "SITE_PROXY_PORT",
  "DASHBOARD_PORT",
  "CONVEX_CLOUD_ORIGIN",
  "CONVEX_SITE_ORIGIN",
  "NEXT_PUBLIC_DEPLOYMENT_URL",
  "CONVEX_SELF_HOSTED_URL",
  "CONVEX_SELF_HOSTED_ADMIN_KEY",
  "BOOT_START",
  "LAUNCH_AGENT_LABEL",
] as const;

const defaultDeploymentRoot = path.join(os.homedir(), "code", "convex-deployments");

type CreateArgs = {
  name: string;
  port?: number;
  location?: string;
  boot: boolean;
};

type EnvMap = Record<string, string>;
type ComposeRuntime =
  | { kind: "plugin"; dockerPath: string; command: string }
  | { kind: "standalone"; dockerPath: string; composePath: string; command: string };

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

async function main() {
  await yargs(hideBin(process.argv))
    .scriptName("convex")
    .version(false)
    .strict()
    .command(
      ["create", "add"],
      "Create a local self-hosted Convex deployment",
      createOptions,
      (argv: ArgumentsCamelCase<CreateOptions>) =>
        createDeployment({
          name: argv.name,
          port: argv.port,
          location: argv.location,
          boot: argv.boot,
        }),
    )
    .command(
      ["delete <id>", "rm <id>"],
      "Stop and delete a deployment, including its Docker volume",
      idOptions,
      (argv: ArgumentsCamelCase<IdOptions>) => deleteDeployment(argv.id),
    )
    .command(
      "restart <id>",
      "Start and restart a deployment",
      idOptions,
      (argv: ArgumentsCamelCase<IdOptions>) => restartDeployment(argv.id),
    )
    .command(
      "dashboard <id>",
      "Start a deployment and open its dashboard",
      idOptions,
      (argv: ArgumentsCamelCase<IdOptions>) => openDashboard(argv.id),
    )
    .demandCommand(1, "Choose a command.")
    .help()
    .wrap(process.stdout.columns || 100)
    .parseAsync();
}

interface CreateOptions {
  name: string;
  port?: number;
  location?: string;
  boot: boolean;
}

interface IdOptions {
  id: string;
}

function createOptions(y: Argv): Argv<CreateOptions> {
  return y
    .option("name", {
      alias: "n",
      type: "string",
      demandOption: true,
      description: "Deployment name. Use lowercase letters, numbers, and hyphens.",
    })
    .option("port", {
      alias: "p",
      type: "number",
      description: "Backend API port. HTTP actions use port + 1, dashboard uses port + 2.",
    })
    .option("location", {
      alias: "l",
      type: "string",
      description: `Deployment folder. Defaults to ${defaultDeploymentRoot}/<name>.`,
    })
    .option("boot", {
      type: "boolean",
      default: true,
      description: "Register this deployment to start at login. Disable with --no-boot.",
    }) as Argv<CreateOptions>;
}

function idOptions(y: Argv): Argv<IdOptions> {
  return y.positional("id", {
    type: "string",
    demandOption: true,
    description: `Folder name under ${defaultDeploymentRoot}, or a full deployment path.`,
  }) as Argv<IdOptions>;
}

async function createDeployment(args: CreateArgs) {
  validateName(args.name);

  const location = expandHome(
    args.location ?? path.join(defaultDeploymentRoot, args.name),
  );
  const envPath = path.join(location, ".env");
  const composePath = path.join(location, "docker-compose.yml");
  const readmePath = path.join(location, "README.md");
  const startScriptPath = path.join(location, "start.sh");
  const existingEnv = await readEnvIfExists(envPath);
  const port = await resolvePort(args.port, existingEnv);
  const env = buildEnv(args.name, port, existingEnv);
  env.BOOT_START = args.boot ? "1" : "0";
  env.LAUNCH_AGENT_LABEL = launchAgentLabel(args.name);

  await mkdir(location, { recursive: true });
  await writeFileIfMissing(composePath, composeFile);
  await writeEnv(envPath, env, existingEnv);
  await writeReadme(readmePath, args.name, env, args.boot);

  const compose = await requireCompose();
  console.error(`Starting Convex deployment "${args.name}" in ${location}`);
  await runCompose(compose, ["up", "-d"], location);
  await waitForBackend(Number(env.PORT));

  if (!env.CONVEX_SELF_HOSTED_ADMIN_KEY) {
    env.CONVEX_SELF_HOSTED_ADMIN_KEY = await generateAdminKey(location, compose);
    await writeEnv(envPath, env, existingEnv);
  }

  if (args.boot) {
    await enableBootStart(args.name, location, startScriptPath, compose);
  } else {
    await disableBootStart(args.name);
  }

  await writeEnv(envPath, env, existingEnv);
  await writeReadme(readmePath, args.name, env, args.boot, compose.command);

  process.stdout.write(
    [
      `CONVEX_SELF_HOSTED_URL=${env.CONVEX_SELF_HOSTED_URL}`,
      `CONVEX_SELF_HOSTED_ADMIN_KEY=${env.CONVEX_SELF_HOSTED_ADMIN_KEY}`,
      "",
    ].join("\n"),
  );
}

async function deleteDeployment(id: string) {
  const location = resolveDeploymentLocation(id);
  const env = await readEnvIfExists(path.join(location, ".env"));
  const name = env.INSTANCE_NAME ?? path.basename(location);

  await requireDeployment(location);
  await disableBootStart(name, env);

  const compose = await requireCompose();
  await runCompose(compose, ["down", "-v"], location);
  await run("trash", [location], process.cwd(), { quiet: true });

  process.stdout.write(`Deleted ${location}\n`);
}

async function restartDeployment(id: string) {
  const location = resolveDeploymentLocation(id);
  await requireDeployment(location);

  const env = await readEnvIfExists(path.join(location, ".env"));
  const compose = await requireCompose();
  await runCompose(compose, ["up", "-d"], location);
  await runCompose(compose, ["restart"], location);

  if (env.PORT) {
    await waitForBackend(Number(env.PORT));
  }

  process.stdout.write(
    [
      `Restarted ${location}`,
      `CONVEX_SELF_HOSTED_URL=${env.CONVEX_SELF_HOSTED_URL ?? ""}`,
      `CONVEX_SELF_HOSTED_ADMIN_KEY=${env.CONVEX_SELF_HOSTED_ADMIN_KEY ?? ""}`,
      "",
    ].join("\n"),
  );
}

async function openDashboard(id: string) {
  const location = resolveDeploymentLocation(id);
  await requireDeployment(location);

  const env = await readEnvIfExists(path.join(location, ".env"));
  const compose = await requireCompose();
  await runCompose(compose, ["up", "-d"], location);

  if (env.PORT) {
    await waitForBackend(Number(env.PORT));
  }

  const dashboardUrl = `http://127.0.0.1:${env.DASHBOARD_PORT ?? Number(env.PORT ?? 3210) + 2}`;

  if (process.platform === "darwin") {
    await run("open", [dashboardUrl], location, { quiet: true });
  }

  process.stdout.write(`${dashboardUrl}\n`);
}

function parsePort(value: string) {
  const port = Number(value);

  if (!Number.isInteger(port) || port < 1024 || port > 65533) {
    throw new Error("Port must be an integer between 1024 and 65533.");
  }

  return port;
}

function validateName(name: string) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new Error("Name must use lowercase letters, numbers, and hyphens.");
  }
}

function expandHome(input: string) {
  if (input === "~") {
    return os.homedir();
  }

  if (input.startsWith("~/")) {
    return path.join(os.homedir(), input.slice(2));
  }

  return path.resolve(input);
}

function resolveDeploymentLocation(id: string) {
  const expanded = expandHome(id);

  if (path.isAbsolute(id) || id.startsWith("~/") || id.includes(path.sep)) {
    return expanded;
  }

  return path.join(defaultDeploymentRoot, id);
}

async function requireDeployment(location: string) {
  try {
    await access(path.join(location, "docker-compose.yml"), constants.F_OK);
  } catch (error) {
    if (isMissingFile(error)) {
      throw new Error(`No Convex deployment found at ${location}.`);
    }

    throw error;
  }
}

async function readEnvIfExists(filePath: string): Promise<EnvMap> {
  try {
    const contents = await readFile(filePath, "utf8");
    return parseEnv(contents);
  } catch (error) {
    if (isMissingFile(error)) {
      return {};
    }

    throw error;
  }
}

function parseEnv(contents: string): EnvMap {
  const env: EnvMap = {};

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (!line || line.startsWith("#")) {
      continue;
    }

    const equalsIndex = line.indexOf("=");
    if (equalsIndex === -1) {
      continue;
    }

    const key = line.slice(0, equalsIndex).trim();
    const value = line.slice(equalsIndex + 1).trim().replace(/^['"]|['"]$/g, "");
    env[key] = value;
  }

  return env;
}

async function resolvePort(requestedPort: number | undefined, existingEnv: EnvMap) {
  if (existingEnv.PORT) {
    const existingPort = parsePort(existingEnv.PORT);

    if (requestedPort && requestedPort !== existingPort) {
      throw new Error(`Deployment already uses port ${existingPort}; refusing to rewrite it to ${requestedPort}.`);
    }

    return existingPort;
  }

  if (requestedPort) {
    await requirePortBlockFree(requestedPort);
    return requestedPort;
  }

  return findPortBlock(3210);
}

async function findPortBlock(start: number) {
  for (let port = start; port <= 65520; port += 10) {
    if (await isPortBlockFree(port)) {
      return port;
    }
  }

  throw new Error("No free three-port block found.");
}

async function requirePortBlockFree(port: number) {
  if (!(await isPortBlockFree(port))) {
    throw new Error(`Ports ${port}, ${port + 1}, and ${port + 2} must all be free.`);
  }
}

async function isPortBlockFree(port: number) {
  return (
    (await isPortFree(port)) &&
    (await isPortFree(port + 1)) &&
    (await isPortFree(port + 2))
  );
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

function buildEnv(name: string, port: number, existingEnv: EnvMap): EnvMap {
  const sitePort = Number(existingEnv.SITE_PROXY_PORT ?? port + 1);
  const dashboardPort = Number(existingEnv.DASHBOARD_PORT ?? port + 2);
  const apiUrl = `http://127.0.0.1:${port}`;
  const siteUrl = `http://127.0.0.1:${sitePort}`;

  return {
    ...existingEnv,
    COMPOSE_PROJECT_NAME: existingEnv.COMPOSE_PROJECT_NAME ?? `convex_${name.replaceAll("-", "_")}`,
    INSTANCE_NAME: existingEnv.INSTANCE_NAME ?? name,
    PORT: String(port),
    SITE_PROXY_PORT: String(sitePort),
    DASHBOARD_PORT: String(dashboardPort),
    CONVEX_CLOUD_ORIGIN: existingEnv.CONVEX_CLOUD_ORIGIN ?? apiUrl,
    CONVEX_SITE_ORIGIN: existingEnv.CONVEX_SITE_ORIGIN ?? siteUrl,
    NEXT_PUBLIC_DEPLOYMENT_URL: existingEnv.NEXT_PUBLIC_DEPLOYMENT_URL ?? apiUrl,
    CONVEX_SELF_HOSTED_URL: existingEnv.CONVEX_SELF_HOSTED_URL ?? apiUrl,
    CONVEX_SELF_HOSTED_ADMIN_KEY: existingEnv.CONVEX_SELF_HOSTED_ADMIN_KEY ?? "",
    BOOT_START: existingEnv.BOOT_START ?? "1",
    LAUNCH_AGENT_LABEL: existingEnv.LAUNCH_AGENT_LABEL ?? launchAgentLabel(name),
  };
}

async function writeFileIfMissing(filePath: string, contents: string) {
  try {
    await access(filePath, constants.F_OK);
  } catch (error) {
    if (!isMissingFile(error)) {
      throw error;
    }

    await writeFile(filePath, contents);
  }
}

async function writeEnv(filePath: string, env: EnvMap, existingEnv: EnvMap) {
  const known = knownEnvKeys.map((key) => `${key}=${env[key] ?? ""}`);
  const extra = Object.keys(existingEnv)
    .filter((key) => !knownEnvKeys.includes(key as (typeof knownEnvKeys)[number]))
    .sort()
    .map((key) => `${key}=${existingEnv[key]}`);

  await writeFile(filePath, [...known, ...extra, ""].join("\n"));
}

async function writeReadme(
  filePath: string,
  name: string,
  env: EnvMap,
  boot: boolean,
  composeCommand = "docker compose",
) {
  await writeFile(
    filePath,
    `# ${name}

Local self-hosted Convex deployment.

- Dashboard: http://127.0.0.1:${env.DASHBOARD_PORT}
- Backend API: ${env.CONVEX_SELF_HOSTED_URL}
- HTTP actions: ${env.CONVEX_SITE_ORIGIN}

Use from an app repo:

\`\`\`sh
CONVEX_SELF_HOSTED_URL=${env.CONVEX_SELF_HOSTED_URL}
CONVEX_SELF_HOSTED_ADMIN_KEY=<stored in .env>
npx convex dev
\`\`\`

Manage this deployment:

\`\`\`sh
${composeCommand} up -d
${composeCommand} logs -f backend
${composeCommand} down
\`\`\`

Helper commands:

\`\`\`sh
convex.ts restart ${name}
convex.ts dashboard ${name}
convex.ts delete ${name}
\`\`\`

Boot start: ${boot ? `enabled via ${launchAgentPath(name)}` : "disabled"}
`,
  );
}

async function requireCompose(): Promise<ComposeRuntime> {
  const dockerPath = await resolveCommand("docker");
  await run("docker", ["--version"], process.cwd(), { quiet: true });

  try {
    await run("docker", ["compose", "version"], process.cwd(), { quiet: true });
    return { kind: "plugin", dockerPath, command: "docker compose" };
  } catch {
    const composePath = await resolveCommand("docker-compose");
    await run("docker-compose", ["version"], process.cwd(), { quiet: true });
    return { kind: "standalone", dockerPath, composePath, command: "docker-compose" };
  }
}

async function resolveCommand(command: string) {
  const output = await run("which", [command], process.cwd(), { quiet: true });
  const resolved = output.trim().split(/\r?\n/)[0];

  if (!resolved) {
    throw new Error(`${command} not found on PATH.`);
  }

  return resolved;
}

async function runCompose(
  compose: ComposeRuntime,
  args: string[],
  cwd: string,
  options: { quiet?: boolean; allowFailure?: boolean } = {},
) {
  if (compose.kind === "plugin") {
    return run("docker", ["compose", ...args], cwd, options);
  }

  return run("docker-compose", args, cwd, options);
}

async function enableBootStart(
  name: string,
  location: string,
  startScriptPath: string,
  compose: ComposeRuntime,
) {
  if (process.platform !== "darwin") {
    throw new Error("Boot start is currently implemented for macOS launchd. Use --no-boot on other platforms.");
  }

  const label = launchAgentLabel(name);
  const plistPath = launchAgentPath(name);
  await mkdir(path.dirname(plistPath), { recursive: true });
  await writeFile(startScriptPath, startScript(location, compose));
  await chmod(startScriptPath, 0o755);
  await writeFile(plistPath, launchAgentPlist(label, startScriptPath, location));
  await run("launchctl", ["unload", "-w", plistPath], location, { quiet: true, allowFailure: true });
  await run("launchctl", ["load", "-w", plistPath], location, { quiet: true });
}

async function disableBootStart(name: string, env: EnvMap = {}) {
  if (process.platform !== "darwin") {
    return;
  }

  const plistPath = launchAgentPathForLabel(env.LAUNCH_AGENT_LABEL ?? launchAgentLabel(name));
  await run("launchctl", ["unload", "-w", plistPath], process.cwd(), { quiet: true, allowFailure: true });

  try {
    await unlink(plistPath);
  } catch (error) {
    if (!isMissingFile(error)) {
      throw error;
    }
  }
}

function launchAgentLabel(name: string) {
  return `com.codex.convex.${name}`;
}

function launchAgentPath(name: string) {
  return launchAgentPathForLabel(launchAgentLabel(name));
}

function launchAgentPathForLabel(label: string) {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);
}

function startScript(location: string, compose: ComposeRuntime) {
  const runner =
    compose.kind === "plugin"
      ? `DOCKER=${shellQuote(compose.dockerPath)}
if [[ ! -x "$DOCKER" ]]; then
  DOCKER="$(command -v docker || true)"
fi

if [[ -z "$DOCKER" ]]; then
  echo "docker not found"
  exit 127
fi

run_compose() {
  "$DOCKER" compose "$@"
}
`
      : `COMPOSE=${shellQuote(compose.composePath)}
if [[ ! -x "$COMPOSE" ]]; then
  COMPOSE="$(command -v docker-compose || true)"
fi

if [[ -z "$COMPOSE" ]]; then
  echo "docker-compose not found"
  exit 127
fi

run_compose() {
  "$COMPOSE" "$@"
}
`;

  return `#!/usr/bin/env bash
set -euo pipefail

cd ${shellQuote(location)}

${runner}

for _ in $(seq 1 60); do
  if run_compose up -d; then
    exit 0
  fi
  sleep 5
done

exit 1
`;
}

function launchAgentPlist(label: string, startScriptPath: string, location: string) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(startScriptPath)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(location)}</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(path.join(location, "launchd.out.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(path.join(location, "launchd.err.log"))}</string>
</dict>
</plist>
`;
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function xmlEscape(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

async function waitForBackend(port: number) {
  const deadline = Date.now() + 90_000;
  const url = `http://127.0.0.1:${port}/version`;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);

      if (response.ok) {
        return;
      }
    } catch {
      await sleep(1_000);
      continue;
    }

    await sleep(1_000);
  }

  throw new Error(`Convex backend did not become healthy at ${url}.`);
}

async function generateAdminKey(cwd: string, compose: ComposeRuntime) {
  const output = await runCompose(compose, ["exec", "-T", "backend", "./generate_admin_key.sh"], cwd, {
    quiet: true,
  });
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const key = lines.at(-1);

  if (!key || !key.includes("|")) {
    throw new Error(`Could not parse generated admin key from: ${output}`);
  }

  return key;
}

function run(
  command: string,
  args: string[],
  cwd: string,
  options: { quiet?: boolean; allowFailure?: boolean } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: process.env });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on("data", (chunk) => {
      stdout.push(chunk);
      if (!options.quiet) {
        process.stderr.write(chunk);
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr.push(chunk);
      if (!options.quiet) {
        process.stderr.write(chunk);
      }
    });

    child.on("error", reject);
    child.on("close", (code) => {
      const output = Buffer.concat(stdout).toString("utf8");
      const errorOutput = Buffer.concat(stderr).toString("utf8");

      if (code === 0 || options.allowFailure) {
        resolve(output);
      } else {
        reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code}\n${errorOutput}`));
      }
    });
  });
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isMissingFile(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
