/**
 * `toolPackages.*` IPC bridge (D681).
 *
 * The renderer may not touch the filesystem, so every call lands on the host:
 * `toolPackages.list` scans the bundled packages, `toolPackages.setEnabled`
 * persists one toggle. These tests pin the boundary, not the scan itself — the
 * scan lives in host-core and is covered by its own Rust tests.
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

import { IPC } from "@pi-desktop/shared";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { registerToolPackagesIpc } = await import(
  "../electron/main/ipc/tool-packages-ipc.ts"
);

function harness({ host = true } = {}) {
  const handlers = new Map();
  const calls = [];
  registerToolPackagesIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () =>
      host
        ? {
            async call(method, params) {
              calls.push([method, params]);
              return { packages: [{ id: "local.alpha", enabled: params?.enabled ?? true }] };
            },
          }
        : null,
  });
  return { handlers, calls };
}

test("both tool-package channels are registered", () => {
  const { handlers } = harness();
  assert.deepEqual(
    [...handlers.keys()].sort(),
    [IPC.invoke.toolPackagesList, IPC.invoke.toolPackagesSetEnabled].sort(),
  );
});

test("listing forwards to the host scan", async () => {
  const { handlers, calls } = harness();
  const result = await handlers.get(IPC.invoke.toolPackagesList)(undefined);
  assert.deepEqual(calls, [["toolPackages.list", {}]]);
  assert.equal(result.packages.length, 1);
});

test("the toggle forwards a trimmed id and a boolean", async () => {
  const { handlers, calls } = harness();
  await handlers.get(IPC.invoke.toolPackagesSetEnabled)({
    id: "  local.alpha  ",
    enabled: false,
    // A field the renderer invented must not travel.
    force: true,
  });
  assert.deepEqual(calls, [["toolPackages.setEnabled", { id: "local.alpha", enabled: false }]]);
});

test("a malformed toggle never reaches the host", async () => {
  const { handlers, calls } = harness();
  const toggle = handlers.get(IPC.invoke.toolPackagesSetEnabled);
  await assert.rejects(() => toggle({ enabled: true }), /non-empty id/);
  await assert.rejects(() => toggle({ id: "local.alpha" }), /boolean enabled/);
  await assert.rejects(() => toggle("local.alpha"), /expects \{ id, enabled \}/);
  assert.deepEqual(calls, [], "no host call for a rejected shape");
});

test("a missing host fails loudly instead of pretending", async () => {
  const { handlers } = harness({ host: false });
  await assert.rejects(
    () => handlers.get(IPC.invoke.toolPackagesList)(undefined),
    /host unavailable/,
  );
});
