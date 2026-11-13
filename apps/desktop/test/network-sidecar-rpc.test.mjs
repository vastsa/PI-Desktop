import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AgentSidecar } from "@pi-desktop/host-runtime";

// Real Host-side stdio client + built sidecar. No provider turn or external
// request is started; the loopback relay address is only configuration data.
test("sidecar RPC validates native DNS ownership and remains recoverable after bad configuration", {
  timeout: 60_000,
}, async (t) => {
  const agentsDir = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "dns-restore-sidecar-agents-"));
  const env = { ...process.env, PI_DESKTOP_AGENTS_DIR: agentsDir };
  delete env.PI_DESKTOP_PROXY_JSON;
  const sidecar = new AgentSidecar({
    launch: {
      command: process.execPath,
      args: [process.env.PI_DESKTOP_DNS_TEST_SIDECAR ?? fileURLToPath(new URL("../../../packages/agent-runtime/dist/sidecar.js", import.meta.url))],
      env,
    },
    onStderr() {},
  });
  t.after(async () => {
    await sidecar.dispose();
    await rm(agentsDir, { recursive: true, force: true });
  });
  const configure = (params) => sidecar.call("sidecar.configure", params);
  const accepted = { ok: true, mode: "host-proxy" };

  assert.deepEqual(await configure({}), accepted, "older callers can omit DNS ownership");
  for (const invalid of [null, "true", 1, {}, []]) {
    await assert.rejects(configure({ desktopDnsEnabled: invalid }), (error) => {
      assert.equal(error.errorCode, "INVALID_PARAMS");
      assert.equal(error.message, "desktopDnsEnabled must be a boolean");
      return true;
    });
  }
  await assert.rejects(configure({ desktopDnsEnabled: true }), /requires an authenticated proxy relay/);
  for (const mode of ["system", "direct", "custom"]) {
    const networkProxy = mode === "custom"
      ? { mode, url: "http://127.0.0.1:12345" }
      : { mode };
    await assert.rejects(configure({ networkProxy, desktopDnsEnabled: true }),
      /requires an authenticated proxy relay/);
    assert.deepEqual(await configure({
      networkProxy,
      desktopDnsEnabled: true,
      systemProxyRelayUrl: `socks5://system-auto:${"a".repeat(64)}@127.0.0.1:12346`,
    }), accepted);
  }
  assert.deepEqual(await configure({ desktopDnsEnabled: false }), accepted,
    "a flag-only disabling write recovers without an unrelated proxy patch");
  assert.deepEqual(await configure({ networkProxy: { mode: "direct" } }), accepted);
  assert.deepEqual(await sidecar.call("sidecar.health"), { ok: true, runtimes: 0 });
});
