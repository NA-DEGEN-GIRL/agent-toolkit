import fs from "node:fs/promises";
import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import path from "node:path";

/**
 * Provider launch metadata intentionally contains no pinned model names. Model
 * selection belongs to the caller, the provider-specific MODEL environment
 * variable, or the provider CLI's own configuration/default, in that order.
 */
export const LAUNCHER_PROVIDERS = Object.freeze({
  codex: Object.freeze({
    id: "codex",
    envName: "CODEX",
    executable: "codex",
    modelFlags: Object.freeze(["-m", "--model"]),
    canonicalModelFlag: "-m",
    requiredPermissions: Object.freeze(["codex:bypass"])
  }),
  claude: Object.freeze({
    id: "claude",
    envName: "CLAUDE",
    executable: "claude",
    modelFlags: Object.freeze(["--model"]),
    canonicalModelFlag: "--model",
    requiredPermissions: Object.freeze(["claude:bypass"])
  }),
  grok: Object.freeze({
    id: "grok",
    envName: "GROK",
    executable: "grok",
    modelFlags: Object.freeze(["-m", "--model"]),
    canonicalModelFlag: "-m",
    requiredPermissions: Object.freeze([
      "grok:approve",
      "grok:bypass",
      "grok:sandbox-off"
    ])
  }),
  antigravity: Object.freeze({
    id: "antigravity",
    envName: "ANTIGRAVITY",
    executable: "agy",
    modelFlags: Object.freeze(["--model"]),
    canonicalModelFlag: "--model",
    requiredPermissions: Object.freeze(["antigravity:bypass"])
  })
});

const PROVIDER_ALIASES = Object.freeze({
  agy: "antigravity",
  gemini: "antigravity",
  google: "antigravity",
  gpt: "codex",
  openai: "codex",
  xai: "grok"
});

const PERMISSION_SOURCES = new Set(["auto", "router", "launcher"]);
const MAX_WRAPPER_BYTES = 64 * 1024;

export class LauncherConfigError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "LauncherConfigError";
    this.details = details;
  }
}

export function normalizeLauncherProvider(provider) {
  const value = String(provider || "").trim().toLowerCase();
  const normalized = PROVIDER_ALIASES[value] || value;
  if (!Object.hasOwn(LAUNCHER_PROVIDERS, normalized)) {
    throw new LauncherConfigError(
      "provider must be one of: codex, claude, grok, antigravity",
      { provider }
    );
  }
  return normalized;
}

export function resolveProviderModel(provider, requestedModel, environment = process.env) {
  const config = providerConfig(provider);
  const requested = normalizeModelValue(requestedModel, "requested model");
  if (requested) {
    return { model: requested, modelSource: "request" };
  }

  const modelKey = `LLM_ROUTER_MCP_${config.envName}_MODEL`;
  const environmentModel = normalizeModelValue(
    environment[modelKey],
    modelKey
  );
  if (environmentModel) {
    return { model: environmentModel, modelSource: "environment" };
  }

  return { model: "", modelSource: "cli-default" };
}

function normalizeModelValue(value, label) {
  const model = nonEmptyString(value);
  if (!model) {
    return "";
  }
  if (model.length > 200 || model.includes("\0")) {
    throw new LauncherConfigError(`${label} must be at most 200 characters without NUL bytes`);
  }
  return model;
}

export function parseBaseArgs(provider, environment = process.env) {
  const config = providerConfig(provider);
  const key = `LLM_ROUTER_MCP_${config.envName}_BASE_ARGS`;
  const raw = environment[key];
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return [];
  }

  let parsed;
  try {
    parsed = JSON.parse(String(raw));
  } catch (error) {
    throw new LauncherConfigError(`${key} must be a JSON array of strings`, {
      key,
      cause: error instanceof Error ? error.message : String(error)
    });
  }

  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) {
    throw new LauncherConfigError(`${key} must be a JSON array of strings`, { key });
  }
  if (parsed.some((value) => value.includes("\0"))) {
    throw new LauncherConfigError(`${key} arguments must not contain NUL bytes`, { key });
  }
  if (
    parsed.length > 64 ||
    parsed.some((value) => value.length > 4096) ||
    parsed.reduce((total, value) => total + value.length, 0) > 65536
  ) {
    throw new LauncherConfigError(`${key} is too large`, { key });
  }
  const args = [...parsed];
  validateArgumentSource(config.id, args, key, { rejectModelOptions: true });
  return args;
}

