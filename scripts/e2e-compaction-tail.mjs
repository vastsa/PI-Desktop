import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Host, resolveHostBinary } from "./e2e/host.mjs";
import { createSession } from "./e2e/session.mjs";

const temp = await mkdtemp(join(tmpdir(), "pi-compaction-tail-"));
const workspace = join(temp, "workspace");
const host = new Host(resolveHostBinary(), join(temp, "data"));
try {
  await mkdir(workspace);
  await host.start();
  const session = await createSession(host, workspace, "Trailing checkpoints");
  const createdAt = "2026-11-07T00:00:00Z";
  const append = (id) => host.call("session.appendMessage", { sessionId: session.id,
    message: { id, role: "assistant", content: id, usage: { inputTokens: 267261, outputTokens: 0, totalTokens: 267261 }, createdAt } });
  const compact = (id, throughMessageId, contextTokens) => host.call("session.appendCompaction", {
    sessionId: session.id, compaction: { id, throughMessageId, summary: "Synthetic summary", tokensBefore: 267261,
      details: { generation: id === "cp1" ? 1 : 2, contextTokens }, createdAt } });
  await append("m1");
  await compact("cp1", "m1", 40000);
  await append("m2");
  await compact("cp2", "m2", 26136);
  const verify = async () => {
    const { session: page } = await host.call("session.get", { id: session.id, messageLimit: 100 });
    assert.deepEqual(page.compactions.map(checkpoint => checkpoint.id), ["cp1", "cp2"]);
    assert.equal(page.compaction.id, "cp2");
    assert.equal(page.compaction.details.contextTokens, 26136);
    assert.equal(page.messages.at(-1).usage.totalTokens, 267261);
  };
  await verify();
  await host.restart();
  await verify();
  console.log("COMPACTION_TAIL " + JSON.stringify({ ok: true, restart: true, contextTokens: 26136 }));
} finally {
  await host.stop();
  await rm(temp, { recursive: true, force: true });
}
