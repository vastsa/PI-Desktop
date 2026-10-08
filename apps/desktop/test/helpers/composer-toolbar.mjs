/**
 * The production composer toolbar for slot tests: an idle agent session's
 * props, its model menu closed, rendered outside any session provider as
 * the composer is.
 */
import { createElement } from "react";

const USAGE = { inputTokens: 1_000, outputTokens: 200, totalTokens: 1_200 };
const noop = () => {};
const idle = async () => {};
const unavailable = async () => ({
  ok: false,
  error: { code: "TEST_BRIDGE_UNAVAILABLE", message: "The test bridge is unavailable" },
});

export const TOOLBAR_PROPS = {
  t: (key) => key,
  mode: "agent",
  planningLive: false,
  providerId: "provider-1",
  modelId: "model-1",
  thinkingLevel: "off",
  composerPermissionMode: "ask",
  permissionOpen: false,
  setPermissionOpen: noop,
  controlsBlocked: false,
  pasting: false,
  pickAndAttach: idle,
  configureActiveSession: idle,
  showToast: noop,
  modelMenu: {
    open: false,
    setOpen: noop,
    otherModelsExpanded: false, setOtherModelsExpanded: noop, hasOtherModels: false,
    query: "",
    setQuery: noop,
    modelHighlight: -1,
    setModelHighlight: noop,
    thinkingHighlight: -1,
    setThinkingHighlight: noop,
    modelSearchRef: { current: null },
    modelListRef: { current: null },
    thinkingListRef: { current: null },
    modelGroups: [],
    recentEntries: [],
    thinkingMenuLevels: [],
    selectModel: noop,
    commitThinkingLevel: noop,
    selectThinkingLevel: noop,
    onMenuKeyDown: noop,
  },
  modelLabel: "Model",
  thinkingLabel: "Off",
  contextUsage: { usage: USAGE, turnUsage: USAGE, contextWindow: 200_000, tools: [] },
  value: "",
  modelReady: true,
  sendBlocked: false,
  composerTransforms: [],
  activeTransformKey: null,
  undoTransform: null,
  runComposerTransform: idle,
  undoComposerTransform: noop,
  runActive: false,
  hasDraftContent: false,
  abort: idle,
  submit: idle,
};

/** A `() => html` of the toolbar, for a `slotSsr` harness. */
export async function composerToolbar(t, ssr, overrides = {}) {
  const hadWindow = "window" in globalThis;
  const { window } = globalThis;
  // The toolbar reads the shortcut platform off the preload bridge; the
  // transcript renders in this same test read `matchMedia` for reduced
  // motion, so the stand-in window answers it too.
  globalThis.window = {
    piDesktop: { platform: "darwin", invoke: unavailable, on: () => noop },
    matchMedia: () => ({ matches: false }),
    addEventListener: noop,
    removeEventListener: noop,
  };
  t.after(() => {
    if (hadWindow) globalThis.window = window;
    else delete globalThis.window;
  });
  const { ComposerToolbar } = await ssr.load("/src/features/chat/composer/ComposerToolbar.tsx");
  return () =>
    ssr.render(createElement(ComposerToolbar, { ...TOOLBAR_PROPS, ...overrides }), {
      sessionId: null,
    });
}
