import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { repositoryRoot } from "../../../scripts/e2e/boot.mjs";

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");

test("permission IPC trusts only main, requests the host and opens only the fixed OS pane", async (t) => {
  const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "computer-permission-ipc-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const stub = join(temp, "electron.mjs");
  await writeFile(stub, `
export const shell = { openExternal: async (url) => {
  globalThis.computerPermissionFixture.urls.push(url);
  if (globalThis.computerPermissionFixture.openError) throw new Error("Fixture pane unavailable");
} };
export const desktopCapturer = { getSources: async () => { throw new Error("Permission requests must not capture"); } };
export const systemPreferences = {
  getMediaAccessStatus: () => "granted",
  isTrustedAccessibilityClient: (prompt) => {
    globalThis.computerPermissionFixture.prompts.push(prompt);
    return globalThis.computerPermissionFixture.appTrusted;
  },
};
`);
  const outfile = join(temp, "ipc.mjs");
  await build({
    stdin: { contents: `
export { registerComputerIpc } from "./apps/desktop/electron/main/ipc/computer-ipc";
export { IPC } from "@pi-desktop/shared";
`, resolveDir: root },
    outfile, bundle: true, platform: "node", format: "esm",
    alias: { electron: stub, "@pi-desktop/shared": join(root, "packages/shared/src") },
  });
  const { registerComputerIpc, IPC } = await import(pathToFileURL(outfile).href);
  const fixture = { urls: [], openError: false, appTrusted: false, prompts: [] };
  globalThis.computerPermissionFixture = fixture;
  t.after(() => { delete globalThis.computerPermissionFixture; });
  const callbacks = new Map();
  const calls = [];
  let missingHost = false;
  let hostError = null;
  const capabilities = {
    platform: "darwin", backend: "macos-ax", fidelity: "full",
    accessibility: "not-requested", capture: "not-requested",
  };
  registerComputerIpc({
    registrar: {
      handleWithEvent(channel, callback) { callbacks.set(channel, callback); },
      assertMainWindowSender(event) {
        if (!event.trusted) throw new Error("Untrusted sender");
      },
    },
    getHost: () => missingHost ? null : {
      async call(method, params) {
        calls.push({ method, params });
        if (hostError) throw hostError;
        return { ...capabilities };
      },
    },
    publishGrant() { throw new Error("Requesting permission must not create or publish a scope grant"); },
  });
  const request = callbacks.get(IPC.invoke.computerRequestPermission);
  assert.ok(request, "request channel is registered");
  await assert.rejects(request({ trusted: false }), /Untrusted sender/);
  assert.deepEqual(calls, []);
  assert.deepEqual(fixture.urls, []);

  missingHost = true;
  await assert.rejects(request({ trusted: true }), { errorCode: "HOST_UNAVAILABLE" });
  missingHost = false;
  const result = await request({ trusted: true }, { url: "https://not-accepted.invalid", targetId: "not-accepted" });
  assert.equal(result.accessibility, "not-requested");
  assert.equal(result.capture, "granted");
  assert.deepEqual(calls, [{ method: "computer.capabilities", params: {} }]);
  assert.deepEqual(fixture.urls, ["x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"]);

  fixture.urls.length = 0;
  capabilities.accessibility = "granted";
  fixture.appTrusted = true;
  assert.equal((await request({ trusted: true })).accessibility, "granted");
  assert.deepEqual(fixture.urls, []);

  capabilities.accessibility = "denied";
  fixture.appTrusted = false;
  await request({ trusted: true });
  assert.equal(fixture.urls.length, 1);
  fixture.openError = true;
  await assert.rejects(request({ trusted: true }), /Fixture pane unavailable/);
  fixture.openError = false;
  fixture.urls.length = 0;

  fixture.appTrusted = true;
  const read = callbacks.get(IPC.invoke.computerCapabilities);
  const appGranted = await read({ trusted: true });
  assert.equal(appGranted.applicationAccessibility, "granted",
    "Settings must read the app's own TCC grant even when its child reports denied");
  assert.equal(appGranted.accessibility, "denied", "backend refusal must remain authoritative");
  await request({ trusted: true });
  assert.deepEqual(fixture.urls, [], "already-authorized app must not reopen System Settings");
  assert.equal(fixture.prompts.at(-1), false, "an authorized app must not be prompted again");
  fixture.appTrusted = false;

  hostError = Object.assign(new Error("Platform unsupported"), { errorCode: "COMPUTER_PLATFORM_UNSUPPORTED" });
  await assert.rejects(request({ trusted: true }), { errorCode: "COMPUTER_PLATFORM_UNSUPPORTED" });
  assert.deepEqual(fixture.urls, []);
  hostError = null;
  capabilities.platform = "linux";
  capabilities.backend = "unsupported";
  capabilities.accessibility = "unsupported";
  await request({ trusted: true });
  assert.deepEqual(fixture.urls, []);
});
