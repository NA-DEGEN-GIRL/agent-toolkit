import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  LauncherConfigError,
  detectShebangWrapper,
  normalizeLauncherArgs,
  parseBaseArgs,
  resolveLauncher,
  resolveProviderModel
} from "../src/launcher.js";

test("model precedence is request, provider environment, then CLI default", () => {
  assert.deepEqual(
    resolveProviderModel("codex", "requested-model", {
      LLM_ROUTER_MCP_CODEX_MODEL: "environment-model"
    }),
    { model: "requested-model", modelSource: "request" }
  );
  assert.deepEqual(
    resolveProviderModel("claude", undefined, {
      LLM_ROUTER_MCP_CLAUDE_MODEL: "sonnet"
    }),
    { model: "sonnet", modelSource: "environment" }
  );

  for (const provider of ["codex", "claude", "grok", "antigravity"]) {
    assert.deepEqual(resolveProviderModel(provider, undefined, {}), {
      model: "",
      modelSource: "cli-default"
    });
  }
});

test("BASE_ARGS accepts only a JSON array of strings", () => {
  assert.deepEqual(
    parseBaseArgs("grok", {
      LLM_ROUTER_MCP_GROK_BASE_ARGS: '["--no-alt-screen","--no-memory"]'
    }),
    ["--no-alt-screen", "--no-memory"]
  );
  assert.throws(
    () =>
      parseBaseArgs("grok", {
        LLM_ROUTER_MCP_GROK_BASE_ARGS: "--no-alt-screen"
      }),
    LauncherConfigError
  );
  assert.throws(
    () =>
      parseBaseArgs("grok", {
        LLM_ROUTER_MCP_GROK_BASE_ARGS: '["--no-alt-screen",42]'
      }),
    LauncherConfigError
  );

  assert.throws(
    () =>
      parseBaseArgs("codex", {
        LLM_ROUTER_MCP_CODEX_BASE_ARGS: '["--model","configured-model"]'
      }),
    /must not contain --model/
  );
  assert.throws(
    () =>
      parseBaseArgs("codex", {
        LLM_ROUTER_MCP_CODEX_BASE_ARGS: '["--model"]'
      }),
    /must not contain --model/
  );
  assert.throws(
    () =>
      parseBaseArgs("codex", {
        LLM_ROUTER_MCP_CODEX_BASE_ARGS: '["--sandbox"]'
      }),
    /requires a value/
  );
});

test("BASE_ARGS cannot consume a mode argument as a missing option value", async () => {
  await assert.rejects(
    resolveLauncher("codex", {
      mode: "headless",
      modeArgs: ["exec"],
      environment: {
        PATH: "",
        LLM_ROUTER_MCP_CODEX_BASE_ARGS: '["--model"]'
      },
      inspectWrapper: false
    }),
    /must not contain --model/
  );

  await assert.rejects(
    resolveLauncher("codex", {
      mode: "headless",
      modeArgs: ["--sandbox"],
      environment: { PATH: "" },
      inspectWrapper: false
    }),
    /modeArgs option --sandbox requires a value/
  );
});

test("router permission policy replaces semantic duplicates and conflicts", () => {
  assert.deepEqual(
    normalizeLauncherArgs(
      "codex",
      [
        "--ask-for-approval",
        "on-request",
        "--sandbox=read-only",
        "--dangerously-bypass-approvals-and-sandbox",
        "exec"
      ],
      { model: "codex-current", permissionSource: "router" }
    ),
    {
      args: [
        "--dangerously-bypass-approvals-and-sandbox",
        "-m",
        "codex-current",
        "exec"
      ],
      bypassSource: "router",
      bypassVerified: true
    }
  );

  assert.deepEqual(
    normalizeLauncherArgs(
      "claude",
      ["--permission-mode", "dontAsk", "--dangerously-skip-permissions", "-p"],
      { permissionSource: "router" }
    ).args,
    ["--dangerously-skip-permissions", "-p"]
  );

  assert.deepEqual(
    normalizeLauncherArgs(
      "grok",
      [
        "--always-approve",
        "--always-approve",
        "--permission-mode",
        "dontAsk",
        "--permission-mode=bypassPermissions",
        "--sandbox",
        "strict",
        "--no-memory"
      ],
      { permissionSource: "router" }
    ).args,
    [
      "--always-approve",
      "--permission-mode",
      "bypassPermissions",
      "--sandbox",
      "off",
      "--no-memory"
    ]
  );

  assert.deepEqual(
    normalizeLauncherArgs(
      "antigravity",
      ["--sandbox", "--dangerously-skip-permissions", "--model", "old"],
      { model: "new", permissionSource: "router" }
    ).args,
    ["--dangerously-skip-permissions", "--model", "new"]
  );
});

