/**
 * The three composer positions end to end through the host components that own
 * them (ADR 0294, spec 07-plugins/16 §2A.5).
 *
 * `composerControl`, `completionSource`, and `composerReference` each used to
 * register and render nowhere. These cases render the real host components —
 * `ComposerToolbar`, `ComposerAutocomplete`, `ComposerInput` — so the mount is
 * exercised where the composer draws its own controls, its own candidate rows,
 * and its own reference chips: the plugin component really appears in that
 * position, after the host's own content, with the host data and the plugin's
 * own `dispatch`.
 *
 * The store is the only mocked edge (a global singleton); the outlet, registry,
 * relay, loader, and candidate shaping are the production modules. React's
 * server renderer does not run error boundaries — it either drops the errored
 * subtree or surfaces the throw — so the containment contract is checked
 * directly against the slot boundary and the real registrations, the way the
 * E2E window run (`scripts/e2e-plugin-slots.mjs`) exercises it in a real one.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as jsxRuntime from "react/jsx-runtime";
import ts from "typescript";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

// The outlet's loader reports through the registry and the style module expects
// a document; both exist in the app. Nothing here injects a sheet.
globalThis.document = {
  head: { children: [], appendChild: (element) => element },
  createElement: () => ({
    setAttribute() {},
    getAttribute: () => null,
    remove() {},
  }),
  querySelectorAll: () => [],
};
globalThis.piDesktop = {
  invoke: async () => ({ ok: true, data: null }),
  on: () => () => {},
  channels: {},
  platform: "darwin",
};

const { pluginSlots, resetPluginSlots } = await import(
  "../src/plugins/renderer-slots/registry.ts"
);
const candidatesModule = await import("../src/plugins/renderer-slots/candidates.ts");
const loader = await import("../src/plugins/renderer-host/loader.ts");
const relay = await import("../src/plugins/renderer-host/relay.ts");
const registryModule = await import("../src/plugins/renderer-slots/registry.ts");
const shared = await import("@pi-desktop/shared");

/**
 * The one mocked edge: what the composer positions read from the shell store.
 * A server render reads whatever this hands the selector, per render.
 */
const storeState = { plugins: [], activeSessionId: "session-1" };
const storeModule = { useAppStore: (selector) => selector(storeState) };

/**
 * A slot component is compiled the way the other presentation tests load a
 * TSX module: transpiled, then run against an explicit import map, so an
 * import the test forgets is named instead of silently resolving to something
 * else.
 */
function loadTsx(relativePath, imports) {
  const file = new URL(relativePath, import.meta.url);
  const source = readFileSync(file, "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
    fileName: file.pathname,
  });
  const module = { exports: {} };
  new Function("require", "exports", "module", outputText)(
    (id) => {
      assert.ok(Object.hasOwn(imports, id), `unmocked dependency of ${relativePath}: ${id}`);
      return imports[id];
    },
    module.exports,
    module,
  );
  return module.exports;
}

const Icon = () => React.createElement("svg", { "aria-hidden": true });
const TooltipButton = ({ children, ariaLabel, tooltip, ...props }) =>
  React.createElement(
    "button",
    { ...props, "aria-label": ariaLabel ?? tooltip },
    children,
  );
/** Anchored menus portal into `document.body`, which a server render has none. */
const AnchoredMenu = ({ trigger, open, children }) =>
  React.createElement(
    "div",
    { className: "anchored-menu", "data-open": open ? "true" : "false" },
    trigger ? trigger({ current: null }) : null,
    open ? children : null,
  );

const pluginSdk = await import("@pi-desktop/plugin-sdk");
const { PluginSlot, PluginSlotBoundary, useSlotRegistrations } = loadTsx(
  "../src/plugins/renderer-slots/SlotOutlet.tsx",
  {
    react: React,
    "react/jsx-runtime": jsxRuntime,
    "@pi-desktop/plugin-sdk": pluginSdk,
    "../renderer-host/loader": loader,
    "../renderer-host/relay": relay,
    "./registry": registryModule,
  },
);

const { useRendererCandidates } = loadTsx(
  "../src/plugins/renderer-slots/use-renderer-candidates.ts",
  {
    react: React,
    "../../stores/app-store": storeModule,
    "./candidates": candidatesModule,
    "./SlotOutlet": { PluginSlot, PluginSlotBoundary },
  },
);

