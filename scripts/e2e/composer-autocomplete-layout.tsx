import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { en } from "@pi-desktop/i18n";
import { IPC } from "@pi-desktop/shared";
import { ComposerAutocomplete } from "../../apps/desktop/src/components/ComposerAutocomplete";
import { ContextPanel } from "../../apps/desktop/src/components/workpanel/ContextPanel";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import { type AutocompleteItem, useComposerAutocomplete } from "../../apps/desktop/src/hooks/use-composer-autocomplete";

const host = document.createElement("div");
document.body.append(host);
const root = createRoot(host);
const i18n = createInstance();
const noop = () => {};
let accepted = -1;
const command = (name: string, description?: string, extra = {}): AutocompleteItem => ({
  kind: "command",
  command: { name, title: name, kind: "skill", description, ...extra },
  match: { score: 1, ranges: [[0, 2]] },
});
const longDescription = "Review the codebase, find regressions, and propose focused fixes. ".repeat(16);
const items: AutocompleteItem[] = [
  command("caveman", longDescription),
  command("qa-agent", "审查代码并验证功能。".repeat(80)),
  command("short", "Brief description"),
  command("bare"),
  command("review", longDescription, { title: "Code review", argumentHint: "<path>" }),
  command("template", longDescription, { kind: "template", argumentHint: "<file>" }),
  command("very-long-command-".repeat(20), longDescription),
];
function Fixture({ width, fileMode }: { width: number; fileMode: boolean }) {
  const anchorRef = useRef<HTMLTextAreaElement>(null);
  const rows = fileMode ? [{ kind: "path", entry: { path: `nested/${"long-file-name-".repeat(30)}.ts`, kind: "file" }, match: { score: 1, ranges: [] } } as AutocompleteItem] : items;
  const ac: ReturnType<typeof useComposerAutocomplete> = {
    open: true, mode: fileMode ? "file" : "slash", query: "", items: rows,
    selectedSkills: [], hasItems: true, highlight: 0, setHighlight: noop, truncated: false,
    noWorkspace: false, close: noop, accept: () => null,
  };
  return <I18nextProvider i18n={i18n}>
    <textarea ref={anchorRef} aria-label="Composer" defaultValue="/" style={{ position: "absolute", left: 24, top: 520, width, height: 60 }} />
    <ComposerAutocomplete anchorRef={anchorRef} ac={ac} onAccept={(index) => { accepted = index; }} />
  </I18nextProvider>;
}
let selectSkill = (_name: string): boolean => false;
function MultiSkillFixture({ width }: { width: number }) {
  const anchorRef = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState("/");
  const [cursor, setCursor] = useState(1);
  const ac = useComposerAutocomplete({ value, cursor, composing: false, enabled: true });
  selectSkill = (name) => {
    const index = ac.items.findIndex((item) => item.kind === "command" && item.command.name === name);
    if (index < 0) return false;
    const accepted = ac.accept(index);
    if (!accepted) return false;
    setValue(accepted.value);
    setCursor(accepted.cursor);
    return true;
  };
  return <I18nextProvider i18n={i18n}>
    <textarea ref={anchorRef} aria-label="Composer" value={value} readOnly style={{ position: "absolute", left: 24, top: 520, width, height: 60 }} />
    <ComposerAutocomplete anchorRef={anchorRef} ac={ac} onAccept={(index) => {
      const accepted = ac.accept(index);
      if (!accepted) return;
      setValue(accepted.value);
      setCursor(accepted.cursor);
    }} />
  </I18nextProvider>;
}

const settle = async () => {
  await document.fonts.ready;
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
};
declare global {
  var autocompleteLayoutProbe: (width: number, fileMode?: boolean) => Promise<unknown>;
  var autocompleteMultiSkillProbe: (width: number) => Promise<unknown>;
  var contextPanelProbe: () => Promise<unknown>;
}
globalThis.contextPanelProbe = async () => {
  if (!i18n.isInitialized) await i18n.init({ lng: "en", resources: { en: { translation: en } }, interpolation: { escapeValue: false } });
  const listeners = new Map<string, (event: unknown) => void>();
  const dispatched: Array<{ channel: string; args: unknown[] }> = [];
  Object.defineProperty(window, "piDesktop", { configurable: true, value: {
    on: (channel: string, listener: (event: unknown) => void) => {
      listeners.set(channel, listener);
      return () => { listeners.delete(channel); };
    },
    invoke: async (channel: string, ...args: unknown[]) => {
      dispatched.push({ channel, args });
      return { ok: true, data: { ok: true } };
    },
  } });
  useAppStore.setState({ activeSessionId: "context-s1", messages: [], providers: [], providerModels: {}, sessionCompactions: {} });
  flushSync(() => root.render(<I18nextProvider i18n={i18n}><ContextPanel /></I18nextProvider>));
  await settle();
  const actionsBeforeUsage = !!document.querySelector("#context-pack-name");
  listeners.get(IPC.event.extensionsStatus)?.({
    sessionId: "context-s1", extensionId: "pi-context",
    key: "event:context:snapshot",
    text: JSON.stringify({ at: 1, modelId: "m", modelName: "Model", provider: "p", contextWindow: 1000,
      totalTokens: 300, categories: [
        { key: "messages", label: "Messages", tokens: 300, percent: 30 },
        { key: "free", label: "Free", tokens: 700, percent: 70 },
      ], expanded: null, unknownTotal: false }),
  });
  await settle();
  const labels = [...document.querySelectorAll<HTMLElement>(".context-panel-category-label")].map((node) => node.textContent);
  const exportButton = [...document.querySelectorAll<HTMLButtonElement>(".context-panel-action-buttons button")].find((button) => button.textContent?.includes("Export"));
  exportButton?.click();
  await settle();
  return { ok: actionsBeforeUsage && labels.some((label) => label?.includes("Messages")) &&
    labels.some((label) => label?.includes("Free")) &&
    dispatched.some((entry) => entry.channel === IPC.invoke.extensionsCommandRun &&
      (entry.args[0] as { name?: string })?.name === "context-export"),
    actionsBeforeUsage, labels, dispatched: dispatched.length };
};

