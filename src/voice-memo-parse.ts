#!/usr/bin/env bun
import { intro, note, outro } from "@clack/prompts";
import { spawnSync } from "node:child_process";
import {
  accessSync,
  closeSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import env from "./env";
import { failWithFullHelp } from "./utils/yargs";

const APPLE_REFERENCE_UNIX_SECONDS = 978307200;
const APP_NAME = "Voice Memos";
const APP_BUNDLE_ID = "com.apple.VoiceMemos";
const APP_PROCESS_NAME = "VoiceMemos";
const DEFAULT_FOLDER = "Captain's Log";
const DEFAULT_TRANSCRIBE_MODEL = "gemini-2.5-flash";
const DEFAULT_HIGHLIGHTS_MODEL = "gemini-3-flash";
const DEFAULT_SYNC_TIMEOUT_MS = 120_000;
const DEFAULT_SYNC_POLL_INTERVAL_MS = 3_000;
const DEFAULT_SYNC_STABLE_WINDOW_MS = 12_000;
const STATE_FILE_NAME = ".voice-memo-parse-state.json";
const OVERVIEW_FILE_NAME = "_overview.md";
const GEMINI_API_KEY_ENV = "GEMINI_API_KEY";
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com";
const GEMINI_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;
const AUDIO_EXTENSIONS = [".m4a", ".mp3", ".wav", ".aac", ".flac", ".mp4"];
const CONTAINER_ATOM_TYPES = new Set([
  "moov",
  "trak",
  "udta",
  "meta",
  "ilst",
  "mdia",
  "minf",
  "stbl",
  "edts",
  "dinf",
  "mvex",
]);

type SetupCheckId =
  | "sqlite"
  | "voice-memos-app"
  | "full-disk-access"
  | "voice-memos-data"
  | "output-dir"
  | "automation"
  | "gemini-api-key";

interface CliArgs {
  folder: string;
  outDir: string;
  setupPermissions: boolean;
  syncTimeoutMs: number;
  transcribeModel: string;
  highlightsModel: string;
}

interface VoiceMemoStorageLocation {
  recordingsDir: string;
  databasePath: string;
}

interface VoiceMemoRecording {
  guid: string;
  title: string | null;
  folderName: string | null;
  recordedAt: Date | null;
  durationSeconds: number | null;
  sourcePath: string;
}

interface ExportState {
  version: 1;
  exportedGuids: Record<string, ExportStateEntry>;
}

interface ExportStateEntry {
  baseName: string;
  exportedAt: string;
  transcriptSource: "embedded" | "gemini";
}

interface SetupCheckResult {
  id: SetupCheckId;
  label: string;
  ok: boolean;
  required: boolean;
  details: string;
  fix: string;
  settingsUrl?: string;
}

interface SyncSnapshot {
  databaseMtimeMs: number;
  m4aCount: number;
}

interface TranscriptResult {
  text: string;
  source: "embedded" | "gemini";
}

interface GeminiUploadedFile {
  name: string;
  uri: string;
  mimeType: string;
  state?: string;
}

interface OverviewSummary {
  location: string;
  bullets: string[];
}

if (import.meta.main) {
  void runCli();
}

async function runCli(): Promise<void> {
  try {
    const args = await parseCliArgs();
    if (args.setupPermissions) {
      runSetupPermissions(args);
      return;
    }

    const geminiApiKey = env.GEMINI_API_KEY;

    ensureOutputDirWritable(args.outDir);
    ensureVoiceMemosAppExists();

    const storage = resolveVoiceMemoStorageLocation();
    const appWasRunning = isVoiceMemosRunning();
    openVoiceMemosApp();

    try {
      await waitForVoiceMemoSync(storage, {
        timeoutMs: args.syncTimeoutMs,
        pollIntervalMs: DEFAULT_SYNC_POLL_INTERVAL_MS,
        stableWindowMs: DEFAULT_SYNC_STABLE_WINDOW_MS,
      });

      const recordings = loadVoiceMemoRecordings(storage);
      const folderRecordings = filterRecordingsByFolder(recordings, args.folder);
      const state = readExportState(args.outDir);
      const pendingRecordings = folderRecordings.filter(recording => !state.exportedGuids[recording.guid]);

      if (pendingRecordings.length === 0) {
        console.error(`No new recordings in folder "${args.folder}".`);
        const sectionCount = await writeOverviewMarkdown(args.outDir, geminiApiKey, args.highlightsModel);
        console.error(`Overview updated with ${sectionCount} section${sectionCount === 1 ? "" : "s"}.`);
        return;
      }

      await waitForPendingAudioFiles(pendingRecordings, args.syncTimeoutMs);

      console.error(
        `Processing ${pendingRecordings.length} new recording${pendingRecordings.length === 1 ? "" : "s"} from "${args.folder}"...`
      );

      const usedBasenames = collectExistingBasenames(args.outDir);
      let exportedCount = 0;
      let skippedMissingAudioCount = 0;

      for (const recording of pendingRecordings) {
        if (!existsSync(recording.sourcePath)) {
          console.error(`Skipping ${recording.guid}: source audio not downloaded yet (${recording.sourcePath}).`);
          skippedMissingAudioCount += 1;
          continue;
        }

        const recordedAt = recording.recordedAt ?? readBestEffortFileDate(recording.sourcePath);
        if (!recordedAt) {
          throw new Error(`Unable to determine recording date for ${recording.guid}.`);
        }

        const baseName = chooseUniqueBasename(formatMemoBasename(recordedAt), candidate => usedBasenames.has(candidate));
        usedBasenames.add(baseName);

        const sourceExtension = path.extname(recording.sourcePath) || ".m4a";
        const audioOutputPath = path.join(args.outDir, `${baseName}${sourceExtension}`);
        const markdownOutputPath = path.join(args.outDir, `${baseName}.md`);

        copyFileSync(recording.sourcePath, audioOutputPath);

        const transcript = await extractTranscriptWithGeminiFallback({
          audioPath: audioOutputPath,
          geminiApiKey,
          geminiModel: args.transcribeModel,
        });

        const markdown = buildMemoMarkdown({
          title: recording.title,
          folder: recording.folderName ?? args.folder,
          recordedAt,
          durationSeconds: recording.durationSeconds,
          guid: recording.guid,
          audioFileName: path.basename(audioOutputPath),
          transcriptSource: transcript.source,
          transcriptText: transcript.text,
        });

        writeFileSync(markdownOutputPath, markdown, "utf8");

        state.exportedGuids[recording.guid] = {
          baseName,
          exportedAt: new Date().toISOString(),
          transcriptSource: transcript.source,
        };
        writeExportState(args.outDir, state);

        exportedCount += 1;
        console.error(`Exported ${recording.guid} -> ${baseName}${sourceExtension} / ${baseName}.md`);
      }

      const sectionCount = await writeOverviewMarkdown(args.outDir, geminiApiKey, args.highlightsModel);

      console.error(
        `Done. Exported ${exportedCount} recording${exportedCount === 1 ? "" : "s"}.` +
          (skippedMissingAudioCount > 0
            ? ` ${skippedMissingAudioCount} recording${skippedMissingAudioCount === 1 ? "" : "s"} still missing audio.`
            : "")
      );
      console.error(`Overview updated with ${sectionCount} section${sectionCount === 1 ? "" : "s"}.`);
    } finally {
      if (!appWasRunning) {
        try {
          closeVoiceMemosApp();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`Warning: ${message}`);
        }
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  }
}

async function parseCliArgs(): Promise<CliArgs> {
  const home = requireEnv("HOME");
  const defaultOutDir = path.join(home, "Documents", "voice-memos", "captains-log");

  const parsed = await yargs(hideBin(process.argv))
    .scriptName("voice-memo-parse")
    .strict()
    .option("folder", {
      type: "string",
      default: DEFAULT_FOLDER,
      describe: "Voice Memos folder to export from",
    })
    .option("out-dir", {
      alias: ["o"],
      type: "string",
      default: defaultOutDir,
      describe: "Directory where audio + markdown files are written",
    })
    .option("setup-permissions", {
      type: "boolean",
      default: false,
      describe: "Only check permissions and setup requirements",
    })
    .option("sync-timeout-ms", {
      type: "number",
      default: DEFAULT_SYNC_TIMEOUT_MS,
      describe: "How long to wait for Voice Memos iCloud sync/download activity",
    })
    .option("gemini-model", {
      type: "string",
      default: DEFAULT_TRANSCRIBE_MODEL,
      describe: "Gemini model used for transcript fallback when embedded transcript is missing",
    })
    .option("highlights-model", {
      type: "string",
      default: DEFAULT_HIGHLIGHTS_MODEL,
      describe: "Gemini model used to generate _overview.md highlights",
    })
    .fail(failWithFullHelp)
    .help()
    .parseAsync();

  if (!Number.isFinite(parsed["sync-timeout-ms"]) || parsed["sync-timeout-ms"] <= 0) {
    throw new Error("--sync-timeout-ms must be a positive number.");
  }

  return {
    folder: parsed.folder,
    outDir: path.resolve(parsed["out-dir"]),
    setupPermissions: parsed["setup-permissions"],
    syncTimeoutMs: Math.floor(parsed["sync-timeout-ms"]),
    transcribeModel: parsed["gemini-model"],
    highlightsModel: parsed["highlights-model"],
  };
}

function runSetupPermissions(args: CliArgs): void {
  intro("voice-memo-parse permission setup");

  const checks = runSetupChecks(args);
  const checklistLines = checks.map(check => {
    const prefix = check.ok ? "[ok]" : check.required ? "[missing]" : "[warn]";
    return `${prefix} ${check.label}: ${check.details}`;
  });
  note(checklistLines.join("\n"), "Check results");

  const failedRequired = checks.filter(check => check.required && !check.ok);
  const optionalWarnings = checks.filter(check => !check.required && !check.ok);

  if (failedRequired.length === 0) {
    if (optionalWarnings.length > 0) {
      note(optionalWarnings.map(check => `- ${check.label}: ${check.fix}`).join("\n"), "Optional follow-ups");
    }
    outro("All required checks passed. You can run voice-memo-parse now.");
    return;
  }

  const fixLines = failedRequired.map(check => `- ${check.label}: ${check.fix}`);
  note(fixLines.join("\n"), "Action required");

  const steps = buildManualSetupSteps(failedRequired, optionalWarnings);
  if (steps.length > 0) {
    note(steps.join("\n"), "Exact steps");
  }

  openSettingsUrls(
    failedRequired
      .map(check => check.settingsUrl)
      .filter((value): value is string => typeof value === "string" && value.length > 0)
  );

  if (failedRequired.some(check => check.id === "full-disk-access")) {
    note(
      "macOS does not show an approval popup for Full Disk Access. That permission must be toggled manually in System Settings.",
      "Full Disk Access"
    );
  }

  outro("Permission setup is incomplete. Re-run `voice-memo-parse --setup-permissions` after enabling access.");
  process.exit(1);
}

function runSetupChecks(args: CliArgs): SetupCheckResult[] {
  const storage = resolveVoiceMemoStorageLocation();
  return [
    checkSqliteAvailable(),
    checkVoiceMemosAppInstalled(),
    checkFullDiskAccess(storage),
    checkVoiceMemosDataPresence(storage),
    checkOutputDirectoryWritable(args.outDir),
    checkAppleEventsAutomation(),
    checkGeminiApiKey(),
  ];
}

function checkSqliteAvailable(): SetupCheckResult {
  const result = spawnSync("sqlite3", ["-version"], { encoding: "utf8" });
  const ok = result.status === 0;
  return {
    id: "sqlite",
    label: "sqlite3 CLI",
    ok,
    required: true,
    details: ok ? `${(result.stdout ?? "").trim()}` : "sqlite3 is not available on PATH.",
    fix: "Install sqlite3 and ensure it is available on PATH.",
  };
}

function checkVoiceMemosAppInstalled(): SetupCheckResult {
  const appPath = "/System/Applications/VoiceMemos.app";
  const ok = existsSync(appPath);
  return {
    id: "voice-memos-app",
    label: "Voice Memos app",
    ok,
    required: true,
    details: ok ? `Found at ${appPath}` : "Voice Memos.app not found.",
    fix: "Install/restore the Voice Memos app on this Mac.",
  };
}

function checkFullDiskAccess(storage: VoiceMemoStorageLocation): SetupCheckResult {
  const probe = probePath(storage.recordingsDir);
  const ok = probe.exists && !probe.permissionDenied;
  const details = probe.permissionDenied
    ? `Access denied for ${storage.recordingsDir}`
    : probe.exists
      ? `Terminal can access ${storage.recordingsDir}`
      : `${storage.recordingsDir} is not present yet`;
  return {
    id: "full-disk-access",
    label: "Full Disk Access",
    ok,
    required: true,
    details,
    fix:
      "Enable Full Disk Access for your terminal app: System Settings -> Privacy & Security -> Full Disk Access.",
    settingsUrl: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
  };
}

function checkVoiceMemosDataPresence(storage: VoiceMemoStorageLocation): SetupCheckResult {
  const probe = probePath(storage.databasePath);
  const ok = probe.exists && !probe.permissionDenied;
  const details = probe.permissionDenied
    ? `Access denied for ${storage.databasePath}`
    : probe.exists
      ? `Found ${storage.databasePath}`
      : `Missing ${storage.databasePath}`;
  return {
    id: "voice-memos-data",
    label: "Voice Memos database",
    ok,
    required: true,
    details,
    fix: `Open ${APP_NAME}, keep iCloud sync enabled, and wait for recordings to sync to this Mac.`,
  };
}

function checkOutputDirectoryWritable(outDir: string): SetupCheckResult {
  try {
    if (existsSync(outDir)) {
      const stats = lstatSync(outDir);
      if (!stats.isDirectory()) {
        throw new Error(`Output path exists but is not a directory: ${outDir}`);
      }
      accessSync(outDir, fsConstants.W_OK);
      return {
        id: "output-dir",
        label: "Output directory",
        ok: true,
        required: true,
        details: `Writable: ${outDir}`,
        fix: "",
      };
    }

    const parent = findNearestExistingParentDirectory(outDir);
    if (!parent) {
      throw new Error(`No existing parent directory found for ${outDir}`);
    }
    accessSync(parent, fsConstants.W_OK);

    return {
      id: "output-dir",
      label: "Output directory",
      ok: true,
      required: true,
      details: `Will create ${outDir} (parent writable: ${parent})`,
      fix: "",
    };
  } catch (error) {
    const code = extractErrorCode(error);
    const message = error instanceof Error ? error.message : String(error);
    const needsFilesAndFolders = code === "EACCES" || code === "EPERM";
    return {
      id: "output-dir",
      label: "Output directory",
      ok: false,
      required: true,
      details: message,
      fix: needsFilesAndFolders
        ? `Allow ${detectTerminalAppName()} access to Documents in System Settings -> Privacy & Security -> Files and Folders, then retry.`
        : `Fix directory permissions for ${outDir}.`,
      settingsUrl: needsFilesAndFolders
        ? "x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders"
        : undefined,
    };
  }
}

function checkAppleEventsAutomation(): SetupCheckResult {
  const result = spawnSync("osascript", ["-e", `tell application id "${APP_BUNDLE_ID}" to get name`], {
    encoding: "utf8",
  });
  const ok = result.status === 0;
  const stderr = `${result.stderr ?? ""}`.trim();
  return {
    id: "automation",
    label: "Apple Events automation",
    ok,
    required: true,
    details: ok ? "Apple Events control works for Voice Memos." : stderr || "Automation check failed.",
    fix: "Allow your terminal app to control Voice Memos in System Settings -> Privacy & Security -> Automation.",
    settingsUrl: "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation",
  };
}

function checkGeminiApiKey(): SetupCheckResult {
  void env.GEMINI_API_KEY;
  return {
    id: "gemini-api-key",
    label: GEMINI_API_KEY_ENV,
    ok: true,
    required: false,
    details: `${GEMINI_API_KEY_ENV} is configured via src/env.ts schema.`,
    fix: "",
  };
}

function buildManualSetupSteps(
  failedRequired: readonly SetupCheckResult[],
  optionalWarnings: readonly SetupCheckResult[]
): string[] {
  const steps: string[] = [];
  const terminalAppName = detectTerminalAppName();
  let stepNumber = 1;

  const add = (instruction: string) => {
    steps.push(`${stepNumber}) ${instruction}`);
    stepNumber += 1;
  };

  if (failedRequired.some(check => check.id === "full-disk-access" || check.id === "voice-memos-data")) {
    add(
      `Open System Settings -> Privacy & Security -> Full Disk Access, then enable ${terminalAppName}. If missing, click + and add it.`
    );
    add("Fully quit and reopen that terminal app.");
  }

  if (failedRequired.some(check => check.id === "automation")) {
    add(`Open System Settings -> Privacy & Security -> Automation and allow ${terminalAppName} to control Voice Memos.`);
  }

  if (failedRequired.some(check => check.id === "voice-memos-data")) {
    add("Open Voice Memos and keep it open until your target memos are fully downloaded on this Mac.");
    add("Confirm iCloud sync is enabled: System Settings -> Apple Account -> iCloud -> Voice Memos.");
  }

  if (optionalWarnings.some(check => check.id === "gemini-api-key")) {
    add("Set GEMINI_API_KEY for transcription fallback and _overview.md highlights generation.");
  }

  return steps;
}

function openSettingsUrls(urls: readonly string[]): void {
  for (const url of Array.from(new Set(urls))) {
    try {
      runCommandOrThrow("open", [url], `Failed to open System Settings URL: ${url}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Warning: ${message}`);
    }
  }
}

function resolveVoiceMemoStorageLocation(): VoiceMemoStorageLocation {
  const home = requireEnv("HOME");
  const candidates: VoiceMemoStorageLocation[] = [
    {
      recordingsDir: path.join(home, "Library", "Group Containers", "group.com.apple.VoiceMemos.shared", "Recordings"),
      databasePath: path.join(
        home,
        "Library",
        "Group Containers",
        "group.com.apple.VoiceMemos.shared",
        "Recordings",
        "CloudRecordings.db"
      ),
    },
    {
      recordingsDir: path.join(
        home,
        "Library",
        "Containers",
        "com.apple.VoiceMemos",
        "Data",
        "Library",
        "Application Support",
        "Recordings"
      ),
      databasePath: path.join(
        home,
        "Library",
        "Containers",
        "com.apple.VoiceMemos",
        "Data",
        "Library",
        "Application Support",
        "Recordings",
        "CloudRecordings.db"
      ),
    },
    {
      recordingsDir: path.join(home, "Library", "Application Support", "com.apple.voicememos", "Recordings"),
      databasePath: path.join(home, "Library", "Application Support", "com.apple.voicememos", "Recordings", "CloudRecordings.db"),
    },
  ];

  const existing = candidates.find(candidate => existsSync(candidate.databasePath));
  if (existing) {
    return existing;
  }
  const permissionBlocked = candidates.find(candidate => probePath(candidate.recordingsDir).permissionDenied);
  if (permissionBlocked) {
    return permissionBlocked;
  }
  return candidates[0];
}

function ensureVoiceMemosAppExists(): void {
  const appPath = "/System/Applications/VoiceMemos.app";
  if (!existsSync(appPath)) {
    throw new Error(`Voice Memos app not found at ${appPath}.`);
  }
}

function ensureOutputDirWritable(outDir: string): void {
  mkdirSync(outDir, { recursive: true });
  accessSync(outDir, fsConstants.W_OK);
}

function isVoiceMemosRunning(): boolean {
  const result = spawnSync("pgrep", ["-x", APP_PROCESS_NAME], { encoding: "utf8" });
  if (result.error) {
    throw new Error(`Unable to check whether ${APP_NAME} is running: ${result.error.message}`);
  }
  return result.status === 0;
}

function openVoiceMemosApp(): void {
  runCommandOrThrow("open", ["-b", APP_BUNDLE_ID], `Failed to open ${APP_NAME}.`);
}

function closeVoiceMemosApp(): void {
  const quitResult = spawnSync("osascript", ["-e", `tell application id "${APP_BUNDLE_ID}" to quit`], {
    encoding: "utf8",
  });
  if (quitResult.status === 0) {
    return;
  }

  const killResult = spawnSync("pkill", ["-x", APP_PROCESS_NAME], { encoding: "utf8" });
  if (killResult.status === 0) {
    return;
  }

  const quitError = `${quitResult.stderr ?? ""}`.trim() || `${quitResult.stdout ?? ""}`.trim();
  const killError = `${killResult.stderr ?? ""}`.trim() || `${killResult.stdout ?? ""}`.trim();
  throw new Error(`Failed to close ${APP_NAME}.${quitError ? ` ${quitError}` : ""}${killError ? ` ${killError}` : ""}`);
}

async function waitForVoiceMemoSync(
  storage: VoiceMemoStorageLocation,
  options: { timeoutMs: number; pollIntervalMs: number; stableWindowMs: number }
): Promise<void> {
  console.error(`Waiting for ${APP_NAME} sync to settle...`);
  const startTime = Date.now();
  let lastFingerprint = "";
  let stableSince = Date.now();

  while (Date.now() - startTime < options.timeoutMs) {
    const snapshot = readSyncSnapshot(storage);
    if (!snapshot) {
      await sleep(options.pollIntervalMs);
      continue;
    }

    const fingerprint = `${snapshot.databaseMtimeMs}|${snapshot.m4aCount}`;
    if (fingerprint !== lastFingerprint) {
      lastFingerprint = fingerprint;
      stableSince = Date.now();
    }

    if (Date.now() - stableSince >= options.stableWindowMs) {
      console.error(`Sync settled (${snapshot.m4aCount} local .m4a files in storage).`);
      return;
    }

    await sleep(options.pollIntervalMs);
  }

  console.error("Sync wait timed out; continuing with currently available files.");
}

function readSyncSnapshot(storage: VoiceMemoStorageLocation): SyncSnapshot | null {
  if (!existsSync(storage.databasePath) || !existsSync(storage.recordingsDir)) {
    return null;
  }
  try {
    const databaseStat = statSync(storage.databasePath);
    const entries = readdirSync(storage.recordingsDir, { withFileTypes: true });
    const m4aCount = entries.filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith(".m4a")).length;
    return {
      databaseMtimeMs: databaseStat.mtimeMs,
      m4aCount,
    };
  } catch (error) {
    const code = extractErrorCode(error);
    if (code === "EACCES" || code === "EPERM") {
      throw new Error(
        `Cannot access ${storage.recordingsDir}. Enable Full Disk Access for your terminal app and retry.`
      );
    }
    throw error;
  }
}

async function waitForPendingAudioFiles(recordings: readonly VoiceMemoRecording[], timeoutMs: number): Promise<void> {
  const start = Date.now();
  let missing = recordings.filter(recording => !existsSync(recording.sourcePath));
  if (missing.length === 0) {
    return;
  }

  console.error(`Waiting for ${missing.length} pending recording${missing.length === 1 ? "" : "s"} to download...`);
  while (Date.now() - start < timeoutMs) {
    await sleep(DEFAULT_SYNC_POLL_INTERVAL_MS);
    missing = recordings.filter(recording => !existsSync(recording.sourcePath));
    if (missing.length === 0) {
      console.error("All pending recordings are downloaded locally.");
      return;
    }
  }

  if (missing.length > 0) {
    console.error(`Timed out waiting for downloads. ${missing.length} recording${missing.length === 1 ? "" : "s"} still missing audio.`);
  }
}

function loadVoiceMemoRecordings(storage: VoiceMemoStorageLocation): VoiceMemoRecording[] {
  const recordingsProbe = probePath(storage.recordingsDir);
  const databaseProbe = probePath(storage.databasePath);

  if (recordingsProbe.permissionDenied || databaseProbe.permissionDenied) {
    throw new Error(
      `Insufficient permissions to access ${storage.recordingsDir}. Enable Full Disk Access for your terminal app and retry.`
    );
  }
  if (!databaseProbe.exists) {
    throw new Error(
      `Voice Memos database not found at ${storage.databasePath}. Open ${APP_NAME} and wait for iCloud sync, then retry.`
    );
  }

  if (tableExists(storage.databasePath, "ZCLOUDRECORDING")) {
    return loadCloudRecordings(storage);
  }
  if (tableExists(storage.databasePath, "ZRECORDING")) {
    return loadLegacyRecordings(storage);
  }

  throw new Error(`No known recordings table found in ${storage.databasePath}.`);
}

function loadCloudRecordings(storage: VoiceMemoStorageLocation): VoiceMemoRecording[] {
  const sql = `
    SELECT
      r.ZUNIQUEID AS guid,
      r.ZPATH AS rel_path,
      r.ZDATE AS recorded_at,
      r.ZDURATION AS duration_seconds,
      COALESCE(NULLIF(r.ZENCRYPTEDTITLE, ''), NULLIF(r.ZCUSTOMLABELFORSORTING, ''), NULLIF(r.ZCUSTOMLABEL, '')) AS title,
      f.ZENCRYPTEDNAME AS folder_name
    FROM ZCLOUDRECORDING r
    LEFT JOIN ZFOLDER f ON f.Z_PK = r.ZFOLDER
    ORDER BY r.ZDATE ASC;
  `;

  const rows = runSqliteJson(storage.databasePath, sql);
  const recordings: VoiceMemoRecording[] = [];

  for (const row of rows) {
    const guid = normalizeString(row.guid);
    if (!guid) {
      continue;
    }

    const sourcePath = resolveRecordingSourcePath(storage.recordingsDir, guid, normalizeString(row.rel_path));
    recordings.push({
      guid,
      title: normalizeString(row.title),
      folderName: normalizeString(row.folder_name),
      recordedAt: parseAppleDate(row.recorded_at),
      durationSeconds: toFiniteNumber(row.duration_seconds),
      sourcePath,
    });
  }

  return recordings;
}

function loadLegacyRecordings(storage: VoiceMemoStorageLocation): VoiceMemoRecording[] {
  const sql = `
    SELECT
      r.ZUNIQUEID AS guid,
      r.ZPATH AS rel_path,
      r.ZDATE AS recorded_at,
      r.ZDURATION AS duration_seconds,
      NULLIF(r.ZCUSTOMLABEL, '') AS title
    FROM ZRECORDING r
    ORDER BY r.ZDATE ASC;
  `;

  const rows = runSqliteJson(storage.databasePath, sql);
  const recordings: VoiceMemoRecording[] = [];

  for (const row of rows) {
    const guid = normalizeString(row.guid);
    if (!guid) {
      continue;
    }

    const sourcePath = resolveRecordingSourcePath(storage.recordingsDir, guid, normalizeString(row.rel_path));
    recordings.push({
      guid,
      title: normalizeString(row.title),
      folderName: null,
      recordedAt: parseAppleDate(row.recorded_at),
      durationSeconds: toFiniteNumber(row.duration_seconds),
      sourcePath,
    });
  }

  return recordings;
}

function filterRecordingsByFolder(recordings: readonly VoiceMemoRecording[], folderName: string): VoiceMemoRecording[] {
  const target = normalizeFolderName(folderName);
  const filtered = recordings.filter(recording => normalizeFolderName(recording.folderName) === target);
  if (filtered.length > 0) {
    return filtered;
  }

  const knownFolders = Array.from(
    new Set(
      recordings
        .map(recording => recording.folderName)
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    )
  ).sort((left, right) => left.localeCompare(right));

  if (knownFolders.length > 0) {
    throw new Error(`No recordings found in folder "${folderName}". Available folders: ${knownFolders.join(", ")}`);
  }

  throw new Error(`Could not resolve folder names from Voice Memos metadata. Verify folder sync in ${APP_NAME} and retry.`);
}

function resolveRecordingSourcePath(recordingsDir: string, guid: string, relPath: string | null): string {
  if (!relPath) {
    return path.join(recordingsDir, `${guid}.m4a`);
  }

  let candidate = relPath.trim();
  if (candidate.startsWith("file://")) {
    candidate = decodeURIComponent(candidate.slice("file://".length));
  }
  if (candidate.startsWith("~/")) {
    return path.join(requireEnv("HOME"), candidate.slice(2));
  }
  if (path.isAbsolute(candidate)) {
    return candidate;
  }

  const parts = candidate.split("/");
  if (parts[0]?.toLowerCase() === "recordings") {
    return path.join(path.dirname(recordingsDir), ...parts);
  }
  return path.join(recordingsDir, candidate);
}

function tableExists(databasePath: string, tableName: string): boolean {
  const sql = `SELECT name FROM sqlite_master WHERE type='table' AND name='${escapeSqlLiteral(tableName)}';`;
  const rows = runSqliteJson(databasePath, sql);
  return rows.length > 0;
}

function runSqliteJson(databasePath: string, sql: string): Record<string, unknown>[] {
  const result = spawnSync("sqlite3", ["-readonly", "-json", databasePath, sql], { encoding: "utf8" });
  if (result.error) {
    throw new Error(`sqlite3 failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = `${result.stderr ?? ""}`.trim();
    throw new Error(stderr || `sqlite3 query failed for ${databasePath}`);
  }

  const stdout = `${result.stdout ?? ""}`.trim();
  if (!stdout) {
    return [];
  }
  const parsed = JSON.parse(stdout) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("sqlite3 --json output is not an array.");
  }
  return parsed.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object");
}

function readExportState(outDir: string): ExportState {
  const statePath = path.join(outDir, STATE_FILE_NAME);
  if (!existsSync(statePath)) {
    return { version: 1, exportedGuids: {} };
  }
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return { version: 1, exportedGuids: {} };
    }
    const exportedGuids =
      "exportedGuids" in parsed && parsed.exportedGuids && typeof parsed.exportedGuids === "object"
        ? (parsed.exportedGuids as Record<string, ExportStateEntry>)
        : {};
    return { version: 1, exportedGuids };
  } catch {
    return { version: 1, exportedGuids: {} };
  }
}

function writeExportState(outDir: string, state: ExportState): void {
  writeFileSync(path.join(outDir, STATE_FILE_NAME), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function collectExistingBasenames(outDir: string): Set<string> {
  const basenames = new Set<string>();
  if (!existsSync(outDir)) {
    return basenames;
  }

  const entries = readdirSync(outDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const extension = path.extname(entry.name).toLowerCase();
    if (extension === ".md" || AUDIO_EXTENSIONS.includes(extension)) {
      basenames.add(path.basename(entry.name, extension));
    }
  }
  return basenames;
}

function chooseUniqueBasename(baseName: string, isTaken: (candidate: string) => boolean): string {
  if (!isTaken(baseName)) {
    return baseName;
  }
  let suffix = 2;
  while (true) {
    const candidate = `${baseName}-${suffix}`;
    if (!isTaken(candidate)) {
      return candidate;
    }
    suffix += 1;
  }
}

function formatMemoBasename(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}_${hour}-${minute}`;
}

function buildMemoMarkdown(options: {
  title: string | null;
  folder: string;
  recordedAt: Date;
  durationSeconds: number | null;
  guid: string;
  audioFileName: string;
  transcriptSource: "embedded" | "gemini";
  transcriptText: string;
}): string {
  const title = options.title?.trim() || options.guid;
  const lines = [
    `# ${title}`,
    "",
    `- Recorded at: ${options.recordedAt.toISOString()}`,
    `- Folder: ${options.folder}`,
    `- Duration: ${formatDuration(options.durationSeconds)}`,
    `- GUID: ${options.guid}`,
    `- Audio file: ${options.audioFileName}`,
    `- Transcript source: ${options.transcriptSource}`,
    "",
    "## Transcript",
    "",
    options.transcriptText.trim() || "(empty transcript)",
    "",
  ];
  return lines.join("\n");
}

function formatDuration(durationSeconds: number | null): string {
  if (durationSeconds == null || !Number.isFinite(durationSeconds)) {
    return "unknown";
  }
  const totalSeconds = Math.max(0, Math.floor(durationSeconds));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

async function writeOverviewMarkdown(outDir: string, apiKey: string, model: string): Promise<number> {
  const entries = readdirSync(outDir, { withFileTypes: true });
  const markdownFiles = entries
    .filter(entry => entry.isFile())
    .map(entry => entry.name)
    .filter(name => name.endsWith(".md") && name !== OVERVIEW_FILE_NAME)
    .sort((left, right) => right.localeCompare(left));

  if (markdownFiles.length === 0) {
    writeFileSync(path.join(outDir, OVERVIEW_FILE_NAME), "", "utf8");
    return 0;
  }

  const sections: string[] = [];

  for (const markdownFileName of markdownFiles) {
    const markdownPath = path.join(outDir, markdownFileName);
    const baseName = path.basename(markdownFileName, ".md");
    const audioFileName = findAudioFileForBaseName(entries, baseName);
    const content = readFileSync(markdownPath, "utf8");
    const summary = await summarizeMemoForOverview(content, apiKey, model);

    const dateLabel = formatOverviewDate(baseName, markdownPath);
    const location = summary.location || inferLocationFallback(content) || "Unknown";
    const audioPart = audioFileName ? `[audio](${encodeURI(audioFileName)})` : "audio missing";
    const mdPart = `[md](${encodeURI(markdownFileName)})`;

    sections.push(`# ${dateLabel} ${location} (${audioPart}/${mdPart})`);
    for (const bullet of summary.bullets) {
      sections.push(`- ${bullet}`);
    }
    sections.push("");
  }

  writeFileSync(path.join(outDir, OVERVIEW_FILE_NAME), `${sections.join("\n").trimEnd()}\n`, "utf8");
  return markdownFiles.length;
}

function findAudioFileForBaseName(entries: readonly { name: string; isFile(): boolean }[], baseName: string): string | null {
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const extension = path.extname(entry.name).toLowerCase();
    if (!AUDIO_EXTENSIONS.includes(extension)) {
      continue;
    }
    if (path.basename(entry.name, extension) === baseName) {
      return entry.name;
    }
  }
  return null;
}

function formatOverviewDate(baseName: string, markdownPath: string): string {
  const match = baseName.match(/^(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})/);
  if (match) {
    return `${match[1]} ${match[2]}:${match[3]}`;
  }

  const content = readFileSync(markdownPath, "utf8");
  const recordedAtLine = content.match(/^- Recorded at:\s*(.+)$/m);
  if (recordedAtLine) {
    const date = new Date(recordedAtLine[1].trim());
    if (!Number.isNaN(date.getTime())) {
      const base = formatMemoBasename(date);
      return `${base.slice(0, 10)} ${base.slice(11, 13)}:${base.slice(14, 16)}`;
    }
  }

  const date = readBestEffortFileDate(markdownPath);
  if (date) {
    const basename = formatMemoBasename(date);
    return `${basename.slice(0, 10)} ${basename.slice(11).replace("-", ":")}`;
  }
  return baseName;
}

async function summarizeMemoForOverview(content: string, apiKey: string, model: string): Promise<OverviewSummary> {
  const modelsToTry = [normalizeGeminiModel(model)];
  if (!modelsToTry.includes("gemini-2.5-flash")) {
    modelsToTry.push("gemini-2.5-flash");
  }

  for (const candidateModel of modelsToTry) {
    const parsed = await requestOverviewSummary(content, apiKey, candidateModel);
    if (parsed) {
      return parsed;
    }
  }

  return {
    location: inferLocationFallback(content) || "Unknown",
    bullets: fallbackBulletsFromMarkdown(content),
  };
}

async function requestOverviewSummary(content: string, apiKey: string, model: string): Promise<OverviewSummary | null> {
  const prompt = [
    "You will receive a markdown voice memo note.",
    "Return JSON only, no markdown and no code fences.",
    'Schema: {"location":"<short location or Unknown>","bullets":["...","..."]}',
    "Rules:",
    "- location: 1-5 words. If not inferable, use \"Unknown\".",
    "- bullets: 2-5 concise bullets focused on follow-ups, notices, risks, reminders, or key next steps.",
    "- each bullet must be one sentence and under 140 characters.",
    "",
    "Markdown:",
    content,
  ].join("\n");

  try {
    const raw = await generateGeminiText({
      apiKey,
      model,
      parts: [{ text: prompt }],
      errorPrefix: "Gemini overview request failed",
    });

    const parsed = parseOverviewJson(raw);
    if (parsed) {
      return parsed;
    }

    const parsedText = parseOverviewText(raw);
    if (parsedText) {
      return parsedText;
    }

    return null;
  } catch {
    return null;
  }
}

function parseOverviewText(raw: string): OverviewSummary | null {
  const lines = raw
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0);
  if (lines.length === 0) {
    return null;
  }

  let location = "Unknown";
  const bullets: string[] = [];

  for (const line of lines) {
    if (line.toLowerCase().startsWith("location:")) {
      const value = line.slice("location:".length).trim();
      if (value) {
        location = value;
      }
      continue;
    }
    if (line.startsWith("- ") || line.startsWith("* ")) {
      bullets.push(line.slice(2).trim());
    }
  }

  const cleanedBullets = bullets.filter(Boolean).slice(0, 5);
  if (cleanedBullets.length === 0) {
    return null;
  }

  return {
    location,
    bullets: cleanedBullets,
  };
}

function parseOverviewJson(raw: string): OverviewSummary | null {
  const parsed = parseJsonObject(raw);
  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  const locationRaw = record.location;
  const bulletsRaw = record.bullets;
  if (typeof locationRaw !== "string" || !Array.isArray(bulletsRaw)) {
    return null;
  }

  const location = locationRaw.trim() || "Unknown";
  const bullets = bulletsRaw
    .filter((value): value is string => typeof value === "string")
    .map(value => value.trim())
    .filter(value => value.length > 0)
    .slice(0, 5);

  if (bullets.length === 0) {
    return null;
  }

  return {
    location,
    bullets,
  };
}

function parseJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
  }

  const match = trimmed.match(/\{[\s\S]*\}/);
  if (!match) {
    return null;
  }

  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

