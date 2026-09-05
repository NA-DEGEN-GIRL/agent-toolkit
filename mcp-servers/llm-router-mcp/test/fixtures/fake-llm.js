#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);

if (args.includes("--version") || args.includes("version")) {
  console.log("fake-llm 0.1.0");
  process.exit(0);
}
if (args.includes("--help") || args.includes("-h")) {
  console.log("fake-llm help");
  process.exit(0);
}

if (isHeadless(args)) {
  const prompt = readHeadlessPrompt(args);
  if (prompt.includes("HANG_HEADLESS")) {
    if (process.env.LLM_ROUTER_TEST_PID_FILE) {
      fs.writeFileSync(process.env.LLM_ROUTER_TEST_PID_FILE, String(process.pid));
    }
    await new Promise(() => { setInterval(() => {}, 1000); });
  }
  if (prompt.includes("SLOW_HEADLESS")) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600);
  }
  answer(prompt, "headless");
} else {
  process.stdin.setEncoding("utf8");
  process.stdout.write("fake LLM ready\n");

  let buffer = "";
  let requestCount = 0;
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    const reference = /Read and follow the complete llm-router-mcp Markdown request at:\s*([^\r\n]+)/.exec(
      buffer
    );
    if (reference) {
      const requestPath = reference[1].trim();
      fs.writeFileSync(
        path.join(path.dirname(requestPath), "transport.txt"),
        buffer,
        { mode: 0o600 }
      );
      const request = fs.readFileSync(requestPath, "utf8");
      buffer = "";
      requestCount += 1;
      answer(request, `tmux ${requestCount}`, { writeTransaction: true });
      return;
    }
  });
}

function isHeadless(args) {
  return (
    args.includes("exec") ||
    args.includes("-p") ||
    args.includes("--print") ||
    args.includes("--prompt-file")
  );
}

function readHeadlessPrompt(args) {
  const promptFileIndex = args.indexOf("--prompt-file");
  if (promptFileIndex !== -1 && args[promptFileIndex + 1]) {
    return fs.readFileSync(args[promptFileIndex + 1], "utf8");
  }
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function answer(prompt, mode, options = {}) {
  const markers = findMarkers(prompt);
  if (!markers) {
    console.log(`fake ${mode} response without markers`);
    return;
  }

  if (prompt.includes("HUGE_OUTPUT")) {
    process.stdout.write("x".repeat(3 * 1024 * 1024));
  }

  process.stdout.write(`${markers.startPrefix}${markers.nonce}\n`);

  if (prompt.includes("NO_DONE_MARKER")) {
    process.stdout.write(`fake ${mode} started without done marker\n`);
    return;
  }

  const answerText = `fake ${mode} answer\nprompt bytes ${Buffer.byteLength(prompt, "utf8")}`;
  process.stdout.write(`${answerText}\n`);

  if (options.writeTransaction) {
    const transaction = findTransaction(prompt);
    if (!transaction) {
      process.stdout.write("fake transaction metadata missing\n");
      return;
    }
    fs.writeFileSync(transaction.responsePath, `${answerText}\n`, { mode: 0o600 });
    const temporaryDonePath = `${transaction.donePath}.${process.pid}.tmp`;
    fs.writeFileSync(
      temporaryDonePath,
      `${JSON.stringify(
        {
          protocolVersion: 2,
          provider: transaction.provider,
          nonce: markers.nonce,
          requestId: transaction.requestId,
          status: "completed",
          completedAt: new Date().toISOString()
        },
        null,
        2
      )}\n`,
      { mode: 0o600 }
    );
    fs.renameSync(temporaryDonePath, transaction.donePath);
  }
  process.stdout.write(`${markers.donePrefix}${markers.nonce}\n`);
}

function findTransaction(value) {
  const responsePath = /as UTF-8 Markdown to:\s*\n\s+([^\r\n]+)/.exec(value)?.[1]?.trim();
  const donePath = /atomically rename that temporary file to:\s*\n\s+([^\r\n]+)/.exec(value)?.[1]?.trim();
  const provider = /"provider":"([A-Za-z0-9_-]+)"/.exec(value)?.[1];
  const requestId = /"requestId":"([A-Za-z0-9._-]+)"/.exec(value)?.[1];
  if (!responsePath || !donePath || !provider || !requestId) {
    return null;
  }
  return { responsePath, donePath, provider, requestId };
}

function findMarkers(value) {
  const prefixes = [...value.matchAll(/- literal prefix:\s*([A-Z_]+_TMUX_(?:STARTED|DONE):)/g)].map(
    (match) => match[1]
  );
  const nonceMatch = /- nonce:\s*([A-Za-z0-9_.:-]{6,96})/.exec(value);
  if (prefixes.length < 2 || !nonceMatch) {
    return null;
  }
  return {
    startPrefix: prefixes[0],
    donePrefix: prefixes[1],
    nonce: nonceMatch[1]
  };
}
