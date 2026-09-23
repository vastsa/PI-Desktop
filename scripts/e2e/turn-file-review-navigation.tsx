import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import type { i18n } from "i18next";
import type { ReviewChange, ReviewRollbackStatus, UiMessage } from "@pi-desktop/shared";
import { WorkPanel } from "../../apps/desktop/src/components/workpanel/WorkPanel";
import { ChatTranscript } from "../../apps/desktop/src/features/chat/transcript/ChatTranscript";
import { useTranscriptView } from "../../apps/desktop/src/hooks/use-transcript-view";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

const assert = (value: unknown, message: string): void => {
  if (!value) throw new Error(message);
};
const painted = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const sessionId = "review-navigation-a";
const path = "PI-Desktop-worktrees/task-turn-summary/scripts/e2e-transcript-scroll.mjs";
const zeroPath = "docs/spec/recorded.md";
const row = (id: string, role: UiMessage["role"], extra: Partial<UiMessage> = {}): UiMessage => ({
  id, role, content: id, createdAt: "2026-09-20T00:00:00.000Z", ...extra,
});
const change = (snapshotId: string, filePath: string): ReviewChange => ({
  version: 1, snapshotId, messageId: snapshotId, path: filePath,
  operation: "edit", status: "modified", state: "active", additions: 48, deletions: 24,
  hunks: [{ header: "@@ -1 +1 @@", lines: [{ type: "add", text: `persisted ${snapshotId}` }] }],
  reversible: true,
});
const edit = (id: string, reviews: ReviewChange[]): UiMessage => row(id, "tool", {
  toolName: "Bash", toolStatus: "success",
  toolResult: { details: { root: "workspace", reviews, reviewCapture: { status: "complete" } } },
});
const files = [
  ...Array.from({ length: 13 }, (_, index) => change(`extra-${index}`, `src/extra-${index}.ts`)),
  { ...change("zero-lines", zeroPath), additions: 0, deletions: 0, hunks: [], reversible: false },
  change("selected", path),
];
const history = [
  row("user", "user"), edit("earlier", [change("before-checkpoint", path)]),
  row("checkpoint", "assistant"), edit("after-checkpoint", files),
  row("answer", "assistant", { status: "complete" }),
];
const live = [row("later-user", "user"), edit("later", [change("later-same-path", path)]), row("later-answer", "assistant")];

function Fixture() {
  const activeSessionId = useAppStore((state) => state.activeSessionId)!;
  const view = useTranscriptView(activeSessionId);
  const open = useAppStore((state) => state.workPanelOpen);
  const subagentPanel = useAppStore((state) => state.subagentPanel);
  return <div style={{ display: "flex", height: 700 }}>
    <main style={{ width: 720 }}>
      <ChatTranscript sessionId={activeSessionId} messages={view.messages} isRunning={false}
        readingWindow={view.historical} hasMoreBefore={view.hasMoreBefore} hasMoreAfter={view.hasMoreAfter} />
    </main>
    {open || subagentPanel ? <WorkPanel containerWidth={1280} sidebarCollapsed subagentPanel={subagentPanel} /> : null}
  </div>;
}

