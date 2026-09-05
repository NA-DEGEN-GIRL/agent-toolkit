import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  parseBaseArgs,
  resolveExecutablePath,
  resolveLauncher,
  resolveProviderModel
} from "./launcher.js";
import {
  DEFAULT_MAX_MARKDOWN_BYTES,
  createRequestDirectory,
  ensureStateRoot,
  ensureStateSubdir,
  readJsonFile,
  readMarkdownInput,
  resolveStateRoot,
  writeFileAtomic,
  writeFileExclusive,
  writeJsonAtomic
} from "./runtime.js";

export const PROVIDERS = {
  codex: {
    id: "codex",
    displayName: "Codex",
    envName: "CODEX",
    defaultSessionName: "codex-mcp",
    defaultCommand: "codex",
    defaultModel: "",
    supportsModelFlag: true,
    tmuxModeArgs() {
      return ["--no-alt-screen"];
    },
    headlessModeArgs() {
      return [
        "exec",
        "--skip-git-repo-check",
        "--color",
        "never",
        "-"
      ];
    }
  },
  claude: {
    id: "claude",
    displayName: "Claude",
    envName: "CLAUDE",
    defaultSessionName: "claude-mcp",
    defaultCommand: "claude",
    defaultModel: "",
    supportsModelFlag: true,
    tmuxModeArgs() {
      return [];
    },
    headlessModeArgs() {
      return [
        "-p",
        "--output-format",
        "text",
        "--no-session-persistence"
      ];
    }
  },
  grok: {
    id: "grok",
    displayName: "Grok",
    envName: "GROK",
    defaultSessionName: "grok-mcp",
    defaultCommand: "grok --no-alt-screen",
    defaultModel: "",
    supportsModelFlag: true,
    tmuxModeArgs() {
      return ["--no-alt-screen"];
    },
    headlessModeArgs(promptPath) {
      return [
        "--prompt-file",
        promptPath,
        "--output-format",
        "plain",
        "--max-turns",
        "80",
        "--no-memory"
      ];
    }
  },
  antigravity: {
    id: "antigravity",
    displayName: "Antigravity",
    envName: "ANTIGRAVITY",
    defaultSessionName: "antigravity-mcp",
    defaultCommand: "agy",
    defaultModel: "",
    supportsModelFlag: true,
    tmuxModeArgs() {
      return [];
    },
    headlessModeArgs(_promptPath, timeoutMs) {
      return ["--print", "--print-timeout", durationForAgy(timeoutMs)];
    }
  }
};

export const PROVIDER_ALIASES = {
  agy: "antigravity",
  google: "antigravity",
  gemini: "antigravity",
  gpt: "codex",
  openai: "codex",
  xai: "grok"
};

const DEFAULT_CAPTURE_LINES = 4000;
const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_HEADLESS_TIMEOUT_MS = 600000;
const DEFAULT_POLL_MS = 300;
const DEFAULT_READY_TIMEOUT_MS = 15000;
const DEFAULT_COLUMNS = 160;
const DEFAULT_ROWS = 50;
const MAX_TIMEOUT_MS = 60 * 60 * 1000;
const MAX_CAPTURE_LINES = 10000;
const DEFAULT_MAX_COMMAND_OUTPUT_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_SESSIONS = 8;
let activeHeadlessCalls = 0;
const activeHeadlessByProvider = new Map();

export class LlmRouterError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "LlmRouterError";
    this.details = details;
  }
}

export function listProviders() {
  return Object.values(PROVIDERS).map((provider) => ({
    id: provider.id,
    displayName: provider.displayName,
    defaultSessionName: provider.defaultSessionName,
    defaultModel: provider.defaultModel || "CLI default",
    supportsModelFlag: provider.supportsModelFlag,
    defaultTmuxCommand: `${provider.defaultCommand.split(/\s+/)[0]} (wrapper-aware full bypass)`,
    modelPolicy: "request > environment > CLI default",
    bypassRequired: true,
    headlessAvailable: true
  }));
}

export async function doctorProviders(options = {}) {
  throwIfAborted(options.signal);
  const providerIds = options.provider
    ? [normalizeProvider(options.provider)]
    : Object.keys(PROVIDERS);
  const environment = mergedEnv();
  const tmux = await runCommand("tmux", ["-V"], {
    allowFailure: true,
    timeoutMs: 5000,
    signal: options.signal,
    killProcessGroup: true
  }).catch((error) => {
    throwIfAborted(options.signal);
    return { code: null, stdout: "", stderr: error.message };
  });
  const reports = [];

  for (const provider of providerIds) {
    const config = providerConfig(provider);
    try {
      const launcher = await resolveLauncher(provider, {
        mode: "tmux",
        modeArgs: config.tmuxModeArgs(),
        environment,
        cwd: process.cwd()
      });
      const resolvedExecutable = await resolveExecutablePath(launcher.command, {
        environment,
        cwd: process.cwd()
      });
      let version = null;
      let launchProbeAccepted = null;
      let launchProbeExitCode = null;
      let launchProbeSkippedReason = null;
      if (resolvedExecutable) {
        if (launcher.opaqueWrapper) {
          launchProbeSkippedReason =
            "opaque shell wrapper is unverified; version and help probes skipped";
        } else if (!launcher.bypassVerified) {
          launchProbeSkippedReason =
            "launcher bypass is unverified; version and help probes skipped";
        } else {
          const versionRun = await runCommand(launcher.command, ["--version"], {
            allowFailure: true,
            timeoutMs: 5000,
            signal: options.signal,
            killProcessGroup: true,
            maxOutputBytes: 64 * 1024
          });
          version = truncateText((versionRun.stdout || versionRun.stderr).trim(), 500) || null;
          const baseArgs = parseBaseArgs(provider, environment);
          if (!launcher.legacyCommand && baseArgs.length === 0) {
            const probe = await runCommand(launcher.command, [...launcher.args, "--help"], {
              allowFailure: true,
              timeoutMs: 5000,
              signal: options.signal,
              killProcessGroup: true,
              maxOutputBytes: 128 * 1024
            });
            launchProbeAccepted = probe.code === 0;
            launchProbeExitCode = probe.code;
          } else {
            launchProbeSkippedReason = launcher.legacyCommand
              ? "legacy command is opaque"
              : "BASE_ARGS may contain prompt-capable arguments";
          }
        }
      }
      reports.push({
        provider,
        available: Boolean(resolvedExecutable),
        executable: launcher.command,
        resolvedExecutable,
        version,
        launchProbeAccepted,
        launchProbeExitCode,
        launchProbeSkippedReason,
        model: launcher.model || "CLI default",
        modelSource: launcher.modelSource,
        bypassRequired: true,
        bypassSource: launcher.bypassSource,
        bypassVerified: launcher.bypassVerified,
        opaqueWrapper: Boolean(launcher.opaqueWrapper),
        legacyCommand: Boolean(launcher.legacyCommand),
        aliasesSupported: false,
        wrapperInspection: "strict one-line shell exec wrappers with literal known flags"
      });
    } catch (error) {
      throwIfAborted(options.signal);
      reports.push({
        provider,
        available: false,
        bypassRequired: true,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return {
    tmux: {
      available: tmux.code === 0,
      version: tmux.code === 0 ? tmux.stdout.trim() : null,
      socketLabel: tmuxSocketLabel(),
      isolatedSocket: true
    },
    modelPolicy: "request > provider environment > CLI configuration/default",
    providers: reports
  };
}

export function normalizeProvider(provider) {
  const raw = String(provider || "").trim().toLowerCase();
  const id = PROVIDER_ALIASES[raw] || raw;
  if (!PROVIDERS[id]) {
    throw new LlmRouterError("provider must be one of: codex, claude, grok, antigravity", {
      provider
    });
  }
  return id;
}

export function providerConfig(provider) {
  return PROVIDERS[normalizeProvider(provider)];
}

export function defaultStateDir() {
  return resolveStateRoot();
}

export function defaultWorkDir(provider, stateDir = defaultStateDir()) {
  const config = providerConfig(provider);
  return path.join(path.resolve(stateDir), "workdirs", config.id);
}

export function makeNonce() {
  return crypto.randomUUID();
}

export function markerSet(provider, nonce) {
  const config = providerConfig(provider);
  validateNonce(nonce);
  return {
    nonce,
    startMarker: `${config.envName}_TMUX_STARTED:${nonce}`,
    doneMarker: `${config.envName}_TMUX_DONE:${nonce}`,
    startPrefix: `${config.envName}_TMUX_STARTED:`,
    donePrefix: `${config.envName}_TMUX_DONE:`
  };
}

export function validateNonce(nonce) {
  if (typeof nonce !== "string" || !/^[A-Za-z0-9_.:-]{6,96}$/.test(nonce)) {
    throw new LlmRouterError(
      "nonce must be 6-96 chars and contain only letters, numbers, dot, underscore, colon, or dash",
      { nonce }
    );
  }
}

export function validateSessionName(sessionName) {
  if (
    typeof sessionName !== "string" ||
    !/^[A-Za-z0-9_-]{1,80}$/.test(sessionName)
  ) {
    throw new LlmRouterError(
      "sessionName must be 1-80 chars and contain only letters, numbers, underscore, or dash",
      { sessionName }
    );
  }
}

export function tmuxSocketLabel(stateDir) {
  const stateHash = crypto
    .createHash("sha256")
    .update(path.resolve(resolveStateRoot(stateDir)))
    .digest("hex")
    .slice(0, 10);
  const fallback = `llm-router-${typeof process.getuid === "function" ? process.getuid() : "user"}-${stateHash}`;
  const label = process.env.LLM_ROUTER_MCP_TMUX_SOCKET_LABEL || fallback;
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(label)) {
    throw new LlmRouterError(
      "LLM_ROUTER_MCP_TMUX_SOCKET_LABEL must contain only letters, numbers, underscore, or dash",
      { label }
    );
  }
  return label;
}

export function normalizeTimeout(timeoutMs, fallback = DEFAULT_TIMEOUT_MS) {
  if (timeoutMs === undefined || timeoutMs === null) {
    return fallback;
  }
  const parsed = Number(timeoutMs);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > MAX_TIMEOUT_MS) {
    throw new LlmRouterError(`timeoutMs must be between 1 and ${MAX_TIMEOUT_MS}`, { timeoutMs });
  }
  return Math.trunc(parsed);
}

export function normalizeDimension(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 20 || parsed > 1000) {
    throw new LlmRouterError("terminal dimensions must be numbers between 20 and 1000", { value });
  }
  return Math.trunc(parsed);
}

export function resolveModel(provider, requestedModel) {
  return resolveProviderModel(provider, requestedModel).model;
}

export async function buildTmuxCommand(provider, model, options = {}) {
  const config = providerConfig(provider);
  const launcher = await resolveLauncher(config.id, {
    mode: "tmux",
    requestedModel: model,
    modeArgs: config.tmuxModeArgs(),
    environment: mergedEnv(),
    cwd: options.cwd
  });
  assertBypassVerified(launcher, options);
  return launcher.legacyCommand || [launcher.command, ...launcher.args].map(shellQuote).join(" ");
}

export async function runCommand(command, args = [], options = {}) {
  throwIfAborted(options.signal);
  const timeoutMs = normalizeTimeout(options.timeoutMs, 15000);
  const maxOutputBytes = normalizeOutputLimit(options.maxOutputBytes);
  const startedAt = Date.now();

  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: mergedEnv(options.env),
      stdio: ["pipe", "pipe", "pipe"],
      detached: options.killProcessGroup === true && process.platform !== "win32"
    });
    const stdoutCapture = createBoundedCapture(maxOutputBytes);
    const stderrCapture = createBoundedCapture(maxOutputBytes);
    let settled = false;
    let termination = null;
    let inputError = null;
    let forceKillTimer;
    const commandResult = (code, signal) => ({
      command, args, code, signal,
      stdout: stdoutCapture.text(), stderr: stderrCapture.text(),
      stdoutTruncated: stdoutCapture.truncated,
      stderrTruncated: stderrCapture.truncated,
      elapsedMs: Date.now() - startedAt
    });
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceKillTimer);
      options.signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(result);
    };
    const terminationError = (code, signal) => new LlmRouterError(
      termination === "cancelled" ? "operation cancelled"
        : termination === "input" ? `failed to write command input: ${command}`
        : `command timed out after ${timeoutMs}ms`,
      {
        ...commandResult(code, signal),
        code: termination === "cancelled" ? "ERR_CANCELLED"
          : termination === "input" ? "ERR_COMMAND_INPUT" : code,
        ...(inputError ? { cause: inputError.message } : {}),
        cancelled: termination === "cancelled",
        timedOut: termination === "timeout"
      }
    );
    const terminate = (reason) => {
      if (settled || termination) return;
      termination = reason;
      clearTimeout(timer);
      killChild(child, "SIGTERM", options.killProcessGroup === true);
      // A leader can exit while TERM-resistant descendants with independent
      // stdio remain. Keep group escalation alive until KILL, even after close.
      forceKillTimer = setTimeout(() => {
        killChild(child, "SIGKILL", options.killProcessGroup === true);
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        finish(terminationError(null, "SIGKILL"));
      }, 1000);
    };
    const onAbort = () => terminate("cancelled");
    const timer = setTimeout(() => terminate("timeout"), timeoutMs);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    child.stdout.on("data", (chunk) => stdoutCapture.append(chunk));
    child.stderr.on("data", (chunk) => stderrCapture.append(chunk));
    child.stdin.on("error", (error) => {
      if (["EPIPE", "ERR_STREAM_DESTROYED"].includes(error?.code) || settled) return;
      inputError = error;
      terminate("input");
    });
    child.on("error", (error) => {
      finish(new LlmRouterError(`failed to run command: ${command}`, {
        command, args, cause: error.message
      }));
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      if (termination) {
        if (options.killProcessGroup !== true || process.platform === "win32") {
          finish(terminationError(code, signal));
        }
        return;
      }
      const result = commandResult(code, signal);
      if (code !== 0 && !options.allowFailure) {
        finish(new LlmRouterError(`command failed: ${command} ${args.join(" ")}`, result));
      } else finish(null, result);
    });
    try {
      child.stdin.end(options.input);
    } catch (error) {
      if (!["EPIPE", "ERR_STREAM_DESTROYED"].includes(error?.code)) child.stdin.emit("error", error);
    }
  });
}

