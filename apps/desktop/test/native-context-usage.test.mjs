/**
 * The native context snapshot a trusted agent extension reports is the only
 * thing that may supply calibrated input budget figures to the composer's own
 * ring and window header, and only for the exact session, provider and model it
 * was reported for — without adding custom UI rows or touching i18n copy.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const shared = await import("@pi-desktop/shared");
const nativeStore = await import("../src/lib/native-context-store.ts");
const {
  clearNativeContextStore,
  nativeContextSize,
  recordExtensionStatus,
  selectNativeContextSnapshot,
  subscribeNativeContext,
} = nativeStore;
const contextUsageModule = await import("../src/lib/context-usage.ts");
const { latestTurnContextInspector } = await import("../src/lib/latest-turn-context.ts");

test.beforeEach(clearNativeContextStore);

const { formatCompactTokenCount } = shared;

const PROVIDER = "gateway";
const MODEL = "gateway-llm/chat-max";

function snapshot(overrides = {}) {
  return {
    providerId: PROVIDER,
    modelId: MODEL,
    tokens: 90_000,
    hardLimit: 200_000,
    ...overrides,
  };
}

function statusEvent(contextSnapshot, overrides = {}) {
  return {
    sessionId: "s1",
    extensionId: "ext.context-observer",
    key: "contextSnapshot",
    text: undefined,
    contextSnapshot,
    ...overrides,
  };
}

function active(overrides = {}) {
  return selectNativeContextSnapshot({
    sessionId: "s1",
    providerId: PROVIDER,
    modelId: MODEL,
    ...overrides,
  });
}

test("a snapshot is chosen only for the session, provider and model it came from", () => {
  assert.equal(recordExtensionStatus(statusEvent(snapshot())), true);
  assert.deepEqual(active(), snapshot());
  assert.equal(active({ sessionId: "s2" }), undefined);
  assert.equal(active({ providerId: "gateway-other" }), undefined);
  assert.equal(active({ modelId: "gateway-llm/chat-max-lite" }), undefined);
  assert.equal(active({ modelId: "other-route/chat-max" }), undefined);
  assert.equal(active({ modelId: "chat-max" }), undefined);
  assert.equal(active({ modelId: "gateway-llm/chat-max@experimental" }), undefined);
  assert.equal(active({ modelId: "" }), undefined);
  assert.equal(active({ sessionId: null }), undefined);
  assert.ok(
    active({ providerId: " GATEWAY ", modelId: "  Gateway-LLM/Chat-Max " }),
    "a reported snapshot must match the configured binding",
  );
});

test("a null retires one source and never another conversation", () => {
  recordExtensionStatus(statusEvent(snapshot()));
  recordExtensionStatus(statusEvent(snapshot({ tokens: 1_000 }), { sessionId: "s2" }));
  recordExtensionStatus(statusEvent(snapshot({ tokens: 2_000 }), { extensionId: "other.ext" }));
  assert.equal(active().tokens, 2_000, "the latest matching source wins");
  recordExtensionStatus(statusEvent(snapshot({ tokens: 3_000 })));
  assert.equal(active().tokens, 3_000, "re-reporting makes a source newest again");

  assert.equal(recordExtensionStatus(statusEvent(null)), true);
  assert.equal(active().tokens, 2_000, "retiring the newest source exposes the other source");
  assert.equal(
    selectNativeContextSnapshot({ sessionId: "s2", providerId: PROVIDER, modelId: MODEL }).tokens,
    1_000,
    "another conversation keeps its own snapshot",
  );
  recordExtensionStatus(statusEvent(null, { extensionId: "other.ext" }));
  assert.equal(active(), undefined, "the last source leaves nothing to show");
});

test("an unusable snapshot never replaces the composer's own figures and extra fields are stripped", () => {
  assert.equal(
    recordExtensionStatus({ sessionId: "s1", extensionId: "e", key: "working", text: "hi" }),
    false,
  );
  for (const broken of [
    { hardLimit: 0 },
    ...[Number.NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, "100"].flatMap(
      (value) => [{ tokens: value }, { hardLimit: value }],
    ),
    { modelId: "  " },
    { providerId: "" },
  ]) {
    recordExtensionStatus(statusEvent(snapshot()));
    assert.equal(recordExtensionStatus(statusEvent(snapshot(broken))), true);
    assert.equal(active(), undefined, `${JSON.stringify(broken)} must be dropped`);
  }
  const exact = snapshot({
    tokens: 0,
    hardLimit: Number.MAX_SAFE_INTEGER,
  });
  recordExtensionStatus(statusEvent({ ...exact, extraField: 123 }));
  assert.deepEqual(active(), exact, "zero and safe-integer boundary values are exact and extra fields are stripped");
});

test("the store is bounded by session and by source", () => {
  for (let index = 0; index < 40; index += 1) {
    recordExtensionStatus(statusEvent(snapshot(), { sessionId: `session-${index}` }));
  }
  const size = nativeContextSize();
  assert.ok(size.sessions <= 24, `sessions grew to ${size.sessions}`);
  assert.ok(
    selectNativeContextSnapshot({ sessionId: "session-39", providerId: PROVIDER, modelId: MODEL }),
    "the newest conversation must survive",
  );
  assert.equal(
    selectNativeContextSnapshot({ sessionId: "session-0", providerId: PROVIDER, modelId: MODEL }),
    undefined,
    "the oldest conversation must be dropped first",
  );

  clearNativeContextStore();
  for (let index = 0; index < 8; index += 1) {
    recordExtensionStatus(statusEvent(snapshot(), { extensionId: `ext-${index}` }));
  }
  assert.ok(nativeContextSize().sources <= 4, "one conversation cannot pin every extension");
  assert.equal(active().tokens, 90_000, "the newest report for a model wins");
});

test("subscribers hear a report and a retirement, not a plain status", () => {
  let notices = 0;
  const off = subscribeNativeContext(() => {
    notices += 1;
  });
  recordExtensionStatus(statusEvent(snapshot()));
  assert.equal(notices, 1);
  recordExtensionStatus(statusEvent(null));
  assert.equal(notices, 2);
  recordExtensionStatus({ sessionId: "s1", extensionId: "e", key: "working", text: "hi" });
  assert.equal(notices, 2, "a floating status must not redraw the ring");
  off();
  recordExtensionStatus(statusEvent(snapshot()));
  assert.equal(notices, 2);
});

/* --- the real component, with only its host edges stubbed ------------------ */

