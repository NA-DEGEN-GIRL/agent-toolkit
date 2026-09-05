import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildTmuxCommand,
  doctorProviders,
  ensureSession,
  headlessAsk,
  hasSession,
  killSession,
  listProviders,
  runCommand,
  sendInput,
  status,
  tmuxSocketLabel,
  tmuxAsk,
  waitForResponse,
  writeInputFile
} from "../src/core.js";

const PROVIDERS = ["codex", "claude", "grok", "antigravity"];
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = path.dirname(TEST_DIR);
const FAKE_LLM = path.join(TEST_DIR, "fixtures", "fake-llm.js");

async function requireTmux(t) {
  try {
    const result = await runCommand("tmux", ["-V"], {
      allowFailure: true,
      timeoutMs: 5000
    });
    if (result.code === 0) {
      return true;
    }
  } catch {
    // Direct node:test runs may not have the package pretest prerequisite.
  }
  t.skip("tmux is not available");
  return false;
}

async function makeFixture(t) {
  if (!(await requireTmux(t))) {
    return null;
  }
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "llm-router-mcp-test-"));
  const previousReadySettle = process.env.LLM_ROUTER_MCP_READY_SETTLE_MS;
  process.env.LLM_ROUTER_MCP_READY_SETTLE_MS = "250";
  const sessionPrefix = `lrm-${process.pid}-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}`;
  const sessions = new Set();
  t.after(async () => {
    for (const { provider, sessionName } of sessions) {
      await killSession({ provider, sessionName, stateDir: tmp });
    }
    await fs.rm(tmp, { recursive: true, force: true });
    if (previousReadySettle === undefined) {
      delete process.env.LLM_ROUTER_MCP_READY_SETTLE_MS;
    } else {
      process.env.LLM_ROUTER_MCP_READY_SETTLE_MS = previousReadySettle;
    }
  });
  return {
    tmp,
    fakeCommand: `node ${shellQuote(FAKE_LLM)}`,
    sessionPrefix,
    cwd: PACKAGE_DIR,
    trackSession(provider, sessionName) {
      sessions.add({ provider, sessionName });
    }
  };
}

async function makeFakePath(t) {
  const fakeBin = await fs.mkdtemp(path.join(os.tmpdir(), "llm-router-fake-bin-"));
  for (const name of ["codex", "claude", "grok", "agy"]) {
    const target = path.join(fakeBin, name);
    await fs.copyFile(FAKE_LLM, target);
    await fs.chmod(target, 0o755);
  }
  const oldPathPrefix = process.env.LLM_ROUTER_MCP_PATH_PREFIX;
  process.env.LLM_ROUTER_MCP_PATH_PREFIX = fakeBin;
  t.after(async () => {
    if (oldPathPrefix === undefined) {
      delete process.env.LLM_ROUTER_MCP_PATH_PREFIX;
    } else {
      process.env.LLM_ROUTER_MCP_PATH_PREFIX = oldPathPrefix;
    }
    await fs.rm(fakeBin, { recursive: true, force: true });
  });
}

test("provider list and tmux commands enforce bypass without pinning default models", async (t) => {
  const executableKeys = PROVIDERS.map((provider) =>
    `LLM_ROUTER_MCP_${provider === "antigravity" ? "ANTIGRAVITY" : provider.toUpperCase()}_EXECUTABLE`
  );
  const previous = new Map(executableKeys.map((key) => [key, process.env[key]]));
  for (const key of executableKeys) {
    process.env[key] = process.execPath;
  }
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const providers = listProviders();
  assert.deepEqual(
    providers.map((provider) => provider.id),
    PROVIDERS
  );
  assert.equal(providers.every((provider) => provider.defaultModel === "CLI default"), true);
  assert.match(await buildTmuxCommand("codex", "gpt-test"), /--dangerously-bypass-approvals-and-sandbox/);
  assert.match(await buildTmuxCommand("codex", "gpt-test"), /-m gpt-test/);
  assert.match(await buildTmuxCommand("claude", "opus"), /--dangerously-skip-permissions/);
  assert.match(await buildTmuxCommand("claude", "opus"), /--model opus/);
  assert.match(await buildTmuxCommand("grok", "grok-test"), /--permission-mode bypassPermissions/);
  assert.match(await buildTmuxCommand("grok", "grok-test"), /--sandbox off/);
  assert.match(await buildTmuxCommand("antigravity", "agy-test"), /--model agy-test/);
});

test("provider doctor reports isolated tmux and verified launchers without model calls", async (t) => {
  await makeFakePath(t);
  const report = await doctorProviders();
  assert.equal(report.tmux.available, true);
  assert.equal(report.tmux.isolatedSocket, true);
  assert.equal(report.providers.length, PROVIDERS.length);
  assert.equal(report.providers.every((provider) => provider.available), true);
  assert.equal(report.providers.every((provider) => provider.bypassVerified), true);
  assert.equal(report.providers.every((provider) => provider.launchProbeAccepted), true);
  assert.equal(report.providers.every((provider) => /fake-llm/.test(provider.version)), true);
  const priorBaseArgs = process.env.LLM_ROUTER_MCP_CLAUDE_BASE_ARGS;
  process.env.LLM_ROUTER_MCP_CLAUDE_BASE_ARGS = '["--"]';
  t.after(() => {
    if (priorBaseArgs === undefined) delete process.env.LLM_ROUTER_MCP_CLAUDE_BASE_ARGS;
    else process.env.LLM_ROUTER_MCP_CLAUDE_BASE_ARGS = priorBaseArgs;
  });
  const skipped = await doctorProviders({ provider: "claude" });
  assert.equal(skipped.providers[0].launchProbeAccepted, null);
  assert.match(skipped.providers[0].launchProbeSkippedReason, /BASE_ARGS/);
});