export async function tmuxVersion() {
  const result = await runCommand("tmux", ["-V"]);
  return result.stdout.trim();
}

async function runTmux(args, options = {}) {
  const { stateDir, ...commandOptions } = options;
  return await runCommand(
    "tmux",
    ["-L", tmuxSocketLabel(stateDir), "-f", "/dev/null", ...args],
    commandOptions
  );
}

function exactTmuxTarget(sessionName) {
  return `=${sessionName}`;
}

function exactTmuxPaneTarget(sessionName) {
  return `=${sessionName}:`;
}

function isTmuxAbsentResult(result) {
  const message = `${result?.stdout || ""}\n${result?.stderr || ""}`;
  return /(?:no server running|can't find (?:session|pane)|no sessions|error connecting to .*\((?:no such file or directory|connection refused)\))/i.test(
    message
  );
}

async function cleanupTmuxSocketIfEmpty(stateDir) {
  let absent = false;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const sessions = await runTmux(["list-sessions", "-F", "#{session_name}"], {
      allowFailure: true,
      timeoutMs: 5000,
      stateDir
    });
    if (sessions.code === 0 && sessions.stdout.trim()) {
      return false;
    }
    if (sessions.code !== 0 && !isTmuxAbsentResult(sessions)) {
      throw new LlmRouterError("could not determine whether the tmux socket is empty", {
        code: "ERR_TMUX_LIST",
        exitCode: sessions.code,
        stderr: truncateText(sessions.stderr.trim(), 500)
      });
    }
    if (sessions.code !== 0 && isTmuxAbsentResult(sessions)) {
      absent = true;
      break;
    }
    await sleep(50);
  }
  if (!absent) {
    return false;
  }
  const socketDirectory = path.join(
    process.env.TMUX_TMPDIR || os.tmpdir(),
    `tmux-${typeof process.getuid === "function" ? process.getuid() : "user"}`
  );
  const socketPath = path.join(socketDirectory, tmuxSocketLabel(stateDir));
  try {
    const stat = await fs.lstat(socketPath);
    if (stat.isSocket()) {
      await fs.rm(socketPath, { force: true });
      return true;
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return false;
}

export async function hasSession(options = {}) {
  const sessionName = resolveSessionName(options.provider, options.sessionName);
  validateSessionName(sessionName);
  let result;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    result = await runTmux(["has-session", "-t", exactTmuxTarget(sessionName)], {
      allowFailure: true,
      timeoutMs: 5000,
      stateDir: options.stateDir
    });
    // tmux can close its last-session server while a lookup connects. Retry
    // the transient disconnect, rather than misreporting stop as a failure.
    if (result.code !== 0 && /server exited unexpectedly/i.test(result.stderr) && attempt < 2) {
      await sleep(25);
      continue;
    }
    break;
  }
  if (result.code === 0) return true;
  if (isTmuxAbsentResult(result)) return false;
  throw new LlmRouterError("tmux session lookup failed", {
    code: "ERR_TMUX_LOOKUP",
    exitCode: result.code,
    stderr: truncateText(result.stderr.trim(), 500)
  });
}

export async function killSession(options = {}) {
  throwIfAborted(options.signal);
  const provider = normalizeProvider(options.provider);
  const sessionName = resolveSessionName(options.provider, options.sessionName);
  validateSessionName(sessionName);
  const stateDir = await ensureStateRoot(options.stateDir);
  const paths = await sessionStatePaths({ provider, sessionName, stateDir });
  const releaseLaunchLock = await acquireDirectoryLock(paths.launchLockPath, {
    timeoutMs: 10000,
    signal: options.signal,
    wait: true,
    metadata: { provider, sessionName, kind: "launch" }
  });
  try {
    const capacityDir = await ensureStateSubdir(stateDir, "sessions");
    const releaseCapacityLock = await acquireDirectoryLock(
      path.join(capacityDir, ".capacity-lock"),
      {
        timeoutMs: 10000,
        signal: options.signal,
        wait: true,
        metadata: { kind: "capacity" }
      }
    );
    try {
      let stopTarget = exactTmuxTarget(sessionName);
      if (options.requireOwned) {
        if (await hasSession({ provider, sessionName, stateDir })) {
          const metadata = await readSessionMetadata(paths.metadataPath);
          if (isStartingSessionMetadata(metadata, provider, sessionName)) {
            stopTarget = await assertRecoverableLaunchOwnership(metadata, stateDir);
          } else {
            await verifyOwnedSession({
              provider,
              sessionName,
              stateDir,
              metadata
            });
          }
        } else {
          const metadata = await readSessionMetadata(paths.metadataPath);
          if (!metadata || metadata.provider !== provider || metadata.sessionName !== sessionName) {
            throw new LlmRouterError("tmux session is not owned by this router state", {
              code: "ERR_SESSION_NOT_OWNED",
              provider,
              sessionName
            });
          }
        }
      }
      // Cancellation is honored until the stop commits. Once kill is sent,
      // complete cleanup without cancellation to avoid half-removed state.
      throwIfAborted(options.signal);
      const result = await runTmux(["kill-session", "-t", stopTarget], {
        allowFailure: true,
        timeoutMs: 5000,
        stateDir
      });
      const stopped = !(await hasSession({ provider, sessionName, stateDir }));
      if (!stopped) {
        throw new LlmRouterError("tmux session is still running after stop request", {
          code: "ERR_SESSION_STOP_FAILED",
          provider,
          sessionName,
          exitCode: result.code,
          stderr: truncateText(result.stderr.trim(), 500)
        });
      }
      await Promise.all([
        fs.rm(paths.metadataPath, { force: true }),
        fs.rm(paths.busyLockPath, { recursive: true, force: true })
      ]);
      await cleanupTmuxSocketIfEmpty(stateDir);
      return {
        provider,
        sessionName,
        stopped: result.code === 0,
        running: false
      };
    } finally {
      await releaseCapacityLock();
    }
  } finally {
    await releaseLaunchLock();
  }
}

