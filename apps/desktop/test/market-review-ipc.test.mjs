import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { IPC, IPC_WHITELIST } from "@pi-desktop/shared";

/**
 * The review channels are a thin pass-through: the renderer names plugin ids
 * or one query, and host-core owns the trusted origin, the five-second bound,
 * and the refusal mapping. These tests pin the bridge half of that contract.
 *
 * The module is transpiled with stubbed dependencies, the pattern the other
 * Electron IPC tests use, so the test exercises the real registration code
 * without loading unrelated main-process modules.
 */
function loadMarketIpc() {
  const file = new URL("../electron/main/ipc/market-ipc.ts", import.meta.url);
  const { outputText } = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    fileName: file.pathname,
  });
  const module = { exports: {} };
  const dependencies = {
    "@pi-desktop/shared": {
      IPC,
      ErrorCodes: {},
      trustedExtensionCommandId: (name) => `builtin.${name}`,
      trustedExtensionCommandName: () => undefined,
    },
    "../builtin-commands": { builtinPaletteItems: () => [] },
  };
  new Function("require", "exports", "module", outputText)(
    (id) => {
      assert.ok(Object.hasOwn(dependencies, id), `unexpected market IPC dependency: ${id}`);
      return dependencies[id];
    },
    module.exports,
    module,
  );
  return module.exports.registerMarketIpc;
}

function setup(responses = {}, { host = true } = {}) {
  const handlers = new Map();
  const calls = [];
  const hostProcess = {
    async call(method, params) {
      calls.push({ method, params });
      const response = responses[method];
      if (response instanceof Error) throw response;
      return typeof response === "function" ? response(params) : response ?? {};
    },
  };
  loadMarketIpc()({
    registrar: {
      handle: (channel, handler) => handlers.set(channel, handler),
    },
    getHost: () => (host ? hostProcess : null),
    plugins: {
      loadFromPath: async () => {},
      drainToasts: () => [],
      getCommands: () => [],
    },
    agentExtensions: { allCommands: () => [] },
    optionalWorkspaceRoot: async () => null,
    pluginActiveInProject: () => true,
    sendToRenderer: () => {},
  });
  const invoke = (channel, ...args) => handlers.get(channel)(...args);
  return { invoke, calls };
}

test("review channels are registered and allowed through the preload gate", () => {
  assert.equal(IPC.invoke.marketReviewSummaries, "pi-desktop/market/reviewSummaries");
  assert.equal(IPC.invoke.marketReviews, "pi-desktop/market/reviews");
  assert.equal(IPC_WHITELIST.has(IPC.invoke.marketReviewSummaries), true);
  assert.equal(IPC_WHITELIST.has(IPC.invoke.marketReviews), true);
});

test("summary reads forward the ids and return the host payload unchanged", async () => {
  const summaries = {
    "demo.hello": {
      pluginId: "demo.hello",
      ratingAvg: 4.5,
      ratingCount: 2,
      ratingDist: [0, 0, 0, 1, 1],
      positiveCount: 2,
      neutralCount: 0,
      negativeCount: 0,
    },
  };
  const { invoke, calls } = setup({ "market.reviewSummaries": { summaries } });
  assert.deepEqual(await invoke(IPC.invoke.marketReviewSummaries, { pluginIds: ["demo.hello"] }), {
    summaries,
  });
  assert.deepEqual(calls, [
    { method: "market.reviewSummaries", params: { pluginIds: ["demo.hello"] } },
  ]);
});

test("a missing or malformed id list becomes an empty request, never a crash", async () => {
  const { invoke, calls } = setup({ "market.reviewSummaries": { summaries: {} } });
  await invoke(IPC.invoke.marketReviewSummaries);
  await invoke(IPC.invoke.marketReviewSummaries, { pluginIds: "demo.hello" });
  assert.deepEqual(calls, [
    { method: "market.reviewSummaries", params: { pluginIds: [] } },
    { method: "market.reviewSummaries", params: { pluginIds: [] } },
  ]);
});

test("review reads forward the query and return the page unchanged", async () => {
  const page = {
    reviews: [
      {
        id: "r1",
        pluginId: "demo.hello",
        authorName: "Ada",
        ratingHalfStars: 9,
        body: "Great plugin",
        status: "visible",
        pluginVersion: "",
        helpfulCount: 3,
        createdAt: "2026-10-01T00:00:00Z",
        updatedAt: "2026-10-01T00:00:00Z",
        editedAt: null,
      },
    ],
    nextCursor: null,
    summary: {
      pluginId: "demo.hello",
      ratingAvg: 4.5,
      ratingCount: 1,
      ratingDist: [0, 0, 0, 1, 0],
      positiveCount: 1,
      neutralCount: 0,
      negativeCount: 0,
    },
    reviewUrl: "https://plugins.aiuo.net/plugins/demo.hello#reviews",
  };
  const query = {
    pluginId: "demo.hello",
    limit: 20,
    sentiment: "all",
    sort: "newest",
    cursor: "cursor-2",
  };
  const { invoke, calls } = setup({ "market.reviews": page });
  assert.deepEqual(await invoke(IPC.invoke.marketReviews, query), page);
  assert.deepEqual(calls, [{ method: "market.reviews", params: query }]);
});

test("an unsupported or unreachable center reaches the caller unchanged", async () => {
  const outage = Object.assign(new Error("PLUGIN_NETWORK: review request failed"), {
    data: { errorCode: "PLUGIN_NETWORK" },
  });
  const { invoke } = setup({ "market.reviews": outage });
  await assert.rejects(
    invoke(IPC.invoke.marketReviews, { pluginId: "demo.hello" }),
    (error) => error.data?.errorCode === "PLUGIN_NETWORK",
  );
});

test("review reads require a running host", async () => {
  const { invoke } = setup({}, { host: false });
  await assert.rejects(invoke(IPC.invoke.marketReviewSummaries, { pluginIds: ["demo.hello"] }), {
    message: "host unavailable",
  });
});