test("provider doctor never executes an explicitly unverified opaque wrapper", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "llm-router-doctor-opaque-"));
  const wrapper = path.join(directory, "claude-wrapper");
  const sentinel = path.join(directory, "invoked");
  await fs.writeFile(
    wrapper,
    `#!/bin/sh\nprintf invoked > ${shellQuote(sentinel)}\nexec claude "$@"\n`,
    { mode: 0o700 }
  );
  const keys = [
    "LLM_ROUTER_MCP_CLAUDE_EXECUTABLE",
    "LLM_ROUTER_MCP_CLAUDE_PERMISSION_SOURCE",
    "LLM_ROUTER_MCP_CLAUDE_BASE_ARGS",
    "LLM_ROUTER_MCP_CLAUDE_CMD"
  ];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  process.env.LLM_ROUTER_MCP_CLAUDE_EXECUTABLE = wrapper;
  process.env.LLM_ROUTER_MCP_CLAUDE_PERMISSION_SOURCE = "launcher";
  delete process.env.LLM_ROUTER_MCP_CLAUDE_BASE_ARGS;
  delete process.env.LLM_ROUTER_MCP_CLAUDE_CMD;
  t.after(async () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(directory, { recursive: true, force: true });
  });

  const report = await doctorProviders({ provider: "claude" });
  const claude = report.providers[0];
  assert.equal(claude.available, true);
  assert.equal(claude.opaqueWrapper, true);
  assert.equal(claude.bypassVerified, false);
  assert.equal(claude.version, null);
  assert.equal(claude.launchProbeAccepted, null);
  assert.match(claude.launchProbeSkippedReason, /version and help probes skipped/);
  await assert.rejects(fs.stat(sentinel), (error) => error?.code === "ENOENT");
});

test("runCommand handles early stdin close and bounded output without crashing", async () => {
  const earlyExit = await runCommand(
    process.execPath,
    ["-e", "process.exit(2)"],
    {
      input: "x".repeat(1024 * 1024),
      allowFailure: true,
      timeoutMs: 5000
    }
  );
  assert.equal(earlyExit.code, 2);

  const bounded = await runCommand(
    process.execPath,
    ["-e", "process.stdout.write('x'.repeat(20000))"],
    { maxOutputBytes: 1024, timeoutMs: 5000 }
  );
  assert.equal(bounded.stdoutTruncated, true);
  assert.equal(Buffer.byteLength(bounded.stdout, "utf8") <= 1024, true);
  await assert.rejects(
    runCommand(process.execPath, ["-e", ""], { maxOutputBytes: Number.NaN }),
    /maxOutputBytes/
  );
});

test("tmux ask preserves context-capable Markdown nonce protocol for each provider", async (t) => {
  const fixture = await makeFixture(t);
  if (!fixture) {
    return;
  }

  for (const provider of PROVIDERS) {
    const sessionName = `${fixture.sessionPrefix}-${provider}`;
    fixture.trackSession(provider, sessionName);
    const input = await writeInputFile({
      provider,
      markdown: `# ${provider} review\n\nThis is a long Markdown prompt.\n`,
      filename: `${provider}.md`,
      stateDir: fixture.tmp
    });

    const result = await tmuxAsk({
      provider,
      inputPath: input.inputPath,
      sessionName,
      command: fixture.fakeCommand,
      allowUnverifiedLauncher: true,
      cwd: fixture.cwd,
      stateDir: fixture.tmp,
      timeoutMs: 5000,
      pollMs: 50
    });

    assert.equal(result.mode, "tmux");
    assert.equal(result.sent, true);
    assert.equal(result.started, true);
    assert.equal(result.completed, true);
    assert.equal(result.timedOut, false);
    assert.match(result.answer, /fake tmux \d+ answer/);
    assert.match(result.responsePath, /\/response\.md$/);
    assert.equal(result.transport, "markdown-file-v2");
    assert.equal(result.completionSource, "markdown-file-v2");
    assert.equal(await fs.readFile(result.responsePath, "utf8"), `${result.answer}\n`);
    const transportText = await fs.readFile(
      path.join(path.dirname(result.promptPath), "transport.txt"),
      "utf8"
    );
    assert.match(transportText, /^Read and follow the complete llm-router-mcp Markdown request at:/);
    assert.doesNotMatch(transportText, /BEGIN MCP MARKDOWN INPUT/);
    assert.equal(transportText.trim().split(/\r?\n/).length, 1);

    const current = await status({
      provider,
      sessionName,
      nonce: result.nonce,
      stateDir: fixture.tmp
    });
    assert.equal(current.running, true);
    assert.equal(current.markerStatus.started, true);
    assert.equal(current.markerStatus.completed, true);
    assert.equal(current.paneTail, null);

    if (provider === "antigravity") {
      await killSession({ provider, sessionName, stateDir: fixture.tmp });
      const recovered = await waitForResponse({
        provider,
        sessionName,
        nonce: result.nonce,
        stateDir: fixture.tmp,
        timeoutMs: 1000
      });
      assert.equal(recovered.completed, true);
      assert.equal(recovered.sessionEnded, true);
      assert.equal(recovered.answer, result.answer);
    }
  }
});

test("tmux wait returns timeout state and Markdown fallback when done marker is missing", async (t) => {
  const fixture = await makeFixture(t);
  if (!fixture) {
    return;
  }
  const input = await writeInputFile({
    provider: "grok",
    markdown: "NO_DONE_MARKER",
    filename: "timeout.md",
    stateDir: fixture.tmp
  });
  const sessionName = `${fixture.sessionPrefix}-timeout`;
  fixture.trackSession("grok", sessionName);

  const sent = await sendInput({
    provider: "grok",
    inputPath: input.inputPath,
    sessionName,
    command: fixture.fakeCommand,
    allowUnverifiedLauncher: true,
    cwd: fixture.cwd,
    stateDir: fixture.tmp,
    timeoutMs: 5000
  });

  assert.equal(sent.sent, true);

  const queuedInput = await writeInputFile({
    provider: "grok",
    markdown: "This request must not interleave with the unfinished request.",
    filename: "busy.md",
    stateDir: fixture.tmp
  });
  await assert.rejects(
    sendInput({
      provider: "grok",
      inputPath: queuedInput.inputPath,
      sessionName,
      command: fixture.fakeCommand,
      allowUnverifiedLauncher: true,
      cwd: fixture.cwd,
      stateDir: fixture.tmp,
      timeoutMs: 5000
    }),
    (error) => error?.details?.code === "ERR_SESSION_BUSY"
  );

  const waited = await waitForResponse({
    provider: "grok",
    sessionName,
    nonce: sent.nonce,
    timeoutMs: 300,
    pollMs: 50,
    stateDir: fixture.tmp
  });
  assert.equal(waited.completed, false);
  assert.equal(waited.timedOut, true);
  assert.match(waited.fallbackPath, /\/fallback\.md$/);
  assert.match(await fs.readFile(waited.fallbackPath, "utf8"), /timed out/);
});

