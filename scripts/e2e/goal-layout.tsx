import { useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { IPC, type AppSettings, type ModeControlRequest, type ModeRun } from "@pi-desktop/shared";
import { ModeRunStatusBar } from "../../apps/desktop/src/features/modes/ModeRunStatusBar";
import { GoalBudgetSettingsRow } from "../../apps/desktop/src/features/modes/GoalBudgetSettingsRow";
import { SettingsCard } from "../../apps/desktop/src/features/settings/primitives";
import { startModesSync } from "../../apps/desktop/src/features/modes/modes-sync";
import { goalLayoutServices } from "./fixtures/goal-layout-store";

const i18n = createInstance();
const failures: string[] = [];
const measurements: unknown[] = [];
let checks = 0;
const check = (value: unknown, message: string) => { checks += 1; if (!value) failures.push(message); };
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
async function settle() { await frame(); await frame(); }
async function until(predicate: () => boolean, message: string) {
  for (let attempt = 0; attempt < 120; attempt += 1) { if (predicate()) return; await frame(); }
  throw new Error(message);
}
function element<T extends HTMLElement = HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`Missing ${selector}`);
  return found;
}
const box = (node: Element) => {
  const r = node.getBoundingClientRect();
  return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
};
const overlaps = (a: ReturnType<typeof box>, b: ReturnType<typeof box>) =>
  Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;

// The only clock seam is the browser clock/timer boundary. React effects run normally.
let now = 1_800_000_000_000;
let nextTimer = 0;
let callbacks = 0;
const intervals = new Map<number, { next: number; delay: number; fire: () => void }>();
const realNow = Date.now;
const realSetInterval = window.setInterval;
const realClearInterval = window.clearInterval;
Date.now = () => now;
window.setInterval = (handler: TimerHandler, delay = 0, ...args: unknown[]) => {
  if (typeof handler !== "function" || delay <= 0) throw new Error("Unexpected fixture interval");
  const id = ++nextTimer;
  intervals.set(id, { next: now + delay, delay, fire: () => { callbacks += 1; handler(...args); } });
  return id;
};
window.clearInterval = (id?: number) => { if (id !== undefined) intervals.delete(id); };
async function advance(ms: number) {
  const target = now + ms;
  for (;;) {
    const due = [...intervals.values()].filter((timer) => timer.next <= target).sort((a, b) => a.next - b.next)[0];
    if (!due) break;
    now = due.next;
    due.next += due.delay;
    flushSync(due.fire);
  }
  now = target;
  await settle();
}

