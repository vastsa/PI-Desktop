import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { en, zhCN } from "@pi-desktop/i18n";
import {
  DEFAULT_SESSION_REFERENCE_PAGE_LIMIT,
  expandSessionReferences,
  readSessionReferenceSource,
  stripSessionReferencePrompt,
  type UiMessage,
} from "@pi-desktop/shared";
import { SessionReferenceBudgetRow } from "../../apps/desktop/src/features/settings/SessionReferenceBudgetRow";
import {
  getSessionReferenceBudgetPercent,
  setSessionReferenceBudgetPercent,
} from "../../apps/desktop/src/lib/session-reference-preferences";

const host = document.createElement("main");
host.className = "main-pane";
host.style.cssText = "padding:24px;max-width:900px;margin:auto";
document.body.append(host);
const root = createRoot(host);
const i18n = createInstance();
const sourceId = "11111111-1111-4111-8111-111111111111";
const secondId = "22222222-2222-4222-8222-222222222222";
let sequence = 0;
const row = (role: UiMessage["role"], content: string, extra: Partial<UiMessage> = {}): UiMessage => ({
  id: `fixture-${++sequence}`, role, content, status: "complete", createdAt: "2026-09-16T00:00:00.000Z", ...extra,
});
const settle = async () => {
  await document.fonts.ready;
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
};
const check = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
function renderControl() {
  flushSync(() => root.render(<I18nextProvider i18n={i18n}><div className="settings-panel"><SessionReferenceBudgetRow /></div></I18nextProvider>));
}
declare global {
  var sessionReferenceBudgetProbe: (language: "en" | "zh-CN") => Promise<unknown>;
}
globalThis.sessionReferenceBudgetProbe = async (language) => {
  if (!i18n.isInitialized) {
    await i18n.init({ lng: language, resources: { en: { translation: en }, "zh-CN": { translation: zhCN } }, interpolation: { escapeValue: false } });
  } else await i18n.changeLanguage(language);
  flushSync(() => root.render(null));
  setSessionReferenceBudgetPercent(25);
  renderControl();
  await settle();
  const label = i18n.t("settings.sessionReferenceBudget");
  check(!label.startsWith("settings."), "budget label is missing from the catalog");
  if (language === "zh-CN") check(/[\u4e00-\u9fff]/.test(label), "Chinese label is untranslated");
  let trigger = host.querySelector<HTMLButtonElement>(".settings-menu-select-trigger")!;
  check(trigger?.getAttribute("aria-label") === label, "accessible budget trigger missing");
  check(trigger.textContent?.includes("25%"), "default preference is not rendered");
  trigger.click();
  await settle();
  const options = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')];
  check(options.length === 4, "budget choices missing");
  const half = options.find((option) => option.textContent?.includes("50%"));
  check(half, "50% option missing");
  half!.click();
  await settle();
  check(getSessionReferenceBudgetPercent() === 50, "setting did not persist");
  flushSync(() => root.render(null));
  renderControl();
  await settle();
  trigger = host.querySelector<HTMLButtonElement>(".settings-menu-select-trigger")!;
  check(trigger.textContent?.includes("50%"), "setting lost on component remount");
  const settingRow = host.querySelector<HTMLElement>(".settings-row")!;
  check(settingRow.scrollWidth <= settingRow.clientWidth + 1, "settings row overflows viewport");

  const history = [
    row("user", "RECOVER_THIS_QUESTION"),
    ...Array.from({ length: 450 }, () => row("tool", "EXCLUDED_TOOL_TRACE")),
    row("assistant", "Visible progress."),
    row("assistant", "FULL_GUIDE_MARKER", { thinking: "EXCLUDED_THINKING" }),
    row("assistant", "ADDENDUM_MARKER"),
    row("assistant", "EXCLUDED_STREAM", { status: "streaming" }),
    row("assistant", "EXCLUDED_DELEGATE", { parentToolCallId: "tool-delegate" }),
  ];
  const pages: number[] = [];
  const request = `Use @session:${sourceId}\n## Current request:\nPreserve this literal heading.`;
  const expanded = await expandSessionReferences(request, {
    budgetTokens: 4_000,
    loadSession: (id, budgetTokens) => readSessionReferenceSource(id, async (_id, before) => {
      const end = before ?? history.length;
      const start = Math.max(0, end - DEFAULT_SESSION_REFERENCE_PAGE_LIMIT);
      pages.push(start);
      return { id, title: "Paged source", messages: history.slice(start, end), messageStart: start, messageEnd: end, hasMoreBefore: start > 0 };
    }, { budgetTokens }),
  });
  check(pages.length === 2 && pages.at(-1) === 0, "reader stopped at one physical page");
  check(!expanded.blockedReason, "recoverable history blocked");
  for (const marker of ["RECOVER_THIS_QUESTION", "Visible progress.", "FULL_GUIDE_MARKER", "ADDENDUM_MARKER"]) check(expanded.content.includes(marker), `missing ${marker}`);
  for (const marker of ["EXCLUDED_TOOL_TRACE", "EXCLUDED_THINKING", "EXCLUDED_STREAM", "EXCLUDED_DELEGATE"]) check(!expanded.content.includes(marker), `leaked ${marker}`);
  check(stripSessionReferencePrompt(expanded.content) === request, "wrapper parser lost literal current request");
  check(stripSessionReferencePrompt(expanded.content) === request, "wrapper parser lost literal current request");

  const shortHistory = Array.from({ length: 32 }, (_, index) => [row("user", `Question ${index}`), row("assistant", `Answer ${index}`)]).flat();
  const many = await expandSessionReferences(`@session:${sourceId}`, {
    budgetTokens: 4_000,
    loadSession: async (id) => ({ id, title: "Many turns", messages: shortHistory }),
  });
  check(many.notices[0]?.includedTurns === 32, "obsolete fixed turn cap survived into the build");
  const oversized = await expandSessionReferences(`@session:${sourceId} @session:${secondId}`, {
    budgetTokens: 600,
    loadSession: async (id) => ({ id, title: "Oversized", messages: [row("user", "Question"), row("assistant", "x".repeat(1_500))] }),
  });
  check(oversized.blockedReason === "budget", "multiple sources bypassed their shared budget");
  return {
    ok: true, language, viewport: innerWidth, settingLabel: label,
    restoredPreference: getSessionReferenceBudgetPercent(), pageStarts: pages,
    includedTurns: expanded.notices[0].includedTurns,
    estimatedTokens: expanded.estimatedTokens, uncappedShortTurns: many.notices[0].includedTurns,
    oversizedBlocked: oversized.blockedReason,
    rowWidth: settingRow.clientWidth, rowContent: settingRow.scrollWidth,
  };
};