test("shebang wrapper detection ignores comments and recognizes literal bypass flags", () => {
  const commentOnly = detectShebangWrapper(
    "grok",
    `#!/usr/bin/env bash
# --always-approve --permission-mode bypassPermissions
exec grok-real "$@"
`
  );
  assert.deepEqual(commentOnly.provided, []);

  const grok = detectShebangWrapper(
    "grok",
    `#!/usr/bin/env bash
exec grok-real --always-approve --permission-mode=bypassPermissions "$@"
`
  );
  assert.equal(grok.wrapper, true);
  assert.deepEqual(new Set(grok.provided), new Set(["grok:approve", "grok:bypass"]));
  assert.deepEqual(grok.conflicts, []);

  const conflicting = detectShebangWrapper(
    "grok",
    `#!/usr/bin/env bash
exec grok-real --permission-mode dontAsk "$@"
`
  );
  assert.deepEqual(conflicting.conflicts, ["--permission-mode=dontAsk"]);

  const sandboxed = detectShebangWrapper(
    "grok",
    `#!/usr/bin/env bash
exec grok-real --always-approve --permission-mode bypassPermissions --sandbox strict "$@"
`
  );
  assert.deepEqual(sandboxed.conflicts, ["--sandbox=strict"]);

  assert.deepEqual(
    detectShebangWrapper(
      "antigravity",
      `#!/bin/sh
exec agy-real --dangerously-skip-permissions "$@"
`
    ).provided,
    ["antigravity:bypass"]
  );

  const falsePositive = detectShebangWrapper(
    "claude",
    `#!/bin/sh
exec env NOTE="--dangerously-skip-permissions" claude-real "$@"
`
  );
  assert.equal(falsePositive.wrapper, false);
  assert.deepEqual(falsePositive.provided, []);

  const falseBoolean = detectShebangWrapper(
    "claude",
    `#!/bin/sh
exec claude-real --dangerously-skip-permissions=false "$@"
`
  );
  assert.deepEqual(falseBoolean.provided, []);
  assert.deepEqual(falseBoolean.unsupportedArgs, ["--dangerously-skip-permissions=false"]);

  const pinnedModel = detectShebangWrapper(
    "claude",
    `#!/bin/sh
exec claude-real --dangerously-skip-permissions --model sonnet "$@"
`
  );
  assert.deepEqual(pinnedModel.modelOptions, ["sonnet"]);

  const missingModelValue = detectShebangWrapper(
    "claude",
    `#!/bin/sh
exec claude-real --dangerously-skip-permissions --model "$@"
`
  );
  assert.deepEqual(missingModelValue.unsupportedArgs, ["--model"]);

  const nodeCli = detectShebangWrapper(
    "claude",
    `#!/usr/bin/env node
console.log("--dangerously-skip-permissions");
`
  );
  assert.equal(nodeCli.opaqueWrapper, false);
  assert.equal(nodeCli.wrapper, false);

  for (const forwarding of ["'$@'", "$@"]) {
    const unsafeForwarding = detectShebangWrapper(
      "claude",
      `#!/bin/sh\nexec claude-real --dangerously-skip-permissions ${forwarding}\n`
    );
    assert.equal(unsafeForwarding.wrapper, false);
    assert.equal(unsafeForwarding.opaqueWrapper, true);
  }

  for (const shebang of ["#!/bin/ash", "#!/usr/bin/busybox sh"]) {
    const alternateShell = detectShebangWrapper(
      "claude",
      `${shebang}\nexec /bin/true\n`
    );
    assert.equal(alternateShell.opaqueWrapper, true);
  }
});

test("auto and router modes reject opaque shell wrappers", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "llm-router-launcher-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  await writeExecutable(
    path.join(directory, "claude-ignores-argv"),
    `#!/bin/sh
exec /bin/true
`
  );
  await assert.rejects(
    resolveLauncher("claude", {
      environment: {
        PATH: directory,
        LLM_ROUTER_MCP_CLAUDE_EXECUTABLE: "claude-ignores-argv"
      }
    }),
    /opaque shell wrapper/
  );

  await writeExecutable(
    path.join(directory, "claude-literal-argv"),
    `#!/bin/sh
exec /bin/true --dangerously-skip-permissions '$@'
`
  );
  await assert.rejects(
    resolveLauncher("claude", {
      environment: {
        PATH: directory,
        LLM_ROUTER_MCP_CLAUDE_EXECUTABLE: "claude-literal-argv"
      }
    }),
    /opaque shell wrapper/
  );

  await writeExecutable(
    path.join(directory, "claude-two-lines"),
    `#!/usr/bin/env bash
echo starting >&2
exec /bin/true --dangerously-skip-permissions "$@"
`
  );
  await assert.rejects(
    resolveLauncher("claude", {
      environment: {
        PATH: directory,
        LLM_ROUTER_MCP_CLAUDE_EXECUTABLE: "claude-two-lines",
        LLM_ROUTER_MCP_CLAUDE_PERMISSION_SOURCE: "router"
      }
    }),
    /opaque shell wrapper/
  );
});

