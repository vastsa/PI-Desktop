// Production UI and store; only the external IPC transport and input data are fixtures.
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { api } from "../../apps/desktop/src/lib/api";
import { ReviewHistoryFile } from "../../apps/desktop/src/components/workpanel/ReviewHistoryFile";
import { groupReviewFiles } from "../../apps/desktop/src/lib/review-history";
import { ReviewTab } from "../../apps/desktop/src/components/workpanel/ReviewTab";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import { requestReviewFocus } from "../../apps/desktop/src/lib/review-focus-request";
import type { SessionSummary, UiMessage } from "@pi-desktop/shared";

declare global {
  interface Window {
    reviewFixture: { action(name: string, input?: unknown): Promise<unknown> };
    reviewProbe(): Promise<{ checks: string[] }>;
    reviewReloadProbe(): Promise<{ checks: string[] }>;
  }
}
await i18n.use(initReactI18next).init({ lng: "zh-CN", fallbackLng: "en", keySeparator: false,
  resources: { "zh-CN": { translation: flattenCatalog(catalogs["zh-CN"]) }, en: { translation: flattenCatalog(catalogs.en) } }, interpolation: { escapeValue: false } });
document.documentElement.dataset.theme = "light";
const root = createRoot(document.getElementById("root")!);
// Yield one renderer task; hidden-window animation frames may be suspended.
// Readiness is determined by until predicates, not elapsed time or paint count.
const frame = () => new Promise<void>(resolve => {
  const channel = new MessageChannel();
  channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); resolve(); };
  channel.port2.postMessage(null);
});
function assert(value: unknown, reason: string): asserts value { if (!value) throw new Error(reason); }
async function until(predicate: () => boolean | Promise<boolean>, reason: string) {
  const end = performance.now() + 15000;
  while (!await predicate()) { if (performance.now() > end) throw new Error(reason); await frame(); }
  await frame();
}
const action = (name: string, input?: unknown) => window.reviewFixture.action(name, input);
Object.defineProperty(navigator, "clipboard", { value: { writeText: (text: string) => action("copy", text) } });
const select = (label: string) => document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
function checkSelectStyle(node: HTMLSelectElement) {
  assert(node?.classList.contains('field-select'), 'Review restores the shared native Select');
  assert(getComputedStyle(node).appearance === 'base-select', 'Native picker supports local styling');
  assert(getComputedStyle(node).alignItems === 'center', 'Closed native trigger centers its text and arrow vertically');
  const height = node.getBoundingClientRect().height;
  assert(Math.abs(height - (node.classList.contains('review-round-scope') ? 24 : 28)) < 1, 'Scope is 24px; round field retains 28px');
  const picker = getComputedStyle(node, '::picker(select)');
  assert(parseFloat(picker.borderTopLeftRadius) > 0 && parseFloat(picker.borderBottomLeftRadius) > 0, 'Picker has top and bottom outer corners');
  const options = [...node.options];
  options.forEach((option, index) => {
    const style = getComputedStyle(option);
    assert((parseFloat(style.borderTopLeftRadius) > 0) === (index === 0) && (parseFloat(style.borderTopRightRadius) > 0) === (index === 0), 'Only first option has upper corners');
    assert((parseFloat(style.borderBottomLeftRadius) > 0) === (index === options.length - 1) && (parseFloat(style.borderBottomRightRadius) > 0) === (index === options.length - 1), 'Only last option has lower corners');
  });
  const chosen = node.selectedOptions[0];
  assert(chosen && getComputedStyle(chosen).backgroundColor !== picker.backgroundColor, 'Selected background differs from list base');
  const root = document.documentElement, originalTheme = root.dataset.theme;
  const property = '--ds-bg-sidebar', original = root.style.getPropertyValue(property), priority = root.style.getPropertyPriority(property);
  try {
    for (const theme of ['light', 'dark']) {
      root.dataset.theme = theme;
      const colors: string[] = [];
      for (const sidebar of ['#465548', '#5e4652']) {
        root.style.setProperty(property, sidebar);
        const base = getComputedStyle(node, '::picker(select)').backgroundColor;
        const selected = getComputedStyle(chosen).backgroundColor;
        assert(selected !== base && selected !== 'rgb(0, 120, 215)', 'Theme selection is distinct, not system blue');
        colors.push(selected);
      }
      assert(colors[0] !== colors[1], 'Selection follows live sidebar color changes');
    }
  } finally {
    if (originalTheme === undefined) delete root.dataset.theme; else root.dataset.theme = originalTheme;
    if (original) root.style.setProperty(property, original, priority); else root.style.removeProperty(property);
  }
}
async function choose(label: string, value: string) {
  const node = select(label);
  checkSelectStyle(node);
  assert([...node.options].some(option => option.value === value), 'Requested option exists');
  if (label === '对话轮次') assert([...node.options].every(option => !option.textContent?.includes('·')), 'Round labels show date and time only');
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
  setter.call(node, value);
  node.dispatchEvent(new Event('change', { bubbles: true }));
  await frame();
}
async function mode(history: boolean) {
  await choose("审阅范围", history ? "history" : "last");
}
async function contextLines(lines: 1 | 3 | 5, expected?: 1 | 3 | 5) {
  document.querySelector<HTMLButtonElement>(".review-settings-button")!.click();
  await until(() => !!document.querySelector('[data-context-menu-item="review-context"]'), "Settings menu opens");
  document.querySelector('[data-context-menu-item="review-context"]')!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  await until(() => document.querySelectorAll('[data-context-menu-submenu-item]').length === 3, "Hover reveals exactly 1/3/5 options");
  assert(!document.querySelector('[data-context-menu-item="review-context--1"]'), "No full context option");
  const checked = document.querySelector<HTMLElement>('[data-context-menu-submenu-item][aria-checked="true"]')!;
  assert(checked.getAttribute("aria-checked") === "true", "Selected context is accessible");
  if (expected !== undefined) assert(checked.dataset.contextMenuItem === `review-context-${expected}`, "Global context choice survives session switches and reopening");
  const mark = checked.querySelector<HTMLElement>('.context-menu-check')!;
  assert(mark && mark.getBoundingClientRect().left > checked.querySelector('.context-menu-label')!.getBoundingClientRect().right, "Checkmark is on the right");
  await action("screenshot", "review-menu.png");
  document.querySelector<HTMLButtonElement>(`[data-context-menu-item="review-context-${lines}"]`)!.click();
  await frame();
}
const headers = () => [...document.querySelectorAll<HTMLButtonElement>(".review-history-file-header")];
const scroller = () => document.querySelector<HTMLElement>(".review-scroll")!;
async function ready() { await until(() => document.querySelector(".review-history")?.getAttribute("aria-busy") === "false", "Review read must settle"); assert(!document.querySelector('[role="alert"]'), document.querySelector('[role="alert"]')?.textContent ?? "Review error"); }
async function mount(session: SessionSummary, wait = true) {
  useAppStore.setState({ activeSessionId: session.id, sessions: [session], messages: [], isRunning: false });
  flushSync(() => root.render(<main className="fixture"><p className="fixture-label">受控测试数据 · 原生审阅实现预览</p><div className="fixture-panel"><ReviewTab /></div></main>));
  if (wait) await ready();
}
window.reviewProbe = async () => {
  const checks: string[] = [];
  const seed = await action("seed") as { session: SessionSummary; other: SessionSummary; round: string; latest: string; firstSnapshot: string; late: UiMessage };
  await mount(seed.session);
  await contextLines(3, 3);
  assert(headers().some(node => node.textContent?.includes("latest.txt")), "Latest ignores the newer no-edit conversation");
  const settingsStyle = getComputedStyle(document.querySelector('.review-settings-button')!);
  assert(settingsStyle.borderTopWidth === "0px", "Settings dots have no circular border");
  assert(getComputedStyle(headers()[0]).backgroundColor === "rgba(0, 0, 0, 0)", "File buttons have no permanent fill");
  checks.push("latest-skips-no-edit-round");
  const fileMenu = async (index = 0) => {
    document.querySelectorAll<HTMLButtonElement>('.review-file-menu-button')[index].click();
    await until(() => !!document.querySelector('[data-context-menu-item="review-open-external"]'), "File menu opens");
  };
  await fileMenu();
  assert(document.querySelector<HTMLButtonElement>('[data-context-menu-item="review-open-internal"]')!.disabled, "Missing file manager disables internal open");
  assert(headers()[0].getAttribute('aria-expanded') === 'false', "Menu does not expand the file");
  document.querySelector<HTMLButtonElement>('[data-context-menu-item="review-open-external"]')!.click();
  await until(() => !document.querySelector('[data-context-menu-item="review-open-external"]'), "File menu closes after action");
  await until(async () => (await action('opened') as unknown[]).length === 1, "External open reaches OS boundary");
  const opened = await action('opened') as {path:string;sessionId:string}[];
  assert(opened.length === 1 && opened[0].path.endsWith('latest.txt') && opened[0].sessionId === seed.session.id, "External action opens resolved current file with owning session");
  await fileMenu();
  const fileItems = [...document.querySelectorAll<HTMLButtonElement>('[data-context-menu-item]')];
  assert(fileItems.map(item => item.dataset.contextMenuItem).join(',') === 'review-open-internal,review-open-external,review-open-folder', "Folder action follows the two open actions");
  assert(!fileItems[2].disabled, "System folder action does not require a plugin");
  fileItems[2].click();
  await until(async () => (await action('revealed') as unknown[]).length === 1, "Folder action reaches OS file manager boundary");
  const revealed = await action('revealed') as {path:string;sessionId:string}[];
  assert(revealed[0].path.endsWith('latest.txt') && revealed[0].sessionId === seed.session.id, "Folder action uses exact resolved file and owning session");
  checks.push('open-containing-folder-through-system-file-manager');
  useAppStore.setState({ pluginViews: await api.listPluginViews() }); await frame();
  await fileMenu();
  assert(!document.querySelector<HTMLButtonElement>('[data-context-menu-item="review-open-internal"]')!.disabled, "Loaded file manager enables internal open");
  document.querySelector<HTMLButtonElement>('[data-context-menu-item="review-open-internal"]')!.click();
  await until(() => useAppStore.getState().workPanelTabs.some(tab => tab.location === 'latest.txt' && tab.resource === 'pi.file-manager/manager'), "Internal action opens the file manager tab");
  checks.push('file-menu-disabled-internal-loaded-plugin-and-external-current-file');
  await action("screenshot", "review-latest.png");
  assert(!select('对话轮次'), "History selector is hidden by default");
  assert(!document.querySelector('select[aria-label="上下文"]'), "No main context selector");
  await mode(true);
  await until(() => !!select('对话轮次'), "History adds its own row");
  const roundSelect = select("对话轮次");
  assert(roundSelect.getBoundingClientRect().height <= 30, "History selector stays compact");
  assert(parseFloat(getComputedStyle(roundSelect).columnGap) >= 10, 'Native trigger reserves space before its arrow');
  for (const count of [1, 3]) {
    const geometry = roundSelect.cloneNode(true) as HTMLSelectElement;
    geometry.replaceChildren(...Array.from({ length: count }, (_, index) => new Option(`Round ${index}`, String(index), index === 0, index === 0)));
    roundSelect.parentElement!.append(geometry);
    try { checkSelectStyle(geometry); } finally { geometry.remove(); }
  }
  checks.push('native-review-select-sidebar-colors-and-outer-only-corners');
  await choose("对话轮次", seed.round); await ready();
  assert(headers().length === 3, "Workspace, delegated and approved outside changes share one file list");
  assert(headers()[2].querySelector('.review-change-card-path')?.textContent === '.../review-open-tests-source.mjs', "Real outside Write shows only basename with three-dot prefix");
  assert(getComputedStyle(headers()[2].querySelector('.review-change-card-path')!).direction === 'ltr', "Outside prefix must stay before the filename visually");
  assert(headers()[2].title.includes('outside') && !headers()[2].title.includes('/workspace/'), "Outside title retains actual path, without prepending workspace");
  headers()[2].click(); await until(() => document.querySelectorAll('.review-history-file-body').length === 1, "Outside file expands");
  await fileMenu(2);
  assert(!document.querySelector('[data-context-menu-item="review-open-internal"]'), "Outside files omit internal open entirely");
  assert(document.querySelectorAll('[data-context-menu-item]').length === 2, "Outside menu has only external open and folder");
  assert(document.querySelector('.context-menu')!.getBoundingClientRect().width < 180, "File menu is compact");
  document.querySelector<HTMLButtonElement>('[data-context-menu-item="review-open-external"]')!.click();
  await until(async () => (await action('opened') as unknown[]).length === 2, "Outside open reaches actual reviewed-file service");
  await fileMenu(2); document.querySelector<HTMLButtonElement>('[data-context-menu-item="review-open-folder"]')!.click();
  await until(async () => (await action('revealed') as unknown[]).length === 2, "Outside folder reaches actual reviewed-file service");
  checks.push('outside-files-open-and-reveal-through-snapshot-no-internal-option');
  await until(() => document.querySelector('.review-history-file-body')?.textContent?.includes('outside = true') === true, "Outside file has real captured diff");
  assert(!document.querySelector('.review-change-rollback'), "Outside snapshot does not grant rollback writes");
  headers()[2].click(); await frame();
  checks.push('real-approved-outside-write-capture-display-and-safe-rollback');
  assert(headers()[0].textContent?.includes("long.ts"), "Files preserve original order");
  headers()[0].click();
  await until(() => document.querySelectorAll(".review-history-record").length === 2, "All same-file change records expand together");
  assert(document.querySelectorAll('.review-history-file-body .review-change-card-actions').length === 1, "One action bar per file");
  assert(document.querySelectorAll('.review-change-copy').length === 1 && document.querySelectorAll('.review-change-rollback').length === 1, "Exactly one copy and rollback for all operations");
  assert(!document.querySelector('.review-history-file-body')!.textContent?.includes('修改记录'), "No per-operation title");
  checks.push('one-file-one-copy-and-rollback-no-record-titles');
  assert(!document.querySelector(".review-history-root"), "No extra execution-root row in the diff");
  assert(document.querySelectorAll(".review-line-number").length > 0, "Old and new line numbers render");
  await contextLines(5);
  await until(() => document.querySelector('.review-change-diff')?.textContent?.includes("line_025") === true, "5-line context is loaded from bounded history");
  assert(!document.querySelector('.review-change-diff')?.textContent?.includes("line_001"), "No full-file context is rendered");
  assert(!document.querySelector('.review-change-diff')?.textContent?.includes("external-current-only"), "Current disk never supplies historical context");
  assert(!document.querySelector('.review-history-file-body')!.textContent?.includes('差异过大'), "3100-line file with small edits stays reviewable");
  checks.push("trimmed-3100-line-file-keeps-numbered-finite-context");
  checks.push("hover-menu-only-1-3-5-context-and-numbered-lines");
  const nested = [...scroller().querySelectorAll<HTMLElement>("*")].filter(node => ["auto", "scroll"].includes(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight + 1);
  assert(nested.length === 0, "No nested vertical scrolling in expanded files");
  assert(scroller().scrollHeight > scroller().clientHeight, "Outer review scrolls");
  scroller().scrollTop = 420; await frame();
  const box = headers()[0].getBoundingClientRect(), outer = scroller().getBoundingClientRect();
  const stickyTop = outer.top + parseFloat(getComputedStyle(scroller()).paddingTop);
  assert(Math.abs(box.top - stickyTop) <= 2, `File header sticks below toolbar: ${box.top}/${stickyTop}`);
  assert(document.elementFromPoint(box.left + 20, box.top + box.height / 2)?.closest(".review-history-file-header"), "Sticky header is not covered");
  await action("screenshot", "review-normal.png");
  await action("resize", 420); await frame(); await frame();
  assert(scroller().getBoundingClientRect().width <= 420, "Narrow viewport applied");
  assert(headers()[0].getBoundingClientRect().right <= window.innerWidth + 1, "Narrow header fits");
  assert(Math.abs(headers()[0].getBoundingClientRect().top - scroller().getBoundingClientRect().top - parseFloat(getComputedStyle(scroller()).paddingTop)) <= 2, "Narrow sticky header is visible");
  await action("screenshot", "review-narrow.png");
  checks.push("single-outer-scroll-normal-narrow-sticky-uncovered");
  await action("resize", 920); scroller().scrollTop = 0; await frame();
  const copy = document.querySelector<HTMLButtonElement>(".review-change-copy")!; copy.click();
  await until(() => copy.classList.contains("copied"), "Copy action succeeds");
  assert((await action("clipboard") as string).includes("@@"), "Copied text is a diff, not line-number UI");
  assert((await action("clipboard") as string).includes("line_040 = 400"), "File copy includes every recorded operation");
  document.querySelector<HTMLButtonElement>(".review-change-rollback")!.click();
  await until(() => useAppStore.getState().toasts.length > 0, "Hash conflict remains visible");
  assert((await action("readCurrent") as string).includes("external-current-only"), "Conflict rollback leaves user edits untouched");
  checks.push("copy-and-existing-hash-guarded-rollback");
  document.querySelector<HTMLButtonElement>(".review-settings-button")!.click();
  await until(() => !!document.querySelector('[data-context-menu-item="review-wrap"]'), "Word wrap menu opens");
  document.querySelector<HTMLButtonElement>('[data-context-menu-item="review-wrap"]')!.click();
  await until(() => !!document.querySelector('.review-history.is-nowrap'), "Word wrap can be disabled");
  assert(getComputedStyle(document.querySelector('.diff-line-text')!).whiteSpace === "pre", "Disabled wrapping preserves lines");
  document.querySelector<HTMLButtonElement>(".review-settings-button")!.click();
  await until(() => !!document.querySelector('[data-context-menu-item="review-wrap"]'), "Word wrap menu reopens");
  document.querySelector<HTMLButtonElement>('[data-context-menu-item="review-wrap"]')!.click();
  await until(() => !document.querySelector('.review-history.is-nowrap'), "Word wrap restores");

  headers()[0].click(); await frame(); assert(!document.querySelector(".review-history-file-body"), "File can collapse after browsing");
  await mode(false); await ready();
  await action("late");
  useAppStore.setState({ messages: [seed.late] }); await ready();
  assert(headers().some(node => node.textContent?.includes("latest.txt")), "Late old delegate does not take over Latest");
  await action("restart");
  await mount(seed.other); assert(headers().length === 0, "Other session has no leaked files");
  await contextLines(1, 5);
  flushSync(() => root.render(null));
  await mount(seed.other); await contextLines(1, 1);
  await mount(seed.session); assert(headers().some(node => node.textContent?.includes("latest.txt")), "Persisted history survives restart");
  await contextLines(1, 1);
  requestReviewFocus([seed.firstSnapshot], { expand: true, sessionId: seed.session.id }); await ready();
  await until(() => headers()[0]?.getAttribute("aria-expanded") === "true", "Chat file request finds old round and expands file");
  checks.push("late-delegate-session-isolation-restart-and-focus");
  await until(() => document.querySelector('.review-change-diff')?.textContent?.includes('line_029') === true && !document.querySelector('.review-change-card-body-content [role="status"]'), 'Remembered one-line context reaches the actual diff');
  assert(!document.querySelector('.review-change-diff')?.textContent?.includes('line_028'), 'Remembered context does not expand to three or five lines');
  checks.push('global-context-choice-survives-session-switch-and-panel-reopen');
  await contextLines(3, 1); await frame(); scroller().scrollTop = 0; await frame();
  await action("screenshot", "review-overview.png");
  await mount(seed.other);
  await action("holdReads");
  await mount(seed.session, false);
  await action("readBlocked");
  await mount(seed.other, false);
  await action("releaseReads"); await ready();
  assert(headers().length === 0, "An old session read cannot populate the new session");
  await mount(seed.session);
  await mode(false); await ready();
  await action("runningStart"); useAppStore.setState({ isRunning: true }); await ready();
  assert(headers().some(node => node.textContent?.includes("latest.txt")), "Empty running round keeps prior modified round");
  const live = await action("runningWrite") as UiMessage;
  useAppStore.setState({ messages: [live] }); await ready();
  await until(() => headers().some(node => node.textContent?.includes("running.txt")), "First live modification becomes Latest");
  await action("runningEnd"); useAppStore.setState({ isRunning: false }); await ready();
  checks.push("inflight-session-switch-and-first-live-modification");
  await mode(true); await choose("对话轮次", seed.round); await ready();
  await action('resetCurrent'); headers()[0].click();
  await until(() => !!document.querySelector('.review-change-rollback'), "Grouped rollback is reachable from file footer");
  document.querySelector<HTMLButtonElement>('.review-change-rollback')!.click();
  await until(() => !!document.querySelector('.review-history-file-body .is-rolled-back'), "One grouped action marks every file record rolled back");
  const restored = await action('readCurrent') as string;
  assert(restored.includes('line_030 = 30;') && restored.includes('line_040 = 40;') && restored.includes('line_080 = 80;'), "File rollback restores the state before the first operation");
  checks.push('single-file-action-rolls-back-entire-chain');
  // Presentation-only fixture: this does not claim outside-workspace capture.
  const outside = { ...groupReviewFiles([{ message: seed.late }])[0], root: undefined, path: '/outside/deep/review-open-tests-source.mjs' };
  flushSync(() => root.render(<ReviewHistoryFile file={outside} sessionId={seed.session.id} context={3} disabled={false} onChanged={() => {}} />));
  assert(document.querySelector('.review-change-card-path')?.textContent === '.../review-open-tests-source.mjs', "Absolute file labels hide directory prefixes");
  assert(headers()[0].title === outside.path, "Full source path remains available in title");
  checks.push('outside-path-display-only-basename-and-full-title');
  await mount(seed.session); await contextLines(1);
  return { checks };
};

// A fresh renderer module graph must read the same choice from the profile.
window.reviewReloadProbe = async () => {
  const seed = await action('currentSeed') as { session: SessionSummary; firstSnapshot: string };
  await mount(seed.session);
  await contextLines(1, 1);
  requestReviewFocus([seed.firstSnapshot], { expand: true, sessionId: seed.session.id }); await ready();
  await until(() => document.querySelector('.review-change-diff')?.textContent?.includes('line_029') === true && !document.querySelector('.review-change-card-body-content [role="status"]'), 'Reloaded renderer restores one-line context in captured diff');
  assert(!document.querySelector('.review-change-diff')?.textContent?.includes('line_028'), 'Reloaded renderer does not revert to the default context');
  return { checks: ['global-context-choice-survives-renderer-reload'] };
};