test("a dead busy session is replaced without carrying its stale request lock", async (t) => {
  const fixture = await makeFixture(t);
  if (!fixture) return;
  const provider = "grok";
  const sessionName = `${fixture.sessionPrefix}-dead-busy`;
  fixture.trackSession(provider, sessionName);
  const firstInput = await writeInputFile({
    provider,
    markdown: "NO_DONE_MARKER",
    filename: "dead-busy-first.md",
    stateDir: fixture.tmp
  });
  await sendInput({
    provider,
    inputPath: firstInput.inputPath,
    sessionName,
    command: fixture.fakeCommand,
    allowUnverifiedLauncher: true,
    cwd: fixture.cwd,
    stateDir: fixture.tmp,
    timeoutMs: 5000
  });
  const killed = await runCommand(
    "tmux",
    [
      "-L",
      tmuxSocketLabel(fixture.tmp),
      "-f",
      "/dev/null",
      "kill-session",
      "-t",
      `=${sessionName}`
    ],
    { allowFailure: true, timeoutMs: 5000 }
  );
  assert.equal(killed.code, 0, killed.stderr);
  assert.equal(await hasSession({ provider, sessionName, stateDir: fixture.tmp }), false);

  const replacementInput = await writeInputFile({
    provider,
    markdown: "Answer after replacing the dead provider generation.",
    filename: "dead-busy-replacement.md",
    stateDir: fixture.tmp
  });
  const replacement = await tmuxAsk({
    provider,
    inputPath: replacementInput.inputPath,
    sessionName,
    command: fixture.fakeCommand,
    allowUnverifiedLauncher: true,
    cwd: fixture.cwd,
    stateDir: fixture.tmp,
    timeoutMs: 5000,
    pollMs: 50
  });
  assert.equal(replacement.completed, true);
  assert.equal(replacement.sessionBusy, false);
});

test("completed requests recover a crashed busy-lock release marker without ABA", async (t) => {
  const fixture = await makeFixture(t);
  if (!fixture) return;
  const provider = "claude";
  const sessionName = `${fixture.sessionPrefix}-release-recovery`;
  fixture.trackSession(provider, sessionName);
  const input = await writeInputFile({
    provider,
    markdown: "Complete this request after a simulated lock-release crash.",
    filename: "release-recovery.md",
    stateDir: fixture.tmp
  });
  const sent = await sendInput({
    provider,
    inputPath: input.inputPath,
    sessionName,
    command: fixture.fakeCommand,
    allowUnverifiedLauncher: true,
    cwd: fixture.cwd,
    stateDir: fixture.tmp,
    timeoutMs: 5000
  });
  const busyLock = path.join(
    fixture.tmp,
    "sessions",
    provider,
    `${sessionName}.busy-lock`
  );
  await fs.writeFile(path.join(busyLock, ".release"), "crashed-releaser", {
    flag: "wx",
    mode: 0o600
  });

  const completed = await waitForResponse({
    provider,
    sessionName,
    nonce: sent.nonce,
    timeoutMs: 5000,
    pollMs: 50,
    stateDir: fixture.tmp
  });
  assert.equal(completed.completed, true);
  assert.equal(completed.sessionBusy, false);
  assert.equal(
    (await status({ provider, sessionName, stateDir: fixture.tmp })).busy,
    false
  );
});

test("session startup recovers a reclaim marker abandoned by a dead lock owner", async (t) => {
  const fixture = await makeFixture(t);
  if (!fixture) return;
  const provider = "codex";
  const sessionName = `${fixture.sessionPrefix}-reclaim-recovery`;
  fixture.trackSession(provider, sessionName);
  const launchLock = path.join(
    fixture.tmp,
    "sessions",
    "launch-locks",
    `${sessionName}.launch-lock`
  );
  await fs.mkdir(launchLock, { recursive: true, mode: 0o700 });
  const deadPid = 99_999_999;
  await fs.writeFile(
    path.join(launchLock, "owner.json"),
    JSON.stringify({
      token: "abandoned-owner",
      pid: deadPid,
      kind: "launch",
      provider,
      sessionName
    }),
    { mode: 0o600 }
  );
  await fs.writeFile(
    path.join(launchLock, ".reclaim"),
    JSON.stringify({ token: "abandoned-reclaimer", pid: deadPid }),
    { mode: 0o600 }
  );
  const old = new Date(Date.now() - 10_000);
  await fs.utimes(launchLock, old, old);

  const started = await ensureSession({
    provider,
    sessionName,
    command: fixture.fakeCommand,
    allowUnverifiedLauncher: true,
    cwd: fixture.cwd,
    stateDir: fixture.tmp,
    timeoutMs: 5000
  });
  assert.equal(started.created, true);
  await assert.rejects(fs.stat(launchLock), (error) => error?.code === "ENOENT");
});

test("session startup recovers an abandoned reclaim marker with no owner file", async (t) => {
  const fixture = await makeFixture(t);
  if (!fixture) return;
  const provider = "claude";
  const sessionName = `${fixture.sessionPrefix}-ownerless-reclaim`;
  fixture.trackSession(provider, sessionName);
  const launchLock = path.join(
    fixture.tmp,
    "sessions",
    "launch-locks",
    `${sessionName}.launch-lock`
  );
  await fs.mkdir(launchLock, { recursive: true, mode: 0o700 });
  await fs.writeFile(
    path.join(launchLock, ".reclaim"),
    JSON.stringify({ token: "abandoned-ownerless-reclaimer", pid: 99_999_999 }),
    { mode: 0o600 }
  );
  const old = new Date(Date.now() - 10_000);
  await fs.utimes(launchLock, old, old);

  const started = await ensureSession({
    provider,
    sessionName,
    command: fixture.fakeCommand,
    allowUnverifiedLauncher: true,
    cwd: fixture.cwd,
    stateDir: fixture.tmp,
    timeoutMs: 5000
  });
  assert.equal(started.created, true);
  await assert.rejects(fs.stat(launchLock), (error) => error?.code === "ENOENT");
});

