import assert from "node:assert/strict";
import test from "node:test";
import { fork } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(here, "..");
const hostProcessEntry = join(desktopRoot, "electron/main/plugin-host-process.mjs");

function writeFixturePlugin() {
  const dir = mkdtempSync(join(tmpdir(), "pi-plugin-lifetime-"));
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({ schemaVersion: 1, id: "fixture.lifetime", name: "Lifetime", version: "0.0.1", main: "main.js" }),
    "utf8",
  );
  // A referenced timer would keep a plain Node host alive forever; the real
  // plugin host must exit with its parent regardless of plugin activity.
  writeFileSync(
    join(dir, "main.js"),
    "module.exports = { onLoad() { setInterval(() => {}, 1000); } };",
    "utf8",
  );
  return dir;
}

function forkHost(extraEnv = {}) {
  const child = fork(hostProcessEntry, [], {
    execArgv: [],
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { ...process.env, ...extraEnv },
  });
  return child;
}

test("plugin host exits when the parent disconnects despite a referenced plugin timer", async () => {
  const dir = writeFixturePlugin();
  const child = forkHost();
  const exited = once(child, "exit");
  const ready = once(child, "message");
  child.send({ t: "init", id: 1, pluginId: "fixture.lifetime", pluginPath: dir, main: "main.js" });
  const [initReply] = await ready;
  assert.equal(initReply.ok, true, "fixture plugin should load");
  // Dropping the IPC side is what a dying parent's connector looks like.
  child.disconnect();
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
  }, 2000);
  const [code] = await exited;
  clearTimeout(timer);
  assert.equal(code, 0, "host must exit cleanly on parent disconnect");
});

test("plugin host exits when a send to the parent channel fails", async () => {
  const dir = writeFixturePlugin();
  const child = forkHost();
  const exited = once(child, "exit");
  const ready = once(child, "message");
  child.send({ t: "init", id: 1, pluginId: "fixture.lifetime", pluginPath: dir, main: "main.js" });
  await ready;
  // Same close as a dead parent, but without the disconnect handshake order.
  child._channel?.close?.();
  child.disconnect();
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
  }, 2000);
  const [code] = await exited;
  clearTimeout(timer);
  assert.equal(code, 0);
});

/**
 * Fixture whose `process.send` never touches the channel for diagnostics: a
 * `log` frame succeeds synchronously but reports an EPIPE delivery failure
 * asynchronously through the process-level `error` event — the boundary Node
 * IPC actually uses when the parent connector dies between the send and the
 * flush. Other frames (the init reply) still go through the real channel so
 * the test can wait for the host to come up. `trigger` then produces the
 * diagnostics path under test.
 */
function writeFixturePluginWithAsyncSendFailure(trigger) {
  const dir = mkdtempSync(join(tmpdir(), "pi-plugin-async-send-"));
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({ schemaVersion: 1, id: "fixture.async-send", name: "AsyncSend", version: "0.0.1", main: "main.js" }),
    "utf8",
  );
  writeFileSync(
    join(dir, "main.js"),
    `module.exports = {
      onLoad() {
        // Keep the host alive until the broken transport tears it down.
        setInterval(() => {}, 1000);
        const realSend = process.send.bind(process);
        process.send = (message, callback) => {
          if (message && message.t === "log") {
            setImmediate(() => {
              const error = new Error("write EPIPE");
              error.code = "EPIPE";
              process.emit("error", error);
            });
            return true;
          }
          return realSend(message, callback);
        };
        setImmediate(() => { ${trigger} });
      },
    };`,
    "utf8",
  );
  return dir;
}

/**
 * Both async scenarios share the same contract: the diagnostic send fails
 * asynchronously (EPIPE via process.emit("error")), the host must take the
 * terminal path exactly once — a clean exit(0), not a recursion loop — and
 * must not emit the "broken channel" note more than once.
 */
async function runAsyncSendFailureScenario(trigger) {
  const dir = writeFixturePluginWithAsyncSendFailure(trigger);
  const child = forkHost();
  const exited = once(child, "exit");
  const ready = once(child, "message");
  const stderrChunks = [];
  child.stderr.on("data", (chunk) => stderrChunks.push(String(chunk)));
  child.send({ t: "init", id: 1, pluginId: "fixture.async-send", pluginPath: dir, main: "main.js" });
  const [initReply] = await ready;
  assert.equal(initReply.ok, true, "fixture plugin should load");
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
  }, 5000);
  const [code, signal] = await exited;
  clearTimeout(timer);
  const stderrText = stderrChunks.join("");
  return { code, signal, stderrText };
}

test("plugin host exits once when an async send failure surfaces through uncaughtException", async () => {
  // The plugin's own uncaught exception makes the host log diagnostics through
  // the transport; the patched send then fails asynchronously with EPIPE.
  const { code, signal, stderrText } = await runAsyncSendFailureScenario(
    `throw new Error("plugin boom");`,
  );
  assert.equal(signal, null, "host must exit by itself, not be SIGKILLed");
  assert.equal(code, 0, "host must take the clean terminal path exactly once");
  const notes = stderrText.split("parent IPC channel is broken").length - 1;
  assert.equal(notes, 1, `diagnostics must not recurse (got ${notes} broken-channel notes)`);
});

test("plugin host exits once when an async send failure surfaces through unhandledRejection", async () => {
  const { code, signal, stderrText } = await runAsyncSendFailureScenario(
    `Promise.reject(new Error("plugin boom"));`,
  );
  assert.equal(signal, null, "host must exit by itself, not be SIGKILLed");
  assert.equal(code, 0, "host must take the clean terminal path exactly once");
  const notes = stderrText.split("parent IPC channel is broken").length - 1;
  assert.equal(notes, 1, `diagnostics must not recurse (got ${notes} broken-channel notes)`);
});
