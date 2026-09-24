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
const providerSync = await import("../electron/main/remote/remote-provider-sync.ts");

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
      if (id === "../bootstrap/remote-hosts") {
        return { getActiveRemoteHostsBoot: () => null, sshMetadataOf: (record) => record.ssh ?? null };
      }
      if (id === "../remote/backend-router") return router;
      if (id === "../remote/remote-provider-sync") return providerSync;
      if (id === "../remote/ssh-transport") {
        return {
          createSystemSshTransport: () => {
            throw new Error("tests never spawn ssh");
          },
        };
      }
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

function setup(bootOverrides = {}, { noBoot = false, ipcOptions = {} } = {}) {
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
    ...ipcOptions,
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

const SECRET = "sk-sync-secret";
const SYNC_PROVIDERS = [
  {
    id: "local",
    name: "OpenAI",
    vendorKey: "openai",
    type: "native",
    protocol: "openai-responses",
    enabled: true,
    authKind: "api_key",
    hasSecret: true,
    models: [{ id: "gpt-x" }],
    supportedThinkingLevels: ["off"],
  },
  {
    id: "plugin-row",
    name: "Plugin",
    vendorKey: "x",
    type: "custom",
    protocol: "openai-chat",
    enabled: true,
    authKind: "api_key",
    hasSecret: true,
    ownerPluginId: "some.plugin",
    models: [{ id: "m" }],
    supportedThinkingLevels: [],
  },
];

function syncSetup({ ssh = { host: "box", remotePort: 7777, version: "1" }, stdout } = {}) {
  const sent = [];
  const hostCalls = [];
  const summary = { imported: [{ sourceId: "local", providerId: "h1", action: "created" }], skipped: [], defaultSet: true };
  const { invoke } = setup(
    { registry: { list: async () => [{ hostKey: "h", label: "box", url: "ws://x", deviceToken: "t", ssh }] } },
    {
      ipcOptions: {
        getHost: () => ({
          call: async (method, params) => {
            hostCalls.push(method);
            if (method === "providers.list") return { providers: SYNC_PROVIDERS };
            if (method === "providers.getSecret") return { value: params.id === "local" ? SECRET : undefined };
            throw new Error(`unexpected ${method}`);
          },
        }),
        buildSshTransport: () => ({
          exec: async () => assert.fail("exec is not used"),
          execWithInput: async (command, input) => {
            sent.push({ command, input });
            return { stdout: stdout ?? `PI_HOST_PROVIDERS ${JSON.stringify(summary)}\n`, stderr: "", code: 0 };
          },
          forward: async () => assert.fail("forward is not used"),
          dispose: () => undefined,
        }),
      },
    },
  );
  return { invoke, sent, hostCalls, summary };
}

test("remoteHostSyncProviders copies a local provider over the host's SSH stdin", async () => {
  const { invoke, sent, summary } = syncSetup();
  const result = await invoke(IPC.invoke.remoteHostSyncProviders, {
    hostKey: "h",
    providerIds: [" local "],
    setDefault: true,
  });
  assert.deepEqual(result, summary);
  assert.equal(sent.length, 1);
  assert.ok(!sent[0].command.includes(SECRET));
  const payload = JSON.parse(sent[0].input);
  assert.equal(payload.providers[0].input.secretValue, SECRET);
  assert.deepEqual(payload.defaultModel, { sourceId: "local", modelId: "gpt-x" });
  assert.ok(!JSON.stringify(result).includes(SECRET));
});

test("remoteHostSyncProviders re-checks every id in main", async () => {
  const { invoke, sent } = syncSetup();
  for (const providerIds of [undefined, [], ["  "], ["x".repeat(257)]]) {
    await assert.rejects(
      invoke(IPC.invoke.remoteHostSyncProviders, { hostKey: "h", providerIds, setDefault: false }),
      isInvalid("providerIds"),
    );
  }
  for (const providerIds of [["plugin-row"], ["missing"]]) {
    await assert.rejects(
      invoke(IPC.invoke.remoteHostSyncProviders, { hostKey: "h", providerIds, setDefault: false }),
      isInvalid(),
    );
  }
  await assert.rejects(
    invoke(IPC.invoke.remoteHostSyncProviders, { hostKey: "other", providerIds: ["local"], setDefault: false }),
    isInvalid("hostKey"),
  );
  assert.equal(sent.length, 0);
});

test("remoteHostSyncProviders refuses a host paired by URL", async () => {
  const { invoke, sent, hostCalls } = syncSetup({ ssh: null });
  await assert.rejects(
    invoke(IPC.invoke.remoteHostSyncProviders, { hostKey: "h", providerIds: ["local"], setDefault: false }),
    (error) => error.errorCode === "CAPABILITY_UNAVAILABLE",
  );
  assert.equal(sent.length, 0);
  assert.equal(hostCalls.length, 0, "no key is read for a host that cannot receive it");
});

test("remoteHostSyncProviders surfaces the host's failure code", async () => {
  const { invoke } = syncSetup({ stdout: 'PI_HOST_FAILED {"code":"ADMIN_UNAVAILABLE"}\n' });
  await assert.rejects(
    invoke(IPC.invoke.remoteHostSyncProviders, { hostKey: "h", providerIds: ["local"], setDefault: false }),
    (error) => error.data?.code === "ADMIN_UNAVAILABLE",
  );
});