function fallbackBulletsFromMarkdown(content: string): string[] {
  const transcriptMatch = content.match(/## Transcript\n\n([\s\S]*)$/);
  const source = transcriptMatch ? transcriptMatch[1] : content;
  const lines = source
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .slice(0, 3)
    .map(line => line.slice(0, 140));

  if (lines.length > 0) {
    return lines;
  }

  return ["Review this memo for key follow-ups."];
}

function inferLocationFallback(content: string): string | null {
  const titleMatch = content.match(/^#\s+(.+)$/m);
  if (titleMatch && titleMatch[1].trim().length > 0) {
    return titleMatch[1].trim().slice(0, 40);
  }
  return null;
}

async function extractTranscriptWithGeminiFallback(options: {
  audioPath: string;
  geminiApiKey: string;
  geminiModel: string;
}): Promise<TranscriptResult> {
  const embedded = extractEmbeddedTranscriptText(options.audioPath);
  if (embedded) {
    return { text: embedded, source: "embedded" };
  }

  const transcript = await transcribeAudioWithGemini({
    audioPath: options.audioPath,
    apiKey: options.geminiApiKey,
    model: options.geminiModel,
  });
  return { text: transcript, source: "gemini" };
}

function extractEmbeddedTranscriptText(audioPath: string): string | null {
  const buffer = readFileSync(audioPath);
  const payload = findAtomPayload(buffer, "tsrp", 0, buffer.length);
  if (!payload) {
    return null;
  }

  const text = payload.toString("utf8").trim();
  if (!text) {
    return null;
  }

  try {
    const parsed = JSON.parse(text) as unknown;
    return extractTranscriptFromTsrpJson(parsed);
  } catch {
    return null;
  }
}

function extractTranscriptFromTsrpJson(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const root = value as Record<string, unknown>;
  const fragments: string[] = [];
  collectTextFragments(root.attributedString, fragments);
  if (fragments.length === 0) {
    collectTextFragments(root.transcript, fragments);
  }

  const combined = fragments.join('').replaceAll('\0', '').trim();
  return combined.length > 0 ? combined : null;
}

function collectTextFragments(value: unknown, fragments: string[]): void {
  if (typeof value === "string") {
    fragments.push(value);
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectTextFragments(item, fragments);
    }
    return;
  }

  const record = value as Record<string, unknown>;
  for (const key of ["text", "string", "value"]) {
    const candidate = record[key];
    if (typeof candidate === "string") {
      fragments.push(candidate);
    }
  }
  if (Array.isArray(record.runs)) {
    for (const run of record.runs) {
      collectTextFragments(run, fragments);
    }
  }
}

function findAtomPayload(buffer: Buffer, targetType: string, start: number, end: number): Buffer | null {
  let cursor = start;

  while (cursor + 8 <= end) {
    const header = readAtomHeader(buffer, cursor, end);
    if (!header) {
      break;
    }

    const atomStart = cursor;
    const atomEnd = atomStart + header.atomSize;
    if (atomEnd <= atomStart || atomEnd > end) {
      break;
    }

    const payloadStart = atomStart + header.headerSize;
    const payloadEnd = atomEnd;
    if (header.type === targetType) {
      return buffer.subarray(payloadStart, payloadEnd);
    }

    if (CONTAINER_ATOM_TYPES.has(header.type)) {
      const childStart = header.type === "meta" ? Math.min(payloadStart + 4, payloadEnd) : payloadStart;
      const childPayload = findAtomPayload(buffer, targetType, childStart, payloadEnd);
      if (childPayload) {
        return childPayload;
      }
    }

    cursor = atomEnd;
  }

  return null;
}

function readAtomHeader(
  buffer: Buffer,
  offset: number,
  parentEnd: number
): { type: string; atomSize: number; headerSize: number } | null {
  if (offset + 8 > parentEnd) {
    return null;
  }

  const size32 = buffer.readUInt32BE(offset);
  const type = buffer.toString("ascii", offset + 4, offset + 8);

  if (size32 === 0) {
    return { type, atomSize: parentEnd - offset, headerSize: 8 };
  }
  if (size32 === 1) {
    if (offset + 16 > parentEnd) {
      return null;
    }
    const extended = Number(buffer.readBigUInt64BE(offset + 8));
    if (!Number.isFinite(extended) || extended < 16) {
      return null;
    }
    return { type, atomSize: extended, headerSize: 16 };
  }
  if (size32 < 8) {
    return null;
  }
  return { type, atomSize: size32, headerSize: 8 };
}

async function transcribeAudioWithGemini(options: { audioPath: string; apiKey: string; model: string }): Promise<string> {
  const mimeType = inferMimeType(options.audioPath);
  const displayName = path.basename(options.audioPath);
  let uploadedFile: GeminiUploadedFile | null = null;

  try {
    uploadedFile = await uploadFileToGemini({
      apiKey: options.apiKey,
      filePath: options.audioPath,
      mimeType,
      displayName,
    });

    const activeFile = await waitForGeminiFileReady({
      apiKey: options.apiKey,
      file: uploadedFile,
      timeoutMs: 120_000,
      pollIntervalMs: 2_000,
    });

    const text = await generateGeminiText({
      apiKey: options.apiKey,
      model: options.model,
      parts: [
        {
          text: "Generate a verbatim transcript for this audio. Return plain text only and keep natural paragraph breaks.",
        },
        {
          file_data: {
            file_uri: activeFile.uri,
            mime_type: activeFile.mimeType,
          },
        },
      ],
      errorPrefix: "Gemini transcription request failed",
    });

    const transcript = text.trim();
    if (!transcript) {
      throw new Error("Gemini returned an empty transcript.");
    }
    return transcript;
  } finally {
    if (uploadedFile?.name) {
      await deleteGeminiFileBestEffort(options.apiKey, uploadedFile.name);
    }
  }
}

async function uploadFileToGemini(options: {
  apiKey: string;
  filePath: string;
  mimeType: string;
  displayName: string;
}): Promise<GeminiUploadedFile> {
  const fileSize = statSync(options.filePath).size;
  const startResponse = await fetch(
    `${GEMINI_BASE_URL}/upload/v1beta/files?key=${encodeURIComponent(options.apiKey)}`,
    {
      method: "POST",
      headers: {
        "X-Goog-Upload-Protocol": "resumable",
        "X-Goog-Upload-Command": "start",
        "X-Goog-Upload-Header-Content-Length": `${fileSize}`,
        "X-Goog-Upload-Header-Content-Type": options.mimeType,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ file: { display_name: options.displayName } }),
    }
  );

  if (!startResponse.ok) {
    throw new Error(`Gemini upload start failed: ${await formatFetchError(startResponse)}`);
  }

  const uploadUrl = startResponse.headers.get("x-goog-upload-url");
  if (!uploadUrl) {
    throw new Error("Gemini upload start did not return x-goog-upload-url.");
  }

  const fd = openSync(options.filePath, "r");
  let offset = 0;

  try {
    while (offset < fileSize) {
      const bytesToRead = Math.min(GEMINI_UPLOAD_CHUNK_BYTES, fileSize - offset);
      const buffer = Buffer.allocUnsafe(bytesToRead);
      const bytesRead = readSync(fd, buffer, 0, bytesToRead, offset);
      if (bytesRead <= 0) {
        throw new Error("Unexpected EOF during Gemini file upload.");
      }

      const isFinalChunk = offset + bytesRead >= fileSize;
      const uploadCommand = isFinalChunk ? "upload, finalize" : "upload";

      const uploadResponse = await fetch(uploadUrl, {
        method: "POST",
        headers: {
          "Content-Length": `${bytesRead}`,
          "X-Goog-Upload-Offset": `${offset}`,
          "X-Goog-Upload-Command": uploadCommand,
        },
        body: bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead),
      });

      if (!uploadResponse.ok) {
        throw new Error(`Gemini upload chunk failed: ${await formatFetchError(uploadResponse)}`);
      }

      if (isFinalChunk) {
        const payload = (await uploadResponse.json()) as { file?: GeminiUploadedFile } | GeminiUploadedFile;
        const file = (payload && "file" in payload ? payload.file : payload) as GeminiUploadedFile | undefined;
        if (!file || !file.name || !file.uri) {
          throw new Error("Gemini upload finalize response did not include file metadata.");
        }
        return {
          name: file.name,
          uri: file.uri,
          mimeType: file.mimeType || options.mimeType,
          state: file.state,
        };
      }

      offset += bytesRead;
    }
  } finally {
    closeSync(fd);
  }

  throw new Error("Gemini upload failed before finalize.");
}

