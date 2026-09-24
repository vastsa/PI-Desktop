import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  classifyMainProcessError,
  describeMainProcessError,
  describeError,
  installMainProcessErrorHandlers,
  isNonAsciiHttpHeaderError,
  reportMainProcessError,
} from "../electron/main/main-process-errors.ts";

function byteStringError() {
  return new TypeError(
    "Cannot convert argument to a ByteString because the character at index 0 has a value of 26143 which is greater than 255.",
  );
}

function brokenPipe() {
  const error = new Error("write EPIPE");
  error.code = "EPIPE";
  return error;
}

test("Chromium non-ASCII HTTP header throws are recoverable", () => {
  const error = byteStringError();
  assert.equal(isNonAsciiHttpHeaderError(error), true);
  const classified = classifyMainProcessError("uncaughtException", error);
  assert.equal(classified.code, "NON_ASCII_HTTP_HEADER");
  assert.equal(classified.recoverable, true);
  assert.equal(classified.message, "uncaught exception in main");
  assert.match(describeMainProcessError(error), /ByteString/);
});

test("broken-pipe throws stay recoverable when they reach the handler", () => {
  const classified = classifyMainProcessError("uncaughtException", brokenPipe());
  assert.equal(classified.code, "EPIPE");
  assert.equal(classified.recoverable, true);
});

test("unknown uncaught exceptions are logged and do not quit", () => {
  const classified = classifyMainProcessError(
    "uncaughtException",
    new Error("unexpected"),
  );
  assert.equal(classified.code, "UNCAUGHT_EXCEPTION");
  assert.equal(classified.recoverable, false);
});

test("unhandled rejections keep the existing log message", () => {
  const classified = classifyMainProcessError(
    "unhandledRejection",
    new Error("no listener"),
  );
  assert.equal(classified.message, "unhandled promise rejection in main");
  assert.equal(classified.code, "UNHANDLED_REJECTION");
});

test("reportMainProcessError emits a recoverable ByteString record", () => {
  const seen = [];
  installMainProcessErrorHandlers({
    emit(record) {
      seen.push(record);
    },
  });
  const record = reportMainProcessError("uncaughtException", byteStringError());
  assert.equal(record.code, "NON_ASCII_HTTP_HEADER");
  assert.equal(record.recoverable, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].code, "NON_ASCII_HTTP_HEADER");
  assert.match(seen[0].detail, /ByteString/);
});

test("reportMainProcessError never throws when the sink fails", () => {
  const originalError = console.error;
  console.error = () => {};
  try {
    installMainProcessErrorHandlers({
      emit() {
        throw new Error("logger down");
      },
    });
    assert.doesNotThrow(() =>
      reportMainProcessError("uncaughtException", byteStringError()),
    );
  } finally {
    console.error = originalError;
  }
});

test("installMainProcessErrorHandlers is idempotent", () => {
  installMainProcessErrorHandlers();
  const afterFirstEx = process.listenerCount("uncaughtException");
  const afterFirstRej = process.listenerCount("unhandledRejection");
  installMainProcessErrorHandlers();
  assert.equal(process.listenerCount("uncaughtException"), afterFirstEx);
  assert.equal(process.listenerCount("unhandledRejection"), afterFirstRej);
});

test("Electron main installs handlers and does not use Electron's default dialog path", async () => {
  const index = await readFile(
    new URL("../electron/main/index.ts", import.meta.url),
    "utf8",
  );
  assert.match(index, /installMainProcessErrorHandlers\(\)/);
  assert.match(index, /installMainProcessErrorHandlers\(\{/);
  assert.match(index, /emit:/);
  assert.doesNotMatch(
    index,
    /process\.on\("unhandledRejection"/,
  );
  assert.doesNotMatch(
    index,
    /process\.on\("uncaughtException"/,
  );
});

test("user-facing error descriptions preserve the 300-character limit", () => {
  assert.equal(describeError(new Error("x".repeat(400))), "x".repeat(300));
  assert.equal(describeError("y".repeat(400)), "y".repeat(300));
  assert.equal(describeError(null), "null");
});