export async function ensureSession(options = {}) {
  throwIfAborted(options.signal);
  const timeoutMs = normalizeTimeout(options.timeoutMs, DEFAULT_READY_TIMEOUT_MS);
  const deadline = Date.now() + timeoutMs;
  readinessTimeoutBudget(timeoutMs);
  const provider = normalizeProvider(options.provider);
  const config = providerConfig(provider);
  const sessionName = resolveSessionName(provider, options.sessionName);
  const stateDir = await ensureStateRoot(options.stateDir);
  const requestedCwd =
    options.cwd ||
    process.env[`LLM_ROUTER_MCP_${config.envName}_CWD`] ||
    (await ensureDefaultWorkDir(provider, stateDir));
  const cwd = await canonicalDirectory(requestedCwd, "provider cwd");
  const columns = normalizeDimension(options.columns, DEFAULT_COLUMNS);
  const rows = normalizeDimension(options.rows, DEFAULT_ROWS);
  const directModel = resolveProviderModel(provider, options.model);
  const launcher = options.command
    ? {
        command: "<unsafe-command>",
        args: [],
        model: directModel.model,
        modelSource: directModel.modelSource,
        bypassSource: "unsafe-command",
        bypassVerified: false,
        legacyCommand: String(options.command)
      }
    : await resolveLauncher(provider, {
        mode: "tmux",
        requestedModel: options.model,
        modeArgs: config.tmuxModeArgs(),
        environment: mergedEnv(),
        cwd
      });
  assertBypassVerified(launcher, options);

  const resolvedExecutable = launcher.legacyCommand
    ? null
    : await resolveExecutablePath(launcher.command, {
        environment: mergedEnv(),
        cwd
      });
  if (!launcher.legacyCommand && !resolvedExecutable) {
    throw new LlmRouterError(`provider executable was not found: ${launcher.command}`, {
      code: "ERR_PROVIDER_NOT_FOUND",
      provider
    });
  }
  const canonicalExecutable = resolvedExecutable
    ? await fs.realpath(resolvedExecutable)
    : null;
  const command = launcher.legacyCommand ||
    [canonicalExecutable, ...launcher.args].map(shellQuote).join(" ");
  const launchSpec = {
    protocolVersion: 2,
    provider,
    cwd,
    command: canonicalExecutable || launcher.command,
    wrapperFingerprints: launcher.wrapperFingerprints || [],
    executableFingerprint: canonicalExecutable
      ? await executableFingerprint(canonicalExecutable)
      : null,
    argsHash: stableHash(launcher.args),
    legacyCommandHash: launcher.legacyCommand
      ? crypto.createHash("sha256").update(launcher.legacyCommand).digest("hex")
      : null,
    model: launcher.model,
    modelSource: launcher.modelSource,
    bypassSource: launcher.bypassSource,
    bypassVerified: launcher.bypassVerified,
    socketLabel: tmuxSocketLabel(stateDir),
    columns,
    rows
  };
  const launchSpecHash = stableHash(launchSpec);
  const sessionPaths = await sessionStatePaths({ provider, sessionName, stateDir });

  validateSessionName(sessionName);
  await tmuxVersion();
  const releaseLaunchLock = await acquireDirectoryLock(sessionPaths.launchLockPath, {
    timeoutMs: remainingTimeout(deadline),
    signal: options.signal,
    wait: true,
    metadata: { provider, sessionName, kind: "launch" }
  });

  try {
    throwIfAborted(options.signal);
    if (await hasSession({ provider, sessionName, stateDir })) {
      const metadata = await readSessionMetadata(sessionPaths.metadataPath);
      if (isStartingSessionMetadata(metadata, provider, sessionName)) {
        const recoveringId = await assertRecoverableLaunchOwnership(metadata, stateDir);
        // A prior router process can die after tmux creates the session but
        // before readiness metadata is finalized. The launch intent is written
        // before new-session, so after acquiring the abandoned launch lock this
        // exact session is safe to remove and recreate.
        await runTmux(["kill-session", "-t", recoveringId], {
          allowFailure: true,
          timeoutMs: 5000,
          stateDir
        });
        if (await hasSession({ provider, sessionName, stateDir })) {
          throw new LlmRouterError("could not recover an interrupted tmux session launch", {
            code: "ERR_SESSION_RECOVERY_FAILED",
            provider,
            sessionName
          });
        }
        await Promise.all([
          fs.rm(sessionPaths.metadataPath, { force: true }),
          fs.rm(sessionPaths.busyLockPath, { recursive: true, force: true })
        ]);
      } else if (
        !metadata ||
        metadata.ready !== true ||
        metadata.launchSpecHash !== launchSpecHash
      ) {
        throw new LlmRouterError(
          "existing tmux session is unready or its launch specification differs; stop it before reuse",
          {
            code: "ERR_SESSION_SPEC_MISMATCH",
            provider,
            sessionName,
            requestedLaunchSpecHash: launchSpecHash,
            currentLaunchSpecHash: metadata?.launchSpecHash || null,
            currentReady: metadata?.ready === true
          }
        );
      } else {
        await verifyOwnedSession({ provider, sessionName, stateDir, metadata });
        await waitForPaneReadiness({
          provider,
          sessionName,
          paneId: metadata.paneId,
          stateDir,
          timeoutMs: remainingTimeout(deadline),
          signal: options.signal,
          detectStartupInteraction: false
        });
        return {
          provider,
          sessionName,
          cwd,
          created: false,
          running: true,
          ready: true,
          model: launcher.model || "CLI default",
          modelSource: launcher.modelSource,
          bypassSource: launcher.bypassSource,
          bypassVerified: launcher.bypassVerified,
          launchSpecHash,
          paneId: metadata.paneId,
          sessionGeneration: stableHash(metadata.ownerToken),
          paneTail: await optionalPaneTail({
            provider,
            sessionName,
            paneId: metadata.paneId,
            stateDir,
            lines: 80
          })
        };
      }
    }

    // No provider process from the old generation remains. Its request can no
    // longer make progress, so carrying the old busy lock into a replacement
    // session would wedge every future send. Completed artifacts remain
    // readable by waitForResponse even after this lock is retired.
    await fs.rm(sessionPaths.busyLockPath, { recursive: true, force: true });

    const capacityDir = await ensureStateSubdir(stateDir, "sessions");
    const releaseCapacityLock = await acquireDirectoryLock(
      path.join(capacityDir, ".capacity-lock"),
      {
        timeoutMs: remainingTimeout(deadline),
        signal: options.signal,
        wait: true,
        metadata: { kind: "capacity" }
      }
    );
    try {
      throwIfAborted(options.signal);
      await assertSessionCapacity(stateDir);
      const ownerToken = crypto.randomUUID();
      const args = [
        "new-session",
        "-e",
        `LLM_ROUTER_MCP_OWNER=${ownerToken}`,
        "-P",
        "-F",
        "#{session_id}",
        "-d",
        "-x",
        String(columns),
        "-y",
        String(rows),
        "-s",
        sessionName,
        "-c",
        cwd,
        command
      ];
      const metadata = {
        protocolVersion: 2,
        provider,
        sessionName,
        paneId: null,
        ownerToken,
        launchSpecHash,
        launchSpec,
        status: "starting",
        ready: false,
        creatorPid: process.pid,
        createdAt: new Date().toISOString()
      };
      let createdSessionId = null;
      let creationAttempted = false;
      try {
        // Persist launch intent first. A hard crash after tmux new-session can
        // then be distinguished from an unrelated session and recovered by the
        // next process after it acquires the abandoned launch lock.
        await writeJsonAtomic(sessionPaths.metadataPath, metadata, {
          stateDir,
          requireWithinState: true
        });
        throwIfAborted(options.signal);
        const creationTimeoutMs = remainingTimeout(deadline);
        creationAttempted = true;
        const createdSession = await runTmux(args, { timeoutMs: creationTimeoutMs, stateDir });
        createdSessionId = createdSession.stdout.trim();
        if (!/^\$\d+$/.test(createdSessionId)) {
          throw new LlmRouterError("tmux did not return a created session identity");
        }

        while (Date.now() < deadline) {
          if (await hasSession({ provider, sessionName, stateDir })) {
            const pane = await runTmux(
              ["display-message", "-p", "-t", createdSessionId, "#{pane_id}"],
              { timeoutMs: 5000, stateDir }
            );
            await runTmux(
              [
                "set-option",
                "-q",
                "-t",
                createdSessionId,
                "@llm_router_owner",
                ownerToken
              ],
              { timeoutMs: 5000, stateDir }
            );
            metadata.paneId = pane.stdout.trim();
            metadata.tmuxCreatedAt = new Date().toISOString();
            await writeJsonAtomic(sessionPaths.metadataPath, metadata, {
              stateDir,
              requireWithinState: true
            });
            await verifyOwnedSession({ provider, sessionName, stateDir, metadata });
            await waitForPaneReadiness({
              provider,
              sessionName,
              paneId: metadata.paneId,
              timeoutMs: remainingTimeout(deadline),
              stateDir,
              signal: options.signal,
              detectStartupInteraction: true
            });
            metadata.ready = true;
            metadata.status = "ready";
            metadata.readyAt = new Date().toISOString();
            await writeJsonAtomic(sessionPaths.metadataPath, metadata, {
              stateDir,
              requireWithinState: true
            });
            return {
              provider,
              sessionName,
              cwd,
              created: true,
              running: true,
              ready: true,
              model: launcher.model || "CLI default",
              modelSource: launcher.modelSource,
              bypassSource: launcher.bypassSource,
              bypassVerified: launcher.bypassVerified,
              launchSpecHash,
              paneId: metadata.paneId,
              sessionGeneration: stableHash(metadata.ownerToken),
              paneTail: await optionalPaneTail({
                provider,
                sessionName,
                paneId: metadata.paneId,
                stateDir,
                lines: 80
              }),
              columns,
              rows
            };
          }
          await sleep(100);
        }
        throw new LlmRouterError("tmux session did not become available before timeout", {
          provider,
          sessionName,
          timeoutMs
        });
      } catch (error) {
        // new-session can create and print an ID before its client times out.
        // Verify the creation-time token, rather than treating a rejected await
        // as proof that nothing was created or killing by name alone.
        const partialId = !error?.details?.stdoutTruncated &&
          typeof error?.details?.stdout === "string" ? error.details.stdout.trim() : "";
        const candidate = createdSessionId || (/^\$\d+$/.test(partialId) ? partialId : null);
        let cleanupConfirmed = !creationAttempted;
        if (creationAttempted) {
          try {
            const ownedId = await ownedLaunchSessionId({
              stateDir, sessionName, ownerToken, sessionId: candidate
            });
            if (ownedId) {
              await runTmux(["kill-session", "-t", ownedId], {
                allowFailure: true, timeoutMs: 5000, stateDir
              });
              cleanupConfirmed = !(await ownedLaunchSessionId({
                stateDir, sessionName, ownerToken, sessionId: ownedId
              }));
            } else {
              // A definite CLI rejection (including duplicate names) created
              // nothing owned by this attempt. A timeout is ambiguous: retain
              // recoverable intent if no trustworthy identity is available.
              cleanupConfirmed = Number.isInteger(error?.details?.code) &&
                error.details.code !== 0 && !error.details.timedOut;
            }
          } catch {
            // Failed cleanup/probes must not erase the only recovery record.
          }
        }
        if (cleanupConfirmed) {
          await Promise.all([
            fs.rm(sessionPaths.metadataPath, { force: true }),
            fs.rm(sessionPaths.busyLockPath, { recursive: true, force: true })
          ]);
        } else {
          await writeJsonAtomic(sessionPaths.metadataPath, {
            ...metadata, status: "starting", ready: false, creationUncertain: true
          }, { stateDir, requireWithinState: true });
        }
        throw error;
      }
    } finally {
      await releaseCapacityLock();
    }
  } finally {
    await releaseLaunchLock();
  }
}

export async function capturePane(options = {}) {
  throwIfAborted(options.signal);
  const provider = normalizeProvider(options.provider);
  const sessionName = resolveSessionName(provider, options.sessionName);
  const lines = Math.min(
    MAX_CAPTURE_LINES,
    Math.max(1, Math.trunc(Number(options.lines || DEFAULT_CAPTURE_LINES)))
  );

  validateSessionName(sessionName);
  let paneTarget = options.paneId || exactTmuxPaneTarget(sessionName);
  if (options.requireOwned) {
    const metadata = await verifyOwnedSession({
      provider,
      sessionName,
      stateDir: options.stateDir
    });
    paneTarget = metadata.paneId;
  }
  const args = ["capture-pane", "-p", "-J", "-t", paneTarget];
  if (options.currentOnly !== true) {
    args.push("-S", `-${lines}`);
  }
  const result = await runTmux(args, { timeoutMs: 5000, stateDir: options.stateDir });
  return stripAnsi(result.stdout);
}

export async function writeInputFile(options = {}) {
  throwIfAborted(options.signal);
  const provider = options.provider ? normalizeProvider(options.provider) : "shared";
  const markdown = options.markdown;
  if (typeof markdown !== "string" || markdown.length === 0) {
    throw new LlmRouterError("markdown must be a non-empty string");
  }
  const markdownBytes = Buffer.byteLength(markdown, "utf8");
  if (markdownBytes > DEFAULT_MAX_MARKDOWN_BYTES) {
    throw new LlmRouterError(`markdown exceeds ${DEFAULT_MAX_MARKDOWN_BYTES} byte limit`, {
      code: "ERR_MARKDOWN_TOO_LARGE",
      bytes: markdownBytes
    });
  }

  const stateDir = await ensureStateRoot(options.stateDir);
  const inputDir = await ensureStateSubdir(stateDir, "inputs", provider);

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const requestedName = options.filename
    ? path.basename(options.filename)
    : `${timestamp}-${crypto.randomBytes(4).toString("hex")}.md`;
  const safeName = requestedName.replace(/[^A-Za-z0-9_.-]/g, "_");
  const filename = /\.(md|markdown)$/i.test(safeName) ? safeName : `${safeName}.md`;
  const inputPath = path.join(inputDir, filename);

  const written = await writeFileExclusive(inputPath, markdown, {
    stateDir,
    requireWithinState: true
  });
  return { inputPath: written.filePath, bytes: written.bytes };
}

