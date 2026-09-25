/**
 * The production composer toolbar for slot tests: an idle agent session's
 * props, its model menu closed, rendered outside any session provider as
 * the composer is.
 */
import { createElement } from "react";

const USAGE = { inputTokens: 1_000, outputTokens: 200, totalTokens: 1_200 };
const noop = () => {};
const idle = async () => {};

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
    view: "root",
    query: "",
    setQuery: noop,
    modelHighlight: -1,
    setModelHighlight: noop,
    thinkingHighlight: -1,
    setThinkingHighlight: noop,
    rootMenuRef: { current: null },
    modelSearchRef: { current: null },
    modelListRef: { current: null },
    thinkingListRef: { current: null },
    modelGroups: [],
    thinkingMenuLevels: [],
    showView: noop,
    selectModel: noop,
    commitThinkingLevel: noop,
    selectThinkingLevel: noop,
    onMenuKeyDown: noop,
  },
  modelLabel: "Model",
  thinkingLabel: "Off",
  contextUsage: { usage: USAGE, turnUsage: USAGE, contextWindow: 200_000, tools: [] },
  enhancementDraft: "",
  value: "",
  modelReady: true,
  sendBlocked: false,
  enhancingPrompt: false,
  enhancementUndoText: null,
  enhancePrompt: idle,
  undoPromptEnhancement: noop,
  clearEnhancementError: noop,
  runActive: false,
  hasDraftContent: false,
  abort: idle,
  submit: idle,
};

/** A `() => html` of the toolbar, for a `slotSsr` harness. */
export async function composerToolbar(t, ssr) {
  const hadWindow = "window" in globalThis;
  const { window } = globalThis;
  // The toolbar reads the shortcut platform off the preload bridge.
  globalThis.window = { piDesktop: { platform: "darwin" } };
  t.after(() => {
    if (hadWindow) globalThis.window = window;
    else delete globalThis.window;
  });
  const { ComposerToolbar } = await ssr.load("/src/features/chat/composer/ComposerToolbar.tsx");
  return () => ssr.render(createElement(ComposerToolbar, TOOLBAR_PROPS), { sessionId: null });
}
