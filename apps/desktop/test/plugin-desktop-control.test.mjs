import assert from "node:assert/strict";
import test from "node:test";
import { fork } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const hostProcessEntry = join(here, "../electron/main/plugin-host-process.mjs");
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");
const { createPluginSessionProjectResolver } =
  await import("../electron/main/services/plugin-session-project.ts");

function forkPluginProcess({ entry }) {
  const child = fork(entry, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  return {
    postMessage: (message) => {
      if (child.connected) child.send(message);
    },
    onMessage: (handler) => child.on("message", handler),
    onExit: (handler) => child.on("exit", (code) => handler(code ?? 0)),
    kill: () => child.kill(),
  };
}

function writePlugin(id, permissions, main) {
  const dir = mkdtempSync(join(tmpdir(), "pi-desktop-control-plugin-"));
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      id,
      name: id,
      version: "0.0.1",
      main: "main.js",
      permissions,
    }),
    "utf8",
  );
  writeFileSync(join(dir, "main.js"), main, "utf8");
  return dir;
}

function createRuntime(t, calls, extraServices = {}) {
  const runtime = new PluginRuntime({
    hostEntry: hostProcessEntry,
    spawnProcess: forkPluginProcess,
    desktopControl: {
      operations: [
        {
          id: "project/set",
          channel: "projectSet",
          description: "Open a project",
          risk: "write",
        },
        {
          id: "session/create",
          channel: "sessionCreate",
          description: "Create a durable session",
          risk: "write",
        },
        {
          id: "session/delete",
          channel: "sessionDelete",
          description: "Delete a session",
          risk: "dangerous",
        },
      ],
      invoke: async (input) => {
        calls.push(input);
        return { ok: true };
      },
    },
    ...extraServices,
  });
  t.after(async () => {
    for (const loaded of runtime.listLoaded())
      await runtime.unload(loaded.manifest.id);
  });
  return runtime;
}

const DANGEROUS_PLUGIN = `
  module.exports = {
    onPanelInvoke: async (channel, payload) => {
      try {
        return { ok: true, result: await pi.desktop.invoke({ operation: "session/delete", args: ["s1"], confirm: payload?.confirm !== false }) };
      } catch (error) {
        return { ok: false, code: error.code, message: error.message };
      }
    },
  };
`;

test("dangerous desktop operations are refused without a host consent service", async (t) => {
  const calls = [];
  const runtime = createRuntime(t, calls);
  const dir = writePlugin(
    "demo.dangerous.headless",
    ["desktop.control"],
    DANGEROUS_PLUGIN,
  );
  await runtime.loadFromPath(dir, ["desktop.control"]);
  const result = await runtime.invokePanelBridge(
    "demo.dangerous.headless",
    "desktop.test",
    {},
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "PERMISSION_DENIED");
  assert.deepEqual(
    calls,
    [],
    "the controller must never see an unconfirmed dangerous call",
  );
});

test("dangerous desktop operations need the user's native consent, not just confirm=true", async (t) => {
  const calls = [];
  const prompts = [];
  let answer = false;
  const runtime = createRuntime(t, calls, {
    confirmDesktopControl: async (request) => {
      prompts.push(request);
      return answer;
    },
  });
  const dir = writePlugin(
    "demo.dangerous",
    ["desktop.control"],
    DANGEROUS_PLUGIN,
  );
  await runtime.loadFromPath(dir, ["desktop.control"]);

  const declined = await runtime.invokePanelBridge(
    "demo.dangerous",
    "desktop.test",
    {},
  );
  assert.equal(declined.ok, false);
  assert.equal(declined.code, "PERMISSION_DENIED");
  assert.deepEqual(calls, []);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].pluginId, "demo.dangerous");
  assert.equal(prompts[0].operation, "session/delete");
  assert.equal(prompts[0].description, "Delete a session");
  assert.deepEqual(prompts[0].args, ["s1"]);

  answer = true;
  const granted = await runtime.invokePanelBridge(
    "demo.dangerous",
    "desktop.test",
    {},
  );
  assert.equal(granted.ok, true, JSON.stringify(granted));
  assert.deepEqual(calls, [
    {
      operation: "session/delete",
      args: ["s1"],
      confirm: true,
      source: "plugin",
      pluginContext: { pluginId: "demo.dangerous" },
    },
  ]);

  // A plugin that does not even acknowledge the risk never reaches the user.
  const unacknowledged = await runtime.invokePanelBridge(
    "demo.dangerous",
    "desktop.test",
    { confirm: false },
  );
  assert.equal(unacknowledged.code, "CONFIRMATION_REQUIRED");
  assert.equal(
    prompts.length,
    2,
    "no consent prompt for an unacknowledged call",
  );
});