export async function sendInput(options = {}) {
  throwIfAborted(options.signal);
  const provider = normalizeProvider(options.provider);
  const sessionName = resolveSessionName(provider, options.sessionName);
  const stateDir = await ensureStateRoot(options.stateDir);
  const timeoutMs = normalizeTimeout(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const nonce = options.nonce || makeNonce();
  const { startMarker, doneMarker } = markerSet(provider, nonce);
  const requestId = requestIdForNonce(provider, nonce);

  validateSessionName(sessionName);
  const inputPath = path.resolve(requireInputPath(options.inputPath));
  const input = await readRouterInput({
    provider,
    inputPath,
    stateDir,
    allowExternalInput: options.allowExternalInput
  });
  const markdown = input.markdown;
  if (markdown.includes(startMarker) || markdown.includes(doneMarker)) {
    throw new LlmRouterError(
      "input file already contains the generated nonce markers; pass a different nonce",
      { inputPath, nonce }
    );
  }

  const session = await ensureSession({
    provider,
    sessionName,
    command: options.command,
    cwd: options.cwd,
    timeoutMs,
    stateDir,
    columns: options.columns,
    rows: options.rows,
    model: options.model,
    signal: options.signal,
    allowUnverifiedLauncher: options.allowUnverifiedLauncher
  });
  const sessionPaths = await sessionStatePaths({ provider, sessionName, stateDir });
  const releaseLaunchLock = await acquireDirectoryLock(sessionPaths.launchLockPath, {
    timeoutMs,
    signal: options.signal,
    wait: true,
    metadata: { provider, sessionName, kind: "launch" }
  });
  let busyLockAcquired = false;
  let dispatchStarted = false;

  try {
    throwIfAborted(options.signal);
    const current = await verifyOwnedSession({ provider, sessionName, stateDir });
    if (
      stableHash(current.ownerToken) !== session.sessionGeneration ||
      current.paneId !== session.paneId ||
      current.launchSpecHash !== session.launchSpecHash
    ) {
      throw new LlmRouterError("tmux session generation changed before request send", {
        code: "ERR_SESSION_GENERATION_CHANGED",
        provider,
        sessionName
      });
    }

    // Busy-lock creation and removal are serialized by the session launch lock.
    // The busy lock deliberately survives this function: waitForResponse releases
    // it only after the matching file transaction is complete and the pane settles.
    await acquireDirectoryLock(sessionPaths.busyLockPath, {
      wait: false,
      metadata: { provider, sessionName, nonce, requestId, kind: "request" }
    });
    busyLockAcquired = true;

    const created = await createRequestDirectory({ stateDir, provider, requestId });
    const requestDir = created.requestDir;
    const promptPath = path.join(requestDir, "request.md");
    const responsePath = path.join(requestDir, "response.md");
    const donePath = path.join(requestDir, "done.json");
    const prompt = buildPrompt({
      provider,
      mode: "tmux",
      inputPath: input.inputPath,
      markdown,
      nonce,
      requestId,
      responsePath,
      donePath,
      model: options.model
    });

    await writeFileExclusive(promptPath, prompt, {
      stateDir,
      requireWithinState: true
    });
    await writeJsonAtomic(path.join(requestDir, "metadata.json"), {
      protocolVersion: 2,
      provider,
      sessionName,
      nonce,
      requestId,
      requestPath: promptPath,
      responsePath,
      donePath,
      inputPath: input.inputPath,
      sentAt: new Date().toISOString(),
      launchSpecHash: session.launchSpecHash,
      sessionGeneration: session.sessionGeneration,
      paneId: session.paneId
    }, {
      stateDir,
      requireWithinState: true
    });

    throwIfAborted(options.signal);
    // Commit transport atomically with respect to cancellation. Once dispatch
    // starts, retain the request lock even if delivery becomes uncertain.
    dispatchStarted = true;
    await sendFileReferenceToTmux({
      sessionName,
      paneId: session.paneId,
      promptPath,
      stateDir
    });

    return {
      provider,
      sessionName,
      nonce,
      requestId,
      inputPath: input.inputPath,
      promptPath,
      responsePath,
      donePath,
      startMarker,
      doneMarker,
      transport: "markdown-file-v2",
      sent: true,
      sentAt: new Date().toISOString()
    };
  } catch (error) {
    if (busyLockAcquired && !dispatchStarted) {
      await forceReleaseRequestBusyLock(sessionPaths.busyLockPath, requestId);
    }
    throw error;
  } finally {
    await releaseLaunchLock();
  }
}

export async function waitForResponse(options = {}) {
  throwIfAborted(options.signal);
  const provider = normalizeProvider(options.provider);
  const sessionName = resolveSessionName(provider, options.sessionName);
  const timeoutMs = normalizeTimeout(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const pollMs = normalizeTimeout(options.pollMs, DEFAULT_POLL_MS);
  const { nonce, startMarker, doneMarker } = markerSet(
    provider,
    requireNonce(options.nonce)
  );
  const stateDir = await ensureStateRoot(options.stateDir);
  const requestId = requestIdForNonce(provider, nonce);
  const requestDir = path.join(stateDir, "requests", provider, requestId);
  const responsePath = path.join(requestDir, "response.md");
  const donePath = path.join(requestDir, "done.json");
  const requestMetadata = await readJsonFile(path.join(requestDir, "metadata.json"), {
    stateDir,
    requireWithinState: true
  });
  assertRequestMetadata(requestMetadata, { provider, sessionName, nonce, requestId });
  const sessionPaths = await sessionStatePaths({ provider, sessionName, stateDir });
  const sessionMetadata = await readSessionMetadata(sessionPaths.metadataPath);
  const alreadyCompleted = await readCompletedFileTransaction({
    provider,
    nonce,
    requestId,
    responsePath,
    donePath,
    stateDir
  });
  if (alreadyCompleted) {
    const completion = await settleCompletedSession({
      provider,
      sessionName,
      stateDir,
      sessionMetadata,
      requestMetadata,
      sessionPaths,
      requestId,
      timeoutMs,
      signal: options.signal
    });
    return completedWaitResult({
      provider,
      sessionName,
      nonce,
      requestId,
      startMarker,
      doneMarker,
      startSeenAt: null,
      fileResult: alreadyCompleted,
      responsePath,
      donePath,
      ...completion
    });
  }
  if (!requestMatchesSession(requestMetadata, sessionMetadata)) {
    throw new LlmRouterError("request launch metadata no longer matches the provider session", {
      code: "ERR_REQUEST_SESSION_MISMATCH",
      provider,
      sessionName
    });
  }
  if (await hasSession({ provider, sessionName, stateDir })) {
    await verifyOwnedSession({ provider, sessionName, stateDir, metadata: sessionMetadata });
  }
  const deadline = Date.now() + timeoutMs;
  let started = false;
  let startSeenAt = null;
  let lastPane = "";

  validateSessionName(sessionName);

  while (Date.now() <= deadline) {
    throwIfAborted(options.signal);
    const fileResult = await readCompletedFileTransaction({
      provider,
      sessionName,
      nonce,
      requestId,
      responsePath,
      donePath,
      stateDir
    });
    if (fileResult) {
      const completion = await settleCompletedSession({
        provider,
        sessionName,
        stateDir,
        sessionMetadata,
        requestMetadata,
        sessionPaths,
        requestId,
        timeoutMs,
        signal: options.signal
      });
      return completedWaitResult({
        provider,
        sessionName,
        nonce,
        requestId,
        startMarker,
        doneMarker,
        startSeenAt,
        fileResult,
        responsePath,
        donePath,
        paneText: lastPane,
        ...completion
      });
    }

    try {
      lastPane = await capturePane({
        provider,
        sessionName,
        paneId: sessionMetadata.paneId,
        stateDir,
        lines: options.captureLines || DEFAULT_CAPTURE_LINES
      });
    } catch (error) {
      if (!(await hasSession({ provider, sessionName, stateDir }))) {
        await releaseRequestBusyUnderLaunch({
          provider,
          sessionName,
          sessionPaths,
          requestId,
          timeoutMs
        });
        const fallbackPath = await writeFallbackFile({
          provider,
          stateDir,
          nonce,
          requestId,
          title: `${providerConfig(provider).displayName} tmux session ended before done marker`,
          paneTail: lastPane,
          error
        });
        return {
          provider,
          sessionName,
          nonce,
          started,
          completed: false,
          timedOut: false,
          sessionEnded: true,
          startMarker,
          doneMarker,
          startSeenAt,
          completedAt: null,
          answer: null,
          responsePath: null,
          fallbackPath,
          paneTail: debugPaneTail(lastPane, 160),
          error: error instanceof Error ? error.message : String(error)
        };
      }
      throw error;
    }

    const startIndex = lastPane.indexOf(startMarker);
    const doneIndex = lastPane.indexOf(doneMarker);

    if (startIndex !== -1 && !started) {
      started = true;
      startSeenAt = new Date().toISOString();
    }

    if (
      process.env.LLM_ROUTER_MCP_ENABLE_PANE_FALLBACK === "1" &&
      startIndex !== -1 &&
      doneIndex > startIndex
    ) {
      const answer = extractAnswer(lastPane, startMarker, doneMarker);
      if (answer !== null) {
        const response = await writeFileAtomic(responsePath, `${answer}\n`, {
          stateDir,
          requireWithinState: true
        });
        const completedAt = new Date().toISOString();
        await writeJsonAtomic(donePath, {
          protocolVersion: 2,
          provider,
          nonce,
          requestId,
          status: "completed",
          completedAt,
          completionSource: "pane-fallback"
        }, {
          stateDir,
          requireWithinState: true
        });
        await releaseRequestBusyUnderLaunch({
          provider,
          sessionName,
          sessionPaths,
          requestId,
          timeoutMs
        });
        return {
          provider,
          sessionName,
          nonce,
          requestId,
          started: true,
          completed: true,
          timedOut: false,
          sessionEnded: false,
          startMarker,
          doneMarker,
          startSeenAt,
          completedAt,
          completionSource: "pane-fallback",
          answer,
          responsePath: response.filePath,
          responseBytes: response.bytes,
          donePath,
          fallbackPath: null,
          paneTail: debugPaneTail(lastPane, 120)
        };
      }
    }

    await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())), options.signal);
  }

  const fallbackPath = await writeFallbackFile({
    provider,
    stateDir,
    nonce,
    requestId,
    title: `${providerConfig(provider).displayName} tmux wait timed out before done marker`,
    paneTail: lastPane
  });

  return {
    provider,
    sessionName,
    nonce,
    requestId,
    started,
    completed: false,
    timedOut: true,
    sessionEnded: false,
    startMarker,
    doneMarker,
    startSeenAt,
    completedAt: null,
    answer: null,
    responsePath: null,
    donePath,
    fallbackPath,
    paneTail: debugPaneTail(lastPane, 160),
    sessionBusy: true
  };
}

export async function waitForStart(options = {}) {
  throwIfAborted(options.signal);
  const provider = normalizeProvider(options.provider);
  const sessionName = resolveSessionName(provider, options.sessionName);
  const timeoutMs = normalizeTimeout(options.timeoutMs, 30000);
  const pollMs = normalizeTimeout(options.pollMs, DEFAULT_POLL_MS);
  const { nonce, startMarker, doneMarker } = markerSet(
    provider,
    requireNonce(options.nonce)
  );
  const stateDir = await ensureStateRoot(options.stateDir);
  const requestId = requestIdForNonce(provider, nonce);
  const requestDir = path.join(stateDir, "requests", provider, requestId);
  const responsePath = path.join(requestDir, "response.md");
  const donePath = path.join(requestDir, "done.json");
  const requestMetadata = await readJsonFile(path.join(requestDir, "metadata.json"), {
    stateDir,
    requireWithinState: true
  });
  assertRequestMetadata(requestMetadata, { provider, sessionName, nonce, requestId });
  const sessionPaths = await sessionStatePaths({ provider, sessionName, stateDir });
  const sessionMetadata = await readSessionMetadata(sessionPaths.metadataPath);
  const alreadyCompleted = await readCompletedFileTransaction({
    provider,
    nonce,
    requestId,
    responsePath,
    donePath,
    stateDir
  });
  if (alreadyCompleted) {
    return {
      provider,
      sessionName,
      nonce,
      requestId,
      started: true,
      completed: true,
      timedOut: false,
      startMarker,
      doneMarker,
      startSeenAt: null,
      completionSource: "markdown-file-v2",
      paneTail: null
    };
  }
  if (!requestMatchesSession(requestMetadata, sessionMetadata)) {
    throw new LlmRouterError("request launch metadata no longer matches the provider session", {
      code: "ERR_REQUEST_SESSION_MISMATCH",
      provider,
      sessionName
    });
  }
  if (await hasSession({ provider, sessionName, stateDir })) {
    await verifyOwnedSession({ provider, sessionName, stateDir, metadata: sessionMetadata });
  }
  const deadline = Date.now() + timeoutMs;
  let lastPane = "";

  validateSessionName(sessionName);

  while (Date.now() <= deadline) {
    throwIfAborted(options.signal);
    const fileResult = await readCompletedFileTransaction({
      provider,
      sessionName,
      nonce,
      requestId,
      responsePath,
      donePath,
      stateDir
    });
    if (fileResult) {
      return {
        provider,
        sessionName,
        nonce,
        requestId,
        started: true,
        completed: true,
        timedOut: false,
        startMarker,
        doneMarker,
        startSeenAt: null,
        completionSource: "markdown-file-v2",
        paneTail: debugPaneTail(lastPane, 120)
      };
    }
    lastPane = await capturePane({
      provider,
      sessionName,
      paneId: sessionMetadata.paneId,
      stateDir,
      lines: options.captureLines || DEFAULT_CAPTURE_LINES
    });
    const started = lastPane.includes(startMarker);
    const completed = lastPane.includes(doneMarker);

    if (started || completed) {
      return {
        provider,
        sessionName,
        nonce,
        requestId,
        started,
        completed,
        timedOut: false,
        startMarker,
        doneMarker,
        startSeenAt: started ? new Date().toISOString() : null,
        paneTail: debugPaneTail(lastPane, 120)
      };
    }

    await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())), options.signal);
  }

  return {
    provider,
    sessionName,
    nonce,
    requestId,
    started: false,
    completed: false,
    timedOut: true,
    startMarker,
    doneMarker,
    startSeenAt: null,
    paneTail: debugPaneTail(lastPane, 160)
  };
}