const outletImports = {
  react: React,
  "react/jsx-runtime": jsxRuntime,
  "@pi-desktop/plugin-sdk": pluginSdk,
  "../../../plugins/renderer-slots/SlotOutlet": { PluginSlot, useSlotRegistrations },
  "../../../plugins/renderer-slots/use-renderer-candidates": { useRendererCandidates },
  "../../../stores/app-store": storeModule,
};

const { ComposerControlSlot } = loadTsx(
  "../src/features/chat/composer/ComposerControlSlot.tsx",
  outletImports,
);
const { CompletionSourceSlot } = loadTsx(
  "../src/features/chat/composer/CompletionSourceSlot.tsx",
  outletImports,
);
const { ComposerReferenceSlot } = loadTsx(
  "../src/features/chat/composer/ComposerReferenceSlot.tsx",
  { ...outletImports, "./model": {} },
);

/**
 * The two host pieces that render as themselves inside the composer's own
 * toolbar. They are markers rather than the real components (which need the
 * store, portals and menus), but they are the *elements the host builds*: the
 * region tests below locate them inside whatever the plugin draws.
 */
const ContextDisplay = ({ contextWindow }) =>
  React.createElement("span", { className: "host-context-display" }, `context:${contextWindow}`);
const ModelPicker = ({ modelLabel }) =>
  React.createElement("span", { className: "host-model-picker" }, `model:${modelLabel}`);
const contextUsageModule = await import("../src/lib/context-usage.ts");

const { ComposerToolbar } = loadTsx(
  "../src/features/chat/composer/ComposerToolbar.tsx",
  {
    react: React,
    "react/jsx-runtime": jsxRuntime,
    "@pi-desktop/shared": shared,
    "../../../lib/bridge": { bridgePlatform: () => "darwin" },
    "../../../components/settings/AnchoredMenu": { AnchoredMenu },
    "../../../components/ContextUsageInspector": { ContextUsageInspector: ContextDisplay },
    "../../../components/ui": { TooltipButton },
    "../../../components/icons": new Proxy({}, { get: () => Icon }),
    "./ComposerModeIcon": { ModeIcon: () => null },
    "./ComposerModelPicker": { ComposerModelPicker: ModelPicker },
    "./model": {
      MODE_LABEL_KEYS: { agent: "agent", plan: "plan", goal: "goal" },
      PERMISSION_MODE_I18N_KEYS: { ask: "ask", "accept-edits": "accept-edits", auto: "auto" },
      nextMode: (mode) => mode,
    },
    "./hooks/useComposerModelMenu": {},
    "../../../lib/context-usage": contextUsageModule,
    "./ComposerControlSlot": { ComposerControlSlot },
  },
);

const { ComposerAutocomplete } = loadTsx("../src/components/ComposerAutocomplete.tsx", {
  react: React,
  "react/jsx-runtime": jsxRuntime,
  "react-i18next": { useTranslation: () => ({ t: (key) => key }) },
  "../hooks/use-composer-autocomplete": {},
  "./icons": new Proxy({}, { get: () => Icon }),
  "./settings/AnchoredMenu": { AnchoredMenu },
  "../features/chat/composer/CompletionSourceSlot": { CompletionSourceSlot },
  "@pi-desktop/shared": shared,
});

const { ComposerInput } = loadTsx("../src/features/chat/composer/ComposerInput.tsx", {
  react: React,
  "react/jsx-runtime": jsxRuntime,
  "../../../hooks/use-composer-autocomplete": {},
  "./editor": { editorSelectionRange: () => ({ start: 0, end: 0 }), readEditorValue: () => "" },
  "./ComposerReferenceSlot": { ComposerReferenceSlot },
  "./model": {},
});

const PLUGIN = {
  id: "acme.composer",
  version: "1.0.0",
  capabilities: ["renderer"],
  rendererData: ["draft"],
  rendererActions: ["ui.toast"],
};

/** Register a component for a slot under the standard plugin row. */
function registerSlot(slot, component, options) {
  storeState.plugins = [PLUGIN];
  const handle = pluginSlots.register(PLUGIN.id, slot, component, options);
  assert.notEqual(handle, null, `the ${slot} registration was refused`);
  return handle;
}

function reset({ plugins = [], sessionId = "session-1" } = {}) {
  resetPluginSlots();
  loader.resetRendererPlugins();
  relay.resetRendererRelay();
  storeState.plugins = plugins;
  storeState.activeSessionId = sessionId;
}

