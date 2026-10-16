// Production shell, settings, composer and effects; only the host boundary and
// initial store data are fixtures. No real profile, provider or agent is used.
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { IPC } from "@pi-desktop/shared";
import { AppShell } from "../../apps/desktop/src/features/app/AppShell";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import { initLanguageSync } from "../../apps/desktop/src/lib/app-language";

const sessionId = "fixture-queued-animation";
const draft = { text: "", fileReferences: [] };
const queued = [
  { id: "fixture-queued-1", sessionId, content: "Review the implementation and explain the changes", draft, createdAt: 1, priority: 1 },
  { id: "fixture-queued-2", sessionId, content: "Then check the tests and summarize the results", draft, createdAt: 2 },
];
const defaults = {
  defaultMode: "agent", theme: "light", language: "en", enterToSend: true,
  developerMode: false, queuedPromptAnimation: "off",
};
let settings = { ...defaults, ...JSON.parse(localStorage.getItem("queue-fixture-settings") || "{}") };
window.piDesktop = {
  platform: "win32",
  on() { return () => {}; },
  async invoke(channel, input) {
    let data = {};
    switch (channel) {
      case IPC.invoke.settingsGet: data = settings; break;
      case IPC.invoke.settingsSet:
        settings = input;
        localStorage.setItem("queue-fixture-settings", JSON.stringify(settings));
        data = settings; break;
      case IPC.invoke.agentQueueList: data = { entries: queued }; break;
      case IPC.invoke.backgroundTasksList: data = { tasks: [] }; break;
      case IPC.invoke.providersList: data = { providers: [] }; break;
      case IPC.invoke.sessionList: data = { sessions: useAppStore.getState().sessions }; break;
      case IPC.invoke.commandShellList: data = { choices: [], effective: null }; break;
      case IPC.invoke.appGetOnboarding: data = {}; break;
      case IPC.invoke.todosGet: data = { sessionId, todos: [], revision: 0, updatedAt: 1 }; break;
      case IPC.invoke.updatesGetState:
        data = { mode: "in-app", preference: "automatic", status: "idle", currentVersion: "0.20.1" }; break;
      case IPC.invoke.configSyncGetState:
        data = { configured: false, enabled: false, paused: false, locked: false, status: "notConfigured", categories: {}, pendingApprovals: [], mappings: [] }; break;
      case IPC.invoke.pluginScenicThemesDestinations: data = []; break;
      default:
        if (/list|destinations|views|themes/i.test(channel)) data = [];
    }
    return { ok: true, data };
  },
};
await i18n.use(initReactI18next).init({
  lng: "en", fallbackLng: "en", keySeparator: false,
  resources: { en: { translation: flattenCatalog(catalogs.en) } },
  interpolation: { escapeValue: false },
});
useAppStore.setState({
  ready: true, healthOk: true, bootstrap: async () => {},
  refreshPluginThemes: async () => {}, refreshPlugins: async () => {}, refreshPluginViews: async () => {},
  settings, settingsTab: "ai", page: "settings", activeSessionId: sessionId,
  retainedSessionIds: [sessionId],
  sessions: [{ id: sessionId, title: "Queued message animation", mode: "agent", projectPath: null, createdAt: 1, updatedAt: 1 }],
  messages: [], isRunning: true, runningSessions: { [sessionId]: true },
  queuedPrompts: { [sessionId]: queued }, providers: [],
});
initLanguageSync();
const frame = () => new Promise(requestAnimationFrame);
const settle = async () => { await frame(); await frame(); await new Promise((r) => setTimeout(r, 120)); };
const row = () => [...document.querySelectorAll(".settings-row")]
  .find((node) => node.textContent.includes("Queued message animation"));
function assert(value, message) { if (!value) throw new Error(message); }
window.__QUEUE_CAPTURE__ = {
  async view(page) {
    flushSync(() => useAppStore.setState({ page }));
    await settle();
    if (page === "settings") { row()?.scrollIntoView({ block: "center" }); await settle(); }
  },
  async openOptions() {
    const button = row()?.querySelector('button[aria-haspopup="listbox"]');
    assert(button, "Missing queue animation setting");
    button.click(); await settle();
  },
  async choose(label) {
    const option = [...document.querySelectorAll('[role="option"]')].find((node) => node.textContent.trim() === label);
    assert(option, `Missing option: ${label}`);
    option.click(); await settle();
  },
  async theme(theme) {
    settings = { ...settings, theme };
    flushSync(() => useAppStore.setState({ settings })); await settle();
  },
  rect(selector) {
    const target = selector === "setting" ? row() : document.querySelector(selector);
    assert(target, `Missing capture target: ${selector}`);
    const r = target.getBoundingClientRect();
    return { x: Math.max(0, Math.floor(r.x - 12)), y: Math.max(0, Math.floor(r.y - 12)), width: Math.min(innerWidth - Math.max(0, Math.floor(r.x - 12)), Math.ceil(r.width + 24)), height: Math.min(innerHeight - Math.max(0, Math.floor(r.y - 12)), Math.ceil(r.height + 24)) };
  },
  state() {
    const promoted = document.querySelector('.composer-queued-prompt[data-priority="true"]');
    const ordinary = document.querySelector('.composer-queued-prompt:not([data-priority="true"])');
    const pseudo = promoted && getComputedStyle(promoted, "::after");
    const other = ordinary && getComputedStyle(ordinary, "::after");
    return {
      preference: settings.queuedPromptAnimation, rootAnimation: document.documentElement.dataset.queueAnimation,
      theme: document.documentElement.dataset.theme, queuedRows: document.querySelectorAll(".composer-queued-prompt").length,
      content: pseudo?.content, display: pseudo?.display, animationName: pseudo?.animationName,
      background: pseudo?.backgroundImage, ordinaryContent: other?.content,
      layout: [".app-shell", ".main-pane", ".chat-surface", ".home-main-content", ".composer-queued-prompts"].map((s) => {
        const node = document.querySelector(s); const r = node?.getBoundingClientRect();
        return { selector: s, rect: r?.toJSON(), display: node && getComputedStyle(node).display };
      }),
    };
  },
};
flushSync(() => createRoot(document.getElementById("root")).render(<AppShell />));
