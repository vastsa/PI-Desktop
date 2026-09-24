import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const shared = await import("@pi-desktop/shared");
const { IPC } = shared;
const router = await import("../electron/main/remote/backend-router.ts");

/** Load remote-host-ipc.ts with Electron and the boot singleton stubbed out. */
function loadRemoteHostIpc() {
  const file = new URL("../electron/main/ipc/remote-host-ipc.ts", import.meta.url);
  const { outputText } = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    fileName: file.pathname,
  });
  const module = { exports: {} };
  new Function("require", "exports", "module", outputText)(
    (id) => {
      if (id === "electron") return { app: { getName: () => "test", getVersion: () => "0.0.0" } };
      if (id === "@pi-desktop/shared") return shared;
      if (id === "../bootstrap/remote-hosts") return { getActiveRemoteHostsBoot: () => null };
      if (id === "../remote/backend-router") return router;
      if (id === "../remote/racp-remote-host-client") {
        return { exchangePairingToken: async () => "device-token" };
      }
      throw new Error(`unexpected dependency: ${id}`);
    },
    module.exports,
    module,
  );
  return module.exports;
}

const { registerRemoteHostIpc } = loadRemoteHostIpc();

function setup(bootOverrides = {}, { noBoot = false } = {}) {
  const handlers = new Map();
  const calls = [];
  const record =
    (name, value) =>
    async (...args) => {
      calls.push([name, ...args]);
      return typeof value === "function" ? value(...args) : value;
    };
  const boot = {
    listProjects: record("listProjects", [{ id: "p1", label: "repo", archived: false }]),
    browseProject: record("browseProject", { path: "/srv", entries: [] }),
    registerProject: record("registerProject", { id: "p2", label: "new", archived: false }),
    createSession: record("createSession", { id: "remote:h:s" }),
    ...bootOverrides,
  };
  registerRemoteHostIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getRemoteHostsBoot: () => (noBoot ? null : boot),
    clientInfo: { name: "test", version: "0.0.0" },
  });
  const invoke = (channel, request) => handlers.get(channel)(request);
  return { invoke, calls };
}

const isInvalid = (field) => (error) =>
  error.errorCode === "INVALID_ARGUMENT" && (field === undefined || error.field === field);

const BAD_HOST_KEYS = [undefined, "", "   ", "a:b", "x".repeat(257), 42];
const CHANNELS = [
  IPC.invoke.remoteProjectList,
  IPC.invoke.remoteProjectBrowse,
  IPC.invoke.remoteProjectRegister,
  IPC.invoke.remoteSessionCreate,
];

test("every new remote handler is registered", () => {
  const handlers = new Set();
  registerRemoteHostIpc({
    registrar: { handle: (channel) => handlers.add(channel) },
    getRemoteHostsBoot: () => null,
    clientInfo: { name: "test", version: "0.0.0" },
  });
  for (const channel of CHANNELS) assert.ok(handlers.has(channel), channel);
});

test("each new handler requires a valid hostKey before touching the boot", async () => {
  for (const channel of CHANNELS) {
    const { invoke, calls } = setup();
    for (const hostKey of BAD_HOST_KEYS) {
      await assert.rejects(
        invoke(channel, { hostKey, path: "/srv/x", projectId: "p1" }),
        isInvalid("hostKey"),
        `${channel} with hostKey ${String(hostKey).slice(0, 20)}`,
      );
    }
    await assert.rejects(invoke(channel, undefined), isInvalid("hostKey"));
    assert.equal(calls.length, 0, channel);
  }
});

test("a 256-char hostKey is accepted and trimmed", async () => {
  const { invoke, calls } = setup();
  const hostKey = "k".repeat(256);
  await invoke(IPC.invoke.remoteProjectList, { hostKey: `  ${hostKey} ` });
  assert.deepEqual(calls, [["listProjects", hostKey]]);
});