/** Every plugin container in a markup string, in document order. */
function containers(markup) {
  return [
    ...markup.matchAll(
      /<div [^>]*class="pi-plugin-slot"[^>]*data-pi-plugin="([^"]*)"[^>]*>/g,
    ),
  ].map((match) => match[0]);
}

/* ---------- composerControl ---------- */
/** The composer's own context props, in the shape Composer hands the toolbar. */
const CONTEXT_USAGE = {
  usage: { inputTokens: 1_000, outputTokens: 200, totalTokens: 1_200 },
  turnUsage: { inputTokens: 1_000, outputTokens: 200, totalTokens: 1_200 },
  contextWindow: 200_000,
  tools: [],
};


function renderToolbar({
  draft = "hello",
  sessionId = "session-1",
  contextUsage = null,
  enhancementUndoText = null,
} = {}) {
  storeState.activeSessionId = sessionId;
  return renderToStaticMarkup(
    React.createElement(ComposerToolbar, {
      t: (key) => key,
      mode: "agent",
      planningLive: false,
      providerId: "provider-1",
      modelId: "model-1",
      thinkingLevel: "off",
      composerPermissionMode: "ask",
      permissionOpen: false,
      setPermissionOpen: () => {},
      controlsBlocked: false,
      pasting: false,
      pickAndAttach: async () => {},
      configureActiveSession: async () => {},
      showToast: () => {},
      modelMenu: { open: false, setOpen: () => {} },
      modelLabel: "Model",
      thinkingLabel: "off",
      contextUsage,
      enhancementDraft: draft,
      value: draft,
      modelReady: true,
      sendBlocked: false,
      enhancingPrompt: false,
      enhancementUndoText,
      enhancePrompt: async () => {},
      undoPromptEnhancement: () => {},
      clearEnhancementError: () => {},
      runActive: false,
      hasDraftContent: true,
      abort: async () => {},
      submit: async () => {},
    }),
  );
}

let composerControlProps = [];

test("a composerControl plugin draws in both control rows, after the host's own controls", async () => {
  reset();
  composerControlProps = [];
  const remove = relay.registerHostRendererAction("ui.toast", (payload, pluginId) => ({
    payload,
    pluginId,
  }));
  registerSlot("composerControl", (props) => {
    composerControlProps.push(props);
    return React.createElement("span", { className: "acme-control" }, props.position);
  });

  const markup = renderToolbar({ draft: "hello world" });
  const [left, right] = containers(markup);
  assert.ok(left && right, "the plugin drew in both control rows");
  assert.match(left, /data-pi-plugin="acme\.composer"/);
  assert.match(left, /data-pi-plugin-slot="composerControl"/);
  assert.match(left, /data-pi-control-position="left"/);
  assert.match(right, /data-pi-control-position="right"/);

  // Position, not luck: the left mount is inside the left row, the right mount
  // inside the right one, and each row's own controls are already before it.
  assert.ok(markup.indexOf('class="composer-left"') < markup.indexOf(left));
  assert.ok(markup.indexOf(left) < markup.indexOf('class="composer-right"'));
  assert.ok(markup.indexOf('class="composer-right"') < markup.indexOf(right));
  assert.ok(
    markup.indexOf('class="send-btn"') < markup.indexOf(right),
    "the host's send control stays ahead of the plugin's right-position control",
  );
  assert.ok(
    markup.indexOf("composer-mode-chip") < markup.indexOf(left),
    "the host's own left controls stay ahead of the plugin's",
  );

  // The contract's host data, and nothing else.
  assert.deepEqual(
    composerControlProps.map((props) => props.position),
    ["left", "right"],
  );
  assert.equal(composerControlProps[0].draft, "hello world");
  assert.equal(composerControlProps[0].sessionId, "session-1");
  assert.deepEqual(Object.keys(composerControlProps[0]).sort(), [
    "dispatch",
    "draft",
    "position",
    "sessionId",
  ]);

  // A declared action runs in the host under the plugin's own id; an undeclared
  // one is a coded refusal, never a silent no-op.
  assert.deepEqual(await composerControlProps[0].dispatch("ui.toast", { message: "hi" }), {
    payload: { message: "hi" },
    pluginId: "acme.composer",
  });
  await assert.rejects(
    () => composerControlProps[1].dispatch("composer.replaceDraft", { text: "x" }),
    (error) => error.code === "PLUGIN_ACTION_UNDECLARED",
  );
  remove();
});

