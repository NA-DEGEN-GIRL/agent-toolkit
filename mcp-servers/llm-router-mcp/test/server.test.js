import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { killSession, runCommand } from "../src/core.js";
import { loadPackageVersion } from "../src/server.js";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = path.dirname(TEST_DIR);
const SERVER_ENTRYPOINT = path.join(PACKAGE_DIR, "bin", "llm-router-mcp.js");
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

test("server version is derived from the package manifest", async () => {
  const manifest = JSON.parse(
    await fs.readFile(new URL("../package.json", import.meta.url), "utf8")
  );
  assert.equal(await loadPackageVersion(), manifest.version);
});

test("stdio MCP server exposes the unified LLM router tools", async () => {
  const client = new Client({
    name: "llm-router-mcp-test-client",
    version: "0.0.0"
  });
  const transport = new StdioClientTransport({
    command: "node",
    args: [SERVER_ENTRYPOINT],
    cwd: PACKAGE_DIR,
    stderr: "pipe"
  });

  try {
    await client.connect(transport);
    const result = await client.listTools();
    const names = result.tools.map((tool) => tool.name).sort();

    assert.deepEqual(names, [
      "llm_headless_ask",
      "llm_list_providers",
      "llm_provider_doctor",
      "llm_tmux_ask",
      "llm_tmux_capture",
      "llm_tmux_send",
      "llm_tmux_start",
      "llm_tmux_status",
      "llm_tmux_stop",
      "llm_tmux_wait",
      "llm_tmux_wait_start",
      "llm_write_input"
    ]);
    const startTool = result.tools.find((tool) => tool.name === "llm_tmux_start");
    assert.equal(Object.hasOwn(startTool.inputSchema.properties, "command"), false);
    assert.equal(Object.hasOwn(startTool.inputSchema.properties, "stateDir"), false);
    const capture = await client.callTool({
      name: "llm_tmux_capture",
      arguments: { provider: "claude" }
    });
    assert.equal(capture.isError, true);
    assert.match(capture.content[0].text, /raw pane capture is disabled/);
  } finally {
    await client.close();
  }
});

test("stdio MCP server can ask a provider through a tmux-backed fake session", async (t) => {
  if (!(await requireTmux(t))) {
    return;
  }
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "llm-router-mcp-stdio-"));
  const fakeClaude = path.join(tmp, "claude");
  await fs.copyFile(FAKE_LLM, fakeClaude);
  await fs.chmod(fakeClaude, 0o755);
  const sessionName = `lrm-stdio-${process.pid}-${Date.now()}`;
  t.after(async () => {
    await killSession({ provider: "claude", sessionName, stateDir: tmp });
    await fs.rm(tmp, { recursive: true, force: true });
  });

  const client = new Client({
    name: "llm-router-mcp-test-client",
    version: "0.0.0"
  });
  const transport = new StdioClientTransport({
    command: "node",
    args: [SERVER_ENTRYPOINT],
    cwd: PACKAGE_DIR,
    env: {
      ...process.env,
      LLM_ROUTER_MCP_STATE_DIR: tmp,
      LLM_ROUTER_MCP_READY_SETTLE_MS: "250",
      LLM_ROUTER_MCP_PATH_PREFIX: tmp
    },
    stderr: "pipe"
  });

  try {
    await client.connect(transport);
    const written = parseToolResult(
      await client.callTool({
        name: "llm_write_input",
        arguments: {
          provider: "claude",
          markdown: "End-to-end MCP request.",
          filename: "stdio.md"
        }
      })
    );

    const asked = parseToolResult(
      await client.callTool({
        name: "llm_tmux_ask",
        arguments: {
          provider: "claude",
          inputPath: written.inputPath,
          sessionName,
          timeoutMs: 5000,
          pollMs: 50
        }
      })
    );

    assert.equal(asked.completed, true);
    assert.equal(asked.timedOut, false);
    assert.equal(asked.transport, "markdown-file-v2");
    assert.match(asked.answer, /fake tmux/);
    assert.match(asked.responsePath, /\/response\.md$/);
    assert.match(await fs.readFile(asked.responsePath, "utf8"), /fake tmux/);
  } finally {
    await client.close();
  }
});

function parseToolResult(result) {
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, "text");
  return JSON.parse(result.content[0].text);
}


test("MCP cancellation reaches headless subprocesses and releases the provider slot", async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "llm-router-mcp-cancel-"));
  const pidFile = path.join(tmp, "provider.pid");
  const fakeClaude = path.join(tmp, "claude");
  await fs.copyFile(FAKE_LLM, fakeClaude);
  await fs.chmod(fakeClaude, 0o755);
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const client = new Client({ name: "cancellation-test", version: "0.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath, args: [SERVER_ENTRYPOINT], cwd: PACKAGE_DIR, stderr: "pipe",
    env: {
      ...process.env,
      LLM_ROUTER_MCP_STATE_DIR: tmp,
      LLM_ROUTER_MCP_PATH_PREFIX: tmp,
      LLM_ROUTER_MCP_CLAUDE_EXECUTABLE: "",
      LLM_ROUTER_TEST_PID_FILE: pidFile
    }
  });
  let pid;
  try {
    await client.connect(transport);
    const controller = new AbortController();
    const rejected = assert.rejects(client.callTool({
      name: "llm_headless_ask",
      arguments: { provider: "claude", markdown: "HANG_HEADLESS", timeoutMs: 15_000 }
    }, undefined, { signal: controller.signal }));
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try { pid = Number(await fs.readFile(pidFile, "utf8")); break; }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.ok(pid, "fake provider should have started before cancellation");
    controller.abort();
    await rejected;
    let response;
    const cleanupDeadline = Date.now() + 4000;
    while (Date.now() < cleanupDeadline) {
      response = await client.callTool({
        name: "llm_headless_ask", arguments: { provider: "claude", markdown: "after MCP cancellation", timeoutMs: 5000 }
      });
      if (!response.isError) break;
      assert.match(response.content[0].text, /concurrency limit/);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(response.isError, undefined);
    assert.equal(parseToolResult(response).success, true);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally {
    if (pid) try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    await client.close();
  }
});