function loadModule(relative, imports) {
  const file = new URL(relative, import.meta.url);
  const { outputText } = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: file.pathname,
  });
  const module = { exports: {} };
  new Function("require", "exports", "module", "document", outputText)(
    (id) => {
      assert.ok(Object.hasOwn(imports, id), `unmocked dependency: ${id}`);
      return imports[id];
    },
    module.exports,
    module,
    {},
  );
  return module.exports;
}

const storeState = {
  activeSessionId: "s1",
  sessions: [{ id: "s1", providerId: PROVIDER, modelId: MODEL, updatedAt: "2026-01-01T00:00:00.000Z" }],
  messages: [],
  sessionHistory: {},
  sessionCompactions: {},
  runningSessions: {},
  isRunning: false,
  agentStatuses: {},
  settings: {},
};

const ReactOpen = {
  ...React,
  useState: (initial) => [initial === false ? true : initial, () => {}],
};
const translate = (key, values) =>
  values === undefined
    ? key
    : `${key}|${Object.keys(values)
        .sort()
        .map((name) => `${name}=${values[name]}`)
        .join(",")}`;

const reportedUsage = { inputTokens: 40_000, outputTokens: 2_000, totalTokens: 42_000 };

function renderInspector({ snapshot: native, inspector, session, display, t = translate } = {}) {
  if (native !== undefined) recordExtensionStatus(statusEvent(native));
  const state = {
    ...storeState,
    ...(session
      ? {
          activeSessionId: session.id,
          sessions: [{ ...storeState.sessions[0], ...session }],
        }
      : {}),
    settings: display ? { contextUsageDisplay: display } : {},
  };
  const useAppStore = (select) => select(state);
  const nativeHook = loadModule("../src/hooks/use-active-native-context.ts", {
    react: { useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot() },
    "../lib/native-context-store": nativeStore,
    "../stores/app-store": { useAppStore },
  });
  const module = loadModule("../src/components/ContextUsageInspector.tsx", {
    react: ReactOpen,
    "react/jsx-runtime": jsxRuntime,
    "../lib/portal-visibility": { portalToBody: (node) => node },
    "react-i18next": { useTranslation: () => ({ t }) },
    "@pi-desktop/shared": shared,
    "../stores/app-store": { useAppStore },
    "../lib/tool-display": { formatToolDuration: () => "0s" },
    "./ui": {
      TooltipButton: React.forwardRef((props, ref) =>
        React.createElement(
          "button",
          { ref, type: "button", title: props.tooltip, "aria-label": props.ariaLabel },
          props.children,
        ),
      ),
    },
    "../lib/context-usage": contextUsageModule,
    "../lib/context-inspector-position": {
      placeContextInspector: () => ({ top: 0, left: 0, maxWidth: 420 }),
    },
    "../features/chat/context-usage/useSessionTiming": {
      useSessionTiming: () => ({ timing: null, historyStatus: "idle", breakdown: undefined }),
    },
    "../features/chat/context-usage/ContextCostKpis": {
      ContextCostKpis: () => React.createElement("i", null, "test-cost-kpis"),
    },
    "../hooks/use-active-native-context": nativeHook,
  });
  return renderToStaticMarkup(
    React.createElement(
      module.ContextUsageInspector,
      inspector ?? {
        usage: reportedUsage,
        turnUsage: reportedUsage,
        contextWindow: 256_000,
        contextWindowEstimated: true,
        tools: [],
      },
    ),
  ).replace(/<!--\s*-->/g, "");
}