/**
 * Inspect a small, simple shebang wrapper. This deliberately does not source a
 * user's shell and therefore does not support aliases or shell functions.
 * Detection is advisory and limited to literal, known permission flags.
 */
export function detectShebangWrapper(provider, source) {
  const id = normalizeLauncherProvider(provider);
  const text = String(source || "");
  const firstLineEnd = text.indexOf("\n");
  const firstLine = (firstLineEnd === -1 ? text : text.slice(0, firstLineEnd)).trim();
  if (!firstLine.startsWith("#!")) {
    return { ...emptyWrapperInspection(), inspected: true };
  }
  if (!isShellShebang(firstLine)) {
    return {
      ...emptyWrapperInspection(),
      inspected: true,
      shebang: true,
      nonShellScript: true
    };
  }
  const wrapper = parseStrictExecWrapper(text);
  if (!wrapper) {
    return {
      ...emptyWrapperInspection(),
      inspected: true,
      shebang: true,
      opaqueWrapper: true
    };
  }

  const wrapperArgs = wrapper.args;
  const provided = new Set();
  const conflicts = [];
  const modelOptions = argOptionValues(
    wrapperArgs,
    LAUNCHER_PROVIDERS[id].modelFlags
  );
  const unsupportedArgs = unsupportedWrapperArgs(id, wrapperArgs);

  if (id === "codex") {
    if (hasExactFlag(wrapperArgs, "--dangerously-bypass-approvals-and-sandbox")) {
      provided.add("codex:bypass");
    }
    for (const value of argOptionValues(wrapperArgs, ["--ask-for-approval", "-a"])) {
      if (value && value !== "never") {
        conflicts.push(`--ask-for-approval=${value}`);
      }
    }
    for (const value of argOptionValues(wrapperArgs, ["--sandbox", "-s"])) {
      if (value && value !== "danger-full-access") {
        conflicts.push(`--sandbox=${value}`);
      }
    }
  } else if (id === "claude") {
    if (hasExactFlag(wrapperArgs, "--dangerously-skip-permissions")) {
      provided.add("claude:bypass");
    }
    for (const value of argOptionValues(wrapperArgs, ["--permission-mode"])) {
      if (value && value !== "bypassPermissions") {
        conflicts.push(`--permission-mode=${value}`);
      } else if (value === "bypassPermissions") {
        provided.add("claude:bypass");
      }
    }
  } else if (id === "grok") {
    if (hasExactFlag(wrapperArgs, "--always-approve")) {
      provided.add("grok:approve");
    }
    for (const value of argOptionValues(wrapperArgs, ["--permission-mode"])) {
      if (value === "bypassPermissions") {
        provided.add("grok:bypass");
      } else if (value) {
        conflicts.push(`--permission-mode=${value}`);
      }
    }
    for (const value of argOptionValues(wrapperArgs, ["--sandbox"])) {
      if (value === "off") {
        provided.add("grok:sandbox-off");
      } else if (value) {
        conflicts.push(`--sandbox=${value}`);
      }
    }
  } else if (id === "antigravity") {
    if (hasExactFlag(wrapperArgs, "--dangerously-skip-permissions")) {
      provided.add("antigravity:bypass");
    }
    if (hasExactFlag(wrapperArgs, "--sandbox")) {
      conflicts.push("--sandbox");
    }
  }

  return {
    inspected: true,
    shebang: true,
    wrapper: true,
    opaqueWrapper: false,
    provided: [...provided],
    conflicts,
    modelOptions,
    unsupportedArgs,
    targetExecutable: wrapper.executable
  };
}

function isShellShebang(firstLine) {
  const command = firstLine.slice(2).trim();
  const words = command.split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return false;
  }
  const interpreter = path.basename(words[0]);
  if (interpreter === "env") {
    // Support common `env bash` and `env -S bash ...` shebangs without trying
    // to interpret arbitrary environment assignments or shell expressions.
    const candidates = words.slice(1).filter((word) => word !== "-S");
    return candidates.some((word) => isShellInterpreter(path.basename(word)));
  }
  if (interpreter === "busybox") {
    return words.slice(1).some((word) => isShellInterpreter(path.basename(word)));
  }
  return isShellInterpreter(interpreter);
}

