import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { IPC } from "@pi-desktop/shared";
import { ExtensionPromptHost } from "../../src/components/ExtensionPromptDialog";
import { SessionRenameDialog } from "../../src/components/SessionRenameDialog";
import { ProjectInstructionsDialog } from "../../src/components/ProjectInstructionsDialog";
import { ProjectMemoryDialog } from "../../src/components/ProjectMemoryDialog";
import { ProjectDeleteDialog } from "../../src/components/ProjectDeleteDialog";
import { PluginInstallDialog } from "../../src/components/plugins/PluginInstallDialog";
import { OAuthLoginDialog } from "../../src/components/settings/OAuthLoginDialog";
import { PluginDialogs } from "../../src/features/plugins/PluginDialogs";
import { PluginSettingsSheet } from "../../src/components/plugins/PluginSettingsSheet";
import { newInstallJob } from "../../src/features/plugins/install-progress";

const listeners = new Map();
const path = "C:\\Users\\Example\\AppData\\Local\\Temp\\pi-extension-fixture\\plugins\\greet\\src\\greet.ts";
const long = "Project_" + "abcdefghij".repeat(25);
window.piDesktop = {
  platform: "win32",
  on(channel, listener) {
    const set = listeners.get(channel) ?? new Set();
    listeners.set(channel, set); set.add(listener);
    return () => set.delete(listener);
  },
  async invoke(channel, ...args) {
    if (channel === IPC.invoke.extensionsUiRespond) window.dialogFixture.responses.push(args[0]);
    return { ok: true, data: { project: { scope: "project", path, content: "Fixture instructions", exists: true },
      content: "Fixture instructions", memory: { content: "", entries: [] } } };
  },
};
await i18n.use(initReactI18next).init({ lng: "en", fallbackLng: "en", keySeparator: false,
  resources: Object.fromEntries(["en", "zh-CN"].map((locale) => [locale, { translation: flattenCatalog(catalogs[locale]) }])),
  interpolation: { escapeValue: false } });
const root = createRoot(document.getElementById("root"));
let revision = 0;
const frame = () => new Promise(requestAnimationFrame);
const close = () => { window.dialogFixture.closed = true; flushSync(() => root.render(null)); };
const error = (value) => { throw value; };
window.dialogFixture = {
  responses: [], closed: false, saved: null,
  async show(kind, options = {}) {
    flushSync(() => root.render(null));
    this.responses = []; this.closed = false; this.saved = null;
    document.documentElement.dataset.theme = options.theme ?? "light";
    await i18n.changeLanguage(options.locale ?? "en");
    const project = { name: long, path, groupId: "fixture-group", sessionCount: 2 };
    const props = { project, onClose: close, onSaved() {}, onError: error };
    let component;
    if (kind === "extension") component = <ExtensionPromptHost key={++revision} />;
    if (kind === "rename") component = <SessionRenameDialog session={{ id: "s", title: long }} onClose={close} onSave={async (value) => { this.saved = value; }} onError={error} />;
    if (kind === "instructions") component = <ProjectInstructionsDialog {...props} />;
    if (kind === "memory") component = <ProjectMemoryDialog {...props} />;
    if (kind === "delete") component = <ProjectDeleteDialog {...props} runningSessionIds={[]} onDeleted={() => {}} />;
    if (kind === "install") component = <PluginInstallDialog job={{ ...newInstallJob({ id: "fixture", name: long, grantedPermissions: [], autoUpdate: false }), status: "failed", error: long }} onCancel={close} onRetry={() => {}} onClose={close} />;
    if (kind === "plugin-settings") component = <PluginSettingsSheet plugin={{ id: "fixture", name: long, settings: [] }} platform="win32" onClose={close} onSaved={() => {}} />;
    if (kind === "plugin-review") component = <PluginDialogs t={i18n.t.bind(i18n)} pendingInstall={{ id: "fixture", name: long, permissions: [] }} setPendingInstall={close} confirmInstall={close} autoUpdate={false} setAutoUpdate={() => {}} />;
    if (kind === "oauth") component = <OAuthLoginDialog vendor={{ id: "fixture", name: "Fixture" }} onClose={close} onDone={close} session={{
      subscribe(listener) { queueMicrotask(() => listener({ kind: "authUrl", url: "https://example.invalid/" + long, instructions: "Open the sign-in URL", opened: false })); return () => {}; },
      cancel: async () => {},
    }} />;
    flushSync(() => root.render(component));
    await frame();
    if (kind === "extension") {
      const requestKind = options.request ?? "input";
      const request = { kind: requestKind, title: options.longTitle ? long : "Your name?",
        placeholder: "e.g. Ann", message: long.repeat(2), options: [long, "Second option"] };
      for (const listener of listeners.get(IPC.event.extensionsUiPrompt) ?? []) {
        listener({ promptId: `fixture-${revision}`, sessionId: "s", extensionId: path,
          extensionLabel: options.longTitle ? long : "greet", request });
      }
    }
    await frame(); await frame();
    await Promise.all(document.getAnimations().filter((animation) => animation.effect.getComputedTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => {})));
  },
};