test("existing tmux sessions reject launcher or model drift instead of silently reusing", async (t) => {
  const fixture = await makeFixture(t);
  if (!fixture) {
    return;
  }
  const sessionName = `${fixture.sessionPrefix}-drift`;
  fixture.trackSession("claude", sessionName);
  const common = {
    provider: "claude",
    sessionName,
    command: fixture.fakeCommand,
    allowUnverifiedLauncher: true,
    cwd: fixture.cwd,
    stateDir: fixture.tmp,
    timeoutMs: 5000
  };

  const started = await ensureSession({ ...common, model: "opus-current" });
  assert.equal(started.created, true);
  await assert.rejects(
    ensureSession({ ...common, model: "opus-next" }),
    (error) => error?.details?.code === "ERR_SESSION_SPEC_MISMATCH"
  );
});

test("interrupted starting sessions can be recreated or stopped as router-owned", async (t) => {
  const fixture = await makeFixture(t);
  if (!fixture) return;
  const provider = "claude";

  const recreateName = `${fixture.sessionPrefix}-starting-recreate`;
  fixture.trackSession(provider, recreateName);
  await createStartingSessionArtifact({ fixture, provider, sessionName: recreateName });
  const recreated = await ensureSession({
    provider,
    sessionName: recreateName,
    command: fixture.fakeCommand,
    allowUnverifiedLauncher: true,
    cwd: fixture.cwd,
    stateDir: fixture.tmp,
    timeoutMs: 5000
  });
  assert.equal(recreated.created, true);
  const readyMetadata = JSON.parse(
    await fs.readFile(
      path.join(fixture.tmp, "sessions", provider, `${recreateName}.json`),
      "utf8"
    )
  );
  assert.equal(readyMetadata.status, "ready");

  const stopName = `${fixture.sessionPrefix}-starting-stop`;
  fixture.trackSession(provider, stopName);
  await createStartingSessionArtifact({ fixture, provider, sessionName: stopName });
  const stopped = await killSession({
    provider,
    sessionName: stopName,
    stateDir: fixture.tmp,
    requireOwned: true
  });
  assert.equal(stopped.running, false);
  assert.equal(await hasSession({ provider, sessionName: stopName, stateDir: fixture.tmp }), false);
});

test("startup stabilization rejects delayed interaction screens and cleans the session", async (t) => {
  const fixture = await makeFixture(t);
  if (!fixture) return;
  const sessionName = `${fixture.sessionPrefix}-startup-modal`;
  fixture.trackSession("claude", sessionName);
  process.env.LLM_ROUTER_MCP_READY_SETTLE_MS = "1000";
  const script =
    'console.log("loading...");setTimeout(()=>console.log("Authentication required"),400);setInterval(()=>{},1000)';
  await assert.rejects(
    ensureSession({
      provider: "claude",
      sessionName,
      command: `${shellQuote(process.execPath)} -e ${shellQuote(script)}`,
      allowUnverifiedLauncher: true,
      cwd: fixture.cwd,
      stateDir: fixture.tmp,
      timeoutMs: 3000
    }),
    (error) => error?.details?.code === "ERR_PROVIDER_INTERACTION_REQUIRED"
  );
  process.env.LLM_ROUTER_MCP_READY_SETTLE_MS = "250";
  assert.equal(
    await hasSession({ provider: "claude", sessionName, stateDir: fixture.tmp }),
    false
  );
});

test("Codex readiness tolerates a rotating prompt suggestion", async (t) => {
  const fixture = await makeFixture(t);
  if (!fixture) return;
  const sessionName = `${fixture.sessionPrefix}-codex-dynamic-ready`;
  fixture.trackSession("codex", sessionName);
  process.env.LLM_ROUTER_MCP_READY_SETTLE_MS = "700";
  const script = String.raw`let i=0;setInterval(()=>{process.stdout.write("\u001b[2J\u001b[H› suggestion "+i+++"\n\n  test-model xhigh · /tmp\n")},100)`;
  try {
    const started = await ensureSession({
      provider: "codex",
      sessionName,
      command: `${shellQuote(process.execPath)} -e ${shellQuote(script)}`,
      allowUnverifiedLauncher: true,
      cwd: fixture.cwd,
      stateDir: fixture.tmp,
      timeoutMs: 3000
    });
    assert.equal(started.ready, true);
  } finally {
    process.env.LLM_ROUTER_MCP_READY_SETTLE_MS = "250";
  }
});

test("Codex readiness still tracks non-suggestion screen changes", async (t) => {
  const fixture = await makeFixture(t);
  if (!fixture) return;
  const sessionName = `${fixture.sessionPrefix}-codex-dynamic-status`;
  fixture.trackSession("codex", sessionName);
  process.env.LLM_ROUTER_MCP_READY_SETTLE_MS = "500";
  const script = String.raw`let i=0;setInterval(()=>{process.stdout.write("\u001b[2J\u001b[H› suggestion "+i+"\n\n  startup phase "+i+++"\n")},100)`;
  try {
    await assert.rejects(
      ensureSession({
        provider: "codex",
        sessionName,
        command: `${shellQuote(process.execPath)} -e ${shellQuote(script)}`,
        allowUnverifiedLauncher: true,
        cwd: fixture.cwd,
        stateDir: fixture.tmp,
        timeoutMs: 1400
      }),
      (error) => error?.details?.code === "ERR_PROVIDER_NOT_READY"
    );
  } finally {
    process.env.LLM_ROUTER_MCP_READY_SETTLE_MS = "250";
  }
});

test("session reuse honors readiness settle windows above three seconds", async (t) => {
  const fixture = await makeFixture(t);
  if (!fixture) return;
  const sessionName = `${fixture.sessionPrefix}-long-settle`;
  fixture.trackSession("codex", sessionName);
  process.env.LLM_ROUTER_MCP_READY_SETTLE_MS = "3100";
  const options = {
    provider: "codex",
    sessionName,
    command: fixture.fakeCommand,
    allowUnverifiedLauncher: true,
    cwd: fixture.cwd,
    stateDir: fixture.tmp,
    timeoutMs: 5000
  };
  assert.equal((await ensureSession(options)).created, true);
  assert.equal((await ensureSession(options)).created, false);
  process.env.LLM_ROUTER_MCP_READY_SETTLE_MS = "250";
});

