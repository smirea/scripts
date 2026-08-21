#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

import { failWithFullHelp } from "./utils/yargs";

const DEFAULT_OWNER = "smirea";
const DEFAULT_AI_USER = "smirea-ai";
const DEFAULT_DAYS = 365;
const HOSTNAME = "github.com";
const REQUIRED_SCOPES = "repo,read:org,gist";
const RESTORE_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

let restoreGhUser = DEFAULT_OWNER;
let restoreInProgress = false;

interface CliArgs {
  owner: string;
  ai: string;
  days: number;
  repos: string[];
  includeArchived: boolean;
  includeForks: boolean;
  dryRun: boolean;
  login: boolean;
}

interface GithubUser {
  login: string;
}

interface GithubRepo {
  name: string;
  full_name: string;
  html_url: string;
  private: boolean;
  fork: boolean;
  archived: boolean;
  created_at: string;
  owner: GithubUser;
}

interface GithubInvitation {
  id: number;
  permissions?: string;
  repository: GithubRepo;
  invitee?: GithubUser;
  inviter?: GithubUser;
}

interface RepoCheck {
  repo: GithubRepo;
  status: "already-collaborator" | "pending-invite" | "invited" | "would-invite";
}

if (import.meta.main) {
  void runCli();
}

async function runCli(): Promise<void> {
  installRestoreSignalHandlers();
  try {
    const args = await parseCliArgs();
    restoreGhUser = args.owner;

    const activeUser = getActiveGhUser();
    if (activeUser && activeUser !== args.owner) {
      console.log(`Active gh account is ${activeUser}; owner operations will use stored ${args.owner} auth.`);
    }

    const ownerToken = ensureGhToken(args.owner, args.login);
    const aiToken = args.dryRun ? getGhToken(args.ai) : ensureGhToken(args.ai, args.login);
    assertTokenUser(ownerToken, args.owner);
    if (aiToken) {
      assertTokenUser(aiToken, args.ai);
    }

    const cutoff = daysAgo(args.days);
    const repos = listRepos(ownerToken, args.owner, cutoff, args);
    printRepoList(args, cutoff, repos);

    const checks = await inviteMissingAiCollaborator(ownerToken, repos, args);
    const accepted = aiToken ? acceptPendingInvitations(aiToken, args, repos) : skipAcceptPreview(args);

    printSummary(checks, accepted, args.dryRun);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  } finally {
    restoreConfiguredGhUser();
  }
}

