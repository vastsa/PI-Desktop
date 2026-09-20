import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { I18nextProvider } from "react-i18next";
import { en } from "@pi-desktop/i18n";
import { Composer } from "../../apps/desktop/src/components/Composer";
import {
  materializeDraftSession,
  useAppStore,
} from "../../apps/desktop/src/stores/app-store";
import { api } from "../../apps/desktop/src/lib/api";

// Real Composer, hooks, store and coordination; only the host API is a fixture.
const storageKey = "pi.desktop.composerModelPreferences.v1";
const providers = ["alpha", "beta"].map((id) => ({
  id,
  name: `Fixture ${id}`,
  enabled: true,
  authKind: "none",
  hasSecret: false,
  supportsReasoning: true,
  supportedThinkingLevels: ["low", "high"],
  models: [
    {
      id: `${id}-model`,
      thinkingLevels: ["low", "high"],
      defaultThinkingLevel: "high",
    },
  ],
}));
const settings = {
  defaultMode: "agent",
  defaultProviderId: "alpha",
  defaultModelId: "alpha-model",
  defaultPermissionMode: "ask",
};
let sequence = 0;
let failConfigure = false;
let holdConfigure;
const sessions = new Map();
api.composerCommands = async () => ({ commands: [] });
api.listProviderModels = async () => ({ models: [] });
api.createSession = async (config) => {
  const session = {
    id: `fixture-${++sequence}`,
    title: "New task",
    createdAt: sequence,
    updatedAt: sequence,
    messageCount: 0,
    permissionMode: "inherit",
    ...config,
  };
  sessions.set(session.id, session);
  return { session };
};
api.configureSession = async (id, config) => {
  if (failConfigure) throw new Error("Fixture configuration rejected");
  if (holdConfigure) await holdConfigure;
  const session = { ...sessions.get(id), ...config };
  sessions.set(id, session);
  return { session };
};
api.pendingPlans = async () => ({ plans: [], state: "inactive" });
api.getSession = async (id) => ({
  session: { ...sessions.get(id), messages: [] },
});
api.getSessionCollaboration = async () => ({
  sessionId: "fixture",
  messages: [],
  peers: [],
});

const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const settle = () =>
  new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve)),
  );
async function until(predicate, message) {
  for (let frame = 0; frame < 120; frame += 1) {
    if (predicate()) return;
    await settle();
  }
  throw new Error(message);
}
const current = () => {
  const state = useAppStore.getState();
  return state.sessions.find((session) => session.id === state.activeSessionId);
};
const click = async (selector) => {
  const button = document.querySelector(selector);
  check(button && !button.disabled, `Missing enabled control: ${selector}`);
  button.click();
  await settle();
};
async function model(id) {
  if (!document.querySelector(".composer-menu-root"))
    await click(".composer-model-thinking-chip");
  await click(".composer-menu-entry");
  await click(`.composer-model-option[title='${id}']`);
  await until(() => current()?.modelId === id, "model choice not applied");
}
async function thinking(level) {
  if (!document.querySelector(".composer-menu-root"))
    await click(".composer-model-thinking-chip");
  await click(".composer-menu-entry:nth-child(2)");
  const option = [...document.querySelectorAll("[data-thinking-index]")].find(
    (node) => node.textContent.trim() === level,
  );
  check(option, `Missing reasoning option ${level}`);
  option.click();
  await until(
    () => current()?.thinkingLevel === level,
    "thinking choice not applied",
  );
  await settle();
}
const host = document.createElement("main");
host.style.cssText = "width:820px;margin:80px auto;padding:24px";
document.body.append(host);
await i18n.init({
  lng: "en",
  resources: { en: { translation: en } },
  interpolation: { escapeValue: false },
});
useAppStore.setState({
  ready: true,
  settings,
  providers,
  providerModels: {},
  page: "chat",
});
flushSync(() =>
  createRoot(host).render(
    <I18nextProvider i18n={i18n}>
      <Composer />
    </I18nextProvider>,
  ),
);