test("router tmux socket is isolated from same-named user sessions", async (t) => {
  const fixture = await makeFixture(t);
  if (!fixture) {
    return;
  }
  const sessionName = `${fixture.sessionPrefix}-isolated`;
  fixture.trackSession("codex", sessionName);
  await runCommand("tmux", ["new-session", "-d", "-s", sessionName, "sleep 30"]);
  t.after(async () => {
    await runCommand("tmux", ["kill-session", "-t", `=${sessionName}`], {
      allowFailure: true
    });
  });

  assert.equal(await hasSession({ provider: "codex", sessionName, stateDir: fixture.tmp }), false);
  const started = await ensureSession({
    provider: "codex",
    sessionName,
    command: fixture.fakeCommand,
    allowUnverifiedLauncher: true,
    cwd: fixture.cwd,
    stateDir: fixture.tmp,
    timeoutMs: 5000
  });
  assert.equal(started.created, true);
  assert.equal(await hasSession({ provider: "codex", sessionName, stateDir: fixture.tmp }), true);
  const userSession = await runCommand("tmux", ["has-session", "-t", `=${sessionName}`], {
    allowFailure: true
  });
  assert.equal(userSession.code, 0);
});

test("headless ask uses one-shot CLI calls and writes Markdown outputs", async (t) => {
  await makeFakePath(t);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "llm-router-headless-test-"));
  t.after(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  for (const provider of PROVIDERS) {
    const result = await headlessAsk({
      provider,
      markdown: `# ${provider} one shot\n\nReturn a short answer.`,
      filename: `${provider}.md`,
      stateDir: tmp,
      cwd: PACKAGE_DIR,
      timeoutMs: 5000,
      model: provider === "antigravity" ? "ui-selected" : "test-model"
    });

    assert.equal(result.mode, "headless");
    assert.equal(result.success, true);
    assert.equal(result.exitCode, 0);
    assert.match(result.answer, /fake headless answer/);
    assert.match(result.responsePath, /\/response\.md$/);
    assert.match(result.rawResponsePath, /\/raw\.md$/);
    assert.equal(await fs.readFile(result.responsePath, "utf8"), `${result.answer}\n`);
  }

  const previousClaudeModel = process.env.LLM_ROUTER_MCP_CLAUDE_MODEL;
  process.env.LLM_ROUTER_MCP_CLAUDE_MODEL = "opus-env-test";
  try {
    const configured = await headlessAsk({
      provider: "claude",
      markdown: "Use configured model source.",
      filename: "claude-environment-model.md",
      stateDir: tmp,
      cwd: PACKAGE_DIR,
      timeoutMs: 5000
    });
    assert.equal(configured.model, "opus-env-test");
    assert.equal(configured.modelSource, "environment");
  } finally {
    if (previousClaudeModel === undefined) delete process.env.LLM_ROUTER_MCP_CLAUDE_MODEL;
    else process.env.LLM_ROUTER_MCP_CLAUDE_MODEL = previousClaudeModel;
  }
});

test("headless calls enforce per-provider concurrency limits", async (t) => {
  await makeFakePath(t);
  const previousLimit = process.env.LLM_ROUTER_MCP_MAX_HEADLESS_PER_PROVIDER;
  process.env.LLM_ROUTER_MCP_MAX_HEADLESS_PER_PROVIDER = "1";
  t.after(() => {
    if (previousLimit === undefined) delete process.env.LLM_ROUTER_MCP_MAX_HEADLESS_PER_PROVIDER;
    else process.env.LLM_ROUTER_MCP_MAX_HEADLESS_PER_PROVIDER = previousLimit;
  });
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm-router-headless-limit-"));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  const first = headlessAsk({
    provider: "claude",
    markdown: "SLOW_HEADLESS",
    filename: "slow.md",
    stateDir,
    cwd: PACKAGE_DIR,
    timeoutMs: 5000
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  await assert.rejects(
    headlessAsk({
      provider: "claude",
      markdown: "must be rejected while busy",
      filename: "busy.md",
      stateDir,
      cwd: PACKAGE_DIR,
      timeoutMs: 5000
    }),
    (error) => error?.details?.code === "ERR_HEADLESS_BUSY"
  );
  assert.equal((await first).success, true);
});

test("headless output truncation is never reported as a successful answer", async (t) => {
  await makeFakePath(t);
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm-router-headless-truncated-"));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  const result = await headlessAsk({
    provider: "grok",
    markdown: "HUGE_OUTPUT",
    filename: "huge.md",
    stateDir,
    cwd: PACKAGE_DIR,
    timeoutMs: 5000
  });
  assert.equal(result.stdoutTruncated, true);
  assert.equal(result.success, false);
  assert.equal(result.errorCode, "ERR_OUTPUT_TRUNCATED");
  assert.equal(result.answer, null);
  assert.equal(result.responsePath, null);
});

test("core rejects external Markdown paths unless explicitly opted in", async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm-router-managed-state-"));
  const externalDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm-router-external-input-"));
  const externalPath = path.join(externalDir, "prompt.md");
  await fs.writeFile(externalPath, "external prompt", "utf8");
  t.after(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
    await fs.rm(externalDir, { recursive: true, force: true });
  });

  await assert.rejects(
    headlessAsk({ provider: "codex", inputPath: externalPath, stateDir }),
    (error) => error?.code === "ERR_OUTSIDE_STATE"
  );

  const staleResponseDir = path.join(stateDir, "requests", "codex", "stale-request");
  await fs.mkdir(staleResponseDir, { recursive: true });
  const staleResponse = path.join(staleResponseDir, "response.md");
  await fs.writeFile(staleResponse, "old private response", "utf8");
  await assert.rejects(
    headlessAsk({ provider: "codex", inputPath: staleResponse, stateDir }),
    (error) => error?.details?.code === "ERR_INPUT_PROVENANCE"
  );
});

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

async function createStartingSessionArtifact({ fixture, provider, sessionName }) {
  const sessionDirectory = path.join(fixture.tmp, "sessions", provider);
  await fs.mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
  await fs.writeFile(
    path.join(sessionDirectory, `${sessionName}.json`),
    `${JSON.stringify({
      protocolVersion: 2,
      provider,
      sessionName,
      paneId: null,
      ownerToken: "abandoned-owner-token",
      launchSpecHash: "a".repeat(64),
      launchSpec: {},
      status: "starting",
      ready: false,
      creatorPid: 99_999_999,
      createdAt: new Date(Date.now() - 10_000).toISOString()
    })}\n`,
    { mode: 0o600 }
  );
  const result = await runCommand(
    "tmux",
    [
      "-L",
      tmuxSocketLabel(fixture.tmp),
      "-f",
      "/dev/null",
      "new-session",
      "-e",
      "LLM_ROUTER_MCP_OWNER=abandoned-owner-token",
      "-d",
      "-s",
      sessionName,
      "sleep 30"
    ],
    { allowFailure: true, timeoutMs: 5000 }
  );
  assert.equal(result.code, 0, result.stderr);
}