test("remoteProjectList wraps the host's projects", async () => {
  const { invoke } = setup();
  assert.deepEqual(await invoke(IPC.invoke.remoteProjectList, { hostKey: "h" }), {
    projects: [{ id: "p1", label: "repo", archived: false }],
  });
});

test("remoteProjectBrowse validates an optional path", async () => {
  const { invoke, calls } = setup();
  await invoke(IPC.invoke.remoteProjectBrowse, { hostKey: "h" });
  await invoke(IPC.invoke.remoteProjectBrowse, { hostKey: "h", path: "  " });
  await invoke(IPC.invoke.remoteProjectBrowse, { hostKey: "h", path: " /srv/a " });
  await invoke(IPC.invoke.remoteProjectBrowse, { hostKey: "h", path: "p".repeat(4096) });
  await assert.rejects(
    invoke(IPC.invoke.remoteProjectBrowse, { hostKey: "h", path: "p".repeat(4097) }),
    isInvalid("path"),
  );
  await assert.rejects(
    invoke(IPC.invoke.remoteProjectBrowse, { hostKey: "h", path: "/srv/\0x" }),
    isInvalid("path"),
  );
  assert.deepEqual(
    calls.map((c) => c[2]?.length > 100 ? "long" : c[2]),
    [undefined, undefined, "/srv/a", "long"],
  );
});

test("remoteProjectRegister requires a non-empty valid path", async () => {
  const { invoke, calls } = setup();
  for (const path of [undefined, null, "", "   "]) {
    await assert.rejects(
      invoke(IPC.invoke.remoteProjectRegister, { hostKey: "h", path }),
      isInvalid("path"),
    );
  }
  await assert.rejects(
    invoke(IPC.invoke.remoteProjectRegister, { hostKey: "h", path: "a\0b" }),
    isInvalid("path"),
  );
  assert.equal(calls.length, 0);
  assert.deepEqual(await invoke(IPC.invoke.remoteProjectRegister, { hostKey: "h", path: "/srv/new" }), {
    project: { id: "p2", label: "new", archived: false },
  });
  assert.deepEqual(calls, [["registerProject", "h", "/srv/new"]]);
});

test("remoteSessionCreate requires a projectId and trims and bounds the title", async () => {
  const { invoke, calls } = setup();
  for (const projectId of [undefined, "", "  ", "p".repeat(257)]) {
    await assert.rejects(
      invoke(IPC.invoke.remoteSessionCreate, { hostKey: "h", projectId }),
      isInvalid("projectId"),
    );
  }
  assert.equal(calls.length, 0);
  assert.deepEqual(
    await invoke(IPC.invoke.remoteSessionCreate, { hostKey: "h", projectId: " p1 ", title: "  Hi  " }),
    { session: { id: "remote:h:s" } },
  );
  await invoke(IPC.invoke.remoteSessionCreate, { hostKey: "h", projectId: "p1", title: "   " });
  await invoke(IPC.invoke.remoteSessionCreate, { hostKey: "h", projectId: "p1", title: "t".repeat(500) });
  assert.deepEqual(calls[0], ["createSession", "h", "p1", "Hi"]);
  assert.deepEqual(calls[1], ["createSession", "h", "p1", undefined]);
  assert.equal(calls[2][3].length, 200);
});

test("a RACP host error surfaces with its own code instead of INTERNAL", async () => {
  const { invoke } = setup({
    listProjects: async () => {
      throw Object.assign(new Error("denied"), { code: "PERMISSION_DENIED", retriable: false });
    },
  });
  await assert.rejects(
    invoke(IPC.invoke.remoteProjectList, { hostKey: "h" }),
    (error) => error.errorCode === "PERMISSION_DENIED" && error.data.retriable === false,
  );
});

test("a boot that is not ready refuses with AGENT_UNAVAILABLE", async () => {
  const { invoke } = setup({}, { noBoot: true });
  for (const channel of CHANNELS) {
    await assert.rejects(
      invoke(channel, { hostKey: "h", path: "/x", projectId: "p" }),
      (error) => error.errorCode === "AGENT_UNAVAILABLE",
    );
  }
});