/** Real transcript -> summary -> real store actions -> ReviewTab; only IPC is fake. */
export async function runTurnFileReviewNavigationProbe(i18n: i18n) {
  const previousState = useAppStore.getState();
  const previousBridge = window.piDesktop;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let status: ReviewRollbackStatus = "conflict";
  let completeRollback: (() => void) | undefined;
  let deferRollback = false;
  const requests: { sessionId: string; snapshotId: string }[] = [];
  try {
    window.piDesktop = {
      ...previousBridge!,
      invoke: async (_channel, input) => {
        const request = input as { sessionId: string; snapshotId: string };
        requests.push(request);
        if (deferRollback) await new Promise<void>((resolve) => { completeRollback = resolve; });
        return { ok: true, data: { status, snapshotId: request.snapshotId } };
      },
      on: () => () => undefined,
    };
    for (const mode of ["compaction", "history", "search", "partial-history"] as const) {
      status = "conflict";
      flushSync(() => {
        useAppStore.setState({ activeSessionId: undefined });
        useAppStore.setState({
          activeSessionId: sessionId, selectingSessionId: undefined, isRunning: false,
          retainedSessionIds: [sessionId], runningSessions: {},
          messages: mode === "compaction" ? history : live,
          sessionCompactions: { [sessionId]: [{ id: "mark", throughMessageId: "checkpoint", generation: 1, summaryTokens: 1, summarized: true }] },
          transcriptViews: mode === "compaction" ? {} : { [sessionId]: {
            messages: mode === "partial-history" ? history.slice(3) : history,
            messageStart: mode === "partial-history" ? 3 : 0,
            hasMoreBefore: mode === "partial-history", hasMoreAfter: true,
            focus: mode === "search" ? { sessionId, messageId: "answer", query: "answer", requestId: 1 } : null, loading: null,
          } },
          workPanelOpen: false, workPanelTabs: [], activeWorkPanelTabId: null, workPanelContexts: {},
          subagentPanel: null,
        });
        root.render(<I18nextProvider i18n={i18n}><Fixture key={mode} /></I18nextProvider>);
      });
      const summary = container.querySelector('[data-message-id="answer"]')?.closest(".assistant-turn")
        ?.querySelector<HTMLElement>(".turn-file-summary");
      assert(summary, `${mode}: first-commit file frame waited for unrelated history`);
      const heading = summary!.querySelector(".turn-file-summary-heading strong")?.textContent ?? "";
      assert(heading === "本轮编辑 15 个文件", `${mode}: loaded file count missing on first commit`);
      assert(summary!.querySelector(".turn-file-summary-totals")?.getAttribute("aria-label") ===
        i18n.t("chat.turnFilesEditTotalsLabel", { additions: 14 * 48, deletions: 14 * 24 }),
      `${mode}: loaded line totals missing on first commit`);
      const processHeader = summary!.closest(".assistant-turn")?.querySelector(".turn-process > .tool-activity-header");
      assert(processHeader?.querySelector(".tool-activity-label")?.textContent ===
        i18n.t("chat.processedFor", { time: "0s" }), `${mode}: loaded duration missing on first commit`);
      assert(processHeader?.querySelector(".tool-activity-count")?.textContent ===
        i18n.t("chat.processTools", { count: 1 }), `${mode}: loaded tool count missing on first commit`);
      assert(summary!.querySelectorAll(".turn-file-summary-file-header").length === 3, `${mode}: collapse threshold changed`);
      const click = (filePath: string) => {
        const button = Array.from(summary!.querySelectorAll<HTMLButtonElement>(".turn-file-summary-file-header"))
          .find((element) => element.querySelector(".turn-file-summary-path")?.textContent === filePath);
        assert(button, `${mode}: missing path ${filePath}`);
        flushSync(() => button!.click());
      };
      click(path);
      await painted();
      const review = () => container.querySelector(".review-scroll");
      assert(container.querySelector("[data-testid='work-panel']"), `${mode}: summary click did not open right Review panel`);
      assert(review()?.textContent?.includes("persisted selected"), `${mode}: exact expanded diff missing`);
      assert(!review()?.textContent?.includes("before-checkpoint") && !review()?.textContent?.includes("later-same-path"), `${mode}: same path leaked across turns`);
      assert(review()?.querySelectorAll(".review-change-card").length === 1, `${mode}: unrelated records leaked`);
      const rollback = () => review()?.querySelector<HTMLButtonElement>(".review-change-rollback");
      rollback()?.click();
      await painted();
      assert(review()?.querySelector(".review-change-rollback-note.is-warning"), `${mode}: rollback conflict hidden`);
      assert(!review()?.querySelector('[data-state="rolledBack"]'), `${mode}: conflict incorrectly changed evidence`);
      status = "rolledBack";
      rollback()?.click();
      await painted();
      assert(review()?.querySelector('[data-state="rolledBack"]'), `${mode}: rollback did not update selected reading-range evidence`);
      assert(requests.at(-1)?.sessionId === sessionId && requests.at(-1)?.snapshotId === "selected", `${mode}: wrong rollback target`);
      flushSync(() => useAppStore.getState().toggleSubagentPanel("delegate"));
      assert(!review(), `${mode}: subagent surface should replace Review before navigation`);
      click(zeroPath);
      await painted();
      assert(review()?.querySelector(".review-change-card-body"), `${mode}: +0/-0 record did not open`);
      assert(useAppStore.getState().subagentPanel === null, `${mode}: explicit file navigation retained subagent surface`);
      assert(!rollback(), `${mode}: nonreversible record exposes rollback`);
    }
    // An async response belongs to its captured session, never the new active one.
    flushSync(() => useAppStore.setState({ activeSessionId: sessionId, messages: history }));
    deferRollback = true;
    const pending = useAppStore.getState().rollbackWorkspaceChange("after-checkpoint", "selected");
    const otherMessages = [edit("after-checkpoint", [change("selected", path)])];
    flushSync(() => useAppStore.setState({ activeSessionId: "review-navigation-b", messages: otherMessages, transcriptViews: {}, workPanelOpen: false }));
    completeRollback!();
    await pending;
    assert(useAppStore.getState().messages === otherMessages, "late rollback changed another session's evidence");
    return { ok: true, cases: ["compaction", "history", "search", "partial-history", "subagent-surface", "late-rollback"] };
  } finally {
    flushSync(() => root.unmount());
    useAppStore.setState(previousState, true);
    window.piDesktop = previousBridge;
    container.remove();
  }
}
