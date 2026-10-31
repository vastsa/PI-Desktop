import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { IPC } from "@pi-desktop/shared";
import { ReleaseNotesDialog } from "../../src/components/ReleaseNotesDialog";
import { MarkdownTable } from "../../src/components/MarkdownTable";
import { ProjectInstructionsDialog } from "../../src/components/ProjectInstructionsDialog";
import { ProviderSetupDialog } from "../../src/components/settings/ProviderSetupDialog";
import { SessionHoverCard } from "../../src/features/sessions/SessionHoverCard";
import { useSessionHoverCard } from "../../src/features/sessions/useSessionHoverCard";

// Control only the production reveal/grace timers; polling and animation retain their real clocks.
const setTimer = window.setTimeout.bind(window);
const clearTimer = window.clearTimeout.bind(window);
let now = 0;
let id = -1;
const timers = new Map();
window.setTimeout = (callback, delay, ...args) => {
  if (delay !== 160 && delay !== 500) return setTimer(callback, delay, ...args);
  const handle = id--;
  timers.set(handle, { at: now + delay, callback: () => callback(...args) });
  return handle;
};
window.clearTimeout = (handle) => { timers.delete(handle); clearTimer(handle); };
const session = { id: "selection-session", title: "Selectable session title for copying across the card boundary",
  mode: "agent", updatedAt: "2026-09-26T12:00:00Z" };
let finishSave;
window.piDesktop = {
  platform: "win32",
  on: () => () => {},
  async invoke(channel) {
    if (channel === IPC.invoke.sessionCollaboration) return { ok: true, data: {
      sessionId: session.id, status: "idle", recentExchanges: [], createdSessions: [],
    } };
    if (channel === IPC.invoke.projectGroupInstructionsSave) await new Promise((resolve) => { finishSave = resolve; });
    return { ok: true, data: { content: "Selectable fixture instructions", models: [], providers: [],
      project: { scope: "project", path: "Fixture instructions", content: "Selectable fixture instructions", exists: true } } };
  },
};
await i18n.use(initReactI18next).init({ lng: "en", fallbackLng: "en", keySeparator: false,
  resources: { en: { translation: flattenCatalog(catalogs.en) } }, interpolation: { escapeValue: false } });
const root = createRoot(document.getElementById("root"));
const close = () => flushSync(() => root.render(null));
function HoverFixture() {
  const hover = useSessionHoverCard();
  return <>
    <button id="hover-trigger" style={{ position: "fixed", top: 100, left: 100 }}
      onMouseEnter={(event) => hover.show({ session, target: event.currentTarget, temporary: true, space: "Temporary" })}
      onMouseLeave={hover.scheduleHide}>Hover session</button>
    {hover.card && <SessionHoverCard card={hover.card} runningSessions={{}} pendingPermissions={{}}
      refreshProject={async () => null} onOpenSession={async () => {}} keepVisible={hover.keepVisible} scheduleHide={hover.scheduleHide} registerDismissGuard={hover.registerDismissGuard} />}
  </>;
}
const frame = () => new Promise(requestAnimationFrame);
window.overlayFixture = {
  async show(kind) {
    flushSync(() => root.render(null));
    timers.clear();
    document.getSelection()?.removeAllRanges();
    const props = { onClose: close };
    const component = kind === "release" ? <ReleaseNotesDialog {...props} currentVersion="0.19.1" />
      : kind === "instructions" ? <ProjectInstructionsDialog {...props} project={{ name: session.title, path: "fixture", groupId: "fixture" }} onSaved={() => {}} onError={(error) => { throw error; }} />
      : kind === "provider" ? <ProviderSetupDialog {...props} initialService="custom" onSaved={() => {}} />
      : kind === "hover" ? <HoverFixture />
      : <MarkdownTable markdown="| Selectable table text |" csv="Selectable table text"><thead><tr><th>Selectable table text for copying</th></tr></thead><tbody><tr><td>More text</td></tr></tbody></MarkdownTable>;
    flushSync(() => root.render(component));
    await frame(); await frame();
    await Promise.all(document.getAnimations().filter((animation) => animation.effect.getComputedTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => {})));
  },
  advance(ms) {
    now += ms;
    for (const [handle, timer] of [...timers]) {
      if (timer.at <= now && timers.delete(handle)) flushSync(timer.callback);
    }
  },
  finishSave() { finishSave?.(); },
};
document.addEventListener("pointerdown", (event) => { window.overlayFixture.pointerId = event.pointerId; }, true);