async function waitForGeminiFileReady(options: {
  apiKey: string;
  file: GeminiUploadedFile;
  timeoutMs: number;
  pollIntervalMs: number;
}): Promise<GeminiUploadedFile> {
  const initialState = options.file.state?.toUpperCase();
  if (!initialState || initialState === "ACTIVE") {
    return options.file;
  }

  const start = Date.now();
  while (Date.now() - start < options.timeoutMs) {
    const payload = await fetchJsonOrThrow<{ file?: GeminiUploadedFile } | GeminiUploadedFile>(
      `${GEMINI_BASE_URL}/v1beta/${options.file.name}?key=${encodeURIComponent(options.apiKey)}`,
      { method: "GET" },
      "Gemini file status request failed"
    );
    const file = (payload && "file" in payload ? payload.file : payload) as GeminiUploadedFile | undefined;
    if (!file) {
      throw new Error(`Gemini status response missing file data for ${options.file.name}.`);
    }

    const state = file.state?.toUpperCase();
    if (!state || state === "ACTIVE") {
      return {
        name: file.name || options.file.name,
        uri: file.uri || options.file.uri,
        mimeType: file.mimeType || options.file.mimeType,
        state,
      };
    }
    if (state === "FAILED") {
      throw new Error(`Gemini file processing failed for ${options.file.name}.`);
    }

    await sleep(options.pollIntervalMs);
  }

  throw new Error(`Gemini file did not become ACTIVE within ${Math.round(options.timeoutMs / 1000)} seconds.`);
}

