import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import fs from "node:fs/promises";
import { z } from "zod";

import {
  capturePane,
  doctorProviders,
  ensureSession,
  headlessAsk,
  killSession,
  listProviders,
  sendInput,
  status,
  tmuxAsk,
  waitForResponse,
  waitForStart,
  writeInputFile
} from "./core.js";

const providerSchema = z
  .enum(["codex", "claude", "grok", "antigravity", "agy", "gemini", "gpt", "openai", "xai"])
  .describe("LLM provider. Aliases: agy/gemini -> antigravity, gpt/openai -> codex, xai -> grok.");

const sessionNameSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9_-]+$/)
  .optional()
  .describe("Router-owned tmux session name using letters, numbers, underscore, or dash.");
const timeoutSchema = z
  .number()
  .int()
  .min(1)
  .max(3_600_000)
  .optional()
  .describe("Maximum wait time in milliseconds, capped at one hour.");
const inputPathSchema = z.string().min(1).max(4096);
const dimensionSchema = z.number().int().min(20).max(1000).optional();
const pollSchema = z.number().int().min(1).max(60_000).optional();
const captureLinesSchema = z.number().int().min(1).max(10_000).optional();
const nonceSchema = z.string().min(6).max(96).regex(/^[A-Za-z0-9_.:-]+$/);

const optionalCommon = {
  provider: providerSchema,
  sessionName: sessionNameSchema,
  timeoutMs: timeoutSchema,
  model: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("Optional provider model override. When omitted, the provider CLI configuration/default is used.")
};