function isShellInterpreter(interpreter) {
  return ["sh", "ash", "bash", "dash", "ksh", "mksh", "zsh"].includes(interpreter);
}

function parseStrictExecWrapper(source) {
  const codeLines = String(source)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line, index) => index > 0 && line && !line.startsWith("#"));
  if (codeLines.length !== 1) {
    return null;
  }
  // Only the exact double-quoted forwarding form preserves every caller
  // argument. Unquoted `$@` changes empty/whitespace arguments, while single
  // quotes pass the literal two characters and can silently drop bypass flags.
  if (!/"\$@"$/.test(codeLines[0])) {
    return null;
  }
  const words = parseSimpleShellWords(codeLines[0]);
  if (!words || words.length < 3 || words[0] !== "exec" || words.at(-1) !== "$@") {
    return null;
  }
  const executable = words[1];
  if (
    /[;|&<>()`]/.test(executable) ||
    executable.includes("$") ||
    ["env", "command", "sh", "bash"].includes(path.basename(executable))
  ) {
    return null;
  }
  const args = words.slice(2, -1);
  if (
    args.some(
      (arg) => /[$;|&<>()`]/.test(arg) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)
    )
  ) {
    return null;
  }
  return { executable, args };
}

function parseSimpleShellWords(line) {
  const words = [];
  let word = "";
  let quote = "";
  let inWord = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote) {
      if (character === quote) {
        quote = "";
      } else if (character === "\\") {
        return null;
      } else {
        word += character;
      }
      inWord = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      inWord = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (inWord) {
        words.push(word);
        word = "";
        inWord = false;
      }
      continue;
    }
    if (character === "\\" || character === "#") {
      return null;
    }
    word += character;
    inWord = true;
  }
  if (quote) {
    return null;
  }
  if (inWord) {
    words.push(word);
  }
  return words;
}

function hasExactFlag(args, flag) {
  return args.includes(flag);
}

function argOptionValues(args, flags) {
  const values = [];
  const names = new Set(flags);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const equals = arg.indexOf("=");
    if (equals > 0 && names.has(arg.slice(0, equals))) {
      values.push(arg.slice(equals + 1));
      continue;
    }
    if (names.has(arg) && typeof args[index + 1] === "string") {
      values.push(args[index + 1]);
      index += 1;
    }
  }
  return values;
}

function unsupportedWrapperArgs(provider, args) {
  const config = LAUNCHER_PROVIDERS[provider];
  const unsupported = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const equals = arg.indexOf("=");
    const name = equals > 0 ? arg.slice(0, equals) : arg;
    if (config.modelFlags.includes(name)) {
      if (equals > 0 && arg.slice(equals + 1)) {
        continue;
      }
      if (equals === -1 && typeof args[index + 1] === "string") {
        index += 1;
        continue;
      }
      unsupported.push(arg);
      continue;
    }
    if (provider === "codex" && arg === "--dangerously-bypass-approvals-and-sandbox") {
      continue;
    }
    if (provider === "claude" && arg === "--dangerously-skip-permissions") {
      continue;
    }
    if (provider === "grok" && arg === "--always-approve") {
      continue;
    }
    if (provider === "antigravity" && arg === "--dangerously-skip-permissions") {
      continue;
    }
    if (["claude", "grok"].includes(provider) && name === "--permission-mode") {
      const value = equals > 0 ? arg.slice(equals + 1) : args[index + 1];
      if (equals === -1) index += 1;
      if (value === "bypassPermissions") continue;
    }
    if (provider === "grok" && name === "--sandbox") {
      const value = equals > 0 ? arg.slice(equals + 1) : args[index + 1];
      if (equals === -1 && typeof value === "string") index += 1;
      if (value) continue;
    }
    unsupported.push(arg);
  }
  return unsupported;
}

/**
 * Normalize model and permission options across base and mode-specific args.
 * The returned argv never contains semantic duplicates owned by this module.
 */