globalThis.autocompleteMultiSkillProbe = async (width) => {
  if (!i18n.isInitialized) await i18n.init({ lng: "en", resources: { en: { translation: en } }, interpolation: { escapeValue: false } });
  const commands = ["caveman", "qa-agent", "short"].map((name) => ({
    name, kind: "skill", title: name, skillId: name,
  }));
  Object.defineProperty(window, "piDesktop", { configurable: true, value: {
    invoke: async (channel: string) => channel === IPC.invoke.composerCommands
      ? { ok: true, data: { commands } }
      : { ok: false, error: { message: `Unexpected channel: ${channel}` } },
  } });
  flushSync(() => root.render(<MultiSkillFixture key={width} width={width} />));
  await settle();
  const input = document.querySelector("textarea");
  input?.focus();
  const steps: boolean[] = [];
  for (const name of ["caveman", "qa-agent", "short"]) {
    let accepted = false;
    flushSync(() => { accepted = selectSkill(name); });
    steps.push(accepted);
    await settle();
  }
  const value = input?.value;
  const chips = [...document.querySelectorAll<HTMLElement>(".composer-ac-skill-chip")].map((node) => node.textContent);
  const menu = document.querySelector<HTMLElement>(".composer-autocomplete");
  return { ok: steps.every(Boolean) && value === "/caveman /qa-agent /short " &&
    chips.join(",") === "caveman,qa-agent,short" &&
    !!menu && getComputedStyle(menu).visibility === "visible",
    steps, value, chips, width };
};

globalThis.autocompleteLayoutProbe = async (width, fileMode = false) => {
  if (!i18n.isInitialized) await i18n.init({ lng: "en", resources: { en: { translation: en } }, interpolation: { escapeValue: false } });
  flushSync(() => root.render(<Fixture width={width} fileMode={fileMode} />));
  await settle();
  await Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => {})));
  await settle();
  const input = document.querySelector("textarea")!;
  input.focus();
  const menu = document.querySelector<HTMLElement>(".composer-autocomplete")!;
  const rows = [...document.querySelectorAll<HTMLElement>(".composer-ac-item")];
  const measurements = rows.map((row) => {
    const name = row.querySelector<HTMLElement>(".composer-ac-name")!;
    const desc = row.querySelector<HTMLElement>(".composer-ac-desc");
    return { name: name.textContent, nameWidth: name.clientWidth, nameContent: name.scrollWidth,
      descriptionWidth: desc?.clientWidth, descriptionContent: desc?.scrollWidth,
      rowWidth: row.clientWidth, rowContent: row.scrollWidth };
  });
  const failures: string[] = [];
  if (getComputedStyle(rows[0]).display !== "flex") failures.push("production row styles missing");
  if (getComputedStyle(menu).visibility !== "visible" || getComputedStyle(menu).opacity !== "1") failures.push("menu is not visible");
  if (Math.abs(menu.getBoundingClientRect().width - width) > 1) failures.push("menu lost anchor width");
  for (const [index, row] of measurements.entries()) {
    if (row.rowContent > row.rowWidth + 1) failures.push(`row ${index} overflows`);
    if (!fileMode && index < items.length - 1 && row.nameContent > row.nameWidth + 1) failures.push(`command ${row.name} is truncated`);
    if (!fileMode && [0, 1, 4, 5].includes(index) && !(row.descriptionContent! > row.descriptionWidth!)) failures.push(`long description ${index} is not truncated`);
  }
  const oversizedName = measurements[fileMode ? 0 : measurements.length - 1];
  if (oversizedName.nameContent <= oversizedName.nameWidth) failures.push("oversized name no longer truncates");
  if (fileMode && measurements[0].nameWidth < width - 70) failures.push("file name no longer uses available width");
  accepted = -1;
  rows[0].dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  if (accepted !== 0 || document.activeElement !== input) failures.push("acceptance lost row identity or input focus");
  if (!fileMode && rows[0].querySelector(".composer-ac-hl")?.textContent !== "ca") failures.push("name highlight lost");
  return { ok: failures.length === 0, width, viewport: innerWidth, fileMode, measurements, failures };
};