test("same-name concurrent providers cannot remove the winning tmux session", async (t) => {
  const fixture = await makeFixture(t);
  if (!fixture) return;
  const sessionName = `${fixture.sessionPrefix}-shared`;
  for (const provider of ["claude", "codex"]) fixture.trackSession(provider, sessionName);
  const results = await Promise.allSettled(["claude", "codex"].map(provider => ensureSession({
    provider, sessionName, stateDir: fixture.tmp, command: fixture.fakeCommand,
    allowUnverifiedLauncher: true, cwd: fixture.cwd, timeoutMs: 5000
  })));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.filter(result => result.status === "rejected").length, 1);
  const winner = results.find(result => result.status === "fulfilled").value;
  assert.equal(await hasSession({ provider: winner.provider, sessionName, stateDir: fixture.tmp }), true);
  assert.equal((await status({ provider: winner.provider, sessionName, stateDir: fixture.tmp })).running, true);
});

test("startup readiness permits delayed output within the requested timeout", async (t) => {
  const fixture = await makeFixture(t);
  if (!fixture) return;
  const provider = "claude";
  const sessionName = `${fixture.sessionPrefix}-delayed-ready`;
  fixture.trackSession(provider, sessionName);
  const script = path.join(fixture.tmp, "delayed.cjs");
  await fs.writeFile(script, "setTimeout(() => console.log('fake ready'), 3800); setInterval(() => {}, 1000);\n");
  const started = await ensureSession({
    provider, sessionName, stateDir: fixture.tmp,
    command: `${shellQuote(process.execPath)} ${shellQuote(script)}`,
    allowUnverifiedLauncher: true, cwd: fixture.cwd, timeoutMs: 8000
  });
  assert.equal(started.ready, true);
});

test("timeout and abort kill TERM-resistant descendants after the leader exits", async (t) => {
  if (process.platform !== "linux") return t.skip("checks Linux process state including zombies");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "llm-router-group-kill-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  for (const mode of ["timeout", "abort"]) {
    const pidFile = path.join(directory, `${mode}.pid`);
    const descendant = `process.on('SIGTERM',()=>{});require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`;
    const parent = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});setInterval(()=>{},1000)`;
    const controller = new AbortController();
    const run = runCommand(process.execPath, ["-e", parent], {
      timeoutMs: mode === "timeout" ? 1000 : 10_000,
      killProcessGroup: true, signal: controller.signal
    });
    const rejected = assert.rejects(run, error => mode === "timeout"
      ? error.details.timedOut === true : error.details.code === "ERR_CANCELLED");
    await waitUntil(async () => await fs.access(pidFile).then(() => true, () => false));
    const pid = Number(await fs.readFile(pidFile, "utf8"));
    try {
      if (mode === "abort") controller.abort();
      await rejected;
      await waitUntil(async () => !(await runningLinuxPid(pid)));
      assert.equal(await runningLinuxPid(pid), false);
    } finally {
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
  }
});

test("headless cancellation terminates the provider and releases its concurrency slot", async (t) => {
  await makeFakePath(t);
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm-router-cancel-headless-"));
  const pidFile = path.join(stateDir, "provider.pid");
  const previous = process.env.LLM_ROUTER_TEST_PID_FILE;
  process.env.LLM_ROUTER_TEST_PID_FILE = pidFile;
  t.after(async () => {
    if (previous === undefined) delete process.env.LLM_ROUTER_TEST_PID_FILE;
    else process.env.LLM_ROUTER_TEST_PID_FILE = previous;
    await fs.rm(stateDir, { recursive: true, force: true });
  });
  const controller = new AbortController();
  const rejected = assert.rejects(headlessAsk({
    provider: "claude", markdown: "HANG_HEADLESS", stateDir,
    timeoutMs: 10_000, signal: controller.signal
  }), error => error.details.code === "ERR_CANCELLED");
  await waitUntil(async () => await fs.access(pidFile).then(() => true, () => false));
  controller.abort();
  await rejected;
  const next = await headlessAsk({ provider: "claude", markdown: "after cancellation", stateDir, timeoutMs: 5000 });
  assert.equal(next.success, true);
});

test("cancelled tmux waits preserve active requests and cancellation never kills a reused session", async (t) => {
  const fixture = await makeFixture(t);
  if (!fixture) return;
  const provider = "claude";
  const sessionName = `${fixture.sessionPrefix}-cancel-wait`;
  fixture.trackSession(provider, sessionName);
  const input = await writeInputFile({ provider, markdown: "NO_DONE_MARKER", stateDir: fixture.tmp });
  const sent = await sendInput({
    provider, sessionName, inputPath: input.inputPath, stateDir: fixture.tmp,
    command: fixture.fakeCommand, allowUnverifiedLauncher: true, timeoutMs: 5000
  });
  const controller = new AbortController();
  const rejected = assert.rejects(waitForResponse({
    provider, sessionName, nonce: sent.nonce, stateDir: fixture.tmp,
    signal: controller.signal, timeoutMs: 10_000, pollMs: 50
  }), error => error.details.code === "ERR_CANCELLED");
  setTimeout(() => controller.abort(), 100);
  await rejected;
  const current = await status({ provider, sessionName, stateDir: fixture.tmp });
  assert.equal(current.running, true);
  assert.equal(current.busy, true);
  assert.equal(current.activeRequest.nonce, sent.nonce);
  const reuse = new AbortController();
  const reuseRejected = assert.rejects(ensureSession({
    provider, sessionName, stateDir: fixture.tmp, command: fixture.fakeCommand,
    allowUnverifiedLauncher: true, timeoutMs: 5000, signal: reuse.signal
  }), error => error.details.code === "ERR_CANCELLED");
  setTimeout(() => reuse.abort(), 100);
  await reuseRejected;
  assert.equal(await hasSession({ provider, sessionName, stateDir: fixture.tmp }), true);
});

test("cancelled startup removes only the session created by that request", async (t) => {
  const fixture = await makeFixture(t);
  if (!fixture) return;
  const provider = "claude";
  const sessionName = `${fixture.sessionPrefix}-cancel-start`;
  fixture.trackSession(provider, sessionName);
  const script = path.join(fixture.tmp, "silent.cjs");
  await fs.writeFile(script, "setInterval(() => {}, 1000);\n");
  const controller = new AbortController();
  const rejected = assert.rejects(ensureSession({
    provider, sessionName, stateDir: fixture.tmp,
    command: `${shellQuote(process.execPath)} ${shellQuote(script)}`,
    allowUnverifiedLauncher: true, timeoutMs: 8000, signal: controller.signal
  }), error => error.details.code === "ERR_CANCELLED");
  await waitUntil(() => hasSession({ provider, sessionName, stateDir: fixture.tmp }));
  controller.abort();
  await rejected;
  assert.equal(await hasSession({ provider, sessionName, stateDir: fixture.tmp }), false);
});

async function waitUntil(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail("condition did not become true before timeout");
}

async function runningLinuxPid(pid) {
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
    return !/\) [ZX] /.test(stat);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

test("startup lock contention and readiness share one timeout budget", async (t) => {
  const fixture = await makeFixture(t);
  if (!fixture) return;
  const provider = "claude";
  const sessionName = `${fixture.sessionPrefix}-shared-deadline`;
  fixture.trackSession(provider, sessionName);
  const capacityLock = path.join(fixture.tmp, "sessions", ".capacity-lock");
  await fs.mkdir(capacityLock, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(capacityLock, "owner.json"), JSON.stringify({
    token: "test-capacity-owner", pid: process.pid, kind: "capacity"
  }));
  const release = setTimeout(() => fs.rm(capacityLock, { recursive: true, force: true }), 1100);
  t.after(() => clearTimeout(release));
  const script = path.join(fixture.tmp, "contended.cjs");
  await fs.writeFile(script, "setTimeout(() => console.log('fake ready'), 1400); setInterval(() => {}, 1000);\n");
  await assert.rejects(ensureSession({
    provider, sessionName, stateDir: fixture.tmp,
    command: `${shellQuote(process.execPath)} ${shellQuote(script)}`,
    allowUnverifiedLauncher: true, timeoutMs: 2300
  }), error => ["ERR_PROVIDER_NOT_READY", "ERR_SESSION_START_TIMEOUT"].includes(error.details.code));
  assert.equal(await hasSession({ provider, sessionName, stateDir: fixture.tmp }), false);
});

test("timed-out new-session clients do not orphan created sessions, with or without stdout", async (t) => {
  const fixture = await makeFixture(t);
  if (!fixture) return;
  const tmux = (await runCommand("sh", ["-c", "command -v tmux"])).stdout.trim();
  const shimDir = path.join(fixture.tmp, "shim");
  await fs.mkdir(shimDir);
  const previousPrefix = process.env.LLM_ROUTER_MCP_PATH_PREFIX;
  try {
    for (const { suppressOutput, failProbe } of [
      { suppressOutput: false, failProbe: false },
      { suppressOutput: true, failProbe: false },
      { suppressOutput: true, failProbe: true }
    ]) {
      const shim = `#!/bin/sh