export function normalizeLauncherArgs(provider, inputArgs, options = {}) {
  const id = normalizeLauncherProvider(provider);
  const config = LAUNCHER_PROVIDERS[id];
  const args = validateArgs(inputArgs, "launcher arguments");
  const model = nonEmptyString(options.model);
  const permissionSource = normalizePermissionSource(options.permissionSource);
  const wrapperInspection = options.wrapperInspection || emptyWrapperInspection();
  const wrapperProvided = new Set(wrapperInspection.provided || []);
  const wrapperConflicts = Array.isArray(wrapperInspection.conflicts)
    ? wrapperInspection.conflicts
    : [];
  const wrapperModelOptions = Array.isArray(wrapperInspection.modelOptions)
    ? wrapperInspection.modelOptions
    : [];
  const wrapperUnsupportedArgs = Array.isArray(wrapperInspection.unsupportedArgs)
    ? wrapperInspection.unsupportedArgs
    : [];

  if (wrapperInspection.opaqueWrapper && permissionSource !== "launcher") {
    throw new LauncherConfigError(
      `${id} executable is an opaque shell wrapper or explicitly configured script; use a strict one-line exec wrapper, or explicitly set permission source to launcher and opt in with LLM_ROUTER_MCP_ALLOW_UNVERIFIED_LAUNCHER=1`,
      { provider: id, permissionSource }
    );
  }

  if (wrapperModelOptions.length > 0) {
    throw new LauncherConfigError(
      `${id} shebang wrapper contains a model flag; configure model selection with LLM_ROUTER_MCP_${config.envName}_MODEL so it can be normalized`,
      { provider: id, wrapperModelOptions }
    );
  }
  if (wrapperUnsupportedArgs.length > 0) {
    throw new LauncherConfigError(
      `${id} shebang wrapper contains unsupported fixed arguments; move them to BASE_ARGS`,
      { provider: id, wrapperUnsupportedArgs }
    );
  }

  if (permissionSource === "router" && wrapperProvided.size > 0) {
    throw new LauncherConfigError(
      `${id} launcher already supplies permission-bypass flags; router mode would duplicate them`,
      {
        provider: id,
        permissionSource,
        detected: [...wrapperProvided]
      }
    );
  }

  if (permissionSource !== "launcher" && wrapperConflicts.length > 0) {
    throw new LauncherConfigError(
      `${id} shebang wrapper contains permission flags that conflict with router-managed bypass`,
      {
        provider: id,
        permissionSource,
        conflicts: wrapperConflicts
      }
    );
  }

  const outerPermissionState = inspectPermissionArgs(id, args);
  let stripped = stripKnownOptions(args, [
    ...permissionOptionDefinitions(id),
    ...modelOptionDefinitions(config)
  ]);

  let bypassSource;
  let bypassVerified;
  let policyArgs = [];

  if (permissionSource === "launcher" && wrapperInspection.opaqueWrapper) {
    // A complex shell wrapper may ignore, replace, or reinterpret all outer
    // argv. Never claim that permission flags observed outside it are active.
    bypassSource = "launcher";
    bypassVerified = false;
  } else if (permissionSource === "launcher") {
    if (hasAllRequiredPermissions(config, wrapperProvided)) {
      bypassSource = "launcher";
      bypassVerified = true;
    } else {
      const combinedProvided = new Set([
        ...wrapperProvided,
        ...outerPermissionState.provided
      ]);
      if (hasAllRequiredPermissions(config, combinedProvided)) {
        const missingFromWrapper = new Set(
          config.requiredPermissions.filter(
            (permission) => !wrapperProvided.has(permission)
          )
        );
        bypassSource = wrapperProvided.size > 0 ? "router+launcher" : "launcher";
        bypassVerified = true;
        policyArgs = canonicalPermissionArgs(id, missingFromWrapper);
      } else {
        // An explicit launcher source may be implemented by a binary, managed
        // configuration, or a wrapper too complex for conservative inspection.
        bypassSource = "launcher";
        bypassVerified = false;
      }
    }
  } else if (permissionSource === "auto" && wrapperProvided.size > 0) {
    const missing = config.requiredPermissions.filter(
      (permission) => !wrapperProvided.has(permission)
    );
    policyArgs = canonicalPermissionArgs(id, new Set(missing));
    bypassSource = missing.length === 0 ? "launcher" : "router+launcher";
    bypassVerified = true;
  } else {
    policyArgs = canonicalPermissionArgs(id);
    bypassSource = "router";
    bypassVerified = true;
  }

  const modelArgs = model ? [config.canonicalModelFlag, model] : [];
  stripped = [...policyArgs, ...modelArgs, ...stripped];

  return {
    args: stripped,
    bypassSource,
    bypassVerified
  };
}