test("desktop control is permission-gated and uses the shared controller", async (t) => {
  const calls = [];
  const runtime = createRuntime(t, calls);
  const dir = writePlugin(
    "demo.desktop",
    ["desktop.control"],
    `
    module.exports = {
      onPanelInvoke: async () => ({
        operations: await pi.desktop.listOperations(),
        result: await pi.desktop.invoke({ operation: "project/set", args: ["/tmp/project"] }),
      }),
    };
  `,
  );
  await runtime.loadFromPath(dir, ["desktop.control"]);
  const result = await runtime.invokePanelBridge(
    "demo.desktop",
    "desktop.test",
  );
  assert.deepEqual(result.operations, [
    { id: "project/set", description: "Open a project", risk: "write" },
    {
      id: "session/create",
      description: "Create a durable session",
      risk: "write",
    },
    {
      id: "session/delete",
      description: "Delete a session",
      risk: "dangerous",
    },
  ]);
  assert.deepEqual(calls, [
    {
      operation: "project/set",
      args: ["/tmp/project"],
      confirm: false,
      source: "plugin",
      pluginContext: { pluginId: "demo.desktop" },
    },
  ]);
});

test("permission inheritance is bound to the current plugin tool session", async (t) => {
  const calls = [];
  const runtime = createRuntime(t, calls);
  const dir = writePlugin(
    "demo.inheritance",
    ["agent.tool.register", "desktop.control"],
    `
    module.exports = {
      onLoad: async () => pi.agent.registerTool({
        name: "create_worker",
        description: "Create a worker",
        risk: "high",
        schema: { type: "object" },
        execute: async () => pi.desktop.invoke({
          operation: "session/create",
          args: [{ inheritPermissionFromSessionId: "parent" }],
        }),
      }),
    };
  `,
  );
  await runtime.loadFromPath(dir, ["agent.tool.register", "desktop.control"]);
  const tool = runtime
    .getTools()
    .find((entry) => entry.name === "create_worker");
  assert.ok(tool);

  await assert.rejects(
    tool.execute({}, { sessionId: "other" }),
    (error) => error.code === "PERMISSION_DENIED",
  );
  assert.deepEqual(calls, []);

  await tool.execute({}, { sessionId: "parent" });
  assert.equal(typeof calls[0].pluginContext.invocationId, "string");
  assert.ok(calls[0].signal instanceof AbortSignal);
  assert.deepEqual(calls, [
    {
      operation: "session/create",
      args: [{ inheritPermissionFromSessionId: "parent" }],
      confirm: false,
      source: "plugin",
      pluginContext: {
        pluginId: "demo.inheritance",
        sessionId: "parent",
        invocationId: calls[0].pluginContext.invocationId,
      },
      signal: calls[0].signal,
    },
  ]);
});

test("desktop control fails closed without its permission", async (t) => {
  const runtime = createRuntime(t, []);
  const dir = writePlugin(
    "demo.denied",
    [],
    `
    module.exports = {
      onPanelInvoke: async () => pi.desktop.listOperations(),
    };
  `,
  );
  await runtime.loadFromPath(dir, []);
  await assert.rejects(
    () => runtime.invokePanelBridge("demo.denied", "desktop.test"),
    (error) => error.code === "PERMISSION_DENIED",
  );
});

test("project-scoped plugins get session/list filtered by activation scope", async (t) => {
  const calls = [];
  const runtime = createRuntime(t, calls, {
    desktopControl: {
      operations: [
        {
          id: "session/list",
          channel: "sessionList",
          description: "List durable sessions",
          risk: "read",
        },
      ],
      invoke: async (input) => {
        calls.push(input);
        return {
          sessions: [
            { id: "in-scope", projectPath: "/workspace/allowed" },
            { id: "out-of-scope", projectPath: "/workspace/other" },
            { id: "no-project" },
          ],
        };
      },
    },
    pluginActiveInProject: (pluginId, projectPath) =>
      projectPath === "/workspace/allowed",
  });
  const dir = writePlugin(
    "demo.scoped.list",
    ["desktop.control"],
    `
    module.exports = {
      onPanelInvoke: async () => pi.desktop.invoke({ operation: "session/list", args: [] }),
    };
  `,
  );
  await runtime.loadFromPath(dir, ["desktop.control"]);
  const result = await runtime.invokePanelBridge(
    "demo.scoped.list",
    "desktop.test",
  );
  assert.deepEqual(result.sessions, [
    { id: "in-scope", projectPath: "/workspace/allowed" },
  ]);
});

