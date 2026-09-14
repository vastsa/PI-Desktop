import assert from "node:assert/strict";
import { readFile, readdir, rm, mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  Logger,
  ignoreBrokenStdio,
  isBrokenPipeError,
  summarizeToolResult,
} from "../electron/main/logger.ts";

function brokenPipe(message = "write EPIPE", code = "EPIPE") {
  const error = new Error(message);
  error.code = code;
  return error;
}

test("broken-pipe errors are identified for stdio guards", () => {
  assert.equal(isBrokenPipeError(brokenPipe()), true);
  assert.equal(isBrokenPipeError(brokenPipe("EIO", "EIO")), true);
  assert.equal(isBrokenPipeError(new Error("other")), false);
  assert.equal(isBrokenPipeError("EPIPE"), false);
});

test("ignoreBrokenStdio swallows console EPIPE", () => {
  const originalLog = console.log;
  console.log = () => {
    throw brokenPipe();
  };
  try {
    ignoreBrokenStdio();
    assert.doesNotThrow(() => console.log("still running"));
  } finally {
    console.log = originalLog;
  }
});

test("logger routes records by category and keeps child stderr line-safe", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-desktop-logger-"));
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";

  try {
    const logger = new Logger(dataDir, "debug");
    logger.app("session", "info", "prompt accepted", {
      sessionId: "session-1",
      data: { apiKey: "must-not-be-written" },
    });
    logger.app("tool", "info", "tool execution completed", {
      sessionId: "session-1",
      toolCallId: "tool-1",
      data: {
        toolName: "Read",
        outcome: "success",
        durationMs: 42,
        result: summarizeToolResult({ ok: true, stdout: "file contents" }),
      },
    });
    logger.child(
      "host",
      "\u001b[2m2026-08-02T00:00:00Z\u001b[0m INFO tool=Read",
    );
    logger.child("host", " tool_call_id=tool-1\n");

    const appFiles = (await readdir(join(dataDir, "logs", "app"))).sort();
    assert.deepEqual(appFiles, ["session.log", "tool.log"]);
    assert.equal(existsSync(join(dataDir, "logs", "app.log")), false);

    const sessionRecord = JSON.parse(
      await readFile(join(dataDir, "logs", "app", "session.log"), "utf8"),
    );
    assert.equal(sessionRecord.channel, "app");
    assert.equal(sessionRecord.category, "session");
    assert.equal(sessionRecord.event, "prompt.accepted");
    assert.equal(sessionRecord.data.apiKey, "***REDACTED***");

    const toolRecord = JSON.parse(
      await readFile(join(dataDir, "logs", "app", "tool.log"), "utf8"),
    );
    assert.equal(toolRecord.event, "tool.execution.completed");
    assert.equal(toolRecord.toolCallId, "tool-1");
    assert.equal(toolRecord.data.outcome, "success");
    assert.equal(toolRecord.data.result.stdoutChars, 13);

    const hostRecord = JSON.parse(
      await readFile(join(dataDir, "logs", "host", "tool.log"), "utf8"),
    );
    assert.equal(hostRecord.category, "tool");
    assert.equal(hostRecord.event, "child.process.stderr");
    assert.equal(hostRecord.message, "child process stderr");
    assert.match(hostRecord.data.output, /tool=Read/);
    assert.doesNotMatch(hostRecord.data.output, /\u001b/);
    assert.equal(existsSync(join(dataDir, "logs", "host", "timing.log")), false);
    assert.equal(existsSync(join(dataDir, "logs", "agent")), false);
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("logger suppresses info console mirroring in production and mirrors full records in development", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-desktop-logger-console-"));
  const previousNodeEnv = process.env.NODE_ENV;
  const previousLog = console.log;
  const previousError = console.error;
  const mirrored = [];
  process.env.NODE_ENV = "production";
  console.log = (message) => mirrored.push(message);
  console.error = (message) => mirrored.push(message);

  try {
    const productionLogger = new Logger(dataDir, "debug");
    productionLogger.app("tool", "info", "tool execution completed", {
      data: { toolName: "Read" },
    });
    assert.deepEqual(mirrored, []);

    const developmentLogger = new Logger(dataDir, "debug", {
      mirrorConsole: true,
    });
    developmentLogger.app("tool", "info", "tool execution completed", {
      toolCallId: "tool-1",
      data: { toolName: "Read", outcome: "success" },
    });
    developmentLogger.app("tool", "error", "tool execution failed", {
      toolCallId: "tool-2",
      code: "TOOL_FAILED",
      data: { toolName: "Read", outcome: "error" },
    });
    assert.equal(mirrored.length, 2);
    const records = mirrored.map((line) =>
      JSON.parse(line.slice("[app/tool] ".length)),
    );
    assert.equal(records[0].event, "tool.execution.completed");
    assert.equal(records[0].toolCallId, "tool-1");
    assert.equal(records[0].data.toolName, "Read");
    assert.equal(records[1].event, "tool.execution.failed");
    assert.equal(records[1].code, "TOOL_FAILED");
    assert.equal(records[1].toolCallId, "tool-2");
  } finally {
    console.log = previousLog;
    console.error = previousError;
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("logger bounds and redacts messages, paths, credentials, and arbitrary data", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-desktop-logger-redaction-"));
  try {
    const logger = new Logger(dataDir, "debug");
    const providerSecret = "sk-proj-abcdefghijklmnopqrstuvwxyz";
    logger.app("provider", "error", "provider request failed", {
      sessionId: "session-1",
      code: "PROVIDER_UNAUTHORIZED",
      data: {
        apiKey: providerSecret,
        authorization: "Bearer very-long-provider-token-123456789",
        endpoint: "https://alice:password@example.com/v1?access_token=secret-value",
        path: join(dataDir, "workspace", "private.txt"),
        detail: "failed while reading /Volumes/private/project/config.json",
        password: "do-not-write",
        huge: "x".repeat(30_000),
      },
    });

    const record = JSON.parse(
      await readFile(join(dataDir, "logs", "app", "provider.log"), "utf8"),
    );
    const serialized = JSON.stringify(record);
    assert.equal(record.event, "provider.request.failed");
    assert.equal(record.code, "PROVIDER_UNAUTHORIZED");
    assert.equal(record.data.apiKey, "***REDACTED***");
    assert.equal(record.data.authorization, "***REDACTED***");
    assert.equal(record.data.password, "***REDACTED***");
    assert.equal(record.data.path, "<data-dir>/workspace/private.txt");
    assert.equal(record.data.detail, "failed while reading <local-path>");
    assert.match(record.data.huge, /\[truncated/);
    assert.ok(Buffer.byteLength(JSON.stringify(record.data), "utf8") <= 8 * 1024);
    assert.doesNotMatch(serialized, /sk-proj-abcdefghijklmnopqrstuvwxyz/);
    assert.doesNotMatch(serialized, /very-long-provider-token/);
    assert.doesNotMatch(serialized, /do-not-write/);
    assert.doesNotMatch(serialized, /alice:password@/);
    assert.doesNotMatch(serialized, /access_token=secret-value/);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("tool result summaries keep outcome metadata without copying output", () => {
  const summary = summarizeToolResult({
    ok: false,
    errorCode: "COMMAND_FAILED",
    stdout: "output that must stay out of diagnostic logs",
    stderr: "sk-proj-never-write-this",
    content: [{ type: "text", text: "private content" }],
  });
  assert.equal(summary.ok, false);
  assert.equal(summary.errorCode, "COMMAND_FAILED");
  assert.equal(summary.stdoutChars, 44);
  assert.equal(summary.stderrChars, 24);
  assert.equal(summary.contentBlocks, 1);
  assert.doesNotMatch(JSON.stringify(summary), /must stay out|sk-proj|private content/);
});

test("logger console mirror never throws when stdout is a broken pipe", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-desktop-logger-epipe-"));
  const previousLog = console.log;
  const previousError = console.error;
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "development";
  console.log = () => {
    throw brokenPipe();
  };
  console.error = () => {
    throw brokenPipe();
  };

  try {
    const logger = new Logger(dataDir, "debug");
    assert.doesNotThrow(() => {
      logger.app("session", "info", "prompt accepted", { sessionId: "session-1" });
      logger.app("runtime", "error", "host unavailable");
    });

    const sessionRecord = JSON.parse(
      await readFile(join(dataDir, "logs", "app", "session.log"), "utf8"),
    );
    assert.equal(sessionRecord.message, "prompt accepted");
    const runtimeRecord = JSON.parse(
      await readFile(join(dataDir, "logs", "app", "runtime.log"), "utf8"),
    );
    assert.equal(runtimeRecord.level, "error");
    assert.equal(runtimeRecord.message, "host unavailable");
  } finally {
    console.log = previousLog;
    console.error = previousError;
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    await rm(dataDir, { recursive: true, force: true });
  }
});
