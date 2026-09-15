import { useRef } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { en } from "@pi-desktop/i18n";
import { ComposerAutocomplete } from "../../apps/desktop/src/components/ComposerAutocomplete";
import type { AutocompleteItem, useComposerAutocomplete } from "../../apps/desktop/src/hooks/use-composer-autocomplete";

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
    hasItems: true, highlight: 0, setHighlight: noop, truncated: false,
    noWorkspace: false, close: noop, accept: () => null,
  };
  return <I18nextProvider i18n={i18n}>
    <textarea ref={anchorRef} aria-label="Composer" defaultValue="/" style={{ position: "absolute", left: 24, top: 520, width, height: 60 }} />
    <ComposerAutocomplete anchorRef={anchorRef} ac={ac} onAccept={(index) => { accepted = index; }} />
  </I18nextProvider>;
}
const settle = async () => {
  await document.fonts.ready;
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
};
declare global {
  var autocompleteLayoutProbe: (width: number, fileMode?: boolean) => Promise<unknown>;
}
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
