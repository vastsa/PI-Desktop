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
    logger.app("tool", "info", "tool start", {
      sessionId: "session-1",
      toolCallId: "tool-1",
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
    assert.equal(sessionRecord.data.apiKey, "***REDACTED***");

    const hostRecord = JSON.parse(
      await readFile(join(dataDir, "logs", "host", "tool.log"), "utf8"),
    );
    assert.equal(hostRecord.category, "tool");
    assert.match(hostRecord.message, /tool=Read/);
    assert.doesNotMatch(hostRecord.message, /\u001b/);
    assert.equal(existsSync(join(dataDir, "logs", "host", "timing.log")), false);
    assert.equal(existsSync(join(dataDir, "logs", "agent")), false);
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    await rm(dataDir, { recursive: true, force: true });
  }
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
