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
// A fresh root per render: the probe cycles through modes, and reusing one
// root would leave the previous mode's nodes in the document, so a stale group
// heading could be counted against the current menu. An unmounted root cannot
// be rendered into again, hence one per pass rather than an unmount in place.
let root = createRoot(host);
const i18n = createInstance();
const noop = () => {};
let accepted = -1;
const command = (name: string, description?: string, extra = {}): AutocompleteItem => ({
  kind: "command",
  command: { name, title: name, kind: "skill", description, ...extra },
  match: { score: 1, ranges: [[0, 2]] },
});
const agent = (name: string, description?: string): AutocompleteItem => ({
  kind: "agent",
  agent: { name, description },
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
function Fixture({ width, fileMode, agentMode }: { width: number; fileMode: boolean; agentMode?: boolean }) {
  const anchorRef = useRef<HTMLTextAreaElement>(null);
  const rows = agentMode
    ? [agent("explorer", longDescription), agent("code-reviewer"), { kind: "path", entry: { path: `nested/${"long-file-name-".repeat(30)}.ts`, kind: "file" }, match: { score: 1, ranges: [] } } as AutocompleteItem]
    : fileMode ? [{ kind: "path", entry: { path: `nested/${"long-file-name-".repeat(30)}.ts`, kind: "file" }, match: { score: 1, ranges: [] } } as AutocompleteItem] : items;
  const ac: ReturnType<typeof useComposerAutocomplete> = {
    open: true, mode: fileMode ? "file" : "slash", query: "", items: rows,
    hasItems: true, highlight: 0, setHighlight: noop, truncated: false,
    noWorkspace: false, close: noop, accept: () => null,
  };
  return <I18nextProvider i18n={i18n}>
    <textarea ref={anchorRef} aria-label="Composer" defaultValue={agentMode ? "@" : "/"} style={{ position: "absolute", left: 24, top: 520, width, height: 60 }} />
    <ComposerAutocomplete anchorRef={anchorRef} ac={ac} onAccept={(index) => { accepted = index; }} />
  </I18nextProvider>;
}
const settle = async () => {
  await document.fonts.ready;
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
};
declare global {
  var autocompleteLayoutProbe: (width: number, fileMode?: boolean, agentMode?: boolean) => Promise<unknown>;
}
globalThis.autocompleteLayoutProbe = async (width, fileMode = false, agentMode = false) => {
  if (!i18n.isInitialized) await i18n.init({ lng: "en", resources: { en: { translation: en } }, interpolation: { escapeValue: false } });
  flushSync(() => root.render(<Fixture width={width} fileMode={fileMode} agentMode={agentMode} />));
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
    if (!fileMode && !agentMode && index < items.length - 1 && row.nameContent > row.nameWidth + 1) failures.push(`command ${row.name} is truncated`);
    if (!fileMode && !agentMode && [0, 1, 4, 5].includes(index) && !(row.descriptionContent! > row.descriptionWidth!)) failures.push(`long description ${index} is not truncated`);
  }
  // In "@" mode the file row is last, because the Agents group leads the list.
  const fileRow = measurements[agentMode ? 2 : 0];
  const oversizedName = fileMode ? fileRow : measurements[measurements.length - 1];
  if (oversizedName.nameContent <= oversizedName.nameWidth) failures.push("oversized name no longer truncates");
  if (fileMode && fileRow.nameWidth < width - 70) failures.push("file name no longer uses available width");
  if (agentMode) {
    // The delegate is offered with the exact token that will be typed.
    if (measurements[0].name !== "@explorer") failures.push(`agent row shows ${measurements[0].name}`);
    if (measurements[0].descriptionContent! <= measurements[0].descriptionWidth!) failures.push("agent description is not truncated");
    if (measurements[1].name !== "@code-reviewer") failures.push("second agent row lost its token");
    // Agents lead the file rows, so the delegate must be the first row.
    if (measurements[2].name.includes("@")) failures.push("the file row must follow the agent rows");
    // Two labelled sections, delegates first: an unlabelled file group would
    // render under the Agents heading and read as one mixed section.
    const headings = [...menu.querySelectorAll(".composer-model-group-label")].map((el) => el.textContent);
    if (headings.length !== 2) failures.push(`expected 2 group labels, saw ${headings.length}`);
    if (headings[0] !== en.chat.agentGroup) failures.push(`first group is ${headings[0]}`);
    if (headings[1] !== en.chat.fileGroup) failures.push(`second group is ${headings[1]}`);
    // The bot badge is what marks a row as a delegate, and the real glyph has
    // to survive the CSS build rather than fall back to a box.
    const badges = [...menu.querySelectorAll(".composer-ac-icon svg")];
    if (badges.length !== 3) failures.push(`expected 3 row glyphs, saw ${badges.length}`);
    if (!badges[0].classList.contains("lucide-bot")) failures.push("the delegate lost its bot badge");
    if (!badges[2].classList.contains("lucide-file-text")) failures.push("the file row lost its glyph");
    if (badges[0].getBoundingClientRect().width === 0) failures.push("the bot badge has no size");
  }
  accepted = -1;
  rows[0].dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  if (accepted !== 0 || document.activeElement !== input) failures.push("acceptance lost row identity or input focus");
  if (!fileMode && rows[0].querySelector(".composer-ac-hl")?.textContent !== "ca") failures.push("name highlight lost");
  // Reset for the next mode so nothing from this pass leaks into it.
  const result = { ok: failures.length === 0, width, viewport: innerWidth, fileMode, agentMode, measurements, failures };
  flushSync(() => root.unmount());
  host.textContent = "";
  root = createRoot(host);
  return result;
};