test("the rendered ring, heading and stock window row follow the snapshot without extra native rows", () => {
  const html = renderInspector({ snapshot: snapshot() });
  // 90K of a 200K budget: 55% remaining, 45% used on the stock window row.
  assert.match(html, /class="context-inspector-ring-value">\s*55%/);
  assert.ok(
    html.includes(`chat.usageContextLeft|count=${formatCompactTokenCount(110_000)}`),
    "the heading keeps the user's remaining preference",
  );
  assert.ok(!html.includes("usageNative"), "no extra native rows or custom headings");
  assert.ok(html.includes("chat.usageContextWindow"));
  assert.ok(
    html.includes(
      `chat.usageContextTokens|used=${formatCompactTokenCount(90_000)},window=${formatCompactTokenCount(200_000)}`,
    ),
    "the stock window row carries the calibrated budget figures without an estimated tilde",
  );
  assert.match(html, /class="context-inspector-window-percent">\s*45%/);
  // Provider figures stay untouched.
  assert.ok(html.includes("chat.usageProviderUsage"));
  assert.ok(html.includes("chat.usageTurnTotal"));
  assert.ok(html.includes("chat.usageInput 40K"));
  assert.ok(html.includes("chat.usageOutput 2K"));
  assert.ok(html.includes("test-cost-kpis"));
});

test("the used/remaining preference still decides what leads", () => {
  const html = renderInspector({ snapshot: snapshot(), display: "used" });
  assert.match(html, /class="context-inspector-ring-value">\s*45%/);
  assert.ok(html.includes(`chat.usageContextSpent|count=${formatCompactTokenCount(90_000)}`));
});

test("switching session or binding, clearing, or rejecting the only source restores the stock figures", () => {
  const assertStock = (html) => {
    assert.match(html, /class="context-inspector-ring-value">\s*84%/);
    assert.ok(
      html.includes(
        `chat.usageContextTokens|used=${formatCompactTokenCount(42_000)},window=≈ ${formatCompactTokenCount(256_000)}`,
      ),
    );
    assert.match(html, /class="context-inspector-window-percent">\s*16%/);
  };
  assertStock(renderInspector());
  assert.match(renderInspector({ snapshot: snapshot() }), /55%/);
  assertStock(renderInspector({ session: { id: "s2" } }));
  assertStock(renderInspector({ session: { id: "s1", modelId: "other-route/chat-max" } }));
  assertStock(renderInspector({ session: { id: "s1", providerId: "gateway-other" } }));
  assert.match(renderInspector(), /55%/, "switching back still finds the matching snapshot");
  assertStock(renderInspector({ snapshot: null }));
  assert.match(renderInspector({ snapshot: snapshot() }), /55%/);
  assertStock(renderInspector({ snapshot: snapshot({ hardLimit: 0 }) }));
});

test("a first turn shows the ring and stock window row without presenting zero as this turn's bill", () => {
  const providerModels = {
    [PROVIDER]: [
      {
        modelId: MODEL,
        displayName: "Gateway Chat Max",
        providerId: PROVIDER,
        contextWindow: 256_000,
        capabilities: ["text"],
        source: "discovered",
      },
    ],
  };
  const providers = [{ id: PROVIDER, models: [] }];
  assert.equal(latestTurnContextInspector([], providerModels, providers), undefined);
  const emptyUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const html = renderInspector({
    snapshot: snapshot(),
    inspector: {
      usage: emptyUsage,
      turnUsage: emptyUsage,
      contextWindow: 200_000,
      tools: [],
      responseOutputEstimated: false,
      turnUsageAvailable: false,
    },
  });
  assert.match(html, /class="context-inspector-ring-value">\s*55%/);
  assert.match(html, /role="dialog"/);
  assert.ok(
    html.includes(
      `chat.usageContextTokens|used=${formatCompactTokenCount(90_000)},window=${formatCompactTokenCount(200_000)}`,
    ),
  );
  assert.ok(!html.includes("chat.usageTurnTotal"), "zero is not this turn's bill");
  assert.ok(!html.includes("chat.usageProviderUsage"));
  assert.ok(!html.includes("test-cost-kpis"));
});
