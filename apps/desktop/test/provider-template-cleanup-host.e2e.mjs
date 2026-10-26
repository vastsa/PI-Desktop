import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Host } from "../../../scripts/e2e/host.mjs";

const root = new URL("../../../", import.meta.url);
const binary = process.env.PI_DESKTOP_HOST_BIN ?? fileURLToPath(new URL(
  process.platform === "win32" ? "target/debug/pi-desktop-host-core.exe" : "target/debug/pi-desktop-host-core", root,
));

// Real process/database/encrypted-store regression for audit finding F-01.
test("uninstall failure quarantines every residual account across reload and restart", { timeout: 60000 }, async t => {
  const dir = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "template-cleanup-fix-"));
  const data = join(dir, "data"), plugin = join(dir, "plugin");
  const host = new Host(binary, data, { quiet: true });
  t.after(async () => { await host.stop(); await rm(dir, { recursive: true, force: true }); });
  await mkdir(plugin);
  const pluginId = "fixture.cleanup_fix";
  await writeFile(join(plugin, "main.cjs"), "module.exports={onProviderOAuth(){}};");
  await writeFile(join(plugin, "manifest.json"), JSON.stringify({
    schemaVersion: 1, id: pluginId, name: "Cleanup regression", version: "1.0.0", main: "main.cjs",
    permissions: ["provider.register", "provider.oauth"],
    contributes: { providerTemplates: [{ version: 1, id: "gateway", name: "Gateway", authKind: "oauth",
      baseUrl: "https://api.example.test/v1", models: [{ id: "chat" }] }] },
  }));
  await host.start();
  await host.call("plugins.loadDev", { path: plugin });
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const { provider } = await host.call("providers.createFromTemplate", { pluginId, templateId: "gateway" });
    await host.call("secrets.set", { secretRef: `secret:provider:${provider.id}:oauth`,
      value: JSON.stringify({ accessToken: "synthetic-access", refreshToken: "synthetic-refresh" }) });
    await host.call("providers.completeTemplateOAuth", { id: provider.id });
    ids.push(provider.id);
  }
  ids.sort();
  const blocks = [];
  for (const id of ids.slice(0, 2)) {
    const hash = createHash("sha256").update(`secret:provider:${id}:api_key`).digest("hex") + ".bin";
    const block = join(data, "secrets", hash);
    await mkdir(block);
    blocks.push(block);
  }
  const safeFailure = error => {
    assert.equal(error.errorCode, "INTERNAL");
    assert.match(error.message, /retry uninstall/);
    assert.doesNotMatch(error.message, /synthetic|\.bin|secret:|secrets[/\\]/);
    return true;
  };
  const unavailable = async () => {
    for (const id of ids.slice(0, 2)) {
      const { provider } = await host.call("providers.get", { id });
      assert.equal(provider.enabled, false);
      assert.equal(provider.hasOauth, false, "OAuth erasure must run even if API-key deletion fails");
      await assert.rejects(host.call("providers.update", { id, enabled: true }));
      await assert.rejects(host.call("providers.completeTemplateOAuth", { id }));
    }
    assert.equal((await host.call("providers.get", { id: ids[2] })).provider, null,
      "one cleanup failure must not stop later accounts");
  };
  await assert.rejects(host.call("plugins.uninstall", { id: pluginId }), safeFailure);
  await unavailable();
  await host.call("plugins.loadDev", { path: plugin });
  await host.call("plugins.enable", { id: pluginId });
  await unavailable();
  await host.restart();
  await unavailable();
  await assert.rejects(host.call("plugins.uninstall", { id: pluginId }), safeFailure);
  for (const block of blocks) await rm(block, { recursive: true });
  await host.call("plugins.loadDev", { path: plugin });
  for (const id of ids) {
    assert.equal((await host.call("providers.get", { id })).provider, null);
    assert.equal((await host.call("secrets.getForRuntime", { secretRef: `secret:provider:${id}:oauth` })).value, null);
  }
  const { provider: fresh } = await host.call("providers.createFromTemplate", { pluginId, templateId: "gateway" });
  assert.ok(!ids.includes(fresh.id));
  assert.equal(fresh.enabled, false);
  assert.equal(fresh.hasOauth, false);
  await assert.rejects(host.call("providers.completeTemplateOAuth", { id: fresh.id }));
  assert.equal((await host.call("plugins.uninstall", { id: pluginId })).ok, true);
  await host.restart();
  assert.equal((await host.call("providers.get", { id: fresh.id })).provider, null);
});