case " $* " in
  ${failProbe ? '*" show-environment "*) echo "injected probe failure" >&2; exit 2 ;;' : ""}
  *" new-session "*)
    ${shellQuote(tmux)} "$@"${suppressOutput ? " >/dev/null" : ""}
    code=$?
    sleep 3
    exit "$code"
    ;;
  *) exec ${shellQuote(tmux)} "$@" ;;
esac
`;
      await fs.writeFile(path.join(shimDir, "tmux"), shim, { mode: 0o755 });
      process.env.LLM_ROUTER_MCP_PATH_PREFIX = shimDir;
      const provider = "claude";
      const sessionName = `${fixture.sessionPrefix}-timeout-create-${failProbe ? "recover" : suppressOutput ? "hidden" : "visible"}`;
      fixture.trackSession(provider, sessionName);
      await assert.rejects(ensureSession({
        provider, sessionName, stateDir: fixture.tmp, command: fixture.fakeCommand,
        allowUnverifiedLauncher: true, cwd: fixture.cwd, timeoutMs: 1000
      }), error => error.details.timedOut === true);
      if (failProbe) {
        assert.equal(await hasSession({ provider, sessionName, stateDir: fixture.tmp }), true);
        const pending = JSON.parse(await fs.readFile(path.join(fixture.tmp, "sessions", provider, `${sessionName}.json`), "utf8"));
        assert.equal(pending.creationUncertain, true);
        if (previousPrefix === undefined) delete process.env.LLM_ROUTER_MCP_PATH_PREFIX;
        else process.env.LLM_ROUTER_MCP_PATH_PREFIX = previousPrefix;
        await killSession({ provider, sessionName, stateDir: fixture.tmp, requireOwned: true });
      }
      assert.equal(await hasSession({ provider, sessionName, stateDir: fixture.tmp }), false);
      await assert.rejects(fs.stat(path.join(fixture.tmp, "sessions", provider, `${sessionName}.json`)),
        { code: "ENOENT" });
    }
  } finally {
    if (previousPrefix === undefined) delete process.env.LLM_ROUTER_MCP_PATH_PREFIX;
    else process.env.LLM_ROUTER_MCP_PATH_PREFIX = previousPrefix;
  }
});

test("queued stop cancellation leaves sessions alive for both launch and capacity locks", async (t) => {
  const fixture = await makeFixture(t);
  if (!fixture) return;
  const provider = "claude";
  const sessionName = `${fixture.sessionPrefix}-cancel-stop`;
  fixture.trackSession(provider, sessionName);
  await ensureSession({
    provider, sessionName, stateDir: fixture.tmp, command: fixture.fakeCommand,
    allowUnverifiedLauncher: true, cwd: fixture.cwd, timeoutMs: 5000
  });
  for (const lockPath of [
    path.join(fixture.tmp, "sessions", "launch-locks", `${sessionName}.launch-lock`),
    path.join(fixture.tmp, "sessions", ".capacity-lock")
  ]) {
    await fs.mkdir(lockPath, { mode: 0o700 });
    await fs.writeFile(path.join(lockPath, "owner.json"), JSON.stringify({
      pid: process.pid, token: "queued-stop-test-lock", kind: "capacity"
    }));
    try {
      const controller = new AbortController();
      const rejected = assert.rejects(killSession({
        provider, sessionName, stateDir: fixture.tmp, requireOwned: true, signal: controller.signal
      }), error => error.details.code === "ERR_CANCELLED");
      await new Promise(resolve => setTimeout(resolve, 100));
      controller.abort();
      // A queued cancellation must settle without waiting for lock release.
      await Promise.race([
        rejected,
        new Promise((_, reject) => {
          const timer = setTimeout(() => reject(new Error("queued cancellation did not settle")), 1000);
          rejected.then(() => clearTimeout(timer), () => clearTimeout(timer));
        })
      ]);
    } finally {
      await fs.rm(lockPath, { recursive: true, force: true });
    }
    assert.equal(await hasSession({ provider, sessionName, stateDir: fixture.tmp }), true);
  }
});

test("uncertain launch metadata cannot authorize stopping an unrelated same-name session", async (t) => {
  const fixture = await makeFixture(t);
  if (!fixture) return;
  const provider = "claude";
  const sessionName = `${fixture.sessionPrefix}-uncertain-owner`;
  fixture.trackSession(provider, sessionName);
  await createStartingSessionArtifact({ fixture, provider, sessionName });
  const metadataPath = path.join(fixture.tmp, "sessions", provider, `${sessionName}.json`);
  const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
  metadata.creationUncertain = true;
  metadata.ownerToken = "not-the-live-session-owner";
  await fs.writeFile(metadataPath, JSON.stringify(metadata));
  await assert.rejects(killSession({ provider, sessionName, stateDir: fixture.tmp, requireOwned: true }),
    error => error.details.code === "ERR_SESSION_NOT_OWNED");
  await assert.rejects(ensureSession({
    provider, sessionName, stateDir: fixture.tmp, command: fixture.fakeCommand,
    allowUnverifiedLauncher: true, cwd: fixture.cwd, timeoutMs: 5000
  }), error => error.details.code === "ERR_SESSION_NOT_OWNED");
  assert.equal(await hasSession({ provider, sessionName, stateDir: fixture.tmp }), true);
});

test("stale pre-creation intent cannot claim another provider's ready session", async (t) => {
  const fixture = await makeFixture(t);
  if (!fixture) return;
  const sessionName = `${fixture.sessionPrefix}-stale-intent`;
  fixture.trackSession("claude", sessionName);
  fixture.trackSession("codex", sessionName);
  await createStartingSessionArtifact({ fixture, provider: "claude", sessionName });
  // Retain only the starting intent, as if its writer had crashed before
  // creating a session; another provider can now legitimately use the name.
  await runCommand("tmux", ["-L", tmuxSocketLabel(fixture.tmp), "-f", "/dev/null", "kill-session", "-t", `=${sessionName}`]);
  await ensureSession({
    provider: "codex", sessionName, stateDir: fixture.tmp, command: fixture.fakeCommand,
    allowUnverifiedLauncher: true, cwd: fixture.cwd, timeoutMs: 5000
  });
  await assert.rejects(ensureSession({
    provider: "claude", sessionName, stateDir: fixture.tmp, command: fixture.fakeCommand,
    allowUnverifiedLauncher: true, cwd: fixture.cwd, timeoutMs: 5000
  }), error => error.details.code === "ERR_SESSION_NOT_OWNED");
  await assert.rejects(killSession({ provider: "claude", sessionName, stateDir: fixture.tmp, requireOwned: true }),
    error => error.details.code === "ERR_SESSION_NOT_OWNED");
  assert.equal((await status({ provider: "codex", sessionName, stateDir: fixture.tmp })).running, true);
});

test("ownership lookup cannot transfer authorization to a same-name replacement", async (t) => {
  const fixture = await makeFixture(t);
  if (!fixture) return;
  const provider = "claude";
  const sessionName = `${fixture.sessionPrefix}-replace-during-auth`;
  const keeperName = `${fixture.sessionPrefix}-keeper`;
  fixture.trackSession(provider, sessionName);
  fixture.trackSession(provider, keeperName);
  await createStartingSessionArtifact({ fixture, provider, sessionName });
  const tmux = (await runCommand("sh", ["-c", "command -v tmux"])).stdout.trim();
  const socket = tmuxSocketLabel(fixture.tmp);
  // Keep the tmux server alive so IDs are never reused during replacement.
  await runCommand(tmux, ["-L", socket, "new-session", "-d", "-s", keeperName, "sleep 30"]);
  const shimDir = path.join(fixture.tmp, "race-shim");
  await fs.mkdir(shimDir);
  const onceFile = path.join(shimDir, "replaced");
  await fs.writeFile(path.join(shimDir, "tmux"), `#!/bin/sh