const objective = "Verify a very long Goal objective without hiding controls. ".repeat(70) + "目标验收条件".repeat(80) + "x".repeat(500);
const longElapsed = (1234 * 86_400 + 5 * 3600 + 6 * 60 + 7) * 1000;
let run: ModeRun = {
  id: "layout-run", sessionId: "layout-session", modeId: "goal", snapshotHash: "fixture",
  input: objective, stageId: "work", state: "paused", revision: 1,
  roundsCompleted: 2, tokensUsed: 0, maxTurns: 20, maxTokens: null, artifactPaths: {},
  elapsedMs: longElapsed, createdAt: "2000-01-01T00:00:00Z", updatedAt: "2000-01-01T00:00:00Z",
};
const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
const requests: ModeControlRequest[] = [];
const saves: Partial<AppSettings>[] = [];
function emit() {
  for (const listener of listeners.get(IPC.event.modesChanged) ?? []) listener({ sessionId: run.sessionId, run });
}
function push(patch: Partial<ModeRun>) {
  run = { ...run, ...patch, revision: run.revision + 1 };
  flushSync(emit);
}
window.piDesktop = {
  channels: IPC, platform: "win32",
  on(channel, listener) {
    const set = listeners.get(channel) ?? new Set();
    set.add(listener); listeners.set(channel, set);
    return () => { set.delete(listener); };
  },
  async invoke<T>(channel: string, ...args: unknown[]) {
    let data: unknown;
    if (channel === IPC.invoke.modesCatalog) {
      data = { directory: "/isolated/modes", modes: [], diagnostics: [] };
    } else if (channel === IPC.invoke.modesRunGet) {
      if (args[0] !== run.sessionId) throw new Error("Unexpected session read");
      data = { run };
    } else if (channel === IPC.invoke.modesRunControl) {
      const request = args[0] as ModeControlRequest;
      if (request.runId !== run.id || request.sessionId !== run.sessionId || request.expectedRevision !== run.revision) {
        throw new Error("Control lost the displayed run identity/revision");
      }
      if (request.action !== "pause" && request.action !== "resume") throw new Error("Unexpected destructive control");
      requests.push(request);
      const elapsedMs = (run.elapsedMs ?? 0) + (run.state === "running" ? Math.max(0, now - (run.activeSinceMs ?? now)) : 0);
      run = { ...run, state: request.action === "pause" ? "paused" : "running", elapsedMs,
        activeSinceMs: request.action === "resume" ? now : undefined, revision: run.revision + 1 };
      data = { run, continue: false };
    } else {
      throw new Error(`Unexpected fixture IPC: ${channel}`);
    }
    return { ok: true as const, data: data as T };
  },
};
const host = document.createElement("div");
host.id = "root";
document.body.append(host);
const root = createRoot(host);
let disposeSync: (() => void) | undefined;
function Fixture() {
  const [settings, setSettings] = useState<AppSettings>({
    defaultMode: "goal", theme: "dark", enterToSend: true, onboardingDismissed: true,
    goalBudget: { maxTurns: 20, maxTokens: null },
  });
  return <main data-testid="goal-layout" style={{ width: "100%", height: "100%", padding: 8, overflow: "auto" }}>
    <ModeRunStatusBar sessionId={run.sessionId} />
    <div className="settings-content-inner" style={{ marginTop: 24 }}>
      <SettingsCard><GoalBudgetSettingsRow settings={settings} saveSettings={async (patch) => {
        saves.push(patch); setSettings((current) => ({ ...current, ...patch }));
      }} /></SettingsCard>
    </div>
  </main>;
}
function label(key: string) { return i18n.t(`modes.run.${key}`); }
function button(key: string): HTMLButtonElement {
  const scope = key === "cancelEdit" ? ".mode-run-edit" : ".mode-run-actions";
  const text = label(key === "cancelEdit" ? "cancel" : key);
  const found = [...document.querySelectorAll<HTMLButtonElement>(`${scope} button`)].find((item) => (item.getAttribute("aria-label") ?? item.textContent?.trim()) === text);
  if (!found) throw new Error(`Missing action ${key}: ${text}`);
  return found;
}
function target(node: HTMLElement) {
  node.scrollIntoView({ block: "nearest", inline: "nearest" });
  const r = node.getBoundingClientRect();
  const point = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  check(r.width > 0 && r.height > 0 && point.x >= 0 && point.x < innerWidth && point.y >= 0 && point.y < innerHeight, "Native input target outside viewport");
  check(node.contains(document.elementFromPoint(point.x, point.y)), "Native input target is covered");
  return point;
}
function bounded(node: HTMLElement, name: string) {
  const r = box(node);
  check(r.left >= -0.5 && r.right <= innerWidth + 0.5, `${name}: outside viewport ${JSON.stringify(r)}`);
  check(node.scrollWidth <= node.clientWidth + 1, `${name}: horizontal overflow ${node.scrollWidth}/${node.clientWidth}`);
}
function geometry(phase: string) {
  const bar = element(".mode-run-bar");
  const rounds = element(".mode-run-rounds");
  const elapsed = element(".mode-run-elapsed");
  const r = box(rounds), e = box(elapsed);
  check(getComputedStyle(bar).display === "flex", "Built production mode stylesheet missing");
  check(rounds.nextElementSibling === elapsed, `${phase}: elapsed is not the next metadata item`);
  check(Math.abs((r.top + r.bottom) / 2 - (e.top + e.bottom) / 2) <= 2 && e.left >= r.right - 0.5 && e.left - r.right <= 16,
    `${phase}: elapsed is not immediately right of rounds: ${JSON.stringify({ rounds: r, elapsed: e })}`);
  check(!/\{\{|modes\.run\./.test(elapsed.getAttribute("aria-label") ?? ""), `${phase}: unresolved elapsed accessible label: ${elapsed.getAttribute("aria-label")}`);
  check(Boolean(elapsed.getAttribute("aria-label")) && elapsed.title === elapsed.getAttribute("aria-label"), `${phase}: elapsed accessible title missing`);
  check(/^\d+ [dhms](?: \d+ [dhms])*$/.test(elapsed.textContent ?? ""), `${phase}: duration symbols/spacing are invalid`);
  bounded(bar, `${phase}/bar`);
  bounded(element(".mode-run-summary"), `${phase}/metadata`);
  bounded(element(".mode-run-actions"), `${phase}/actions`);
  const actions = [...document.querySelectorAll<HTMLButtonElement>(".mode-run-actions button")];
  for (const action of actions) {
    const name = action.getAttribute("aria-label") ?? action.textContent?.trim();
    check(Boolean(name) && action.tabIndex >= 0 && !action.disabled, `${phase}: action is not accessible`);
    if (["resume", "pause", "edit", "remove"].some((key) => label(key) === name)) {
      check(Boolean(action.querySelector('svg[aria-hidden="true"]')) && action.textContent?.trim() === "", `${phase}: ${name} is not icon-only`);
    }
    bounded(action, `${phase}/${name}`);
    check(!overlaps(e, box(action)) && !overlaps(r, box(action)), `${phase}: metadata overlaps ${name}`);
    target(action);
  }
  for (let i = 0; i < actions.length; i++) for (const other of actions.slice(i + 1)) {
    check(!overlaps(box(actions[i]), box(other)), `${phase}: actions overlap`);
  }
  if (phase === "paused") {
    check(elapsed.textContent === "1234 d 5 h 6 m 7 s", "Long duration lost units or exact spacing");
  }
  measurements.push({ phase, rounds: r, elapsed: e, actions: actions.map((item) => ({ name: item.getAttribute("aria-label") ?? item.textContent, ...box(item) })) });
}
function budgetGeometry() {
  const fields = [...document.querySelectorAll<HTMLElement>(".settings-goal-budget-field")];
  check(fields.length === 2, "Goal budget must expose two fields");
  const rects = fields.map(box);
  check(Math.abs(rects[0].top - rects[1].top) <= 1 && rects[1].left >= rects[0].right - 0.5, "Goal budget fields are not horizontal");
  bounded(element(".settings-goal-budget"), "Goal budget");
  bounded(element(".settings-row"), "Goal settings row");
  for (const field of fields) {
    const caption = field.querySelector<HTMLElement>(".settings-goal-budget-label");
    const input = field.querySelector<HTMLInputElement>("input");
    if (!caption || !input) throw new Error("Budget shared label/input missing");
    const c = box(caption), i = box(input);
    const range = document.createRange(); range.selectNodeContents(caption);
    const lineTops = [...range.getClientRects()].map((rect) => Math.round(rect.top));
    check(new Set(lineTops).size === 1 && caption.scrollWidth <= caption.clientWidth + 1, `Budget label wraps glyphs: ${caption.textContent}`);
    check(i.left >= c.right - 0.5 && Math.abs((i.top + i.bottom) / 2 - (c.top + c.bottom) / 2) <= 1, "Budget label/input is not horizontal");
    check(i.width >= 60 && input.classList.contains("field-input") && input.inputMode === "numeric", "Budget input is not usable/shared numeric control");
    bounded(field, "Budget field"); target(input);
    measurements.push({ phase: "budget", label: caption.textContent, caption: c, input: i, labelLines: lineTops });
  }
}
function elapsedText() { return element(".mode-run-elapsed").textContent; }
function seconds(value: number) { return `${value} s`; }

const probe = {
  async mount(language: "en" | "zh-CN") {
    await i18n.init({ lng: language, fallbackLng: "en", resources: {
      en: { translation: catalogs.en }, "zh-CN": { translation: catalogs["zh-CN"] },
    }, interpolation: { escapeValue: false } });
    document.documentElement.lang = language;
    document.documentElement.dataset.theme = "dark";
    disposeSync = startModesSync();
    flushSync(() => root.render(<I18nextProvider i18n={i18n}><Fixture /></I18nextProvider>));
    await until(() => Boolean(document.querySelector(".mode-run-elapsed")), "Mode run did not load through IPC");
    await document.fonts.ready; await settle();
    geometry("paused"); budgetGeometry();
    check(intervals.size === 0, "Paused run owns a ticking interval");
    return { viewport: [innerWidth, innerHeight], objectiveLength: objective.length };
  },
  async target(key: string) {
    await settle();
    const node = key.startsWith("budget:")
      ? element<HTMLInputElement>(`.settings-goal-budget-field:nth-child(${Number(key.split(":")[1]) + 1}) input`)
      : button(key);
    return target(node);
  },
  async after(key: string) {
    if (key === "resume" || key === "pause") {
      await until(() => element(".mode-run-bar").dataset.state === (key === "resume" ? "running" : "paused") && element(".mode-run-bar").getAttribute("aria-busy") === "false", `${key} did not settle`);
      check(requests.at(-1)?.action === key, `${key} did not reach the preload boundary`);
      check(intervals.size === (key === "resume" ? 1 : 0), `${key}: active timer ownership wrong`);
    }
    await settle();
    if (key === "edit") {
      const input = element<HTMLTextAreaElement>(".mode-run-edit-objective textarea");
      check(input.value === objective, "Long objective changed in the edit form");
      bounded(input, "Long objective editor"); bounded(element(".mode-run-edit"), "Run edit form");
      geometry("edit");
    } else if (key === "stop" || key === "remove") {
      check(Boolean(document.querySelector(".mode-run-confirm[role='alert']")), `${key}: confirmation missing`);
      geometry(`${key}-confirmation`);
    } else if (key === "cancelEdit") {
      check(!document.querySelector(".mode-run-edit"), "Edit cancel did not close form");
    } else if (key === "cancel") {
      check(!document.querySelector(".mode-run-confirm"), "Confirmation cancel failed");
    }
  },
  async inputReady(index: number) {
    const input = element<HTMLInputElement>(`.settings-goal-budget-field:nth-child(${index + 1}) input`);
    await until(() => document.activeElement === input, `Budget ${index}: native click did not focus the input`);
  },
  async inputSelected(index: number) {
    const input = element<HTMLInputElement>(`.settings-goal-budget-field:nth-child(${index + 1}) input`);
    await until(() => input.selectionStart === 0 && input.selectionEnd === input.value.length, `Budget ${index}: select-all did not settle`);
  },
  async inputEdited(index: number, value: number) {
    const input = element<HTMLInputElement>(`.settings-goal-budget-field:nth-child(${index + 1}) input`);
    await until(() => input.value === String(value), `Budget ${index}: native text insertion did not settle`);
    await settle();
    check(input.value === String(value), `Budget ${index}: controlled render lost inserted text`);
  },
  async inputSaved(index: number, value: number) {
    await until(() => (index === 0 ? saves.at(-1)?.goalBudget?.maxTurns : saves.at(-1)?.goalBudget?.maxTokens) === value, "Budget native input/Enter did not save");
    await settle();
    const input = element<HTMLInputElement>(`.settings-goal-budget-field:nth-child(${index + 1}) input`);
    check(input.value === String(value) && document.activeElement === input, "Budget value/focus lost after save");
    check(input.labels?.length === 1 && Boolean(input.labels[0].textContent?.trim()), "Budget input has no accessible label");
    budgetGeometry();
  },
  async clockStart() {
    push({ state: "running", elapsedMs: 5000, activeSinceMs: now }); await settle();
    check(elapsedText() === seconds(5) && intervals.size === 1, "Active timer did not initialize");
    await advance(1000);
    check(elapsedText() === seconds(6), "Active timer did not tick with controlled clock");
    push({ elapsedMs: 20_000, activeSinceMs: now }); await settle();
    check(elapsedText() === seconds(20) && intervals.size === 1, "Revision did not recompute/re-own timer");
    await advance(1000);
    check(elapsedText() === seconds(21), "Revised timer did not tick");
  },
  async frozen() {
    const frozen = elapsedText(); await advance(5000);
    check(frozen === seconds(21) && elapsedText() === frozen && intervals.size === 0, "Paused timer kept counting");
  },
  async cleanup() {
    await advance(1000);
    check(elapsedText() === seconds(22), "Resumed timer lost accumulated time");
    push({ id: "legacy-run", state: "running", elapsedMs: undefined, activeSinceMs: undefined }); await settle();
    check(elapsedText() === seconds(0) && intervals.size === 0, "Legacy replacement inferred time or leaked timer");
    push({ id: "active-replacement", state: "running", elapsedMs: 3000, activeSinceMs: now }); await settle();
    check(elapsedText() === seconds(3) && intervals.size === 1, "Replacement run did not initialize its timer");
    flushSync(() => root.unmount()); disposeSync?.();
    check(intervals.size === 0, "Unmount leaked timer");
    const before = callbacks; await advance(5000);
    check(callbacks === before, "Timer fired after unmount");
    check([...listeners.values()].every((set) => set.size === 0), "Mode sync listeners survived disposal");
    check(goalLayoutServices.toasts.length === 0, `Unexpected errors: ${goalLayoutServices.toasts.join("; ")}`);
    Date.now = realNow; window.setInterval = realSetInterval; window.clearInterval = realClearInterval;
    return { checks, failures, measurements, requests, saves, timerCallbacks: callbacks };
  },
};
Object.assign(globalThis, { goalLayout: probe });
