#!/usr/bin/env node
/** Headless host RPC model-selection check; no live provider or desktop instance. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Host, resolveHostBinary } from "./e2e/host.mjs";

const binary = resolveHostBinary();
const dataDir = mkdtempSync(join(tmpdir(), "pi-desktop-e2e-model-"));
const host = new Host(binary, dataDir);
const projectPath = process.cwd();

async function createProvider(name, modelId) {
  const result = await host.call("providers.create", {
    name,
    vendorKey: "custom",
    type: "openai_compatible",
    protocol: "openai_compatible",
    baseUrl: "http://127.0.0.1:9/v1",
    authKind: "none",
    defaultModelId: modelId,
    apiStyle: "chat_completions",
  });
  assert.ok(result.provider?.id);
  return result.provider.id;
}

async function readSession(id) {
  const result = await host.call("session.get", { id });
  assert.ok(result.session);
  return result.session;
}

async function main() {
  try {
    await host.start();
    const firstProvider = await createProvider("E2E original model", "e2e-original");
    const nextProvider = await createProvider("E2E selected model", "e2e-selected");
    const createSession = async (title) => {
      const result = await host.call("session.create", {
        title,
        mode: "agent",
        projectPath,
        providerId: firstProvider,
        modelId: "e2e-original",
      });
      assert.ok(result.session?.id);
      return result.session.id;
    };
    const targetId = await createSession("E2E model target");
    const otherId = await createSession("E2E model untouched");
    const before = await readSession(targetId);
    const otherBefore = await readSession(otherId);
    const selection = { id: targetId, providerId: nextProvider, modelId: "e2e-selected" };

    for (const extra of [
      { mode: "goal" },
      { permissionMode: "auto" },
      { thinkingLevel: "high", mode: "goal" },
      { title: "renamed" },
    ]) {
      await assert.rejects(
        host.call("session.configureModel", { ...selection, ...extra }),
        (error) => error.errorCode === "INVALID_PARAMS",
      );
    }
    await assert.rejects(
      host.call("session.configureModel", { ...selection, modelId: "unknown-model" }),
      (error) => error.errorCode === "INVALID_PARAMS",
    );
    await assert.rejects(
      host.call("session.configureModel", { ...selection, thinkingLevel: "maximal" }),
      (error) => error.errorCode === "INVALID_PARAMS",
    );
    assert.deepEqual(await readSession(targetId), before);

    const updated = await host.call("session.configureModel", selection);
    assert.equal(updated.session.providerId, nextProvider);
    assert.equal(updated.session.modelId, "e2e-selected");
    assert.equal(updated.session.thinkingLevel, before.thinkingLevel);
    const retuned = await host.call("session.configureModel", {
      ...selection,
      thinkingLevel: "low",
    });
    assert.equal(retuned.session.thinkingLevel, "low");
    assert.equal(retuned.session.mode, before.mode);
    assert.equal(retuned.session.permissionMode, before.permissionMode);
    const assertPreserved = async () => {
      const target = await readSession(targetId);
      const other = await readSession(otherId);
      assert.equal(target.providerId, nextProvider);
      assert.equal(target.modelId, "e2e-selected");
      assert.equal(target.thinkingLevel, "low");
      for (const field of ["mode", "permissionMode"]) {
        assert.equal(target[field], before[field], `target ${field} changed`);
      }
      for (const field of ["providerId", "modelId", "mode", "permissionMode", "thinkingLevel"]) {
        assert.equal(other[field], otherBefore[field], `other session ${field} changed`);
      }
    };
    await assertPreserved();
    await host.restart();
    await assertPreserved();
    console.log("PASS E2E-236A host RPC model and thinking-level selection, isolation and persistence");
  } finally {
    try {
      await host.stop();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error("FAIL E2E-236A host RPC model selection:", error);
  process.exitCode = 1;
});