case " $* " in
  *" show-environment "*)
    ${shellQuote(tmux)} "$@"
    code=$?
    if test ! -f ${shellQuote(onceFile)}; then
      touch ${shellQuote(onceFile)}
      ${shellQuote(tmux)} -L ${shellQuote(socket)} kill-session -t ${shellQuote(`=${sessionName}`)}
      ${shellQuote(tmux)} -L ${shellQuote(socket)} new-session -d -s ${shellQuote(sessionName)} -e LLM_ROUTER_MCP_OWNER=external "sleep 30"
    fi
    exit "$code"
    ;;
  *) exec ${shellQuote(tmux)} "$@" ;;
esac
`, { mode: 0o755 });
  const previousPrefix = process.env.LLM_ROUTER_MCP_PATH_PREFIX;
  process.env.LLM_ROUTER_MCP_PATH_PREFIX = shimDir;
  try {
    await assert.rejects(killSession({ provider, sessionName, stateDir: fixture.tmp, requireOwned: true }),
      error => ["ERR_SESSION_STOP_FAILED", "ERR_SESSION_NOT_OWNED"].includes(error.details.code));
    assert.equal(await hasSession({ provider, sessionName, stateDir: fixture.tmp }), true);
    const replacement = await runCommand(tmux, ["-L", socket, "show-environment", "-t", `=${sessionName}`, "LLM_ROUTER_MCP_OWNER"]);
    assert.equal(replacement.stdout.trim(), "LLM_ROUTER_MCP_OWNER=external");
  } finally {
    if (previousPrefix === undefined) delete process.env.LLM_ROUTER_MCP_PATH_PREFIX;
    else process.env.LLM_ROUTER_MCP_PATH_PREFIX = previousPrefix;
  }
});