export async function main() {
  const version = await loadPackageVersion();
  const server = new McpServer({
    name: "llm-router-mcp",
    version
  });

  server.registerTool(
    "llm_list_providers",
    {
      title: "List LLM providers",
      description:
        "Show the providers supported by llm-router-mcp, their default sessions, model defaults, and model flag support.",
      inputSchema: {}
    },
    async () => jsonContent({ providers: listProviders() })
  );

  server.registerTool(
    "llm_provider_doctor",
    {
      title: "Inspect provider launchers",
      description:
        "Report resolved provider executables, versions, bypass policy, model source, and tmux availability without making a model request.",
      inputSchema: {
        provider: providerSchema.optional()
      }
    },
    async (args, extra) => jsonContent(await doctorProviders({ ...args, signal: extra.signal }))
  );

  server.registerTool(
    "llm_write_input",
    {
      title: "Write Markdown input",
      description:
        "Write a Markdown prompt to the llm-router state directory and return inputPath for tmux or headless calls.",
      inputSchema: {
        provider: providerSchema.optional(),
        markdown: z.string().min(1).max(2_000_000).describe("Markdown prompt content."),
        filename: z
          .string()
          .max(128)
          .optional()
          .describe("Optional .md filename. Path components are ignored.")
      }
    },
    async (args, extra) => jsonContent(await writeInputFile({ ...args, signal: extra.signal }))
  );

  server.registerTool(
    "llm_tmux_start",
    {
      title: "Start persistent LLM tmux session",
      description:
        "Create or reuse a provider tmux session. Reusing the session preserves conversation context.",
      inputSchema: {
        provider: optionalCommon.provider,
        sessionName: optionalCommon.sessionName,
        model: optionalCommon.model,
        cwd: z
          .string()
          .max(4096)
          .optional()
          .describe("Opt-in working directory override. Requires LLM_ROUTER_MCP_ALLOW_CWD_OVERRIDE=1."),
        timeoutMs: optionalCommon.timeoutMs,
        columns: dimensionSchema,
        rows: dimensionSchema
      }
    },
    async (args, extra) => jsonContent(await ensureSession({ ...guardCwdOverride(args), signal: extra.signal }))
  );

  server.registerTool(
    "llm_tmux_send",
    {
      title: "Send Markdown input to persistent LLM",
      description:
        "Send a Markdown input file through tmux and return nonce markers. Use llm_tmux_wait to collect the answer.",
      inputSchema: {
        provider: optionalCommon.provider,
        inputPath: inputPathSchema.describe("Managed .md/.markdown path returned by llm_write_input. External paths require an explicit server environment opt-in."),
        sessionName: optionalCommon.sessionName,
        model: optionalCommon.model,
        cwd: z
          .string()
          .max(4096)
          .optional()
          .describe("Opt-in working directory override. Requires LLM_ROUTER_MCP_ALLOW_CWD_OVERRIDE=1."),
        timeoutMs: optionalCommon.timeoutMs,
        columns: dimensionSchema,
        rows: dimensionSchema
      }
    },
    async (args, extra) => jsonContent(await sendInput({ ...guardCwdOverride(args), signal: extra.signal }))
  );

  server.registerTool(
    "llm_tmux_wait_start",
    {
      title: "Wait for persistent LLM start marker",
      description:
        "Wait until the Markdown transaction completes or its diagnostic pane start marker appears.",
      inputSchema: {
        provider: optionalCommon.provider,
        nonce: nonceSchema.describe("Nonce returned by llm_tmux_send."),
        sessionName: optionalCommon.sessionName,
        timeoutMs: optionalCommon.timeoutMs,
        pollMs: pollSchema,
        captureLines: captureLinesSchema
      }
    },
    async (args, extra) => jsonContent(await waitForStart({ ...args, signal: extra.signal }))
  );

  server.registerTool(
    "llm_tmux_wait",
    {
      title: "Wait for persistent LLM response",
      description:
        "Wait for validated response.md and done.json transaction files. Pane markers are diagnostic unless legacy fallback is explicitly enabled.",
      inputSchema: {
        provider: optionalCommon.provider,
        nonce: nonceSchema.describe("Nonce returned by llm_tmux_send."),
        sessionName: optionalCommon.sessionName,
        timeoutMs: optionalCommon.timeoutMs,
        pollMs: pollSchema,
        captureLines: captureLinesSchema
      }
    },
    async (args, extra) => jsonContent(await waitForResponse({ ...args, signal: extra.signal }))
  );

  server.registerTool(
    "llm_tmux_ask",
    {
      title: "Ask persistent LLM and wait",
      description:
        "Convenience tool: send one Markdown file reference through tmux, then wait for the validated file transaction.",
      inputSchema: {
        provider: optionalCommon.provider,
        inputPath: inputPathSchema.describe("Managed .md/.markdown path returned by llm_write_input. External paths require an explicit server environment opt-in."),
        sessionName: optionalCommon.sessionName,
        model: optionalCommon.model,
        cwd: z
          .string()
          .max(4096)
          .optional()
          .describe("Opt-in working directory override. Requires LLM_ROUTER_MCP_ALLOW_CWD_OVERRIDE=1."),
        timeoutMs: optionalCommon.timeoutMs,
        pollMs: pollSchema,
        captureLines: captureLinesSchema,
        columns: dimensionSchema,
        rows: dimensionSchema
      }
    },
    async (args, extra) => jsonContent(await tmuxAsk({ ...guardCwdOverride(args), signal: extra.signal }))
  );

  server.registerTool(
    "llm_headless_ask",
    {
      title: "Ask LLM once without persistent context",
      description:
        "Run a one-shot provider CLI call for questions that do not need persistent context. Input and output are Markdown files.",
      inputSchema: {
        provider: optionalCommon.provider,
        inputPath: z
          .string()
          .max(4096)
          .optional()
          .describe("Managed .md/.markdown path returned by llm_write_input. Use this or markdown; external paths require server opt-in."),
        markdown: z
          .string()
          .max(2_000_000)
          .optional()
          .describe("Markdown prompt content. Written to inputPath automatically when inputPath is omitted."),
        filename: z.string().max(128).optional(),
        model: optionalCommon.model,
        cwd: z
          .string()
          .max(4096)
          .optional()
          .describe("Opt-in working directory override. Requires LLM_ROUTER_MCP_ALLOW_CWD_OVERRIDE=1."),
        timeoutMs: optionalCommon.timeoutMs
      }
    },
    async (args, extra) => {
      const hasMarkdown = typeof args.markdown === "string" && args.markdown.length > 0;
      const hasInputPath = typeof args.inputPath === "string" && args.inputPath.length > 0;
      if (hasMarkdown === hasInputPath) {
        throw new Error("exactly one of markdown or inputPath is required");
      }
      return jsonContent(await headlessAsk({ ...guardCwdOverride(args), signal: extra.signal }));
    }
  );

  server.registerTool(
    "llm_tmux_stop",
    {
      title: "Stop persistent LLM tmux session",
      description:
        "Stop a router-owned provider session and clear its launch metadata and busy lock.",
      inputSchema: {
        provider: optionalCommon.provider,
        sessionName: optionalCommon.sessionName
      }
    },
    async (args, extra) => jsonContent(await killSession({ ...args, requireOwned: true, signal: extra.signal }))
  );

  server.registerTool(
    "llm_tmux_status",
    {
      title: "Check persistent LLM tmux status",
      description:
        "Capture tmux pane state and optionally check whether a nonce has started or completed.",
      inputSchema: {
        provider: optionalCommon.provider,
        nonce: nonceSchema
          .optional()
          .describe("Optional nonce to check for start/done markers in pane output."),
        sessionName: optionalCommon.sessionName,
        lines: captureLinesSchema
      }
    },
    async (args, extra) => jsonContent(await status({ ...args, signal: extra.signal }))
  );

  server.registerTool(
    "llm_tmux_capture",
    {
      title: "Capture persistent LLM tmux pane",
      description: "Return raw tmux pane text for debugging.",
      inputSchema: {
        provider: optionalCommon.provider,
        sessionName: optionalCommon.sessionName,
        lines: captureLinesSchema
      }
    },
    async (args, extra) => {
      if (process.env.LLM_ROUTER_MCP_ENABLE_DEBUG_TOOLS !== "1") {
        throw new Error(
          "raw pane capture is disabled; set LLM_ROUTER_MCP_ENABLE_DEBUG_TOOLS=1 to opt in"
        );
      }
      return jsonContent({
        paneText: await capturePane({ ...args, requireOwned: true, signal: extra.signal })
      });
    }
  );

  await server.connect(new StdioServerTransport());
}

export async function loadPackageVersion() {
  const manifestUrl = new URL("../package.json", import.meta.url);
  const manifest = JSON.parse(await fs.readFile(manifestUrl, "utf8"));
  if (typeof manifest.version !== "string" || manifest.version.trim() === "") {
    throw new Error("llm-router-mcp package.json must declare a non-empty version");
  }
  return manifest.version;
}

function jsonContent(value) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}

function guardCwdOverride(args) {
  if (args.cwd && process.env.LLM_ROUTER_MCP_ALLOW_CWD_OVERRIDE !== "1") {
    throw new Error(
      "cwd overrides are disabled; configure a provider CWD in the MCP environment or explicitly set LLM_ROUTER_MCP_ALLOW_CWD_OVERRIDE=1"
    );
  }
  return args;
}