/**
 * Resolve a provider into a spawn-safe command and argv. `modeArgs` should hold
 * only the tmux-interactive or headless-specific options. The executable and
 * BASE_ARGS resolution is shared by both transports.
 *
 * A legacy *_CMD is returned only for mode="tmux". It is deliberately not
 * parsed or modified; callers choosing it must execute it as a shell command
 * and should surface bypassVerified=false.
 */
export async function resolveLauncher(provider, options = {}) {
  const id = normalizeLauncherProvider(provider);
  const config = LAUNCHER_PROVIDERS[id];
  const environment = options.environment || process.env;
  const mode = options.mode || "headless";
  if (mode !== "tmux" && mode !== "headless") {
    throw new LauncherConfigError("launcher mode must be tmux or headless", { mode });
  }

  const executableKey = `LLM_ROUTER_MCP_${config.envName}_EXECUTABLE`;
  const permissionKey = `LLM_ROUTER_MCP_${config.envName}_PERMISSION_SOURCE`;
  const commandKey = `LLM_ROUTER_MCP_${config.envName}_CMD`;
  const configuredExecutable = nonEmptyString(environment[executableKey]);
  const executable = configuredExecutable || config.executable;
  if (executable.includes("\0")) {
    throw new LauncherConfigError(`${executableKey} must not contain NUL bytes`, {
      key: executableKey
    });
  }

  const { model, modelSource } = resolveProviderModel(
    id,
    options.requestedModel ?? options.model,
    environment
  );
  const legacyCommand =
    mode === "tmux" ? nonEmptyString(environment[commandKey]) : "";

  if (legacyCommand) {
    return {
      command: executable,
      args: [],
      model,
      modelSource,
      bypassSource: "legacy-command",
      bypassVerified: false,
      legacyCommand
    };
  }

  const baseArgs = parseBaseArgs(id, environment);
  const modeArgs = validateArgs(options.modeArgs || options.args || [], "modeArgs");
  validateArgumentSource(id, modeArgs, "modeArgs");
  const permissionSource = normalizePermissionSource(environment[permissionKey]);
  let wrapperInspection =
    options.inspectWrapper === false
      ? emptyWrapperInspection()
      : await inspectExecutableWrapper(id, executable, {
          environment,
          cwd: options.cwd
        });
  if (
    configuredExecutable &&
    (wrapperInspection.nonShellScript || wrapperInspection.inspectionFailed)
  ) {
    wrapperInspection = { ...wrapperInspection, opaqueWrapper: true };
  }
  const normalized = normalizeLauncherArgs(id, [...baseArgs, ...modeArgs], {
    model,
    permissionSource,
    wrapperInspection
  });

  return {
    command: executable,
    args: normalized.args,
    model,
    modelSource,
    bypassSource: normalized.bypassSource,
    bypassVerified: normalized.bypassVerified,
    opaqueWrapper: Boolean(wrapperInspection.opaqueWrapper),
    ...(wrapperInspection.wrapperFingerprints?.length > 1
      ? { wrapperFingerprints: wrapperInspection.wrapperFingerprints }
      : {})
  };
}