function installRestoreSignalHandlers(): void {
  for (const signal of RESTORE_SIGNALS) {
    process.once(signal, () => {
      restoreConfiguredGhUser();
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  }
}

function restoreConfiguredGhUser(): void {
  if (restoreInProgress) {
    return;
  }
  restoreInProgress = true;
  try {
    restoreActiveGhUser(restoreGhUser);
  } finally {
    restoreInProgress = false;
  }
}

async function parseCliArgs(): Promise<CliArgs> {
  const parsed = await yargs(hideBin(process.argv))
    .scriptName("git-invite-ai-to-repos")
    .strict()
    .option("owner", {
      type: "string",
      default: DEFAULT_OWNER,
      describe: "GitHub account that owns the repositories to update",
    })
    .option("ai", {
      type: "string",
      default: DEFAULT_AI_USER,
      describe: "GitHub account to invite and use when accepting repository invitations",
    })
    .option("days", {
      type: "number",
      default: DEFAULT_DAYS,
      describe: "Only include repositories created in the last N days",
    })
    .option("repos", {
      type: "string",
      array: true,
      default: [] as string[],
      describe: "Specific repositories to update, as repo names or owner/repo names",
    })
    .option("include-archived", {
      type: "boolean",
      default: false,
      describe: "Include archived repositories",
    })
    .option("include-forks", {
      type: "boolean",
      default: false,
      describe: "Include forked repositories",
    })
    .option("dry-run", {
      type: "boolean",
      default: false,
      describe: "Print missing collaborators and pending invitations without changing GitHub",
    })
    .option("login", {
      type: "boolean",
      default: true,
      describe: "Start gh auth login when either account is not already available",
    })
    .fail(failWithFullHelp)
    .help()
    .wrap(100)
    .parseAsync();

  if (parsed.days <= 0) {
    throw new Error("--days must be greater than 0.");
  }

  return {
    owner: parsed.owner,
    ai: parsed.ai,
    days: parsed.days,
    repos: normalizeRepoArgs(parsed.repos),
    includeArchived: parsed.includeArchived,
    includeForks: parsed.includeForks,
    dryRun: parsed.dryRun,
    login: parsed.login,
  };
}

async function inviteMissingAiCollaborator(
  ownerToken: string,
  repos: GithubRepo[],
  args: CliArgs
): Promise<RepoCheck[]> {
  const checks: RepoCheck[] = [];
  for (const repo of repos) {
    if (isCollaborator(ownerToken, repo, args.ai)) {
      checks.push({ repo, status: "already-collaborator" });
      console.log(`ok      ${repo.full_name} already has ${args.ai}`);
      continue;
    }

    const pendingInvite = findPendingRepoInvitation(ownerToken, repo, args.ai);
    if (pendingInvite) {
      checks.push({ repo, status: "pending-invite" });
      console.log(`pending ${repo.full_name} already has invite #${pendingInvite.id}`);
      continue;
    }

    if (args.dryRun) {
      checks.push({ repo, status: "would-invite" });
      console.log(`invite  ${repo.full_name} would invite ${args.ai}`);
      continue;
    }

    inviteCollaborator(ownerToken, repo, args.ai);
    checks.push({ repo, status: "invited" });
    console.log(`invite  ${repo.full_name} invited ${args.ai}`);
  }
  return checks;
}

function acceptPendingInvitations(aiToken: string, args: CliArgs, repos: GithubRepo[]): GithubInvitation[] {
  const candidateNames = new Set(repos.map(repo => repo.full_name));
  const invitations = listUserInvitations(aiToken).filter(invitation => {
    if (invitation.repository.owner.login !== args.owner) {
      return false;
    }
    return candidateNames.has(invitation.repository.full_name);
  });

  if (invitations.length === 0) {
    console.log(`No pending ${args.ai} invitations to accept for these repositories.`);
    return [];
  }

  const accepted: GithubInvitation[] = [];
  for (const invitation of invitations) {
    if (args.dryRun) {
      console.log(`accept  ${invitation.repository.full_name} would accept invite #${invitation.id}`);
      accepted.push(invitation);
      continue;
    }
    acceptInvitation(aiToken, invitation.id);
    console.log(`accept  ${invitation.repository.full_name} accepted invite #${invitation.id}`);
    accepted.push(invitation);
  }
  return accepted;
}

function skipAcceptPreview(args: CliArgs): GithubInvitation[] {
  console.log(`Skipping invite acceptance preview because gh is not authenticated as ${args.ai}.`);
  return [];
}

function listRepos(ownerToken: string, owner: string, cutoff: Date, args: CliArgs): GithubRepo[] {
  if (args.repos.length > 0) {
    return args.repos.map(repo => getOwnerRepo(ownerToken, owner, repo));
  }
  return listOwnerRepos(ownerToken, owner, cutoff, args);
}

function listOwnerRepos(ownerToken: string, owner: string, cutoff: Date, args: CliArgs): GithubRepo[] {
  const repos = ghApiPaginated<GithubRepo>(
    ownerToken,
    "/user/repos?affiliation=owner&per_page=100&sort=created&direction=desc"
  );
  return repos
    .filter(repo => repo.owner.login === owner)
    .filter(repo => new Date(repo.created_at) >= cutoff)
    .filter(repo => args.includeForks || !repo.fork)
    .filter(repo => args.includeArchived || !repo.archived)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

function printRepoList(args: CliArgs, cutoff: Date, repos: GithubRepo[]): void {
  const flags = [
    args.includeForks ? "including forks" : "excluding forks",
    args.includeArchived ? "including archived" : "excluding archived",
    args.dryRun ? "dry run" : "live",
  ];
  const scope =
    args.repos.length > 0
      ? `matching --repos ${args.repos.join(", ")}`
      : `created since ${formatDate(cutoff)}`;
  console.log(`Found ${repos.length} ${args.owner} repos ${scope} (${flags.join(", ")}).`);
  for (const repo of repos) {
    console.log(`repo    ${repo.full_name} created ${formatDate(new Date(repo.created_at))}`);
  }
}

function printSummary(checks: RepoCheck[], accepted: GithubInvitation[], dryRun: boolean): void {
  const count = (status: RepoCheck["status"]) => checks.filter(check => check.status === status).length;
  const actionVerb = dryRun ? "would accept" : "accepted";
  console.log("");
  console.log("Summary:");
  console.log(`already collaborators: ${count("already-collaborator")}`);
  console.log(`pending invitations:   ${count("pending-invite")}`);
  console.log(`${dryRun ? "would invite" : "invited"}:             ${count(dryRun ? "would-invite" : "invited")}`);
  console.log(`${actionVerb}:          ${accepted.length}`);
}

function isCollaborator(ownerToken: string, repo: GithubRepo, username: string): boolean {
  const result = runGh(
    ["api", `/repos/${encodePath(repo.owner.login)}/${encodePath(repo.name)}/collaborators/${encodePath(username)}`],
    { token: ownerToken, allowFailure: true }
  );
  if (result.status === 0) {
    return true;
  }
  if (isHttpStatus(result, 404)) {
    return false;
  }
  throw new Error(formatGhError(`checking ${username} access for ${repo.full_name}`, result));
}

function findPendingRepoInvitation(
  ownerToken: string,
  repo: GithubRepo,
  username: string
): GithubInvitation | undefined {
  const invitations = ghApiPaginated<GithubInvitation>(
    ownerToken,
    `/repos/${encodePath(repo.owner.login)}/${encodePath(repo.name)}/invitations?per_page=100`
  );
  return invitations.find(invitation => invitation.invitee?.login === username);
}

function inviteCollaborator(ownerToken: string, repo: GithubRepo, username: string): void {
  ghApi(
    ownerToken,
    "PUT",
    `/repos/${encodePath(repo.owner.login)}/${encodePath(repo.name)}/collaborators/${encodePath(username)}`
  );
}

function listUserInvitations(aiToken: string): GithubInvitation[] {
  return ghApiPaginated<GithubInvitation>(aiToken, "/user/repository_invitations?per_page=100");
}

function acceptInvitation(aiToken: string, invitationId: number): void {
  ghApi(aiToken, "PATCH", `/user/repository_invitations/${invitationId}`);
}

function getOwnerRepo(ownerToken: string, owner: string, repoArg: string): GithubRepo {
  const [repoOwner, repoName] = parseRepoArg(owner, repoArg);
  if (repoOwner !== owner) {
    throw new Error(`--repos entry ${repoArg} belongs to ${repoOwner}, but --owner is ${owner}.`);
  }
  return ghApiJson<GithubRepo>(ownerToken, `/repos/${encodePath(repoOwner)}/${encodePath(repoName)}`);
}

function parseRepoArg(owner: string, repoArg: string): [string, string] {
  const parts = repoArg.split("/");
  if (parts.length === 1) {
    return [owner, parts[0]!];
  }
  if (parts.length === 2 && parts[0] && parts[1]) {
    return [parts[0], parts[1]];
  }
  throw new Error(`Invalid --repos entry: ${repoArg}`);
}

function normalizeRepoArgs(values: readonly string[]): string[] {
  const repos = values
    .flatMap(value => value.split(","))
    .map(value => value.trim())
    .filter(Boolean);
  return Array.from(new Set(repos));
}

function ensureGhToken(user: string, loginWhenMissing: boolean): string {
  const existingToken = getGhToken(user);
  if (existingToken) {
    return existingToken;
  }

  if (!loginWhenMissing) {
    throw new Error(`gh is not authenticated as ${user}. Re-run without --no-login or log in manually.`);
  }

  console.log(`gh is not authenticated as ${user}. Starting browser login.`);
  console.log(`Approve GitHub CLI as ${user}; if the browser is on another account, switch accounts first.`);
  const loginResult = spawnSync("gh", ["auth", "login", "--hostname", HOSTNAME, "--web", "--scopes", REQUIRED_SCOPES], {
    stdio: "inherit",
    env: cleanAuthEnv(),
  });
  if (loginResult.status !== 0) {
    throw new Error(`gh auth login failed for ${user}.`);
  }

  const token = getGhToken(user);
  if (!token) {
    throw new Error(
      `gh auth login completed, but ${user} is still not available. Run \`gh auth status -a\` and make sure ${user} is listed.`
    );
  }
  return token;
}

function getGhToken(user: string): string | null {
  const result = runGh(["auth", "token", "--hostname", HOSTNAME, "--user", user], {
    cleanAuth: true,
    allowFailure: true,
  });
  if (result.status !== 0) {
    return null;
  }
  const token = result.stdout.trim();
  return token || null;
}

function assertTokenUser(token: string, expectedUser: string): void {
  const user = ghApiJson<GithubUser>(token, "/user");
  if (user.login !== expectedUser) {
    throw new Error(`Expected ${expectedUser} token, but GitHub returned ${user.login}.`);
  }
}

function getActiveGhUser(): string | null {
  const result = runGh(["api", "/user", "--jq", ".login"], { cleanAuth: true, allowFailure: true });
  if (result.status !== 0) {
    return null;
  }
  return result.stdout.trim() || null;
}

function restoreActiveGhUser(user: string): void {
  if (!getGhToken(user)) {
    return;
  }
  const activeUser = getActiveGhUser();
  if (activeUser === user) {
    return;
  }
  const result = runGh(["auth", "switch", "--hostname", HOSTNAME, "--user", user], {
    cleanAuth: true,
    allowFailure: true,
  });
  if (result.status !== 0) {
    console.error(formatGhError(`restoring active gh account to ${user}`, result));
  }
}

function ghApiPaginated<T>(token: string, endpoint: string): T[] {
  const stdout = ghApiRaw(token, ["api", "--paginate", "--slurp", endpoint]);
  const pages = JSON.parse(stdout) as unknown;
  if (!Array.isArray(pages)) {
    throw new Error(`Expected paginated GitHub response for ${endpoint}.`);
  }
  return pages.flatMap(page => {
    if (!Array.isArray(page)) {
      throw new Error(`Expected GitHub page array for ${endpoint}.`);
    }
    return page as T[];
  });
}

function ghApiJson<T>(token: string, endpoint: string): T {
  return JSON.parse(ghApiRaw(token, ["api", endpoint])) as T;
}

function ghApi(token: string, method: string, endpoint: string): string {
  return ghApiRaw(token, ["api", "--method", method, endpoint]);
}

function ghApiRaw(token: string, args: string[]): string {
  const result = runGh(args, { token });
  if (result.status !== 0) {
    throw new Error(formatGhError(args.join(" "), result));
  }
  return result.stdout;
}

function runGh(
  args: string[],
  options: { token?: string; cleanAuth?: boolean; allowFailure?: boolean } = {}
): SpawnSyncReturns<string> {
  const env = options.token ? tokenEnv(options.token) : options.cleanAuth ? cleanAuthEnv() : process.env;
  const result = spawnSync("gh", args, { encoding: "utf8", env });
  if (!options.allowFailure && result.error) {
    throw new Error(`gh ${args.join(" ")} failed: ${result.error.message}`);
  }
  return result;
}

function tokenEnv(token: string): NodeJS.ProcessEnv {
  return {
    ...cleanAuthEnv(),
    GH_TOKEN: token,
    GITHUB_TOKEN: token,
  };
}

function cleanAuthEnv(): NodeJS.ProcessEnv {
  const next = { ...process.env };
  delete next.GH_TOKEN;
  delete next.GITHUB_TOKEN;
  delete next.GH_ENTERPRISE_TOKEN;
  delete next.GITHUB_ENTERPRISE_TOKEN;
  return next;
}

function formatGhError(action: string, result: SpawnSyncReturns<string>): string {
  if (result.error) {
    return `gh ${action} failed: ${result.error.message}`;
  }
  const stderr = result.stderr.trim();
  const stdout = result.stdout.trim();
  return `gh ${action} failed with status ${result.status}: ${stderr || stdout || "no output"}`;
}

function isHttpStatus(result: SpawnSyncReturns<string>, status: number): boolean {
  return result.stderr.includes(`HTTP ${status}`) || result.stdout.includes(`${status} `);
}

function daysAgo(days: number): Date {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date;
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function encodePath(value: string): string {
  return encodeURIComponent(value);
}