test("a draft with no session reports no sessionId at all", () => {
  reset();
  composerControlProps = [];
  registerSlot("composerControl", (props) => {
    composerControlProps.push(props);
    return null;
  });
  const markup = renderToolbar({ sessionId: null });
  assert.deepEqual(composerControlProps.map((props) => props.position), ["left", "right"]);
  assert.equal(Object.hasOwn(composerControlProps[0], "sessionId"), false);
  // Both positions still carry the plugin's container; what the component drew
  // inside it is what stays empty.
  assert.equal(containers(markup).length, 2);
});

test("with nothing registered for composerControl the toolbar is byte-identical", () => {
  reset();
  const contextUsage = CONTEXT_USAGE;
  const enhancementUndoText = "older draft";
  const bare = renderToolbar({ contextUsage, enhancementUndoText });
  registerSlot("entry", () => React.createElement("span", null, "elsewhere"));
  const withAnotherSlot = renderToolbar({ contextUsage, enhancementUndoText });
  assert.equal(withAnotherSlot, bare);
  assert.doesNotMatch(bare, /data-pi-plugin/);
  assert.match(bare, /class="composer-left"/);
  assert.match(bare, /class="send-btn"/);
  // The region nobody holds is the host's own drawing of it: its three pieces
  // in the host's own order, each exactly once, immediately left of Send.
  assert.doesNotMatch(bare, /data-pi-control-position/);
  const order = [
    'class="host-context-display"',
    'class="host-model-picker"',
    "composer-enhance-btn",
    "composer-enhance-undo",
    'class="send-btn"',
  ].map((needle) => bare.indexOf(needle));
  assert.ok(order.every((index) => index > 0), `host region pieces in order: ${JSON.stringify(order)}`);
  assert.ok(order.every((index, position) => position === 0 || order[position - 1] < index));
  assert.equal((bare.match(/host-model-picker/g) ?? []).length, 1);
  assert.equal((bare.match(/host-context-display/g) ?? []).length, 1);
  assert.equal((bare.match(/composer-enhance-btn/g) ?? []).length, 1);
});

/* ---------- composerControl: the region left of Send ---------- */

let regionProps = [];

/**
 * The occupying component: it renders all three handed pieces, in its own
 * order, and adds a button of its own beside them.
 */
function RegionControl(props) {
  regionProps.push(props);
  const pieces = {
    model: props.modelControl,
    context: props.contextControl,
    enhance: props.enhanceControl,
  };
  return React.createElement("span", { className: "acme-region" }, [
    ...["enhance", "model", "context"].map((name) =>
      React.createElement("span", { key: name, "data-pi-piece": name }, [
        pieces[name],
        React.createElement("span", { key: "own" }, `own-${name}`),
      ]),
    ),
    React.createElement("button", { key: "own", type: "button" }, "plugin-own-control"),
  ]);
}