test("auto mode rejects model flags hidden inside wrappers", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "llm-router-launcher-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await writeExecutable(
    path.join(directory, "claude"),
    `#!/usr/bin/env bash
exec /bin/true --dangerously-skip-permissions --model sonnet "$@"
`
  );
  await assert.rejects(
    resolveLauncher("claude", {
      mode: "tmux",
      requestedModel: "opus",
      environment: { PATH: directory }
    }),
    /contains a model flag/
  );
});

test("auto mode trusts a verified wrapper and strips duplicate outer flags", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "llm-router-launcher-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await writeExecutable(
    path.join(directory, "grok"),
    `#!/usr/bin/env bash
exec /bin/true --always-approve --permission-mode bypassPermissions "$@"
`
  );

  const resolved = await resolveLauncher("grok", {
    mode: "headless",
    requestedModel: "grok-current",
    modeArgs: [
      "--prompt-file",
      "request.md",
      "--permission-mode",
      "dontAsk",
      "--always-approve",
      "--no-memory"
    ],
    environment: {
      PATH: directory,
      LLM_ROUTER_MCP_GROK_BASE_ARGS: '["--no-alt-screen"]'
    }
  });

  assert.deepEqual(resolved, {
    command: "grok",
    args: [
      "--sandbox",
      "off",
      "-m",
      "grok-current",
      "--no-alt-screen",
      "--prompt-file",
      "request.md",
      "--no-memory"
    ],
    model: "grok-current",
    modelSource: "request",
    bypassSource: "router+launcher",
    bypassVerified: true,
    opaqueWrapper: false,
    wrapperFingerprints: resolved.wrapperFingerprints
  });
  assert.equal(resolved.wrapperFingerprints.length, 2);
});

test("auto mode injects bypass for a raw executable and shares BASE_ARGS across modes", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "llm-router-launcher-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await writeExecutable(
    path.join(directory, "claude"),
    "#!/usr/bin/env node\nprocess.exit(0);\n"
  );

  const environment = {
    PATH: directory,
    LLM_ROUTER_MCP_CLAUDE_BASE_ARGS: '["--allowedTools","Read"]',
    LLM_ROUTER_MCP_CLAUDE_MODEL: "sonnet"
  };
  const tmux = await resolveLauncher("claude", {
    mode: "tmux",
    modeArgs: ["--no-chrome"],
    environment
  });
  const headless = await resolveLauncher("claude", {
    mode: "headless",
    modeArgs: ["-p", "--output-format", "text"],
    environment
  });

  assert.equal(tmux.command, "claude");
  assert.equal(headless.command, "claude");
  assert.deepEqual(tmux.args.slice(0, 5), [
    "--dangerously-skip-permissions",
    "--model",
    "sonnet",
    "--allowedTools",
    "Read"
  ]);
  assert.deepEqual(headless.args.slice(0, 5), tmux.args.slice(0, 5));
  assert.equal(tmux.modelSource, "environment");
  assert.equal(headless.bypassSource, "router");
  assert.equal(headless.bypassVerified, true);
});

test("explicitly configured non-shell scripts fail closed as opaque wrappers", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "llm-router-launcher-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await writeExecutable(
    path.join(directory, "custom-claude"),
    "#!/usr/bin/env node\nprocess.exit(0);\n"
  );
  await assert.rejects(
    resolveLauncher("claude", {
      environment: {
        PATH: directory,
        LLM_ROUTER_MCP_CLAUDE_EXECUTABLE: "custom-claude"
      }
    }),
    /explicitly configured script/
  );
});

test("explicit launcher source can be unverified without injecting duplicate flags", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "llm-router-launcher-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await writeExecutable(path.join(directory, "managed-claude"), "#!/bin/sh\nexit 0\n");

  const resolved = await resolveLauncher("claude", {
    mode: "headless",
    modeArgs: ["--dangerously-skip-permissions", "-p"],
    environment: {
      PATH: directory,
      LLM_ROUTER_MCP_CLAUDE_EXECUTABLE: "managed-claude",
      LLM_ROUTER_MCP_CLAUDE_PERMISSION_SOURCE: "launcher"
    }
  });

  assert.deepEqual(resolved.args, ["-p"]);
  assert.equal(resolved.bypassSource, "launcher");
  assert.equal(resolved.bypassVerified, false);
  assert.equal(resolved.opaqueWrapper, true);
});