export async function inspectExecutableWrapper(provider, executable, options = {}) {
  const environment = options.environment || process.env;
  const visited = new Set();
  const wrapperFingerprints = [];
  let combined = null;
  let current = executable;
  for (let depth = 0; depth < 8; depth += 1) {
    const resolvedPath = await resolveExecutablePath(current, { environment, cwd: options.cwd });
    if (!resolvedPath) {
      return combined ? { ...combined, opaqueWrapper: true, wrapperFingerprints } : emptyWrapperInspection();
    }
    let handle;
    try {
      const realPath = await fs.realpath(resolvedPath);
      if (visited.has(realPath)) return { ...combined, opaqueWrapper: true, wrapperFingerprints };
      visited.add(realPath);
      handle = await fs.open(realPath, "r");
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error("launcher is not a regular file");
      const buffer = Buffer.alloc(MAX_WRAPPER_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const bytes = buffer.subarray(0, bytesRead);
      const inspection = detectShebangWrapper(provider, bytes.toString("utf8"));
      wrapperFingerprints.push({
        realPath, dev: stat.dev, ino: stat.ino, size: stat.size,
        mtimeMs: stat.mtimeMs, mode: stat.mode,
        ...(stat.size <= MAX_WRAPPER_BYTES
          ? { sha256: crypto.createHash("sha256").update(bytes).digest("hex") }
          : {})
      });
      // Never verify a truncated shell script, or smuggle a custom Node/Python
      // (or opaque shell) launcher through a one-line outer wrapper. Default
      // provider CLI entrypoint scripts are trusted only at the top level.
      if (inspection.shebang && !inspection.nonShellScript && stat.size > MAX_WRAPPER_BYTES) {
        inspection.opaqueWrapper = true;
      }
      if (depth > 0 && inspection.nonShellScript) inspection.opaqueWrapper = true;
      if (!combined) combined = { ...inspection };
      else {
        for (const key of ["provided", "conflicts", "modelOptions", "unsupportedArgs"]) {
          combined[key] = [...(combined[key] || []), ...(inspection[key] || [])];
        }
        combined.opaqueWrapper ||= inspection.opaqueWrapper;
      }
      if (combined.opaqueWrapper || !inspection.wrapper) {
        return { ...combined, wrapperFingerprints };
      }
      current = inspection.targetExecutable;
    } catch {
      return {
        ...(combined || emptyWrapperInspection()), inspected: true,
        inspectionFailed: true, opaqueWrapper: Boolean(combined), wrapperFingerprints
      };
    } finally {
      await handle?.close().catch(() => {});
    }
  }
  return { ...combined, opaqueWrapper: true, wrapperFingerprints };
}

export async function resolveExecutablePath(executable, options = {}) {
  const value = nonEmptyString(executable);
  if (!value) {
    return null;
  }
  const environment = options.environment || process.env;
  const cwd = options.cwd || process.cwd();
  const candidates = value.includes(path.sep)
    ? [path.isAbsolute(value) ? value : path.resolve(cwd, value)]
    : String(environment.PATH || "")
        .split(path.delimiter)
        .filter(Boolean)
        .map((directory) => path.join(directory, value));

  for (const candidate of candidates) {
    try {
      await fs.access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Continue to the next PATH entry. Shell aliases/functions are
      // intentionally not queried or sourced.
    }
  }
  return null;
}

function providerConfig(provider) {
  return LAUNCHER_PROVIDERS[normalizeLauncherProvider(provider)];
}

function normalizePermissionSource(source) {
  const value = nonEmptyString(source) || "auto";
  if (!PERMISSION_SOURCES.has(value)) {
    throw new LauncherConfigError(
      "permission source must be one of: auto, router, launcher",
      { permissionSource: value }
    );
  }
  return value;
}

function validateArgs(args, label) {
  if (!Array.isArray(args) || args.some((value) => typeof value !== "string")) {
    throw new LauncherConfigError(`${label} must be an array of strings`);
  }
  if (args.some((value) => value.includes("\0"))) {
    throw new LauncherConfigError(`${label} must not contain NUL bytes`);
  }
  return [...args];
}

function validateArgumentSource(provider, args, label, options = {}) {
  const config = LAUNCHER_PROVIDERS[provider];
  const definitions = new Map(
    [...permissionOptionDefinitions(provider), ...modelOptionDefinitions(config)].map(
      (definition) => [definition.name, definition]
    )
  );

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      break;
    }
    const equals = arg.indexOf("=");
    const name = equals > 0 ? arg.slice(0, equals) : arg;

    if (options.rejectModelOptions && config.modelFlags.includes(name)) {
      throw new LauncherConfigError(
        `${label} must not contain ${name}; configure the model with LLM_ROUTER_MCP_${config.envName}_MODEL`,
        { provider, label, option: name }
      );
    }

    const definition = definitions.get(name);
    if (!definition?.takesValue) {
      continue;
    }
    if (equals > 0) {
      if (arg.slice(equals + 1) === "") {
        throw new LauncherConfigError(`${label} option ${name} requires a value`, {
          provider,
          label,
          option: name
        });
      }
      continue;
    }

    const value = args[index + 1];
    if (typeof value !== "string" || value === "--" || value.startsWith("-")) {
      throw new LauncherConfigError(`${label} option ${name} requires a value`, {
        provider,
        label,
        option: name
      });
    }
    index += 1;
  }
}

function modelOptionDefinitions(config) {
  return config.modelFlags.map((name) => ({ name, takesValue: true }));
}