test("the region left of Send is handed over whole, and the plugin's order is what renders", () => {
  reset();
  regionProps = [];
  registerSlot("composerControl", RegionControl, { positions: ["beforeSend"] });
  const markup = renderToolbar({
    draft: "hello world",
    contextUsage: CONTEXT_USAGE,
    enhancementUndoText: "older draft",
  });

  const [region] = containers(markup);
  assert.ok(region, "the plugin drew in the region");
  assert.match(region, /data-pi-plugin-slot="composerControl"/);
  assert.match(region, /data-pi-control-position="beforeSend"/);
  // One mount only: a registration that declared `beforeSend` is not asked for
  // the two control rows as well.
  assert.equal(containers(markup).length, 1);
  const sendIndex = markup.indexOf('class="send-btn"');
  assert.ok(markup.indexOf('class="composer-right"') < markup.indexOf(region));
  assert.ok(markup.indexOf(region) < sendIndex, "the region sits left of the send control");
  assert.doesNotMatch(
    markup.slice(markup.indexOf(region), sendIndex),
    /data-pi-control-position="right"/,
  );

  // The plugin's order, not the host's (the host draws context, model, enhance).
  const order = ["enhance", "model", "context"].map((name) =>
    markup.indexOf(`data-pi-piece="${name}"`),
  );
  assert.ok(order[0] > 0 && order[0] < order[1] && order[1] < order[2]);
  assert.equal((markup.match(/data-pi-piece="/g) ?? []).length, 3);
  // And every host piece is drawn exactly once, inside the plugin's own row:
  // the host does not draw a second copy of what the plugin rendered.
  assert.equal((markup.match(/host-context-display/g) ?? []).length, 1);
  assert.equal((markup.match(/host-model-picker/g) ?? []).length, 1);
  assert.equal((markup.match(/composer-enhance-btn/g) ?? []).length, 1);
  assert.equal((markup.match(/composer-enhance-undo/g) ?? []).length, 1);
  assert.match(markup, /plugin-own-control/);

  // The nodes are the host's own elements, and the data is the host's own.
  assert.deepEqual(regionProps.map((props) => props.position), ["beforeSend"]);
  assert.equal(regionProps[0].draft, "hello world");
  assert.equal(regionProps[0].sessionId, "session-1");
  assert.deepEqual(Object.keys(regionProps[0]).sort(), [
    "contextControl",
    "contextUsage",
    "dispatch",
    "draft",
    "enhanceControl",
    "enhancement",
    "modelControl",
    "modelSelection",
    "position",
    "sessionId",
  ]);
  assert.equal(regionProps[0].modelControl.type, ModelPicker);
  assert.equal(regionProps[0].contextControl.type, ContextDisplay);
  const enhanceChildren = React.Children.toArray(regionProps[0].enhanceControl.props.children);
  assert.equal(enhanceChildren.length, 2, "the enhancement node carries the control and its undo");
  assert.match(enhanceChildren[0].props.className, /composer-enhance-btn/);
  assert.match(enhanceChildren[1].props.className, /composer-enhance-undo/);
  assert.deepEqual(regionProps[0].modelSelection, {
    providerId: "provider-1",
    modelId: "model-1",
    label: "Model",
    thinkingLevel: "off",
    thinkingLabel: "off",
    ready: true,
  });
  assert.deepEqual(regionProps[0].contextUsage, {
    ...contextUsageModule.calculateContextUsage(CONTEXT_USAGE.usage, 200_000),
    contextWindow: 200_000,
  });
  assert.deepEqual(regionProps[0].enhancement, {
    enabled: true,
    busy: false,
    undoText: "older draft",
  });
  assert.equal(typeof regionProps[0].dispatch, "function");
});

test("with no measured turn the region is still handed over, with an empty context piece", () => {
  reset();
  regionProps = [];
  registerSlot("composerControl", RegionControl, { positions: ["beforeSend"] });
  const markup = renderToolbar({ contextUsage: null });
  assert.equal(regionProps.length, 1);
  assert.equal(regionProps[0].contextControl, null);
  assert.equal(regionProps[0].contextUsage, null);
  assert.equal(regionProps[0].modelControl.type, ModelPicker);
  assert.equal(regionProps[0].enhancement.undoText, null);
  assert.equal((markup.match(/host-model-picker/g) ?? []).length, 1);
  assert.equal((markup.match(/host-context-display/g) ?? []).length, 0);
  assert.equal(containers(markup).length, 1);
});

test("a registration that declared no positions keeps the two rows and never draws in the region", () => {
  reset();
  composerControlProps = [];
  registerSlot("composerControl", (props) => {
    composerControlProps.push(props);
    return React.createElement("span", { className: "acme-control" }, props.position);
  });
  const markup = renderToolbar({
    contextUsage: CONTEXT_USAGE,
    enhancementUndoText: "older draft",
  });
  assert.deepEqual(composerControlProps.map((props) => props.position), ["left", "right"]);
  // The handover keys exist at `beforeSend` and nowhere else: the rows' contract
  // is exactly what it was.
  assert.deepEqual(Object.keys(composerControlProps[0]).sort(), [
    "dispatch",
    "draft",
    "position",
    "sessionId",
  ]);
  assert.equal(containers(markup).length, 2);
  assert.doesNotMatch(markup, /data-pi-control-position="beforeSend"/);
  // With nobody holding the region the host draws its own three pieces, in its
  // own order, each exactly once.
  assert.equal((markup.match(/host-model-picker/g) ?? []).length, 1);
  assert.equal((markup.match(/host-context-display/g) ?? []).length, 1);
  assert.equal((markup.match(/composer-enhance-btn/g) ?? []).length, 1);
  const contextIndex = markup.indexOf('class="host-context-display"');
  const modelIndex = markup.indexOf('class="host-model-picker"');
  const enhanceIndex = markup.indexOf("composer-enhance-btn");
  const sendIndex = markup.indexOf('class="send-btn"');
  assert.ok(contextIndex < modelIndex && modelIndex < enhanceIndex && enhanceIndex < sendIndex);
});

test("beforeSend is one claim, and its positions must come from the published vocabulary", () => {
  reset();
  registerSlot("composerControl", RegionControl, { positions: ["beforeSend"] });
  const refused = pluginSlots.register("acme.second", "composerControl", RegionControl, {
    positions: ["beforeSend"],
  });
  assert.equal(refused, null, "a second claim on the region is refused, never stacked");
  assert.deepEqual(
    pluginSlots.listDiagnostics("acme.second").map((entry) => [entry.code, entry.detail]),
    [
      [
        "PLUGIN_SLOT_DUPLICATE",
        "the beforeSend composer position is already claimed by acme.composer",
      ],
    ],
  );
  const invalid = pluginSlots.register("acme.third", "composerControl", RegionControl, {
    positions: ["left", "top"],
  });
  assert.equal(invalid, null, "a position outside the vocabulary is refused, not interpreted");
  assert.equal(
    pluginSlots.listDiagnostics("acme.third")[0].code,
    "PLUGIN_SLOT_INVALID_POSITION",
  );
  assert.deepEqual(
    pluginSlots.list("composerControl").map((entry) => [entry.pluginId, entry.positions]),
    [["acme.composer", ["beforeSend"]]],
  );
  const markup = renderToolbar({ contextUsage: CONTEXT_USAGE });
  assert.equal(containers(markup).length, 1);
  assert.match(markup, /data-pi-plugin="acme\.composer"/);
});

/* ---------- completionSource ---------- */

const commandItem = {
  kind: "command",
  command: { kind: "builtin", name: "help", title: "Help" },
  match: { score: 10, ranges: [[0, 2]] },
};

function renderPopover({ mode = "slash", query = "he", items = [commandItem], open = true,
  sessionId = "session-1", acceptText = () => true } = {}) {
  return renderToStaticMarkup(
    React.createElement(ComposerAutocomplete, {
      anchorRef: { current: null },
      ac: {
        open,
        sessionId,
        mode: open ? mode : null,
        query: open ? query : "",
        items: open ? items : [],
        hasItems: open && items.length > 0,
        highlight: 0,
        setHighlight: () => {},
        truncated: false,
        noWorkspace: false,
        close: () => {},
        accept: () => null,
      },
      onAccept: () => {},
      onAcceptText: acceptText,
    }),
  );
}

let completionProps = [];

test("a completionSource plugin adds candidates for the current query after the host's own rows", () => {
  reset();
  completionProps = [];
  registerSlot("completionSource", (props) => {
    completionProps.push(props);
    return React.createElement("button", { className: "acme-candidate" }, "acme: help");
  });

  const accepted = [];
  const acceptText = (text) => { accepted.push(text); return true; };
  const markup = renderPopover({ mode: "slash", query: "he", acceptText });
  const [container] = containers(markup);
  assert.ok(container, "the plugin drew a candidate inside the popover");
  assert.match(container, /data-pi-plugin-slot="completionSource"/);
  assert.match(container, /data-pi-completion-mode="slash"/);
  assert.ok(
    markup.indexOf('data-ac-index="0"') < markup.indexOf(container),
    "the host's own row keeps its place ahead of the plugin's candidates",
  );
  assert.match(markup, /acme-candidate/);

  // The host owns the query, session identity and acceptance callback.
  assert.deepEqual(
    completionProps.map((props) => ({ mode: props.mode, query: props.query })),
    [{ mode: "slash", query: "he" }],
  );
  assert.deepEqual(Object.keys(completionProps[0]).sort(), ["acceptText", "dispatch", "mode", "query", "sessionId"]);
  assert.equal(typeof completionProps[0].dispatch, "function");
  assert.equal(completionProps[0].sessionId, "session-1");
  assert.equal(completionProps[0].acceptText, acceptText);
  assert.equal(completionProps[0].acceptText("@session:chosen "), true);
  assert.deepEqual(accepted, ["@session:chosen "]);
});

test("the file trigger is reported as its own mode, and the popover is only asked while open", () => {
  reset();
  completionProps = [];
  registerSlot("completionSource", (props) => {
    completionProps.push(props);
    return null;
  });
  renderPopover({ mode: "file", query: "src/" });
  assert.deepEqual(
    completionProps.map((props) => ({ mode: props.mode, query: props.query })),
    [{ mode: "file", query: "src/" }],
  );

  completionProps = [];
  renderPopover({ open: false });
  assert.deepEqual(completionProps, [], "a closed popover asks a plugin for nothing");
});

test("with no host matches the popover keeps its own message and still offers plugin candidates", () => {
  reset();
  completionProps = [];
  registerSlot("completionSource", (props) => {
    completionProps.push(props);
    return React.createElement("span", { className: "acme-candidate" }, "acme");
  });
  const markup = renderPopover({ items: [] });
  assert.match(markup, /composer-model-empty/);
  assert.match(markup, /chat\.slashEmpty/);
  assert.match(markup, /acme-candidate/);
  assert.equal(completionProps.length, 1);
});

test("with nothing registered for completionSource the popover is byte-identical", () => {
  reset();
  const bare = renderPopover();
  registerSlot("toolCard", () => React.createElement("span", null, "elsewhere"));
  assert.equal(renderPopover(), bare);
  assert.doesNotMatch(bare, /data-pi-plugin/);
  assert.match(bare, /data-ac-index="0"/);
});

/* ---------- composerReference ---------- */

const fileReference = { path: "src/index.ts", name: "index.ts", kind: "file" };
const imageReference = {
  path: "/tmp/photo.png",
  name: "photo.png",
  kind: "image",
  mimeType: "image/png",
  token: "\uE001",
};

function renderInput({
  value = "notes \uE001",
  fileReferences = [fileReference],
  sessionId = "session-1",
} = {}) {
  storeState.activeSessionId = sessionId;
  return renderToStaticMarkup(
    React.createElement(ComposerInput, {
      inputRef: { current: null },
      value,
      fileReferences,
      placeholderText: "Ask anything",
      placeholderKey: "home-0-Ask anything",
      inputBlocked: false,
      pasting: false,
      enterToSend: true,
      runActive: false,
      composerAc: {
        open: false,
        items: [],
        hasItems: false,
        highlight: 0,
        setHighlight: () => {},
        close: () => {},
      },
      onPaste: () => {},
      onAcceptCompletion: () => {},
      onSubmit: () => {},
      onInsertNewline: () => {},
      onInput: () => {},
      onCompositionStart: () => {},
      onCompositionEnd: () => {},
      onFocus: () => {},
      onBlur: () => {},
    }),
  );
}

let referenceProps = [];

test("a composerReference plugin draws its chip after the host's own chips, with the host's chip data", async () => {
  reset();
  referenceProps = [];
  const remove = relay.registerHostRendererAction("ui.toast", () => "shown");
  registerSlot("composerReference", (props) => {
    referenceProps.push(props);
    return React.createElement("span", { className: "acme-chip" }, "acme chip");
  });

  const markup = renderInput({ value: "notes \uE001", fileReferences: [fileReference, imageReference] });
  const [container] = containers(markup);
  assert.ok(container, "the plugin drew a chip in the composer's input surface");
  assert.match(container, /data-pi-plugin-slot="composerReference"/);
  assert.match(container, /data-pi-reference-count="2"/);
  assert.ok(
    markup.indexOf('class="composer-input"') < markup.indexOf(container),
    "the host's own editor (and the chips it paints) comes first",
  );
  assert.match(markup, /acme-chip/);

  assert.equal(referenceProps.length, 1);
  assert.equal(referenceProps[0].draft, "notes \uE001");
  assert.equal(referenceProps[0].sessionId, "session-1");
  // Path, name, and kind only: the sentinel token a chip is painted from stays
  // host-owned, so a plugin cannot forge or move a host chip.
  assert.deepEqual(referenceProps[0].references, [
    { path: "src/index.ts", name: "index.ts", kind: "file" },
    { path: "/tmp/photo.png", name: "photo.png", kind: "image" },
  ]);
  assert.deepEqual(Object.keys(referenceProps[0].references[1]).sort(), [
    "kind",
    "name",
    "path",
  ]);
  assert.equal(await referenceProps[0].dispatch("ui.toast", { message: "hi" }), "shown");
  remove();
});

test("a draft with no session and no chips reports neither, and the input surface stays identical", () => {
  reset();
  referenceProps = [];
  registerSlot("composerReference", (props) => {
    referenceProps.push(props);
    return null;
  });
  const markup = renderInput({ value: "", fileReferences: [], sessionId: null });
  assert.equal(Object.hasOwn(referenceProps[0], "sessionId"), false);
  assert.deepEqual(referenceProps[0].references, []);
  assert.equal(containers(markup).length, 1);
  assert.match(markup, /class="composer-input"/);
  assert.match(markup, /Ask anything/);
});

test("with nothing registered for composerReference the input surface is byte-identical", () => {
  reset();
  const bare = renderInput();
  registerSlot("entryExtra", () => React.createElement("span", null, "elsewhere"));
  assert.equal(renderInput(), bare);
  assert.doesNotMatch(bare, /data-pi-plugin/);
});

/* ---------- containment, and the host wiring ---------- */

test("a throwing plugin at any composer position is reported by the slot boundary, which takes that position back", () => {
  reset();
  // Every position is wrapped by the same boundary (SlotOutlet), so the
  // contract is checked once per slot against the real registration.
  for (const slot of ["composerControl", "completionSource", "composerReference"]) {
    registerSlot(slot, () => {
      throw new Error(`boom from ${slot}`);
    });
  }
  for (const slot of ["composerControl", "completionSource", "composerReference"]) {
    const [registration] = pluginSlots.list(slot);
    const boundary = new PluginSlotBoundary({
      registration,
      fallback: "HOST-OWN",
      children: "PLUGIN",
    });
    assert.deepEqual(PluginSlotBoundary.getDerivedStateFromError(), { failed: true });
    boundary.state = { failed: true };
    // D10: a crashed plugin loses the position instead of leaving a hole — the
    // host's own rendering for it (here: the composer's own controls, rows, and
    // chips, which sit outside the outlet) stays.
    assert.equal(boundary.render(), "HOST-OWN");
    boundary.componentDidCatch(new Error(`boom from ${slot}`));
  }
  assert.deepEqual(
    pluginSlots
      .listDiagnostics()
      .filter((entry) => entry.code === "PLUGIN_SLOT_RENDER_FAILED")
      .map((entry) => [entry.pluginId, entry.slot, entry.detail]),
    [
      ["acme.composer", "composerControl", "boom from composerControl"],
      ["acme.composer", "completionSource", "boom from completionSource"],
      ["acme.composer", "composerReference", "boom from composerReference"],
    ],
  );

  // And a throw is never swallowed: the host surface never silently draws
  // nothing in that plugin's place.
  assert.throws(() => renderToolbar(), /boom from composerControl/);
});

test("the composer passes the draft's own reference chips to the position that needs them", () => {
  const composer = readFileSync(
    new URL("../src/components/Composer.tsx", import.meta.url),
    "utf8",
  );
  const input = readFileSync(
    new URL("../src/features/chat/composer/ComposerInput.tsx", import.meta.url),
    "utf8",
  );
  // The draft's live chips are the host data this position promises, and they
  // are not in the store: the facade hands them to the component that renders
  // the input surface, which mounts the slot next to them.
  assert.match(composer, /fileReferences=\{activeFileReferences\}/);
  assert.match(input, /<ComposerReferenceSlot fileReferences=\{fileReferences\} draft=\{value\} \/>/);
});

test("the three positions are mounted through the one outlet, with a way for the plugin to act", () => {
  for (const [slot, component] of [
    ["composerControl", "../src/features/chat/composer/ComposerControlSlot.tsx"],
    ["completionSource", "../src/features/chat/composer/CompletionSourceSlot.tsx"],
    ["composerReference", "../src/features/chat/composer/ComposerReferenceSlot.tsx"],
  ]) {
    const source = readFileSync(new URL(component, import.meta.url), "utf8");
    assert.match(source, new RegExp(`slot="${slot}"`));
    assert.match(source, /<PluginSlot/);
    // No hand-wired copy of the outlet: loading, dispatch, the boundary, and
    // the container contract stay in one place.
    assert.doesNotMatch(source, /slotDispatchFor|PluginSlotBoundary/);
    assert.match(source, /useRendererCandidates\(\)/);
  }
});