globalThis.composerPreferencesProbe = async (phase) => {
  if (phase === "reload") {
    await settle();
    const text = document.querySelector(
      ".composer-model-thinking-chip",
    ).textContent;
    check(
      text.includes(__BASELINE__ ? "alpha-model" : "beta-model"),
      `reload model: ${text}`,
    );
    if (!__BASELINE__) check(text.includes("low"), `reload thinking: ${text}`);
    await useAppStore.getState().newSession();
    check(
      current().providerId === (__BASELINE__ ? "alpha" : "beta"),
      "reload creation disagrees with display",
    );
    return { ok: true, phase, text };
  }
  if (phase === "race") {
    // Configuration failure cannot replace the last accepted preference.
    const state = useAppStore.getState();
    const before = localStorage.getItem(storageKey);
    failConfigure = true;
    await state
      .configureActiveSession(
        {
          mode: "agent",
          providerId: "alpha",
          modelId: "alpha-model",
          thinkingLevel: "high",
        },
        { rememberModel: true },
      )
      .catch(() => {});
    failConfigure = false;
    check(
      localStorage.getItem(storageKey) === before,
      "failed configuration overwrote memory",
    );
    // A stale slow completion must not win over a later explicit draft choice.
    let release;
    holdConfigure = new Promise((resolve) => {
      release = resolve;
    });
    const slow = state.configureActiveSession(
      {
        mode: "agent",
        providerId: "alpha",
        modelId: "alpha-model",
        thinkingLevel: "high",
      },
      { rememberModel: true },
    );
    useAppStore.setState({ activeSessionId: undefined });
    await useAppStore.getState().configureActiveSession(
      {
        mode: "agent",
        providerId: "beta",
        modelId: "beta-model",
        thinkingLevel: "omit",
      },
      { rememberModel: true },
    );
    release();
    await slow;
    holdConfigure = undefined;
    check(
      JSON.parse(localStorage.getItem(storageKey))[0].thinkingLevel === "omit",
      "stale completion overwrote memory",
    );
    // A pending approval rejects changes without recording; a running session
    // accepts next-turn intent without waiting for a host configuration flush.
    const id = state.activeSessionId;
    useAppStore.setState({
      activeSessionId: id,
      pendingPlans: { [id]: { status: "pending" } },
    });
    const choice = {
      mode: "agent",
      providerId: "alpha",
      modelId: "alpha-model",
      thinkingLevel: "low",
    };
    await useAppStore
      .getState()
      .configureActiveSession(choice, { rememberModel: true });
    check(
      JSON.parse(localStorage.getItem(storageKey))[0].providerId === "beta",
      "blocked approval changed memory",
    );
    useAppStore.setState({ pendingPlans: {}, runningSessions: { [id]: true } });
    await useAppStore
      .getState()
      .configureActiveSession(choice, { rememberModel: true });
    check(
      JSON.parse(localStorage.getItem(storageKey))[0].providerId === "alpha",
      "accepted next-turn choice was not remembered",
    );
    useAppStore.setState({ activeSessionId: undefined });
    await materializeDraftSession();
    check(
      current().modelId === "beta-model" && current().thinkingLevel === "omit",
      "first-send materialization must preserve the explicit draft over memory",
    );
    return { ok: true, phase };
  }
  localStorage.removeItem(storageKey);
  const source = {
    id: "source",
    title: "Existing conversation",
    mode: "agent",
    providerId: "alpha",
    modelId: "alpha-model",
    thinkingLevel: "high",
    permissionMode: "inherit",
    messageCount: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  sessions.set(source.id, source);
  useAppStore.setState({ sessions: [source], activeSessionId: source.id });
  await settle();
  await model("beta-model");
  await thinking("low");
  await model("alpha-model");
  if (!__BASELINE__) {
    check(
      current().thinkingLevel === "high",
      "new model must use its own default",
    );
  }
  await model("beta-model");
  if (!__BASELINE__) {
    check(
      current().thinkingLevel === "low",
      "returning to a model must restore its own level",
    );
  }
  await click(".composer-model-thinking-chip");
  // Permission-only configuration deliberately carries model fields, like the toolbar.
  await useAppStore.getState().configureActiveSession({
    mode: "agent",
    providerId: "beta",
    modelId: "beta-model",
    thinkingLevel: "low",
    permissionMode: "auto",
  });
  const remembered = localStorage.getItem(storageKey);
  // Selecting an existing conversation must not replace the explicit preference.
  const older = { ...source, id: "older", updatedAt: 0 };
  sessions.set(older.id, older);
  useAppStore.setState({
    sessions: [...useAppStore.getState().sessions, older],
  });
  await useAppStore.getState().selectSession(older.id);
  check(
    localStorage.getItem(storageKey) === remembered,
    "navigation overwrote preference",
  );
  await useAppStore.getState().newSession();
  await settle();
  check(
    current().providerId === (__BASELINE__ ? "alpha" : "beta"),
    "new session provider",
  );
  check(
    current().thinkingLevel === (__BASELINE__ ? "high" : "low"),
    "new session thinking",
  );
  check(
    current().permissionMode == null || current().permissionMode === "inherit",
    "permission override leaked",
  );
  check(
    sessions.get("source").permissionMode === "auto",
    "existing session changed",
  );
  check(
    settings.defaultProviderId === "alpha" &&
      settings.defaultPermissionMode === "ask",
    "Composer choices changed global defaults",
  );
  return {
    ok: true,
    phase,
    model: current().modelId,
    thinking: current().thinkingLevel,
    permission: current().permissionMode ?? "inherit",
  };
};