async function deleteGeminiFileBestEffort(apiKey: string, fileName: string): Promise<void> {
  try {
    await fetch(`${GEMINI_BASE_URL}/v1beta/${fileName}?key=${encodeURIComponent(apiKey)}`, { method: "DELETE" });
  } catch {
  }
}

async function generateGeminiText(options: {
  apiKey: string;
  model: string;
  parts: Array<Record<string, unknown>>;
  errorPrefix: string;
}): Promise<string> {
  const modelName = normalizeGeminiModel(options.model);
  const response = await fetchJsonOrThrow<GeminiGenerateContentResponse>(
    `${GEMINI_BASE_URL}/v1beta/models/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(options.apiKey)}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [
          {
            parts: options.parts,
          },
        ],
      }),
    },
    options.errorPrefix
  );

  const textParts: string[] = [];
  for (const candidate of response.candidates ?? []) {
    for (const part of candidate.content?.parts ?? []) {
      if (typeof part.text === "string") {
        textParts.push(part.text);
      }
    }
  }

  const text = textParts.join("\n").trim();
  if (!text) {
    throw new Error(`${options.errorPrefix}: model returned no text.`);
  }
  return text;
}

function normalizeGeminiModel(model: string): string {
  const trimmed = model.trim();
  return trimmed.startsWith("models/") ? trimmed.slice("models/".length) : trimmed;
}

function inferMimeType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  switch (extension) {
    case ".m4a":
    case ".mp4":
      return "audio/mp4";
    case ".mp3":
      return "audio/mpeg";
    case ".wav":
      return "audio/wav";
    case ".aac":
      return "audio/aac";
    case ".flac":
      return "audio/flac";
    default:
      return "application/octet-stream";
  }
}

function probePath(filePath: string): { exists: boolean; permissionDenied: boolean } {
  try {
    const stats = lstatSync(filePath);
    if (stats.isDirectory()) {
      readdirSync(filePath, { withFileTypes: true });
    } else if (stats.isFile()) {
      const fd = openSync(filePath, "r");
      closeSync(fd);
    }
    return { exists: true, permissionDenied: false };
  } catch (error) {
    const code = extractErrorCode(error);
    if (code === "EACCES" || code === "EPERM") {
      return { exists: false, permissionDenied: true };
    }
    return { exists: false, permissionDenied: false };
  }
}

function findNearestExistingParentDirectory(targetPath: string): string | null {
  let current = path.resolve(targetPath);
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
  return current;
}

function detectTerminalAppName(): string {
  const termProgram = (process.env.TERM_PROGRAM ?? "").trim();
  if (termProgram === "Apple_Terminal") {
    return "Terminal";
  }
  if (termProgram === "iTerm.app") {
    return "iTerm";
  }
  if (termProgram.toLowerCase() === "vscode") {
    return "Visual Studio Code";
  }
  if (termProgram.toLowerCase().includes("warp")) {
    return "Warp";
  }
  return "the terminal app running this command";
}

function runCommandOrThrow(command: string, args: string[], errorPrefix: string): void {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error) {
    throw new Error(`${errorPrefix} ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = `${result.stderr ?? ""}`.trim();
    const stdout = `${result.stdout ?? ""}`.trim();
    throw new Error(`${errorPrefix}${stderr ? ` ${stderr}` : stdout ? ` ${stdout}` : ""}`);
  }
}