test("router source refuses a detected bypass wrapper instead of creating duplicate flags", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "llm-router-launcher-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await writeExecutable(
    path.join(directory, "grok"),
    `#!/bin/sh
exec /bin/true --always-approve --permission-mode bypassPermissions "$@"
`
  );

  await assert.rejects(
    resolveLauncher("grok", {
      environment: {
        PATH: directory,
        LLM_ROUTER_MCP_GROK_PERMISSION_SOURCE: "router"
      }
    }),
    /would duplicate/
  );
});

test("legacy CMD remains an opaque, unverified tmux-only escape hatch", async () => {
  const environment = {
    PATH: "",
    LLM_ROUTER_MCP_CODEX_CMD: "custom-codex --custom-policy",
    LLM_ROUTER_MCP_CODEX_MODEL: "configured-model"
  };
  const tmux = await resolveLauncher("codex", { mode: "tmux", environment });
  assert.deepEqual(tmux, {
    command: "codex",
    args: [],
    model: "configured-model",
    modelSource: "environment",
    bypassSource: "legacy-command",
    bypassVerified: false,
    legacyCommand: "custom-codex --custom-policy"
  });

  const headless = await resolveLauncher("codex", { mode: "headless", environment });
  assert.equal(Object.hasOwn(headless, "legacyCommand"), false);
  assert.deepEqual(headless.args, ["--dangerously-bypass-approvals-and-sandbox", "-m", "configured-model"]);
});

test("Antigravity supports requested model selection in structured argv", async () => {
  const resolved = await resolveLauncher("agy", {
    mode: "headless",
    requestedModel: "gemini-current",
    modeArgs: ["--print", "--print-timeout", "5m"],
    environment: { PATH: "" },
    inspectWrapper: false
  });
  assert.deepEqual(resolved.args, [
    "--dangerously-skip-permissions",
    "--model",
    "gemini-current",
    "--print",
    "--print-timeout",
    "5m"
  ]);
});

async function writeExecutable(filename, contents) {
  await fs.writeFile(filename, contents, { mode: 0o755 });
  await fs.chmod(filename, 0o755);
}

test("wrapper chains reject opaque targets, script targets, cycles, and hidden models", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "llm-router-chain-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const outer = path.join(directory, "outer");
  const inner = path.join(directory, "inner");
  await writeExecutable(outer, `#!/bin/sh\nexec ${inner} "$@"\n`);
  const environment = { PATH: directory, LLM_ROUTER_MCP_CLAUDE_EXECUTABLE: outer };
  for (const source of [
    "#!/bin/sh\nprintf 'args discarded\\n'\n",
    "#!/usr/bin/env node\nprocess.exit(0);\n",
    `#!/bin/sh\nexec ${outer} "$@"\n`,
    '#!/bin/sh\nexec /bin/true --model hidden "$@"\n'
  ]) {
    await writeExecutable(inner, source);
    await assert.rejects(resolveLauncher("claude", { environment }), /opaque|contains a model flag/);
  }
  await writeExecutable(inner, '#!/bin/sh\nexec /bin/true "$@"\n');
  const before = await resolveLauncher("claude", { environment });
  assert.equal(before.bypassVerified, true);
  assert.equal(before.wrapperFingerprints.length, 3);
  await writeExecutable(inner, '#!/bin/sh\n# updated target wrapper\nexec /bin/true "$@"\n');
  const after = await resolveLauncher("claude", { environment });
  assert.notDeepEqual(after.wrapperFingerprints, before.wrapperFingerprints);
});

test("oversized shell wrapper inspection never trusts a truncated prefix", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "llm-router-large-wrapper-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const wrapper = path.join(directory, "claude");
  await writeExecutable(wrapper, '#!/bin/sh\nexec /bin/true "$@"\n' + "#".repeat(70_000) + "\necho hidden\n");
  await assert.rejects(resolveLauncher("claude", {
    environment: { PATH: directory, LLM_ROUTER_MCP_CLAUDE_EXECUTABLE: wrapper }
  }), /opaque/);
});

test("large default provider CLI scripts remain trusted entrypoints, not verified custom wrappers", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "llm-router-default-script-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const cli = path.join(directory, "claude");
  await writeExecutable(cli, '#!/usr/bin/env node\n//' + "x".repeat(70_000) + "\nprocess.exit(0);\n");
  const normal = await resolveLauncher("claude", { environment: { PATH: directory } });
  assert.equal(normal.bypassVerified, true);
  await assert.rejects(resolveLauncher("claude", {
    environment: { PATH: directory, LLM_ROUTER_MCP_CLAUDE_EXECUTABLE: cli }
  }), /explicitly configured script/);
});