export async function tmuxAsk(options = {}) {
  const totalTimeoutMs = normalizeTimeout(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const deadline = Date.now() + totalTimeoutMs;
  const sent = await sendInput({ ...options, timeoutMs: totalTimeoutMs });
  const remainingMs = deadline - Date.now();
  if (remainingMs < 1) {
    throw new LlmRouterError("tmux ask exhausted its end-to-end timeout while sending", {
      code: "ERR_ASK_DEADLINE",
      timeoutMs: totalTimeoutMs,
      nonce: sent.nonce
    });
  }
  const waited = await waitForResponse({
    provider: sent.provider,
    sessionName: sent.sessionName,
    nonce: sent.nonce,
    timeoutMs: remainingMs,
    pollMs: options.pollMs,
    captureLines: options.captureLines,
    signal: options.signal,
    stateDir: options.stateDir
  });
  return { ...sent, ...waited, mode: "tmux" };
}

export async function headlessAsk(options = {}) {
  throwIfAborted(options.signal);
  const provider = normalizeProvider(options.provider);
  const releaseHeadlessSlot = acquireHeadlessSlot(provider);
  try {
    return await headlessAskWithSlot(options, provider);
  } finally {
    releaseHeadlessSlot();
  }
}

async function headlessAskWithSlot(options, provider) {
  const stateDir = await ensureStateRoot(options.stateDir);
  const timeoutMs = normalizeTimeout(options.timeoutMs, DEFAULT_HEADLESS_TIMEOUT_MS);
  const nonce = options.nonce || makeNonce();
  const hasInputPath = typeof options.inputPath === "string" && options.inputPath.length > 0;
  const hasMarkdown = typeof options.markdown === "string" && options.markdown.length > 0;
  if (hasInputPath === hasMarkdown) {
    throw new LlmRouterError("exactly one of markdown or inputPath is required");
  }
  const input = hasInputPath
    ? await readRouterInput({
        provider,
        inputPath: path.resolve(requireInputPath(options.inputPath)),
        stateDir,
        allowExternalInput: options.allowExternalInput
      })
    : await writeInputFile({
        provider,
        markdown: options.markdown,
        filename: options.filename,
        stateDir
      }).then((written) => readMarkdownInput(written.inputPath, {
        stateDir,
        requireWithinState: true
      }));
  const inputPath = input.inputPath;
  const markdown = input.markdown;
  const requestId = requestIdForNonce(provider, nonce);
  const created = await createRequestDirectory({ stateDir, provider, requestId });
  const requestDir = created.requestDir;
  const promptPath = path.join(requestDir, "request.md");
  const responsePath = path.join(requestDir, "response.md");
  const rawResponsePath = path.join(requestDir, "raw.md");
  const prompt = buildPrompt({
    provider,
    mode: "headless",
    inputPath,
    markdown,
    nonce,
    requestId,
    model: options.model
  });
  const { startMarker, doneMarker } = markerSet(provider, nonce);
  if (prompt.includes(startMarker) || prompt.includes(doneMarker)) {
    throw new LlmRouterError(
      "internal prompt unexpectedly contains full markers before the model can emit them",
      { provider, nonce }
    );
  }

  await writeFileExclusive(promptPath, prompt, {
    stateDir,
    requireWithinState: true
  });

  const config = providerConfig(provider);
  const cwd = await canonicalDirectory(
    options.cwd ||
      process.env[`LLM_ROUTER_MCP_${config.envName}_CWD`] ||
      (await ensureDefaultWorkDir(provider, stateDir)),
    "provider cwd"
  );
  const run = await runHeadlessProvider({
    provider,
    requestedModel: options.model,
    prompt,
    promptPath,
    cwd,
    timeoutMs,
    allowUnverifiedLauncher: options.allowUnverifiedLauncher,
    signal: options.signal
  });

  const raw = await writeRawResponseFile({
    provider,
    stateDir,
    nonce,
    requestId,
    rawResponsePath,
    stdout: run.stdout,
    stderr: run.stderr,
    code: run.code
  });
  const answer =
    run.code === 0 && !run.stdoutTruncated
      ? extractHeadlessAnswer(run.stdout, startMarker, doneMarker)
      : null;
  const protocolCompleted = answer !== null && !run.stdoutTruncated;
  const response = answer === null
    ? null
    : await writeFileExclusive(responsePath, `${answer}\n`, {
        stateDir,
        requireWithinState: true
      });

  return {
    provider,
    mode: "headless",
    nonce,
    requestId,
    inputPath,
    promptPath,
    startMarker,
    doneMarker,
    cwd,
    model: run.model || "CLI default",
    modelSource: run.modelSource,
    bypassSource: run.bypassSource,
    bypassVerified: run.bypassVerified,
    exitCode: run.code,
    success: run.code === 0 && protocolCompleted,
    protocolCompleted,
    errorCode:
      run.stdoutTruncated
        ? "ERR_OUTPUT_TRUNCATED"
        : run.code !== 0
        ? "ERR_PROVIDER_EXIT"
        : protocolCompleted
          ? null
          : "ERR_PROTOCOL_INCOMPLETE",
    elapsedMs: run.elapsedMs,
    stdoutTruncated: run.stdoutTruncated,
    stderrTruncated: run.stderrTruncated,
    answer,
    responsePath: response?.filePath || null,
    responseBytes: response?.bytes || 0,
    rawResponsePath: raw.rawResponsePath,
    rawResponseBytes: raw.bytes,
    stderr: run.stderr.trim() ? truncateText(run.stderr.trim(), 4000) : null
  };
}

export async function status(options = {}) {
  throwIfAborted(options.signal);
  const provider = normalizeProvider(options.provider);
  const sessionName = resolveSessionName(provider, options.sessionName);
  const stateDir = await ensureStateRoot(options.stateDir);
  const running = await hasSession({ provider, sessionName, stateDir });
  const sessionPaths = await sessionStatePaths({ provider, sessionName, stateDir });
  const sessionMetadata = await readSessionMetadata(sessionPaths.metadataPath);
  let markerStatus = null;
  let paneTail = "";

  if (running) {
    await verifyOwnedSession({ provider, sessionName, stateDir, metadata: sessionMetadata });
    paneTail = await capturePane({
      provider,
      sessionName,
      paneId: sessionMetadata.paneId,
      stateDir,
      lines: options.lines || 160
    });
  }
  if (options.nonce) {
    const { startMarker, doneMarker } = markerSet(provider, options.nonce);
    const requestId = requestIdForNonce(provider, options.nonce);
    const requestDir = path.join(stateDir, "requests", provider, requestId);
    const requestMetadata = await readJsonFile(path.join(requestDir, "metadata.json"), {
      stateDir,
      requireWithinState: true
    });
    assertRequestMetadata(requestMetadata, {
      provider,
      sessionName,
      nonce: options.nonce,
      requestId
    });
    const fileResult = await readCompletedFileTransaction({
      provider,
      nonce: options.nonce,
      requestId,
      responsePath: path.join(requestDir, "response.md"),
      donePath: path.join(requestDir, "done.json"),
      stateDir
    });
    if (
      !fileResult &&
      !requestMatchesSession(requestMetadata, sessionMetadata)
    ) {
      throw new LlmRouterError("request launch metadata no longer matches the provider session", {
        code: "ERR_REQUEST_SESSION_MISMATCH",
        provider,
        sessionName
      });
    }
    markerStatus = {
      nonce: options.nonce,
      requestId,
      started: Boolean(fileResult) || paneTail.includes(startMarker),
      completed: Boolean(fileResult) || paneTail.includes(doneMarker),
      completionSource: fileResult ? "markdown-file-v2" : null,
      startMarker,
      doneMarker
    };
  }

  const busy = await pathExists(sessionPaths.busyLockPath);
  let activeRequest = null;
  if (busy) {
    try {
      const owner = await readJsonFile(path.join(sessionPaths.busyLockPath, "owner.json"), {
        stateDir, requireWithinState: true
      });
      if (
        owner.kind === "request" && owner.provider === provider && owner.sessionName === sessionName &&
        typeof owner.nonce === "string" && /^[A-Za-z0-9_.:-]{6,96}$/.test(owner.nonce) &&
        owner.requestId === requestIdForNonce(provider, owner.nonce)
      ) activeRequest = { nonce: owner.nonce, requestId: owner.requestId };
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  const exposePaneTail =
    options.includePaneTail === true || process.env.LLM_ROUTER_MCP_ENABLE_DEBUG_TOOLS === "1";

  return {
    provider,
    sessionName,
    running,
    busy,
    activeRequest,
    markerStatus,
    paneTail: exposePaneTail ? paneTail : null
  };
}

function buildPrompt({
  provider,
  mode,
  inputPath,
  markdown,
  nonce,
  requestId,
  responsePath,
  donePath,
  model
}) {
  const config = providerConfig(provider);
  const { startPrefix, donePrefix } = markerSet(provider, nonce);
  const requestedModel = resolveModel(provider, model);
  const modelInstruction = requestedModel
    ? `The MCP caller requested model: ${requestedModel}. The structured launcher already selected it.`
    : "Use the model selected by this provider CLI's own configuration/default.";
  const transactionInstruction = mode === "tmux"
    ? `
This is file transaction protocol v2. Writing the two router-owned artifacts below is required protocol work and is allowed even when the user only asks an ordinary question.

1. Also present the final Markdown answer normally in this terminal so the user can see it.
2. Write only the final answer, without automation markers, as UTF-8 Markdown to:
   ${responsePath}
3. After the response file is fully closed, write the following JSON in one operation to ${donePath}.tmp-${requestId}, then atomically rename that temporary file to:
   ${donePath}
4. Replace only <ISO-8601 timestamp> in this literal payload:
   {"protocolVersion":2,"provider":"${config.id}","nonce":"${nonce}","requestId":"${requestId}","status":"completed","completedAt":"<ISO-8601 timestamp>"}
5. If your file tool cannot rename atomically, write the literal JSON directly to done.json only after response.md has been fully closed. Never create done.json first.
6. Do not create the completion file if the response file could not be written successfully.
`
    : "";

  return `You are being asked through llm-router-mcp from ${mode === "tmux" ? "a persistent tmux session" : "a headless one-shot run"} for ${config.displayName}.

The request and the final answer are Markdown artifacts. Read the Markdown input exactly and answer in Markdown.

Automation markers are required so the MCP client can detect progress and completion.

Before any substantive answer, print a start marker on its own line.
- literal prefix: ${startPrefix}
- nonce: ${nonce}
- format: prefix immediately followed by nonce, with no spaces

After the final answer is complete, print a done marker on its own line.
- literal prefix: ${donePrefix}
- nonce: ${nonce}
- format: prefix immediately followed by nonce, with no spaces

Do not put either marker in a code block. Do not print the done marker until the answer is finished.
For ordinary questions, answer directly. Apart from the router-owned transaction files explicitly required above, do not run shell commands, edit other files, or send notifications unless the Markdown input explicitly asks you to do that.

${modelInstruction}
${transactionInstruction}

Markdown input file path:
${inputPath}

Markdown input begins below.

--- BEGIN MCP MARKDOWN INPUT ---
${markdown}
--- END MCP MARKDOWN INPUT ---
`;
}

async function runHeadlessProvider({
  provider,
  requestedModel,
  prompt,
  promptPath,
  cwd,
  timeoutMs,
  allowUnverifiedLauncher,
  signal
}) {
  const config = providerConfig(provider);
  const modeArgs = config.headlessModeArgs(promptPath, timeoutMs);
  const launcher = await resolveLauncher(provider, {
    mode: "headless",
    requestedModel,
    modeArgs,
    environment: mergedEnv(),
    cwd
  });
  assertBypassVerified(launcher, { allowUnverifiedLauncher });
  let input = prompt;
  if (provider === "grok") {
    input = undefined;
  }

  const run = await runCommand(launcher.command, launcher.args, {
    cwd,
    input,
    timeoutMs,
    allowFailure: true,
    killProcessGroup: true,
    signal
  });
  return {
    ...run,
    model: launcher.model,
    modelSource: launcher.modelSource,
    bypassSource: launcher.bypassSource,
    bypassVerified: launcher.bypassVerified
  };
}

async function sendFileReferenceToTmux({ sessionName, paneId, promptPath, stateDir }) {
  const instruction = `Read and follow the complete llm-router-mcp Markdown request at: ${promptPath}`;
  const target = paneId || exactTmuxPaneTarget(sessionName);
  await runTmux(["send-keys", "-l", "-t", target, instruction], {
    timeoutMs: 10000,
    stateDir
  });
  await sleep(75);
  await runTmux(["send-keys", "-t", target, "C-m"], {
    timeoutMs: 5000,
    stateDir
  });
}

function assertBypassVerified(launcher, options = {}) {
  if (launcher.bypassVerified) {
    return;
  }
  if (
    options.allowUnverifiedLauncher === true ||
    process.env.LLM_ROUTER_MCP_ALLOW_UNVERIFIED_LAUNCHER === "1"
  ) {
    return;
  }
  throw new LlmRouterError(
    "provider launcher bypass could not be verified; use a strict executable wrapper/structured arguments, or explicitly set LLM_ROUTER_MCP_ALLOW_UNVERIFIED_LAUNCHER=1 to accept the risk",
    {
      code: "ERR_BYPASS_UNVERIFIED",
      bypassSource: launcher.bypassSource,
      legacyCommand: Boolean(launcher.legacyCommand)
    }
  );
}

function stableHash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function canonicalDirectory(directoryPath, label) {
  const absolutePath = path.resolve(String(directoryPath));
  const lexical = await fs.lstat(absolutePath);
  if (lexical.isSymbolicLink() || !lexical.isDirectory()) {
    throw new LlmRouterError(`${label} must be a real directory, not a symlink`, {
      code: "ERR_INVALID_CWD",
      cwd: absolutePath
    });
  }
  const realPath = await fs.realpath(absolutePath);
  const stat = await fs.stat(realPath);
  if (!stat.isDirectory()) {
    throw new LlmRouterError(`${label} must resolve to a directory`, {
      code: "ERR_INVALID_CWD",
      cwd: realPath
    });
  }
  return realPath;
}

async function executableFingerprint(executablePath) {
  const stat = await fs.stat(executablePath);
  const identity = {
    realPath: executablePath,
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    mode: stat.mode
  };
  if (stat.size <= 1024 * 1024) {
    identity.sha256 = crypto
      .createHash("sha256")
      .update(await fs.readFile(executablePath))
      .digest("hex");
  }
  return identity;
}

async function optionalPaneTail(options) {
  if (process.env.LLM_ROUTER_MCP_ENABLE_DEBUG_TOOLS !== "1") {
    return null;
  }
  return await capturePane(options);
}

function requestIdForNonce(provider, nonce) {
  validateNonce(nonce);
  return crypto
    .createHash("sha256")
    .update(`${normalizeProvider(provider)}\0${nonce}`)
    .digest("hex")
    .slice(0, 40);
}

async function sessionStatePaths({ provider, sessionName, stateDir }) {
  const directory = await ensureStateSubdir(stateDir, "sessions", normalizeProvider(provider));
  const lockDirectory = await ensureStateSubdir(stateDir, "sessions", "launch-locks");
  validateSessionName(sessionName);
  return {
    directory,
    metadataPath: path.join(directory, `${sessionName}.json`),
    launchLockPath: path.join(lockDirectory, `${sessionName}.launch-lock`),
    busyLockPath: path.join(directory, `${sessionName}.busy-lock`)
  };
}

async function readSessionMetadata(metadataPath) {
  try {
    return await readJsonFile(metadataPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function isStartingSessionMetadata(metadata, provider, sessionName) {
  return Boolean(
    metadata &&
      metadata.protocolVersion === 2 &&
      metadata.status === "starting" &&
      metadata.ready === false &&
      metadata.provider === provider &&
      metadata.sessionName === sessionName &&
      typeof metadata.ownerToken === "string" &&
      metadata.ownerToken.length >= 16 &&
      typeof metadata.launchSpecHash === "string" &&
      metadata.launchSpecHash.length >= 16 &&
      Number.isSafeInteger(metadata.creatorPid)
  );
}

// The environment is attached by new-session itself, before a wrapper/client
// can time out. It permits safe recovery even if no creation ID reached us.
async function ownedLaunchSessionId({ stateDir, sessionName, ownerToken, sessionId }) {
  // Resolve the mutable name first, then authorize and operate only on that
  // captured ID. A same-name replacement must never inherit the old token.
  let id = sessionId;
  if (!id) {
    const identity = await runTmux(
      ["display-message", "-p", "-t", exactTmuxPaneTarget(sessionName), "#{session_id}"],
      { allowFailure: true, timeoutMs: 5000, stateDir }
    );
    if (identity.code !== 0 && isTmuxAbsentResult(identity)) return null;
    id = identity.stdout.trim();
    if (identity.code !== 0 || !/^\$\d+$/.test(id)) {
      throw new LlmRouterError("could not resolve tmux launch identity", { code: "ERR_LAUNCH_RECOVERY" });
    }
  }
  if (!/^\$\d+$/.test(id)) {
    throw new LlmRouterError("invalid tmux launch identity", { code: "ERR_LAUNCH_RECOVERY" });
  }
  const owner = await runTmux(
    ["show-environment", "-t", id, "LLM_ROUTER_MCP_OWNER"],
    { allowFailure: true, timeoutMs: 5000, stateDir }
  );
  if (owner.code !== 0) {
    if (isTmuxAbsentResult(owner) || /unknown variable/i.test(owner.stderr)) return null;
    throw new LlmRouterError("could not verify tmux launch ownership", { code: "ERR_LAUNCH_RECOVERY" });
  }
  return owner.stdout.trim() === `LLM_ROUTER_MCP_OWNER=${ownerToken}` ? id : null;
}

async function assertRecoverableLaunchOwnership(metadata, stateDir) {
  const sessionId = await ownedLaunchSessionId({
    stateDir, sessionName: metadata.sessionName, ownerToken: metadata.ownerToken
  });
  if (!sessionId) {
    throw new LlmRouterError("starting launch does not own this tmux session", {
      code: "ERR_SESSION_NOT_OWNED", provider: metadata.provider, sessionName: metadata.sessionName
    });
  }
  return sessionId;
}

async function verifyOwnedSession({ provider, sessionName, stateDir, metadata }) {
  const root = await ensureStateRoot(stateDir);
  const paths = await sessionStatePaths({ provider, sessionName, stateDir: root });
  const stored = metadata || (await readSessionMetadata(paths.metadataPath));
  if (
    !stored ||
    stored.provider !== provider ||
    stored.sessionName !== sessionName ||
    typeof stored.ownerToken !== "string" ||
    typeof stored.paneId !== "string"
  ) {
    throw new LlmRouterError("tmux session is not owned by this router state", {
      code: "ERR_SESSION_NOT_OWNED",
      provider,
      sessionName
    });
  }
  if (!(await hasSession({ provider, sessionName, stateDir: root }))) {
    throw new LlmRouterError("router-owned tmux session is not running", {
      code: "ERR_SESSION_NOT_RUNNING",
      provider,
      sessionName
    });
  }
  const owner = await runTmux(
    ["show-options", "-v", "-t", exactTmuxPaneTarget(sessionName), "@llm_router_owner"],
    { allowFailure: true, timeoutMs: 5000, stateDir: root }
  );
  if (owner.code !== 0 || owner.stdout.trim() !== stored.ownerToken) {
    throw new LlmRouterError("tmux owner token does not match router metadata", {
      code: "ERR_SESSION_NOT_OWNED",
      provider,
      sessionName
    });
  }
  const pane = await runTmux(
    [
      "display-message",
      "-p",
      "-t",
      stored.paneId,
      "#{session_name}\t#{pane_id}\t#{pane_dead}"
    ],
    { allowFailure: true, timeoutMs: 5000, stateDir: root }
  );
  const [actualSession, actualPane, paneDead] = pane.stdout.trim().split("\t");
  if (
    pane.code !== 0 ||
    actualSession !== sessionName ||
    actualPane !== stored.paneId ||
    paneDead === "1"
  ) {
    throw new LlmRouterError("stored tmux pane no longer belongs to the owned session", {
      code: "ERR_SESSION_PANE_MISMATCH",
      provider,
      sessionName,
      paneId: stored.paneId
    });
  }
  return stored;
}

async function assertSessionCapacity(stateDir) {
  const configured = Number(process.env.LLM_ROUTER_MCP_MAX_SESSIONS || DEFAULT_MAX_SESSIONS);
  if (!Number.isSafeInteger(configured) || configured < 1 || configured > 64) {
    throw new LlmRouterError("LLM_ROUTER_MCP_MAX_SESSIONS must be an integer from 1 to 64");
  }
  const result = await runTmux(["list-sessions", "-F", "#{session_name}"], {
    allowFailure: true,
    timeoutMs: 5000,
    stateDir
  });
  if (result.code !== 0 && !isTmuxAbsentResult(result)) {
    throw new LlmRouterError("could not list router tmux sessions", {
      code: "ERR_TMUX_LIST",
      exitCode: result.code,
      stderr: truncateText(result.stderr.trim(), 500)
    });
  }
  const sessions = result.code === 0
    ? result.stdout.split(/\r?\n/).filter(Boolean)
    : [];
  if (sessions.length >= configured) {
    throw new LlmRouterError("router tmux session limit reached", {
      code: "ERR_SESSION_LIMIT",
      maxSessions: configured
    });
  }
}

function acquireHeadlessSlot(provider) {
  const totalLimit = normalizeConcurrencyLimit(
    process.env.LLM_ROUTER_MCP_MAX_HEADLESS_CALLS,
    2,
    "LLM_ROUTER_MCP_MAX_HEADLESS_CALLS"
  );
  const providerLimit = normalizeConcurrencyLimit(
    process.env.LLM_ROUTER_MCP_MAX_HEADLESS_PER_PROVIDER,
    1,
    "LLM_ROUTER_MCP_MAX_HEADLESS_PER_PROVIDER"
  );
  const providerActive = activeHeadlessByProvider.get(provider) || 0;
  if (activeHeadlessCalls >= totalLimit || providerActive >= providerLimit) {
    throw new LlmRouterError("headless provider concurrency limit reached", {
      code: "ERR_HEADLESS_BUSY",
      provider,
      totalLimit,
      providerLimit
    });
  }
  activeHeadlessCalls += 1;
  activeHeadlessByProvider.set(provider, providerActive + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeHeadlessCalls = Math.max(0, activeHeadlessCalls - 1);
    const remaining = Math.max(0, (activeHeadlessByProvider.get(provider) || 1) - 1);
    if (remaining === 0) activeHeadlessByProvider.delete(provider);
    else activeHeadlessByProvider.set(provider, remaining);
  };
}

function normalizeConcurrencyLimit(value, fallback, name) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 64) {
    throw new LlmRouterError(`${name} must be an integer from 1 to 64`);
  }
  return parsed;
}

async function acquireDirectoryLock(lockPath, options = {}) {
  throwIfAborted(options.signal);
  const timeoutMs = normalizeTimeout(options.timeoutMs, 5000);
  const deadline = Date.now() + timeoutMs;
  const token = crypto.randomUUID();

  while (true) {
    throwIfAborted(options.signal);
    try {
      await fs.mkdir(lockPath, { mode: 0o700 });
      await writeJsonAtomic(path.join(lockPath, "owner.json"), {
        token,
        pid: process.pid,
        createdAt: new Date().toISOString(),
        ...options.metadata
      });
      return async () => await releaseDirectoryLock(lockPath, { token });
    } catch (error) {
      if (error?.code !== "EEXIST") {
        await fs.rm(lockPath, { recursive: true, force: true }).catch(() => {});
        throw error;
      }

      if (await reclaimStaleLock(lockPath)) {
        continue;
      }
      if (!options.wait) {
        throw new LlmRouterError("provider tmux session already has an in-flight request", {
          code: "ERR_SESSION_BUSY",
          lockPath
        });
      }
      if (Date.now() >= deadline) {
        throw new LlmRouterError("timed out waiting for provider session lock", {
          code: "ERR_SESSION_LOCK_TIMEOUT",
          lockPath,
          timeoutMs
        });
      }
      await sleep(Math.min(100, Math.max(1, deadline - Date.now())), options.signal);
    }
  }
}

async function reclaimStaleLock(lockPath) {
  let initial;
  let owner = null;
  try {
    initial = await fs.lstat(lockPath);
    try {
      owner = await readJsonFile(path.join(lockPath, "owner.json"));
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ERR_INVALID_JSON") {
        throw error;
      }
    }
  } catch (error) {
    return error?.code === "ENOENT";
  }
  const ageMs = Date.now() - initial.mtimeMs;
  const ownerDead =
    Number.isSafeInteger(owner?.pid) &&
    ["launch", "capacity"].includes(owner?.kind) &&
    !isProcessAlive(owner.pid) &&
    ageMs > 5000;
  const ownerMissing = !owner && ageMs > 5000;
  const expiredNonRequest = owner?.kind !== "request" && ageMs > MAX_TIMEOUT_MS * 2;
  if (!ownerDead && !ownerMissing && !expiredNonRequest) {
    return false;
  }

  const markerPath = path.join(lockPath, ".reclaim");
  const markerToken = crypto.randomUUID();
  let markerAcquired = false;
  for (let attempt = 0; attempt < 2 && !markerAcquired; attempt += 1) {
    try {
      await fs.writeFile(
        markerPath,
        JSON.stringify({
          token: markerToken,
          pid: process.pid,
          createdAt: new Date().toISOString()
        }),
        { flag: "wx", mode: 0o600 }
      );
      markerAcquired = true;
    } catch (error) {
      if (error?.code === "EEXIST") {
        const recovered = await recoverAbandonedReclaimMarker({
          lockPath,
          markerPath,
          initial,
          owner
        });
        if (recovered) continue;
        return false;
      }
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  }
  if (!markerAcquired) return false;

  try {
    const current = await fs.lstat(lockPath);
    if (current.dev !== initial.dev || current.ino !== initial.ino) {
      return false;
    }
    let currentOwner = null;
    try {
      currentOwner = await readJsonFile(path.join(lockPath, "owner.json"));
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ERR_INVALID_JSON") {
        throw error;
      }
    }
    if ((currentOwner?.token || null) !== (owner?.token || null)) {
      return false;
    }
    const tombstone = `${lockPath}.reclaimed-${markerToken}`;
    await fs.rename(lockPath, tombstone);
    await fs.rm(tombstone, { recursive: true, force: true });
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  } finally {
    try {
      const marker = JSON.parse(await fs.readFile(markerPath, "utf8"));
      if (marker?.token === markerToken) {
        await fs.rm(markerPath, { force: true });
      }
    } catch {
      // The original lock may already have been renamed and removed.
    }
  }
}

async function recoverAbandonedReclaimMarker({ lockPath, markerPath, initial, owner }) {
  let markerStat;
  let markerOwner = null;
  try {
    markerStat = await fs.lstat(markerPath);
    try {
      markerOwner = JSON.parse(await fs.readFile(markerPath, "utf8"));
    } catch {
      // Markers from older versions contained only a random token. They can be
      // recovered after a conservative grace period.
    }
  } catch (error) {
    return error?.code === "ENOENT";
  }

  const markerAgeMs = Date.now() - markerStat.mtimeMs;
  const markerPid = markerOwner?.pid;
  const abandoned = Number.isSafeInteger(markerPid)
    ? !isProcessAlive(markerPid) || markerAgeMs > MAX_TIMEOUT_MS * 2
    : markerAgeMs > 5000;
  if (!abandoned) return false;

  try {
    const current = await fs.lstat(lockPath);
    if (current.dev !== initial.dev || current.ino !== initial.ino) return false;
    let currentOwner = null;
    try {
      currentOwner = await readJsonFile(path.join(lockPath, "owner.json"));
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ERR_INVALID_JSON") {
        throw error;
      }
    }
    if ((currentOwner?.token || null) !== (owner?.token || null)) return false;
    await fs.rm(markerPath, { force: true });
    return true;
  } catch (error) {
    return error?.code === "ENOENT";
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

// Request busy locks span multiple MCP calls, so they cannot use the token-bound
// release closure returned to the process that created them. Callers must hold
// the matching session launch lock while using this helper. That serialization
// makes the owner check plus removal immune to a new request's lock replacing the
// old one (the ABA race) and also lets us recover from a crashed `.release` marker.
async function forceReleaseRequestBusyLock(lockPath, requestId) {
  let owner;
  try {
    owner = await readJsonFile(path.join(lockPath, "owner.json"));
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
  if (owner.kind !== "request" || owner.requestId !== requestId) {
    return false;
  }
  await fs.rm(lockPath, { recursive: true, force: true });
  return !(await pathExists(lockPath));
}

async function releaseRequestBusyUnderLaunch({
  provider,
  sessionName,
  sessionPaths,
  requestId,
  timeoutMs
}) {
  const releaseLaunchLock = await acquireDirectoryLock(sessionPaths.launchLockPath, {
    timeoutMs,
    wait: true,
    metadata: { provider, sessionName, kind: "launch" }
  });
  try {
    return await forceReleaseRequestBusyLock(sessionPaths.busyLockPath, requestId);
  } finally {
    await releaseLaunchLock();
  }
}

async function releaseDirectoryLock(lockPath, expected = null) {
  let initial;
  if (expected) {
    let owner;
    try {
      owner = await readJsonFile(path.join(lockPath, "owner.json"));
    } catch (error) {
      if (error?.code === "ENOENT") {
        return false;
      }
      throw error;
    }
    if (expected.token && owner.token !== expected.token) {
      return false;
    }
    if (expected.requestId && owner.requestId !== expected.requestId) {
      return false;
    }
  }
  try {
    initial = await fs.lstat(lockPath);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  const markerPath = path.join(lockPath, ".release");
  const markerToken = crypto.randomUUID();
  try {
    await fs.writeFile(markerPath, markerToken, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (["EEXIST", "ENOENT"].includes(error?.code)) return false;
    throw error;
  }
  try {
    const current = await fs.lstat(lockPath);
    if (current.dev !== initial.dev || current.ino !== initial.ino) {
      return false;
    }
    const owner = await readJsonFile(path.join(lockPath, "owner.json"));
    if (expected?.token && owner.token !== expected.token) return false;
    if (expected?.requestId && owner.requestId !== expected.requestId) return false;
    const tombstone = `${lockPath}.released-${markerToken}`;
    await fs.rename(lockPath, tombstone);
    await fs.rm(tombstone, { recursive: true, force: true });
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  } finally {
    try {
      if ((await fs.readFile(markerPath, "utf8")) === markerToken) {
        await fs.rm(markerPath, { force: true });
      }
    } catch {
      // The original lock may already have been renamed and removed.
    }
  }
}

async function waitForPaneReadiness({
  provider,
  sessionName,
  paneId,
  stateDir,
  timeoutMs,
  detectStartupInteraction,
  signal
}) {
  const deadline = Date.now() + normalizeTimeout(timeoutMs, DEFAULT_READY_TIMEOUT_MS);
  const settleMs = readySettleMs();
  let lastPane = "";
  let stableSince = null;
  let previousPane = null;
  while (Date.now() <= deadline) {
    throwIfAborted(signal);
    if (!(await hasSession({ provider, sessionName, stateDir }))) {
      throw new LlmRouterError("provider process exited before its tmux pane became ready", {
        code: "ERR_PROVIDER_STARTUP_EXITED",
        provider,
        sessionName
      });
    }
    const paneState = await runTmux(
      ["display-message", "-p", "-t", paneId, "#{pane_dead}\t#{pane_pid}"],
      { allowFailure: true, timeoutMs: 5000, stateDir }
    );
    if (paneState.code !== 0 || paneState.stdout.trim().startsWith("1\t")) {
      throw new LlmRouterError("provider tmux pane exited before becoming ready", {
        code: "ERR_PROVIDER_STARTUP_EXITED",
        provider,
        sessionName
      });
    }
    lastPane = await capturePane({
      provider,
      sessionName,
      paneId,
      stateDir,
      lines: 80,
      currentOnly: true
    });
    if (lastPane.trim().length > 0) {
      const readinessSignature = paneReadinessSignature(provider, lastPane);
      if (readinessSignature !== previousPane) {
        previousPane = readinessSignature;
        stableSince = Date.now();
      }
      if (
        detectStartupInteraction &&
        /(not logged in|please log in|authentication required|sign in to continue|do you trust|trust this (?:folder|directory)|press enter to continue|update required)/i.test(
          lastPane
        )
      ) {
        throw new LlmRouterError("provider tmux pane requires interactive startup action", {
          code: "ERR_PROVIDER_INTERACTION_REQUIRED",
          provider,
          sessionName
        });
      }
      if (stableSince !== null && Date.now() - stableSince >= settleMs) {
        return true;
      }
    }
    await sleep(100, signal);
  }
  throw new LlmRouterError("provider tmux pane did not show readiness output before timeout", {
    code: "ERR_PROVIDER_NOT_READY",
    provider,
    sessionName,
    paneTail: debugPaneTail(lastPane, 40)
  });
}

function paneReadinessSignature(provider, paneText) {
  // Codex rotates the suggestion rendered after its `›` prompt even while the
  // TUI is fully ready. Normalize only that line; every other current-screen
  // change must still restart the stabilization window. Startup interaction
  // and error patterns are checked on every poll above.
  if (provider === "codex") {
    return paneText
      .split("\n")
      .map((line) => (/^\s*›(?:\s+.*)?$/u.test(line) ? "› <rotating-suggestion>" : line))
      .join("\n");
  }
  return paneText;
}

function readySettleMs() {
  const value = Number(process.env.LLM_ROUTER_MCP_READY_SETTLE_MS || 2000);
  if (!Number.isSafeInteger(value) || value < 250 || value > 10000) {
    throw new LlmRouterError(
      "LLM_ROUTER_MCP_READY_SETTLE_MS must be an integer from 250 to 10000"
    );
  }
  return value;
}

function readinessTimeoutBudget(totalTimeoutMs) {
  const settleMs = readySettleMs();
  if (totalTimeoutMs < settleMs + 500) {
    throw new LlmRouterError(
      "timeoutMs must exceed LLM_ROUTER_MCP_READY_SETTLE_MS by at least 500ms",
      {
        code: "ERR_READY_TIMEOUT_TOO_SMALL",
        timeoutMs: totalTimeoutMs,
        readySettleMs: settleMs
      }
    );
  }
  return totalTimeoutMs;
}

async function waitForPaneQuiet({
  provider,
  sessionName,
  paneId,
  stateDir,
  timeoutMs,
  quietMs,
  signal
}) {
  const deadline = Date.now() + normalizeTimeout(timeoutMs, 5000);
  let previous = null;
  let unchangedSince = null;
  while (Date.now() <= deadline) {
    throwIfAborted(signal);
    if (!(await hasSession({ provider, sessionName, stateDir }))) {
      return true;
    }
    let pane;
    try {
      pane = await capturePane({ provider, sessionName, paneId, stateDir, lines: 120 });
    } catch {
      return !(await hasSession({ provider, sessionName, stateDir }));
    }
    if (pane === previous) {
      unchangedSince ||= Date.now();
      if (Date.now() - unchangedSince >= quietMs) {
        return true;
      }
    } else {
      previous = pane;
      unchangedSince = Date.now();
    }
    await sleep(100, signal);
  }
  return false;
}

function debugPaneTail(value, count) {
  return process.env.LLM_ROUTER_MCP_ENABLE_DEBUG_TOOLS === "1"
    ? tailLines(value || "", count)
    : null;
}

function assertRequestMetadata(metadata, expected) {
  for (const key of ["provider", "sessionName", "nonce", "requestId"]) {
    if (metadata?.[key] !== expected[key]) {
      throw new LlmRouterError("request metadata does not match the requested transaction", {
        code: "ERR_REQUEST_METADATA_MISMATCH",
        key,
        expected: expected[key],
        actual: metadata?.[key]
      });
    }
  }
}

function requestMatchesSession(requestMetadata, sessionMetadata) {
  return Boolean(
    sessionMetadata &&
      requestMetadata.launchSpecHash === sessionMetadata.launchSpecHash &&
      requestMetadata.sessionGeneration === stableHash(sessionMetadata.ownerToken) &&
      requestMetadata.paneId === sessionMetadata.paneId
  );
}

async function readCompletedFileTransaction({
  provider,
  nonce,
  requestId,
  responsePath,
  donePath,
  stateDir
}) {
  let done;
  try {
    done = await readJsonFile(donePath, {
      stateDir,
      requireWithinState: true
    });
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ERR_INVALID_JSON") {
      return null;
    }
    throw error;
  }

  const expected = {
    protocolVersion: 2,
    provider,
    nonce,
    requestId,
    status: "completed"
  };
  for (const [key, value] of Object.entries(expected)) {
    if (done?.[key] !== value) {
      throw new LlmRouterError("completion file does not match the request transaction", {
        code: "ERR_COMPLETION_MISMATCH",
        key,
        expected: value,
        actual: done?.[key]
      });
    }
  }
  if (typeof done.completedAt !== "string" || !Number.isFinite(Date.parse(done.completedAt))) {
    throw new LlmRouterError("completion file must contain a valid completedAt timestamp", {
      code: "ERR_COMPLETION_TIMESTAMP"
    });
  }

  let response;
  try {
    response = await readMarkdownInput(responsePath, {
      stateDir,
      requireWithinState: true
    });
  } catch (error) {
    if (["ENOENT", "ERR_FILE_CHANGED"].includes(error?.code)) {
      return null;
    }
    throw error;
  }
  await Promise.all([
    fs.chmod(response.inputPath, 0o600),
    fs.chmod(donePath, 0o600)
  ]);
  return {
    answer: response.markdown.trimEnd(),
    bytes: response.bytes,
    completedAt: done.completedAt
  };
}

async function settleCompletedSession({
  provider,
  sessionName,
  stateDir,
  sessionMetadata,
  requestMetadata,
  sessionPaths,
  requestId,
  timeoutMs,
  signal
}) {
  throwIfAborted(signal);
  const releaseLaunchLock = await acquireDirectoryLock(sessionPaths.launchLockPath, {
    timeoutMs,
    signal,
    wait: true,
    metadata: { provider, sessionName, kind: "launch" }
  });
  try {
    throwIfAborted(signal);
    const running = await hasSession({ provider, sessionName, stateDir });
    if (!running) {
      throwIfAborted(signal);
      const released = await forceReleaseRequestBusyLock(
        sessionPaths.busyLockPath,
        requestId
      );
      return {
        sessionIdle: released,
        sessionEnded: true,
        ownershipMismatch: !released
      };
    }
    if (!requestMatchesSession(requestMetadata, sessionMetadata)) {
      return { sessionIdle: false, sessionEnded: false, ownershipMismatch: true };
    }
    try {
      await verifyOwnedSession({ provider, sessionName, stateDir, metadata: sessionMetadata });
    } catch {
      return { sessionIdle: false, sessionEnded: false, ownershipMismatch: true };
    }
    const paneQuiet = await waitForPaneQuiet({
      provider,
      sessionName,
      paneId: sessionMetadata.paneId,
      stateDir,
      timeoutMs: Math.min(5000, timeoutMs),
      signal,
      quietMs: 600
    });
    if (!paneQuiet) {
      return { sessionIdle: false, sessionEnded: false, ownershipMismatch: false };
    }
    throwIfAborted(signal);
    const released = await forceReleaseRequestBusyLock(
      sessionPaths.busyLockPath,
      requestId
    );
    return {
      sessionIdle: released,
      sessionEnded: false,
      ownershipMismatch: !released
    };
  } finally {
    await releaseLaunchLock();
  }
}

function completedWaitResult({
  provider,
  sessionName,
  nonce,
  requestId,
  startMarker,
  doneMarker,
  startSeenAt,
  fileResult,
  responsePath,
  donePath,
  paneText = "",
  sessionIdle,
  sessionEnded,
  ownershipMismatch
}) {
  return {
    provider,
    sessionName,
    nonce,
    requestId,
    started: true,
    completed: true,
    timedOut: false,
    sessionEnded,
    startMarker,
    doneMarker,
    startSeenAt,
    completedAt: fileResult.completedAt,
    completionSource: "markdown-file-v2",
    answer: fileResult.answer,
    responsePath,
    responseBytes: fileResult.bytes,
    donePath,
    fallbackPath: null,
    sessionBusy: !sessionIdle,
    ownershipMismatch,
    paneTail: debugPaneTail(paneText, 120)
  };
}

function normalizeOutputLimit(value) {
  if (value === undefined || value === null) {
    return DEFAULT_MAX_COMMAND_OUTPUT_BYTES;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1024 || parsed > 16 * 1024 * 1024) {
    throw new LlmRouterError("maxOutputBytes must be an integer between 1024 and 16777216", {
      maxOutputBytes: value
    });
  }
  return parsed;
}

function createBoundedCapture(maxBytes) {
  const chunks = [];
  let bytes = 0;
  let truncated = false;
  return {
    append(value) {
      let chunk = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
      if (chunk.byteLength >= maxBytes) {
        chunks.length = 0;
        chunk = chunk.subarray(chunk.byteLength - maxBytes);
        chunks.push(chunk);
        bytes = chunk.byteLength;
        truncated = true;
        return;
      }
      chunks.push(chunk);
      bytes += chunk.byteLength;
      while (bytes > maxBytes && chunks.length > 0) {
        const overflow = bytes - maxBytes;
        const first = chunks[0];
        if (first.byteLength <= overflow) {
          chunks.shift();
          bytes -= first.byteLength;
        } else {
          chunks[0] = first.subarray(overflow);
          bytes -= overflow;
        }
        truncated = true;
      }
    },
    text() {
      return Buffer.concat(chunks, bytes).toString("utf8");
    },
    get truncated() {
      return truncated;
    }
  };
}

function killChild(child, signal, processGroup) {
  try {
    if (processGroup && process.platform !== "win32" && child.pid) {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch {
    // The process may have exited between timeout detection and the signal.
  }
}

function truncateText(value, maxCharacters) {
  const text = String(value || "");
  if (text.length <= maxCharacters) {
    return text;
  }
  return `${text.slice(0, maxCharacters)}\n...[truncated]`;
}

async function pathExists(filePath) {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function extractAnswer(paneText, startMarker, doneMarker) {
  const lines = paneText.replace(/\r/g, "").split("\n");
  const startLine = lines.findIndex((line) => line.includes(startMarker));
  if (startLine === -1) {
    return null;
  }
  const doneLine = lines.findIndex(
    (line, index) => index > startLine && line.includes(doneMarker)
  );
  if (doneLine === -1 || doneLine < startLine) {
    return null;
  }

  const answerLines = lines.slice(startLine + 1, doneLine).map(cleanPaneLine);
  return stripCommonIndent(answerLines).join("\n").trimEnd();
}

function extractHeadlessAnswer(stdout, startMarker, doneMarker) {
  return extractAnswer(stdout, startMarker, doneMarker);
}

async function ensureDefaultWorkDir(provider, stateDir) {
  const config = providerConfig(provider);
  const cwd = await ensureStateSubdir(stateDir, "workdirs", config.id);

  const agentsPath = path.join(cwd, "AGENTS.md");
  const agentsText = `# AGENTS.md

This is a private scratch workspace for llm-router-mcp ${config.displayName} chat automation.

- For ordinary questions, answer directly in chat.
- Do not run shell commands, edit unrelated files, or send completion notifications unless the user explicitly asks inside the prompt.
- Follow llm-router-mcp Markdown file transaction v2 and preserve its ${config.envName}_TMUX_STARTED/${config.envName}_TMUX_DONE fallback marker protocol.
`;
  await writeFileAtomic(agentsPath, agentsText, {
    stateDir,
    requireWithinState: true
  });

  try {
    await fs.access(path.join(cwd, ".git"));
  } catch {
    await runCommand("git", ["init", "-q"], {
      cwd,
      allowFailure: true,
      timeoutMs: 10000
    });
  }

  return cwd;
}

async function writeRawResponseFile({
  provider,
  stateDir,
  nonce,
  requestId,
  rawResponsePath,
  stdout,
  stderr,
  code
}) {
  const config = providerConfig(provider);
  const content = `# Raw ${config.displayName} Headless Response

- nonce: ${nonce}
- requestId: ${requestId}
- exitCode: ${code}
- writtenAt: ${new Date().toISOString()}

## stdout

\`\`\`text
${stdout || ""}
\`\`\`

## stderr

\`\`\`text
${stderr || ""}
\`\`\`
`;
  const written = await writeFileExclusive(rawResponsePath, content, {
    stateDir,
    requireWithinState: true
  });
  return {
    rawResponsePath: written.filePath,
    bytes: written.bytes
  };
}

async function writeFallbackFile({ provider, stateDir, nonce, requestId, title, paneTail, error }) {
  const requestDir = path.join(stateDir, "requests", provider, requestId);
  const fallbackPath = path.join(requestDir, "fallback.md");
  const content = `# ${title}

- nonce: ${nonce}
- requestId: ${requestId}
- writtenAt: ${new Date().toISOString()}
${error ? `- error: ${error instanceof Error ? error.message : String(error)}\n` : ""}
## Captured pane tail

\`\`\`text
${tailLines(paneTail || "", 240)}
\`\`\`
`;
  const written = await writeFileAtomic(fallbackPath, content, {
    stateDir,
    requireWithinState: true
  });
  return written.filePath;
}

function resolveSessionName(provider, sessionName) {
  const config = providerConfig(provider);
  return (
    sessionName ||
    process.env[`LLM_ROUTER_MCP_${config.envName}_SESSION`] ||
    config.defaultSessionName
  );
}

function cleanPaneLine(line) {
  return line
    .replace(/[ \t]*[|│┃█▌▐]+[ \t]*$/g, "")
    .replace(/[ \t]{2,}\d{1,2}:\d{2}\s*(?:AM|PM)[ \t]*$/i, "")
    .replace(/[ \t]+$/g, "");
}

function stripCommonIndent(lines) {
  const nonEmpty = lines.filter((line) => line.trim().length > 0);
  if (nonEmpty.length === 0) {
    return lines;
  }
  const common = Math.min(
    ...nonEmpty.map((line) => {
      const match = /^[ \t]*/.exec(line);
      return match ? match[0].length : 0;
    })
  );
  if (common <= 0) {
    return lines;
  }
  return lines.map((line) => line.slice(Math.min(common, line.length)));
}

function stripAnsi(value) {
  return value.replace(
    // eslint-disable-next-line no-control-regex
    /[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g,
    ""
  );
}

function tailLines(value, count) {
  const lines = value.split(/\r?\n/);
  return lines.slice(Math.max(0, lines.length - count)).join("\n");
}

async function readRouterInput({ provider, inputPath, stateDir, allowExternalInput }) {
  const externalAllowed =
    allowExternalInput === true || process.env.LLM_ROUTER_MCP_ALLOW_EXTERNAL_INPUT === "1";
  const input = await readMarkdownInput(inputPath, {
    stateDir,
    requireWithinState: !externalAllowed
  });
  if (externalAllowed) {
    return input;
  }
  const allowedDirectories = [
    path.join(stateDir, "inputs", normalizeProvider(provider)),
    path.join(stateDir, "inputs", "shared")
  ];
  if (!allowedDirectories.some((directory) => isPathWithin(directory, input.inputPath))) {
    throw new LlmRouterError(
      "managed inputPath must come from llm_write_input for this provider or shared inputs",
      {
        code: "ERR_INPUT_PROVENANCE",
        inputPath: input.inputPath
      }
    );
  }
  return input;
}

function isPathWithin(rootPath, candidatePath) {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function requireInputPath(inputPath) {
  if (typeof inputPath !== "string" || inputPath.length === 0) {
    throw new LlmRouterError("inputPath is required and must point to a Markdown file");
  }
  return inputPath;
}

function requireNonce(nonce) {
  if (typeof nonce !== "string" || nonce.length === 0) {
    throw new LlmRouterError("nonce is required");
  }
  return nonce;
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_./:=+-]+$/.test(value)) {
    return value;
  }
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function mergedEnv(extra = {}) {
  const home = os.homedir();
  const pathPrefix = [path.join(home, ".local", "bin"), path.join(home, ".npm-global", "bin")].join(
    path.delimiter
  );
  const customPrefix = process.env.LLM_ROUTER_MCP_PATH_PREFIX || "";
  return {
    ...process.env,
    PATH: [customPrefix, pathPrefix, process.env.PATH || ""]
      .filter(Boolean)
      .join(path.delimiter),
    ...extra
  };
}

function durationForAgy(timeoutMs) {
  const seconds = Math.max(1, Math.ceil(normalizeTimeout(timeoutMs, 300000) / 1000));
  return `${seconds}s`;
}

function remainingTimeout(deadline) {
  const remaining = deadline - Date.now();
  if (remaining < 1) {
    throw new LlmRouterError("session startup exhausted its end-to-end timeout", {
      code: "ERR_SESSION_START_TIMEOUT", timedOut: true
    });
  }
  return remaining;
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw new LlmRouterError("operation cancelled", { code: "ERR_CANCELLED", cancelled: true });
  }
}

function sleep(ms, signal) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(new LlmRouterError("operation cancelled", { code: "ERR_CANCELLED", cancelled: true }));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}