test("project-scoped plugins cannot read an out-of-scope session via desktop.control", async (t) => {
  const calls = [];
  const runtime = createRuntime(t, calls, {
    desktopControl: {
      operations: [
        {
          id: "session/get",
          channel: "sessionGet",
          description: "Read a session",
          risk: "read",
        },
      ],
      invoke: async (input) => {
        calls.push(input);
        return { session: { id: "secret", projectPath: "/workspace/other" } };
      },
    },
    pluginActiveInProject: (pluginId, projectPath) =>
      projectPath !== "/workspace/other",
    getWorkspacePathForSession: (sessionId) =>
      sessionId === "secret" ? "/workspace/other" : null,
  });
  const dir = writePlugin(
    "demo.scoped.get",
    ["desktop.control"],
    `
    module.exports = {
      onPanelInvoke: async () => {
        try {
          return { ok: true, result: await pi.desktop.invoke({
            operation: "session/get",
            args: [{ sessionId: "secret" }],
          }) };
        } catch (error) {
          return { ok: false, code: error.code, message: error.message };
        }
      },
    };
  `,
  );
  await runtime.loadFromPath(dir, ["desktop.control"]);
  const result = await runtime.invokePanelBridge(
    "demo.scoped.get",
    "desktop.test",
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "PERMISSION_DENIED");
  assert.deepEqual(
    calls,
    [],
    "an out-of-scope targeted read never reaches the controller",
  );
});

test("cold durable sessions keep list to get and revisions scope parity", async (t) => {
  const sessions = [
    { id: "cold-allowed", projectPath: "/workspace/allowed" },
    { id: "cold-other", projectPath: "/workspace/other" },
    { id: "unknown" },
  ];
  const calls = [];
  const metadataReads = [];
  const host = {
    isAvailable: () => true,
    call: async (method, input) => {
      assert.equal(method, "session.get");
      metadataReads.push(input.id);
      return { session: sessions.find((s) => s.id === input.id) ?? null };
    },
  };
  const runtime = createRuntime(t, calls, {
    getWorkspacePathForSession: () => null,
    resolveSessionProjectPath: createPluginSessionProjectResolver(() => host),
    pluginActiveInProject: (_, path) => path === "/workspace/allowed",
    desktopControl: {
      operations: ["session/list", "session/get", "session/listRevisions"].map(
        (id) => ({
          id,
          channel: id,
          description: id,
          risk: "read",
        }),
      ),
      invoke: async (input) => {
        calls.push(input);
        if (input.operation === "session/list") return { sessions };
        if (input.operation === "session/listRevisions")
          return { revisions: ["r1"] };
        return {
          session: sessions.find((s) => s.id === input.args[0].sessionId),
        };
      },
    },
  });
  const id = "demo.scoped.cold";
  const dir = writePlugin(
    id,
    ["desktop.control"],
    `
    module.exports = { onPanelInvoke: async (_, input) => {
      try { return { ok: true, result: await pi.desktop.invoke(input) }; }
      catch (error) { return { ok: false, code: error.code }; }
    } };
  `,
  );
  await runtime.loadFromPath(dir, ["desktop.control"]);
  const invoke = (operation, args = []) =>
    runtime.invokePanelBridge(id, "desktop.test", { operation, args });
  const listed = await invoke("session/list");
  assert.deepEqual(listed.result.sessions, [sessions[0]]);
  for (const session of listed.result.sessions) {
    assert.deepEqual(
      (await invoke("session/get", [{ sessionId: session.id }])).result.session,
      session,
    );
    assert.deepEqual(
      (await invoke("session/listRevisions", [{ sessionId: session.id }]))
        .result.revisions,
      ["r1"],
    );
  }
  for (const target of ["cold-other", "unknown", "missing"]) {
    for (const operation of ["session/get", "session/listRevisions"]) {
      assert.deepEqual(await invoke(operation, [{ sessionId: target }]), {
        ok: false,
        code: "PERMISSION_DENIED",
      });
    }
  }
  assert.equal(calls.length, 3, "denied targets never reach the controller");
  assert.deepEqual(metadataReads, [
    "cold-allowed",
    "cold-allowed",
    "cold-other",
    "cold-other",
    "unknown",
    "unknown",
    "missing",
    "missing",
  ]);
});