function permissionOptionDefinitions(provider) {
  if (provider === "codex") {
    return [
      { name: "--dangerously-bypass-approvals-and-sandbox", takesValue: false },
      { name: "--ask-for-approval", takesValue: true },
      { name: "-a", takesValue: true },
      { name: "--sandbox", takesValue: true },
      { name: "-s", takesValue: true }
    ];
  }
  if (provider === "claude") {
    return [
      { name: "--dangerously-skip-permissions", takesValue: false },
      { name: "--permission-mode", takesValue: true }
    ];
  }
  if (provider === "grok") {
    return [
      { name: "--always-approve", takesValue: false },
      { name: "--permission-mode", takesValue: true },
      { name: "--sandbox", takesValue: true }
    ];
  }
  return [
    { name: "--dangerously-skip-permissions", takesValue: false },
    { name: "--sandbox", takesValue: false }
  ];
}

function canonicalPermissionArgs(provider, include) {
  const wanted = include || new Set(LAUNCHER_PROVIDERS[provider].requiredPermissions);
  if (provider === "codex") {
    return wanted.has("codex:bypass")
      ? ["--dangerously-bypass-approvals-and-sandbox"]
      : [];
  }
  if (provider === "claude") {
    return wanted.has("claude:bypass") ? ["--dangerously-skip-permissions"] : [];
  }
  if (provider === "grok") {
    const result = [];
    if (wanted.has("grok:approve")) {
      result.push("--always-approve");
    }
    if (wanted.has("grok:bypass")) {
      result.push("--permission-mode", "bypassPermissions");
    }
    if (wanted.has("grok:sandbox-off")) {
      result.push("--sandbox", "off");
    }
    return result;
  }
  return wanted.has("antigravity:bypass")
    ? ["--dangerously-skip-permissions"]
    : [];
}

function inspectPermissionArgs(provider, args) {
  const provided = new Set();
  const options = collectArgOptions(args);
  if (provider === "codex") {
    if (options.booleans.has("--dangerously-bypass-approvals-and-sandbox")) {
      provided.add("codex:bypass");
    }
  } else if (provider === "claude") {
    if (
      options.booleans.has("--dangerously-skip-permissions") ||
      options.values.get("--permission-mode")?.includes("bypassPermissions")
    ) {
      provided.add("claude:bypass");
    }
  } else if (provider === "grok") {
    if (options.booleans.has("--always-approve")) {
      provided.add("grok:approve");
    }
    if (options.values.get("--permission-mode")?.includes("bypassPermissions")) {
      provided.add("grok:bypass");
    }
    if (options.values.get("--sandbox")?.includes("off")) {
      provided.add("grok:sandbox-off");
    }
  } else if (options.booleans.has("--dangerously-skip-permissions")) {
    provided.add("antigravity:bypass");
  }
  return {
    provided,
    satisfied: hasAllRequiredPermissions(LAUNCHER_PROVIDERS[provider], provided)
  };
}

function collectArgOptions(args) {
  const booleans = new Set();
  const values = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      break;
    }
    const equals = arg.indexOf("=");
    if (equals > 0) {
      const name = arg.slice(0, equals);
      const value = arg.slice(equals + 1);
      addOptionValue(values, name, value);
      continue;
    }
    if (arg.startsWith("-")) {
      booleans.add(arg);
      const next = args[index + 1];
      if (typeof next === "string" && !next.startsWith("-")) {
        addOptionValue(values, arg, next);
      }
    }
  }
  return { booleans, values };
}

function addOptionValue(values, name, value) {
  const current = values.get(name) || [];
  current.push(value);
  values.set(name, current);
}

function hasAllRequiredPermissions(config, provided) {
  return config.requiredPermissions.every((permission) => provided.has(permission));
}

function stripKnownOptions(args, definitions) {
  const byName = new Map(definitions.map((definition) => [definition.name, definition]));
  const result = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      result.push(...args.slice(index));
      break;
    }

    const equals = arg.indexOf("=");
    const name = equals > 0 ? arg.slice(0, equals) : arg;
    const definition = byName.get(name);
    if (!definition) {
      result.push(arg);
      continue;
    }

    if (definition.takesValue && equals === -1 && index + 1 < args.length) {
      index += 1;
    }
  }
  return result;
}

function nonEmptyString(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function emptyWrapperInspection() {
  return {
    inspected: false,
    shebang: false,
    wrapper: false,
    opaqueWrapper: false,
    nonShellScript: false,
    inspectionFailed: false,
    provided: [],
    conflicts: [],
    modelOptions: [],
    unsupportedArgs: []
  };
}
