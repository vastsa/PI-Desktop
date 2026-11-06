/** Real host transport, event pipeline and disk writes against a controlled RPC peer. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { HostProcess } from "../packages/host-runtime/dist/host-process.js";
import { TurnEventPipeline } from "../packages/host-runtime/dist/turn-events.js";
import { InflightCheckpointer } from "../packages/host-runtime/dist/inflight-checkpoint.js";

const root = await mkdtemp(join(tmpdir(), "pi-checkpoint-lifecycle-"));
const hosts = [];
const snapshot = (sessionId, id) => ({ sessionId, turnId: `turn-${id}`,
  message: { id, role: "assistant", content: `Progress from ${id}`, createdAt: "2026-10-27T00:00:00Z" } });
async function startHost() {
  const host = new HostProcess({ binaryPath: process.execPath, dataDir: root,
    env: { NODE_OPTIONS: `--require=${JSON.stringify(fileURLToPath(new URL("./e2e/checkpoint-host-fixture.cjs", import.meta.url)))}` },
    onStderr: (text) => process.stderr.write(text),
  });
  hosts.push(host);
  await host.handshake();
  return host;
}
const call = (host, method, params) => host.call(method, params, 5000);

try {
  const host = await startHost();
  const pipeline = new TurnEventPipeline({
    getHost: () => host,
    ownership: { activeTurnId: () => "turn-held", isStaleTerminalEvent: () => false, finishTurn: async () => undefined },
    emit: () => undefined, log: () => undefined,
  });
  const checkpoint = snapshot("shutdown", "held");
  pipeline.handle({ sessionId: checkpoint.sessionId, turnId: checkpoint.turnId, ts: 1,
    event: { type: "message_update", message: checkpoint.message } });
  await call(host, "fixture.waitStarted", { sessionId: "shutdown", id: "held" });
  const quitting = pipeline.dispose().then(() => host.dispose());
  await nextTurn();
  assert.equal(host.isAvailable(), true, "disposal closed the host before its save reply");
  await call(host, "fixture.release", { sessionId: "shutdown", id: "held" });
  await quitting;

  const restarted = await startHost();
  const recovered = await call(restarted, "fixture.read", { sessionId: "shutdown" });
  assert.deepEqual(recovered, checkpoint);

  const writer = new InflightCheckpointer((value) =>
    call(restarted, "session.saveInflightMessage", value));
  try {
    writer.observe(snapshot("handoff", "old"));
    await call(restarted, "fixture.waitStarted", { sessionId: "handoff", id: "old" });
    writer.settle("handoff");
    writer.observe(snapshot("handoff", "new"));
    writer.observe(snapshot("parallel", "free"));
    await call(restarted, "fixture.waitSaved", { sessionId: "parallel", id: "free" });
    const state = await call(restarted, "fixture.state");
    assert.deepEqual(state.started.filter((item) => item.sessionId === "handoff").map((item) => item.id), ["old"]);
    const flushing = writer.flushAll();
    await call(restarted, "fixture.release", { sessionId: "handoff", id: "old" });
    await flushing;
    const latest = await call(restarted, "fixture.read", { sessionId: "handoff" });
    assert.equal(latest.message.id, "new");
    assert.deepEqual(writer.pendingSessions(), []);
  } finally {
    await call(restarted, "fixture.release", { sessionId: "handoff", id: "old" });
    await writer.flushAll();
    writer.dispose();
  }
  await restarted.dispose();
  console.log(JSON.stringify({ passed: true, checkpointSurvivedRestart: true,
    sameSessionWritesSerialized: true, otherSessionProgressedWhileHeld: true }));
} finally {
  await Promise.allSettled(hosts.map((host) => host.dispose()));
  await rm(root, { recursive: true, force: true });
}
