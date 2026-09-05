# llm-router-mcp

Local stdio MCP server for asking Codex, Claude, Grok, and Antigravity (`agy`)
through either persistent `tmux` sessions or isolated headless calls. This
package is maintained under `mcp-servers/llm-router-mcp/` in
[`agent-toolkit`](https://github.com/NA-DEGEN-GIRL/agent-toolkit).

| Workflow | Use it when | Main tool |
| --- | --- | --- |
| Persistent session | The provider should retain multi-turn context. | `llm_tmux_ask` |
| Headless one-shot | The answer should not enter persistent context. | `llm_headless_ask` |
| Split send/wait | Start a long request and wait separately. | `llm_tmux_send` + `llm_tmux_wait` |

## Important defaults

- **Full provider bypass is required.** The router injects each provider's
  documented non-interactive bypass argv and conservatively verifies supported
  wrappers. It fails closed when an opaque launcher cannot be verified.
- **Models are not pinned.** Selection order is per-call `model`, provider
  `LLM_ROUTER_MCP_<PROVIDER>_MODEL`, then the provider CLI's own configuration
  or default. Claude therefore does not default to `sonnet`; configure your
  Claude CLI for the desired Opus model or set the optional environment
  override to `opus`.
- **Persistent prompts use Markdown file transport.** The router sends one
  short file-reference line to the TUI instead of pasting multiline Markdown.
- **tmux is isolated.** Router sessions use a dedicated `tmux -L` socket and do
  not reuse same-named sessions from the user's normal tmux server.
- **Runtime artifacts are private.** Managed directories are hardened to
  `0700`; managed files are `0600`; symlink and repeated-request collisions are
  rejected.

Full bypass lets provider CLIs act with the OS account's permissions. Only run
this server for a trusted local MCP client on a machine where that is intended.

## Requirements and validation

- Node.js 20+
- `tmux` with `new-session -e`, `-P`, and `-F` support
- Desired provider CLIs installed and logged in: `codex`, `claude`, `grok`,
  and/or `agy`

```bash
git clone https://github.com/NA-DEGEN-GIRL/agent-toolkit.git "$HOME/agent-toolkit"
cd "$HOME/agent-toolkit/mcp-servers/llm-router-mcp"
npm ci
npm test
```

Tests use fake providers and make no real model calls.

## MCP configuration

Codex example:

```toml
[mcp_servers.llm-router]
command = "node"
args = ["/absolute/path/to/agent-toolkit/mcp-servers/llm-router-mcp/bin/llm-router-mcp.js"]

[mcp_servers.llm-router.env]
LLM_ROUTER_MCP_STATE_DIR = "/home/USER/.local/state/llm-router-mcp"
# Optional: prefer Claude's rolling Opus alias (when supported by the installed CLI/account).
# LLM_ROUTER_MCP_CLAUDE_MODEL = "opus"
```

JSON-style clients:

```json
{
  "mcpServers": {
    "llm-router": {
      "command": "node",
      "args": ["/absolute/path/to/agent-toolkit/mcp-servers/llm-router-mcp/bin/llm-router-mcp.js"],
      "env": {
        "LLM_ROUTER_MCP_STATE_DIR": "/home/USER/.local/state/llm-router-mcp"
      }
    }
  }
}
```

Use absolute paths. Some MCP clients do not expand `~` or `$HOME`. Restart the
client after changing its MCP configuration.

## Tools

| Tool | Purpose |
| --- | --- |
| `llm_list_providers` | List providers, aliases, model policy, and bypass requirements. |
| `llm_provider_doctor` | Resolve executables and report versions, model source, bypass source, and tmux isolation without making a model request. |
| `llm_write_input` | Create a managed Markdown input and return its path. |
| `llm_headless_ask` | Run one provider once using exactly one of `markdown` or managed `inputPath`. |
| `llm_tmux_start` | Create or compatibly reuse a persistent provider session. |
| `llm_tmux_ask` | Send a managed Markdown request and wait for its response. |
| `llm_tmux_send` | Send a request and return its nonce/request ID. |
| `llm_tmux_wait_start` | Wait for file completion or the fallback start marker. |
| `llm_tmux_wait` | Read the completed file transaction; pane markers are diagnostic by default. |
| `llm_tmux_status` | Report session, busy, marker, and file-transaction status. |
| `llm_tmux_capture` | Opt-in raw capture for a router-owned pane (`LLM_ROUTER_MCP_ENABLE_DEBUG_TOOLS=1`). |
| `llm_tmux_stop` | Stop a router session and clear its launch metadata/busy lock. |

Raw `command` and per-call `stateDir` overrides are intentionally not exposed
by the MCP tools. A per-call `cwd` override requires the explicit server
environment opt-in `LLM_ROUTER_MCP_ALLOW_CWD_OVERRIDE=1`.

## Examples

Headless request:

```text
llm_headless_ask(
  provider="grok",
  markdown="# Review\n\nGive a second opinion on this API."
)
```

Persistent request:

```text
llm_write_input(
  provider="claude",
  filename="design-review.md",
  markdown="# Design Review\n\nReview this plan..."
)

llm_tmux_ask(
  provider="claude",
  inputPath="/managed/path/returned/above/design-review.md"
)
```

Explicit model override:

```text
llm_headless_ask(provider="claude", model="opus", markdown="# Task\n\n...")
```

When `model` is omitted, the Claude CLI decides. This is the recommended way
to follow an account's configured/default model without hardcoding an exact,
quickly stale model ID.

## Provider launch policy

| Provider | CLI default model when omitted | Required bypass |
| --- | --- | --- |
| Codex | Codex CLI config/default | `--dangerously-bypass-approvals-and-sandbox` |
| Claude | Claude CLI config/default | `--dangerously-skip-permissions` |
| Grok | Grok CLI config/default | `--always-approve --permission-mode bypassPermissions --sandbox off` |
| Antigravity | `agy` config/default | `--dangerously-skip-permissions` |

Antigravity model selection is supported with `--model` when an explicit model
is requested.

### Wrappers and aliases

Interactive shell aliases/functions are not expanded by the router and should
not be relied on. An alias that already appends bypass flags is therefore not
run or duplicated; the router resolves the executable and applies its own
policy. Executable wrappers are supported conservatively:

- strict one-line shell wrappers of the form `exec <binary> <literal-args> "$@"`
  are inspected recursively (at most 8 files), with cycle detection and
  fingerprints for every target; use literal executable paths, not `$HOME`
  interpolation;
- chains ending in a native binary are supported; opaque, missing, oversized,
  cyclic, or custom Node/Python script targets fail closed, including when hidden
  behind a strict outer wrapper. To use a provider's official script entrypoint,
  prefer its default CLI name rather than a custom script wrapper;
- opaque/multi-command shell wrappers and explicitly configured Node/Python or
  other non-shell scripts fail closed because they may ignore or rewrite
  router-supplied arguments; using one requires both
  `PERMISSION_SOURCE=launcher` and the explicit unverified-launcher opt-in;
- structured permission/model duplicates are normalized;
- model flags or unsupported fixed arguments hidden inside wrappers are rejected
  and model selection must be moved to the provider `MODEL` setting;
- conflicting permission modes are replaced or rejected;
- the same structured executable and base arguments are used for tmux and
  headless modes.

Default provider executable names are treated as the installed official CLI
entrypoints. A custom `EXECUTABLE` native binary is trusted as local
configuration, while a custom script must use the strict shell form above to be
verified.

Configuration keys use the provider names `CODEX`, `CLAUDE`, `GROK`, and
`ANTIGRAVITY`:

```text
LLM_ROUTER_MCP_<PROVIDER>_EXECUTABLE=/absolute/path/to/wrapper
LLM_ROUTER_MCP_<PROVIDER>_BASE_ARGS=["--flag","value"]
LLM_ROUTER_MCP_<PROVIDER>_PERMISSION_SOURCE=auto|router|launcher
LLM_ROUTER_MCP_<PROVIDER>_MODEL=provider-model-or-alias
LLM_ROUTER_MCP_<PROVIDER>_CWD=/default/provider/workdir
LLM_ROUTER_MCP_TMUX_SOCKET_LABEL=optional-stable-label
```

`BASE_ARGS` must be a JSON array of strings. Model flags are rejected there;
use `LLM_ROUTER_MCP_<PROVIDER>_MODEL` so precedence remains unambiguous. Known
options that take a value are also validated before transport-specific arguments
are appended. `auto` is recommended. The old
`LLM_ROUTER_MCP_<PROVIDER>_CMD` string is a tmux-only opaque escape hatch and
is rejected by the full-bypass invariant unless the server is deliberately
started with `LLM_ROUTER_MCP_ALLOW_UNVERIFIED_LAUNCHER=1`.

Run `llm_provider_doctor` after changing a launcher.

## Markdown file transaction v2

For each persistent request the router creates:

```text
requests/<provider>/<request-id>/
├── request.md
├── metadata.json
├── response.md       # written by the provider
└── done.json         # written last
```

Only this single-line instruction is typed into tmux:

```text
Read and follow the complete llm-router-mcp Markdown request at: /absolute/path/request.md
```

`done.json` identifies the provider, nonce, and request ID. The router validates
all of them before accepting `response.md`. Pane start/done markers remain
diagnostic by default. Legacy pane completion can be explicitly enabled with
`LLM_ROUTER_MCP_ENABLE_PANE_FALLBACK=1`, but file completion is safer.

Requests are serialized per session with a filesystem lock. A timeout keeps
the session busy because the provider may still be working; call
`llm_tmux_wait` again or use `llm_tmux_stop` to abandon/reset it. A changed
model, launcher, cwd, bypass policy, or terminal specification is never silently
applied to an existing session: stop the session first.

### Cancellation and upgrades

MCP cancellation terminates headless process groups with TERM then KILL and
retains their concurrency slots until cleanup finishes. Cancelling a tmux wait
stops only the wait: it does not abandon the running provider or clear its busy
lock. Retry `llm_tmux_wait`, or explicitly stop the session. If a send/ask was
cancelled after dispatch and its result was lost, `llm_tmux_status.activeRequest`
returns the nonce/request ID needed to resume waiting.

A creation-time tmux owner token permits recovery even if the `new-session`
client times out or loses its stdout after creating the session. Failed cleanup
retains uncertain launch metadata; automatic recovery/stop requires the actual
session token to match, not just a same-named session. This check applies to all
interrupted starts, including crashes before creation. Legacy starting records
without a matching creation-time token fail closed rather than claiming sessions.

Startup cancellation removes only a session created by that startup attempt;
reusing an existing session never gives cancellation permission to kill it.
A queued stop remains cancellable until the kill is submitted.
Once tmux dispatch starts, delivery and its busy-lock bookkeeping finish as a
unit even if the MCP caller cancels. A stop already in progress likewise finishes
its cleanup rather than leaving partially removed state.

Session names share one lock namespace across providers. Before upgrading,
stop router sessions and restart **all** MCP server processes sharing the state
root; do not run old and new versions together, because the lock layout changed.

## Runtime state and security

State resolution order is:

1. `LLM_ROUTER_MCP_STATE_DIR`
2. absolute `XDG_STATE_HOME/llm-router-mcp`
3. `~/.local/state/llm-router-mcp`

The state includes `inputs/`, `requests/`, `sessions/`, and provider scratch
`workdirs/`. It can contain private prompts and responses; do not commit or
share it.

By default, `inputPath` must resolve inside the managed state tree. Prefer
`llm_write_input` or the inline `markdown` argument. External Markdown paths
require the deliberate server opt-in
`LLM_ROUTER_MCP_ALLOW_EXTERNAL_INPUT=1`.

Additional boundaries:

- session names allow only letters, numbers, `_`, and `-`;
- the state-root path rejects control characters so the tmux file reference
  remains exactly one line;
- router sessions live on a state-specific `tmux -L
  llm-router-<uid>-<state-hash>` socket started with `/dev/null` tmux config;
- request IDs and files are created exclusively, with symlinks rejected;
- command output, Markdown/JSON size, dimensions, capture length, and timeouts
  are bounded;
- persistent sessions default to at most 8, while headless calls per MCP server
  process default to 2 total and 1 per provider (`LLM_ROUTER_MCP_MAX_SESSIONS`,
  `LLM_ROUTER_MCP_MAX_HEADLESS_CALLS`,
  `LLM_ROUTER_MCP_MAX_HEADLESS_PER_PROVIDER`);
- headless timeouts terminate the process group with TERM then KILL;
- raw provider argv is not returned by ordinary ask calls.

Do not put credentials in launcher arguments. Environment variables or the
provider's own credential store are safer.

## Troubleshooting

Run the doctor first:

```text
llm_provider_doctor()
```

Use the exact `socketLabel` reported by the doctor when attaching:

```bash
tmux -L "<socketLabel-from-llm_provider_doctor>" list-sessions
tmux -L "<socketLabel-from-llm_provider_doctor>" attach -t claude-mcp
```

Startup readiness uses an owned live-pane check plus a quiet stabilization
window; it is deliberately conservative but remains best-effort because provider
TUIs do not expose a common machine-readable ready signal. The default quiet
window is 2 seconds and can be adjusted with
`LLM_ROUTER_MCP_READY_SETTLE_MS` (250-10000). Startup uses the caller's single
end-to-end timeout across lock acquisition and readiness; a slow cold start is
not subject to an additional hidden 5-second cap. Allow enough time for both
provider startup and the quiet window.

Common cases:

- **Bypass unverified:** prefer the real executable or a strict one-line exec
  wrapper, keep `PERMISSION_SOURCE=auto`, and rerun the doctor. An intentionally
  opaque wrapper needs `PERMISSION_SOURCE=launcher` plus
  `LLM_ROUTER_MCP_ALLOW_UNVERIFIED_LAUNCHER=1` and is not verified by the router.
- **Session spec mismatch:** use `llm_tmux_stop`, then start/ask again.
- **Session remains busy after timeout:** wait again if the provider is still
  running, or stop it to abandon the request.
- **Provider CLI not found:** the MCP client's PATH differs from the interactive
  shell; configure an absolute `EXECUTABLE`.
- **Authentication required:** log in with the provider CLI outside the MCP
  first.

Before staging or publishing, scan tracked files for accidental credentials:

```bash
grep -RInEi '(api[_-]?key|token|secret|password|authorization|bearer|oauth|credential|cookie|private[_-]?key)' \
  . --exclude-dir=node_modules --exclude-dir=.git --exclude=package-lock.json
```
