# MCP Servers

This directory is the repository-owned home for local MCP server packages. It
is intentionally separate from `skills/`: MCP servers keep their own runtime,
manifest, dependency lock, tests, and release version.

The catalog currently registers [`llm-router-mcp`](llm-router-mcp/README.md),
whose standalone Git history was imported into this repository. Do not register
an external checkout as though it were repository-owned source. Add a catalog
entry only when the complete package is present here.

## Current Servers

| Name | Runtime | Transport | Native check |
| --- | --- | --- | --- |
| `llm-router-mcp` | Node.js 20+ | stdio | `npm test` |

## Layout

Each package lives directly under its catalog name:

```text
mcp-servers/
├── catalog.json
└── <server-name>/
    ├── README.md
    ├── package.json
    ├── package-lock.json
    ├── bin/
    ├── src/
    └── test/
```

Schema version 1 entries have exactly four fields:

```json
{
  "name": "example-mcp",
  "source": "mcp-servers/example-mcp",
  "runtime": "node",
  "transport": "stdio"
}
```

- `name` is the package name and direct child directory name.
- `source` is a repository-relative path and must equal
  `mcp-servers/<name>`.
- `runtime` is currently `node`.
- `transport` is currently `stdio`.

Do not duplicate the package version, Node engine, test command, or executable
path in the catalog. Those values are owned by `package.json`; its named `bin`
entry is the MCP entrypoint. Node packages must commit `package-lock.json` so
CI and local setup can use `npm ci` deterministically.

## Validation and Safety

Prepare locked dependencies after cloning or changing a lockfile:

```bash
make setup-mcps
```

Then run the full check-only repository gate:

```bash
make check
```

The focused metadata check is:

```bash
python3 scripts/check_mcp_catalog.py
```

Run `make audit-mcps` for the separate registry-backed dependency security check.
It uses the committed lockfiles without installing packages or changing them,
but requires network access and reflects the registry's current advisories.
The dependency-audit workflow runs weekly, on demand, and for dependency changes;
the deterministic `make check` gate remains independent of registry availability.

Keep `node_modules/`, credentials, generated requests/responses, logs, and MCP
runtime state out of version control. Runtime state and user-specific client
configuration belong outside this repository; commit only reviewed examples or
templates with placeholders.

## Bringing In A Standalone Server

Use a one-time history import, not a permanently synchronized submodule or a
second writable copy:

1. Leave `mcp-servers/<server-name>/` absent until import time.
2. Keep the standalone repository active while the imported copy is tested.
3. Import its history into the direct-child package path and add the catalog
   entry in the same reviewed change.
4. Run locked dependency setup, the package's native tests, and the full root
   gate.
5. Update client configuration only after reviewing paths and backups, then
   restart each client and run a smoke check.
6. After the cutover is verified, make this repository the single writable
   canonical source and archive the old repository with a pointer here.

`llm-router-mcp` has completed the history-import stage. Keep the standalone
repository and current client configuration unchanged only until the imported
copy passes the full gate and client cutover is separately reviewed. New source
changes should be made in this monorepo rather than synchronized both ways.