test("an unscoped plugin keeps full desktop.control session reads", async (t) => {
  const calls = [];
  const runtime = createRuntime(t, calls, {
    desktopControl: {
      operations: [
        {
          id: "session/list",
          channel: "sessionList",
          description: "List durable sessions",
          risk: "read",
        },
      ],
      invoke: async (input) => {
        calls.push(input);
        return { sessions: [{ id: "any", projectPath: "/anywhere" }] };
      },
    },
    pluginActiveInProject: () => true,
  });
  const dir = writePlugin(
    "demo.global.list",
    ["desktop.control"],
    `
    module.exports = {
      onPanelInvoke: async () => pi.desktop.invoke({ operation: "session/list", args: [] }),
    };
  `,
  );
  await runtime.loadFromPath(dir, ["desktop.control"]);
  const result = await runtime.invokePanelBridge(
    "demo.global.list",
    "desktop.test",
  );
  assert.deepEqual(result.sessions, [{ id: "any", projectPath: "/anywhere" }]);
});

const PROMPT_ANSWER_OPERATIONS = [
  {
    id: "agent/askTool/resolve",
    channel: "askToolResolve",
    description: "Answer an Agent question",
    risk: "dangerous",
  },
  {
    id: "tool/resolvePermission",
    channel: "toolResolvePermission",
    description: "Resolve a pending tool permission request",
    risk: "dangerous",
  },
  {
    id: "extensions/ui/respond",
    channel: "extensionsUiRespond",
    description: "Answer a pending trusted extension prompt",
    risk: "dangerous",
  },
  {
    id: "session/delete",
    channel: "sessionDelete",
    description: "Delete a session",
    risk: "dangerous",
  },
];

const RELAY_PLUGIN = `
  module.exports = {
    onPanelInvoke: async (channel, payload) => {
      try {
        return { ok: true, result: await pi.desktop.invoke({ operation: payload.operation, args: [{}], confirm: true }) };
      } catch (error) {
        return { ok: false, code: error.code };
      }
    },
  };
`;

test("an Agent question answer can be allowed until quit; approvals never can", async (t) => {
  const calls = [];
  const prompts = [];
  let answer = "session";
  const runtime = createRuntime(t, calls, {
    desktopControl: {
      operations: PROMPT_ANSWER_OPERATIONS,
      invoke: async (input) => {
        calls.push(input.operation);
        return { ok: true };
      },
    },
    confirmDesktopControl: async (request) => {
      prompts.push(request);
      return answer;
    },
  });
  const dir = writePlugin("demo.relay", ["desktop.control"], RELAY_PLUGIN);
  await runtime.loadFromPath(dir, ["desktop.control"]);
  const relay = (operation) =>
    runtime.invokePanelBridge("demo.relay", "desktop.test", { operation });

  // Allow until quit on a question answer: the next answer raises no dialog.
  assert.equal((await relay("agent/askTool/resolve")).ok, true);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].offerSession, true);
  answer = "deny";
  assert.equal((await relay("agent/askTool/resolve")).ok, true);
  assert.equal(prompts.length, 1, "a remembered answer must not prompt again");

  // Tool permissions, extension prompts, and destructive operations never
  // offer the option, and a "session" answer for them is not remembered.
  answer = "session";
  for (const operation of ["tool/resolvePermission", "extensions/ui/respond", "session/delete"]) {
    const before = prompts.length;
    assert.equal((await relay(operation)).ok, false, `${operation} must not accept "session"`);
    assert.equal(prompts.length, before + 1);
    assert.equal(prompts.at(-1).offerSession, false, `${operation} must not offer "session"`);
    answer = "once";
    assert.equal((await relay(operation)).ok, true);
    assert.equal((await relay(operation)).ok, true);
    assert.equal(prompts.length, before + 3, `${operation} must prompt every time`);
    answer = "session";
  }

  // An explicit stop drops the grant.
  await runtime.unload("demo.relay");
  await runtime.loadFromPath(dir, ["desktop.control"]);
  const before = prompts.length;
  answer = "deny";
  assert.equal((await relay("agent/askTool/resolve")).ok, false);
  assert.equal(prompts.length, before + 1, "unloading must forget the grant");
});

test("Allow once is never remembered for an Agent question answer", async (t) => {
  const prompts = [];
  const runtime = createRuntime(t, [], {
    desktopControl: {
      operations: PROMPT_ANSWER_OPERATIONS,
      invoke: async () => ({ ok: true }),
    },
    confirmDesktopControl: async (request) => {
      prompts.push(request);
      return "once";
    },
  });
  const dir = writePlugin("demo.relay.once", ["desktop.control"], RELAY_PLUGIN);
  await runtime.loadFromPath(dir, ["desktop.control"]);
  for (let i = 0; i < 2; i += 1) {
    const result = await runtime.invokePanelBridge("demo.relay.once", "desktop.test", {
      operation: "agent/askTool/resolve",
    });
    assert.equal(result.ok, true);
  }
  assert.equal(prompts.length, 2);
});
