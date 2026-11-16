import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const hostEntry = new URL("../electron/main/plugin-host-process.mjs", import.meta.url);

async function startHost(t, utilityPort = false) {
  const dir = mkdtempSync(join(tmpdir(), "plugin-host-lifecycle-"));
  writeFileSync(join(dir, "main.cjs"), `
    exports.onLoad = () => { setInterval(() => {}, 1000); };
    exports.onPanelInvoke = (channel, payload) => {
      if (channel === "ping") return "pong";
      if (channel === "parent-gone") {
        process.kill = () => { throw Object.assign(new Error("parent gone"), { code: "ESRCH" }); };
        return null;
      }
      setImmediate(() => {
        if (payload.failure) {
          const transport = process.parentPort ?? process;
          const method = process.parentPort ? "postMessage" : "send";
          const send = transport[method].bind(transport);
          let attempts = 0;
          transport[method] = (message, callback) => {
            if (message.t !== "log") return send(message, callback);
            if (++attempts > 3) process.exit(77);
            const error = Object.assign(new Error("fixture transport failure"), { code: "EPIPE" });
            if (payload.failure === "sync") throw error;
            queueMicrotask(() => callback ? callback(error) : process.emit("error", error));
            return false;
          };
        }
        const error = new Error("fixture plugin failure");
        if (channel === "rejection") void Promise.reject(error);
        else throw error;
      });
      return null;
    };
  `);
  // Model Electron's public parentPort boundary without launching a Desktop.
  const preload = `
    import { EventEmitter } from "node:events";
    process.parentPort = new EventEmitter();
    process.parentPort.postMessage = (message) => process.send(message);
    process.on("message", (data) => process.parentPort.emit("message", { data }));
  `;
  const execArgv = utilityPort ? ["--import", `data:text/javascript,${encodeURIComponent(preload)}`] : [];
  const child = fork(hostEntry, [], { execArgv, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const exited = once(child, "exit");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    rmSync(dir, { recursive: true, force: true });
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const logs = [];
  child.on("message", (message) => { if (message.t === "log") logs.push(message); });
  let nextId = 0;
  const request = async (message) => {
    const id = ++nextId;
    const response = new Promise((resolve) => {
      const receive = (frame) => {
        if (frame.t !== "res" || frame.id !== id) return;
        child.off("message", receive);
        resolve(frame);
      };
      child.on("message", receive);
    });
    child.send({ ...message, id });
    const frame = await response;
    assert.equal(frame.ok, true, JSON.stringify(frame));
    return frame.value;
  };
  await request({ t: "init", pluginId: "fixture.lifecycle", pluginPath: dir, main: "main.cjs" });
  return { child, exited, logs, stderr: () => stderr, request };
}

async function expectExit(exited, code) {
  let timeout;
  try {
    const result = await Promise.race([
      exited,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("plugin host did not exit after transport loss")), 2000);
      }),
    ]);
    assert.deepEqual(result, [code, null]);
  } finally {
    clearTimeout(timeout);
  }
}

test("a plugin timer cannot keep the host alive after parent disconnect", { timeout: 5000 }, async (t) => {
  const host = await startHost(t);
  host.child.disconnect();
  await expectExit(host.exited, 0);
});

test("plugin exceptions remain observable while the parent is connected", { timeout: 5000 }, async (t) => {
  const host = await startHost(t);
  await host.request({ t: "call", method: "panel.invoke", payload: { channel: "exception", payload: {} } });
  while (host.logs.length === 0) await once(host.child, "message");
  assert.match(host.logs[0].message, /uncaught exception:.*fixture plugin failure/);
  assert.equal(await host.request({ t: "call", method: "panel.invoke", payload: { channel: "ping" } }), "pong");
});

test("a utility host exits when its parent PID disappears without a disconnect event", { timeout: 5000 }, async (t) => {
  const host = await startHost(t, true);
  await host.request({ t: "call", method: "panel.invoke", payload: { channel: "parent-gone" } });
  await expectExit(host.exited, 0);
});

test("a utility host exits when exception logging throws", { timeout: 5000 }, async (t) => {
  const host = await startHost(t, true);
  await host.request({ t: "call", method: "panel.invoke", payload: { channel: "exception", payload: { failure: "sync" } } });
  await expectExit(host.exited, 1);
});

for (const channel of ["exception", "rejection"]) {
  for (const failure of ["sync", "async"]) {
    test(`${channel} logging exits once on ${failure} transport failure`, { timeout: 5000 }, async (t) => {
      const host = await startHost(t);
      await host.request({ t: "call", method: "panel.invoke", payload: { channel, payload: { failure } } });
      await expectExit(host.exited, 1);
      assert.doesNotMatch(host.stderr(), /fixture transport failure/);
    });
  }
}
