import i18n from "i18next";
import { en } from "@pi-desktop/i18n";
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { useAppStore, materializeDraftSession } = await import("../src/stores/app-store.ts");
const { api } = await import("../src/lib/api.ts");
const { runPaletteCommand } = await import("../src/lib/commands.ts");
const { sessionFastModeActive } = await import("../src/lib/fast-mode-command.ts");

// ADR 0334: `/fast` is a per-session switch, and model settings decide which
// models may use it.

await i18n.init({ lng: "en", keySeparator: false, resources: { en: { translation: flatten(en) } } });

function flatten(catalog, prefix = "", out = {}) {
  for (const [key, value] of Object.entries(catalog)) {
    if (value && typeof value === "object") flatten(value, `${prefix}${key}.`, out);
    else out[`${prefix}${key}`] = value;
  }
  return out;
}

const codex = {
  id: "codex", name: "ChatGPT", enabled: true, hasSecret: true, authKind: "oauth", apiStyle: "openai_codex_responses",
  models: [{ id: "gpt-codex", fastModeAllowed: true }, { id: "gpt-mini" }],
};
const relay = {
  id: "relay", name: "Relay", enabled: true, hasSecret: true, authKind: "api_key", apiStyle: "responses",
  models: [{ id: "gpt-relay", fastModeAllowed: true }],
};
const completions = {
  id: "completions", name: "Gateway", enabled: true, hasSecret: true, authKind: "api_key", apiStyle: "chat_completions",
  models: [{ id: "chat", fastModeAllowed: true }],
};
const session = (provider, modelId, extra = {}) => ({
  id: "s1", title: "Task", messageCount: 0, mode: "agent", thinkingLevel: "medium", permissionMode: "inherit",
  providerId: provider.id, modelId, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", ...extra,
});

function setup(t, state) {
  const toasts = [];
  const configures = [];
  const creates = [];
  t.mock.method(api, "configureSession", async (id, config) => {
    configures.push(config);
    return { session: { ...useAppStore.getState().sessions.find((item) => item.id === id), ...config, id } };
  });
  t.mock.method(api, "createSession", async (config) => {
    creates.push(config);
    return { session: { ...config, id: "created", title: "New task", messageCount: 0, messages: [] } };
  });
  useAppStore.setState({
    providers: [codex, relay, completions],
    sessions: [],
    activeSessionId: null,
    runningSessions: {},
    pendingPlans: {},
    recentModels: [],
    draftConfiguration: null,
    workspace: null,
    settings: { defaultProviderId: codex.id, defaultModelId: "gpt-codex", defaultMode: "agent" },
    showToast: (message, options) => { toasts.push({ message, variant: options?.variant }); },
    ...state,
  });
  return { toasts, configures, creates };
}

test("/fast toggles an allowed subscription model's session through session.configure", async (t) => {
  const { toasts, configures } = setup(t, { sessions: [session(codex, "gpt-codex")], activeSessionId: "s1" });
  await runPaletteCommand("builtin.session.fast");
  assert.equal(configures.length, 1);
  assert.equal(configures[0].fastMode, true);
  assert.equal(configures[0].thinkingLevel, "medium", "other selections are resent unchanged");
  assert.equal(useAppStore.getState().sessions[0].fastMode, true);
  assert.equal(toasts[0].message, en.chat.fastModeOn);

  await runPaletteCommand("builtin.session.fast");
  assert.equal(configures[1].fastMode, false);
  assert.equal(useAppStore.getState().sessions[0].fastMode, false);
  assert.equal(toasts[1].message, en.chat.fastModeOff);
});

test("/fast on a per-token Responses model warns about the price", async (t) => {
  const { toasts, configures } = setup(t, { sessions: [session(relay, "gpt-relay")], activeSessionId: "s1" });
  await runPaletteCommand("builtin.session.fast");
  assert.equal(configures[0].fastMode, true);
  assert.equal(toasts[0].message, en.chat.fastModeOnUsage);
});

test("/fast refuses a model the user has not allowed, and a wire without the tier", async (t) => {
  const notAllowed = setup(t, { sessions: [session(codex, "gpt-mini")], activeSessionId: "s1" });
  await runPaletteCommand("builtin.session.fast");
  assert.equal(notAllowed.configures.length, 0);
  assert.deepEqual(notAllowed.toasts, [{ message: en.chat.fastModeNotAllowed, variant: "warning" }]);

  const unsupported = setup(t, { sessions: [session(completions, "chat")], activeSessionId: "s1" });
  await runPaletteCommand("builtin.session.fast");
  assert.equal(unsupported.configures.length, 0);
  assert.deepEqual(unsupported.toasts, [{ message: en.chat.fastModeUnsupported, variant: "warning" }]);
});

test("/fast points to model settings instead of toggling a stale switch on an unconfigured model", async (t) => {
  const { configures, toasts } = setup(t, {
    sessions: [session(codex, "gpt-mini", { fastMode: true })],
    activeSessionId: "s1",
  });
  await runPaletteCommand("builtin.session.fast");
  assert.equal(configures.length, 0);
  assert.deepEqual(toasts, [{ message: en.chat.fastModeNotAllowed, variant: "warning" }]);
});

test("/fast refuses remote sessions", async (t) => {
  const { configures, toasts } = setup(t, {
    sessions: [session(codex, "gpt-codex", { id: "remote:host:s1", source: "remote" })],
    activeSessionId: "remote:host:s1",
  });
  await runPaletteCommand("builtin.session.fast");
  assert.equal(configures.length, 0);
  assert.equal(toasts[0].message, en.chat.fastModeRemote);
});

test("/fast on the new-task draft carries the switch into the created session", async (t) => {
  const { configures, creates } = setup(t, {});
  await runPaletteCommand("builtin.session.fast");
  assert.equal(configures.length, 0);
  assert.deepEqual(useAppStore.getState().draftConfiguration, { fastMode: true });

  // Choosing a model on the draft keeps the switch.
  await useAppStore.getState().configureActiveSession({
    mode: "agent", providerId: codex.id, modelId: "gpt-codex", thinkingLevel: "high",
  });
  assert.equal(useAppStore.getState().draftConfiguration.fastMode, true);

  await materializeDraftSession();
  assert.equal(creates.length, 1);
  assert.equal(creates[0].fastMode, true);
  assert.equal(creates[0].thinkingLevel, "high");
});

test("a draft without /fast creates a session on the default tier and default thinking", async (t) => {
  const { creates } = setup(t, {});
  await materializeDraftSession();
  assert.equal(creates.length, 1);
  assert.equal("fastMode" in creates[0], false);
});

test("the Composer marks Fast only when the switch is on for an allowed model", () => {
  assert.equal(sessionFastModeActive(codex, "gpt-codex", { fastMode: true }), true);
  assert.equal(sessionFastModeActive(codex, "gpt-codex", { fastMode: false }), false);
  assert.equal(sessionFastModeActive(codex, "gpt-mini", { fastMode: true }), false);
  assert.equal(sessionFastModeActive(completions, "chat", { fastMode: true }), false);
  assert.equal(sessionFastModeActive(undefined, undefined, { fastMode: true }), false);
});