async function fetchJsonOrThrow<T>(url: string, init: RequestInit, errorPrefix: string): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`${errorPrefix}: ${await formatFetchError(response)}`);
  }
  return (await response.json()) as T;
}

async function formatFetchError(response: Response): Promise<string> {
  const text = (await response.text()).trim();
  return `${response.status} ${response.statusText}${text ? `: ${text.slice(0, 500)}` : ""}`;
}

function parseAppleDate(value: unknown): Date | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date((value + APPLE_REFERENCE_UNIX_SECONDS) * 1000);
  }
  if (typeof value === "string") {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber)) {
      return new Date((asNumber + APPLE_REFERENCE_UNIX_SECONDS) * 1000);
    }
    const asDate = new Date(value);
    if (!Number.isNaN(asDate.getTime())) {
      return asDate;
    }
  }
  return null;
}

function readBestEffortFileDate(filePath: string): Date | null {
  try {
    const stats = statSync(filePath);
    if (typeof stats.birthtimeMs === "number" && Number.isFinite(stats.birthtimeMs) && stats.birthtimeMs > 0) {
      return new Date(stats.birthtimeMs);
    }
    return new Date(stats.mtimeMs);
  } catch {
    return null;
  }
}

function normalizeString(value: unknown): string | null {
  if (typeof value === "string") {
    const normalized = value.replaceAll('\0', '').trim();
    return normalized.length > 0 ? normalized : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function normalizeFolderName(value: string | null): string {
  return (value ?? "").trim().toLocaleLowerCase();
}

function extractErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") {
    return null;
  }
  const code = "code" in error ? (error as { code?: unknown }).code : null;
  return typeof code === "string" ? code : null;
}

function escapeSqlLiteral(value: string): string {
  return value.replaceAll("'", "''");
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set.`);
  }
  return value;
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, milliseconds));
}

interface GeminiGenerateContentResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
  }>;
}
