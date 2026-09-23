import { runTurnFileReviewNavigationProbe } from "./turn-file-review-navigation";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { zhCN } from "@pi-desktop/i18n";
import type { ReviewChange, UiMessage } from "@pi-desktop/shared";
import { WorkPanel } from "../../apps/desktop/src/components/workpanel/WorkPanel";
import { TurnFileSummary } from "../../apps/desktop/src/features/chat/transcript/TurnFileSummary";
import { buildTranscriptEntries } from "../../apps/desktop/src/lib/assistant-turns";
import { reviewChangesFromMessage } from "../../apps/desktop/src/lib/workspace-review";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import { switchWorkPanelSession } from "../../apps/desktop/src/stores/slices/work-panel-slice";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

const painted = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

const message = (
  id: string,
  role: UiMessage["role"],
  content: string,
  extra: Partial<UiMessage> = {},
): UiMessage => ({
  id,
  role,
  content,
  createdAt: "2026-09-20T00:00:00.000Z",
  ...extra,
});

function review(
  snapshotId: string,
  path: string,
  additions: number,
  text = `created ${path}`,
): ReviewChange {
  return {
    version: 1,
    snapshotId,
    messageId: snapshotId.startsWith("session-b") ? "session-b-copy" : "summary-copy",
    path,
    operation: "write",
    status: "added",
    state: "active",
    additions,
    deletions: 0,
    hunks: [
      {
        header: "@@ -0,0 +1 @@",
        lines: [{ type: "add", text }],
      },
    ],
    reversible: true,
  };
}

function screenshotWorkflowMessages(): UiMessage[] {
  return [
    message("summary-copy", "tool", "copied", {
      toolName: "Bash",
      toolStatus: "success",
      toolResult: {
        details: {
          root: "workspace",
          exitCode: 0,
          reviews: [
            review("snapshot-html", "index.html", 20),
            review("snapshot-css", "styles.css", 12),
            review("snapshot-js", "app.js", 8),
          ],
          reviewCapture: { status: "complete" },
        },
      },
    }),
    message("summary-answer", "assistant", "Done", { status: "complete" }),
    message("next-user", "user", "Change HTML again"),
    message("later-html", "tool", "changed", {
      toolName: "Edit",
      toolStatus: "success",
      toolResult: {
        details: {
          root: "workspace",
          review: {
            ...review("snapshot-html-later", "index.html", 1, "later turn html"),
            messageId: "later-html",
          },
        },
      },
    }),
    message("later-answer", "assistant", "Changed again", { status: "complete" }),
  ];
}

function sessionBMessages(): UiMessage[] {
  return [
    message("session-b-copy", "tool", "copied", {
      toolName: "Bash",
      toolStatus: "success",
      toolResult: {
        details: {
          root: "workspace",
          exitCode: 0,
          reviews: [review("session-b-css", "styles.css", 2, "session b css")],
          reviewCapture: { status: "complete" },
        },
      },
    }),
    message("session-b-answer", "assistant", "Done", { status: "complete" }),
  ];
}

function Fixture({ turnId }: { turnId: string }) {
  const messages = useAppStore((state) => state.messages);
  const sessionId = useAppStore((state) => state.activeSessionId);
  const workPanelOpen = useAppStore((state) => state.workPanelOpen);
  const entry = buildTranscriptEntries(messages).entries.find(
    (item) => item.kind === "assistant-turn" && item.id === turnId,
  );
  assert(entry?.kind === "assistant-turn", `assistant turn ${turnId} missing`);
  return (
    <div className="turn-file-summary-fixture">
      <main>
        <TurnFileSummary entry={entry} sessionId={sessionId} />
      </main>
      {workPanelOpen ? <WorkPanel containerWidth={1280} sidebarCollapsed /> : null}
    </div>
  );
}

/** Mounted component probe; the transcript runner may register this directly. */
export async function runTurnFileSummaryProbe() {
  const i18n = createInstance();
  await i18n.init({
    lng: "zh-CN",
    resources: { "zh-CN": { translation: zhCN } },
    interpolation: { escapeValue: false },
  });
  const navigation = await runTurnFileReviewNavigationProbe(i18n);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const previousState = useAppStore.getState();
  const previousBridge = window.piDesktop;
  const sessionA = "turn-file-summary-a";
  const sessionB = "turn-file-summary-b";
  const render = (turnId: string) => {
    flushSync(() =>
      root.render(
        <I18nextProvider i18n={i18n}>
          <Fixture turnId={turnId} />
        </I18nextProvider>,
      ),
    );
  };
  const summaryButton = (path: string) => {
    const button = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".turn-file-summary-file-header"),
    ).find((candidate) => candidate.textContent?.includes(path));
    assert(button, `${path} summary navigation missing`);
    return button;
  };

  try {
    window.piDesktop = {
      invoke: async (_channel, input) => ({
        ok: true,
        data: {
          status: "rolledBack",
          snapshotId: (input as { snapshotId: string }).snapshotId,
        },
      }),
      on: () => () => undefined,
      channels: previousBridge?.channels ?? ({} as NonNullable<typeof window.piDesktop>["channels"]),
      platform: "win32",
    };
    useAppStore.setState({
      activeSessionId: sessionA,
      isRunning: false,
      messages: screenshotWorkflowMessages(),
      workPanelOpen: false,
      workPanelTabs: [],
      activeWorkPanelTabId: null,
      workPanelContexts: {},
    });
    render("summary-copy");

    assert(container.textContent?.includes("本轮编辑 3 个文件"), "exact summary title missing");
    assert(!container.querySelector(".turn-file-summary-note"), "scope disclaimer still rendered");
    assert(!container.querySelector(".turn-file-summary .review-change-card"), "chat contains nested review diff");
    for (const count of [3, 4, 5, 6, 21]) {
      const files = Array.from({ length: count }, (_, index) =>
        review(`count-${count}-${index}`, `file-${index}.ts`, 1),
      );
      flushSync(() => useAppStore.setState({ messages: [
        message("summary-copy", "tool", "created files", {
          toolName: "Bash",
          toolStatus: "success",
          toolResult: { details: { root: "workspace", reviews: files } },
        }),
        message("summary-answer", "assistant", "Done", { status: "complete" }),
      ] }));
      const rows = () => container.querySelectorAll(".turn-file-summary-file-header").length;
      const toggle = () => container.querySelector<HTMLButtonElement>(".turn-file-summary-more");
      assert(rows() === (count > 5 ? 3 : count), `${count} files: incorrect initial visible count`);
      if (count <= 5) {
        assert(!toggle(), `${count} files must not show a collapse control`);
      } else {
        const more = toggle();
        assert(more?.textContent === i18n.t("chat.turnFilesShowMore", { count: count - 3 }), "remaining file count is wrong");
        flushSync(() => more.click());
        assert(rows() === count && toggle()?.getAttribute("aria-expanded") === "true", "expand must show every file");
        flushSync(() => toggle()?.click());
        assert(rows() === 3 && toggle()?.getAttribute("aria-expanded") === "false", "collapse must restore the first three files");
      }
    }
    flushSync(() => useAppStore.setState({ messages: screenshotWorkflowMessages() }));
    const fileSummary = container.querySelector<HTMLElement>(
      ".turn-file-summary",
    );
    const summaryHeader = container.querySelector<HTMLElement>(
      ".turn-file-summary-header",
    );
    const summaryIcon = container.querySelector<HTMLElement>(
      ".turn-file-summary-icon",
    );
    const summaryList = container.querySelector<HTMLElement>(
      ".turn-file-summary-list",
    );
    const summaryTitle = container.querySelector<HTMLElement>(
      ".turn-file-summary-heading strong",
    );
    const summaryTotals = container.querySelector<HTMLElement>(
      ".turn-file-summary-totals",
    );
    const firstFile = container.querySelector<HTMLElement>(
      ".turn-file-summary-file-header",
    );
    const firstFilePath = container.querySelector<HTMLElement>(
      ".turn-file-summary-path",
    );
    assert(
      fileSummary &&
        summaryHeader &&
        summaryIcon &&
        summaryList &&
        summaryTitle &&
        summaryTotals &&
        firstFile &&
        firstFilePath,
      "summary layout regions missing",
    );
    await document.fonts.ready;
    for (const width of [640, 320]) {
      fileSummary.style.width = `${width}px`;
      await painted();
      const summaryStyle = getComputedStyle(fileSummary);
      const headerStyle = getComputedStyle(summaryHeader);
      const iconStyle = getComputedStyle(summaryIcon);
      const listStyle = getComputedStyle(summaryList);
      const fileStyle = getComputedStyle(firstFile);
      const pathStyle = getComputedStyle(firstFilePath);
      const headerRect = summaryHeader.getBoundingClientRect();
      const iconRect = summaryIcon.getBoundingClientRect();
      const titleRect = summaryTitle.getBoundingClientRect();
      const totalsRect = summaryTotals.getBoundingClientRect();
      const fileRect = firstFile.getBoundingClientRect();
      const pathRect = firstFilePath.getBoundingClientRect();
      const lineHeight = Number.parseFloat(pathStyle.lineHeight);
      assert(summaryStyle.borderTopWidth === "1px" && Number.parseFloat(summaryStyle.borderTopLeftRadius) > 0, "rounded file summary frame missing");
      assert(
        summaryStyle.backgroundColor === "rgba(0, 0, 0, 0)",
        "file summary still paints a tile background",
      );
      assert(
        headerRect.height >= 40 && headerRect.height <= 48,
        "file summary header must preserve card padding",
      );
      assert(
        iconRect.width <= 16 && iconRect.height <= 16,
        "file summary icon is still a heavy tile",
      );
      assert(
        iconStyle.backgroundColor === "rgba(0, 0, 0, 0)",
        "file summary icon still paints a tile",
      );
      assert(
        headerStyle.borderBottomWidth === "0px" &&
          listStyle.borderTopWidth === "1px",
        "header/list distinction must use only the subtle list divider",
      );
      assert(
        Math.abs(
          titleRect.top +
            titleRect.height / 2 -
            (totalsRect.top + totalsRect.height / 2),
        ) <= 1,
        "summary totals must share the heading line",
      );
      assert(
        fileRect.top - headerRect.bottom >= 4,
        "file list must stay distinct from the header",
      );
      assert(
        fileRect.height >= 27 && fileRect.height <= 30,
        "file row is not native-compact",
      );
      assert(
        fileStyle.alignItems === "center",
        "file hover row does not center its contents",
      );
      assert(
        Number.isFinite(lineHeight) && pathStyle.lineHeight !== "normal",
        "file name line box is implicit",
      );
      assert(
        Math.abs(pathRect.height - lineHeight) <= 0.75,
        "file name element does not expose its real line box",
      );
      assert(
        Math.abs(
          pathRect.top +
            pathRect.height / 2 -
            (fileRect.top + fileRect.height / 2),
        ) <= 0.5,
        "file name line box is not vertically centered in the hover row",
      );
      assert(
        fileSummary.scrollWidth <= fileSummary.clientWidth + 1,
        "file summary overflows a narrow viewport",
      );
    }
    fileSummary.style.removeProperty("width");

    flushSync(() => summaryButton("styles.css").click());
    await painted();
    assert(container.querySelector("[data-testid='work-panel']"), "work panel did not open");
    assert(container.querySelector(".review-change-card-body"), "selected diff did not expand");
    assert(container.textContent?.includes("created styles.css"), "CSS snapshot hunk missing");
    assert(!container.textContent?.includes("created app.js"), "unrelated selected record rendered");

    flushSync(() => useAppStore.getState().openNewWorkPanelTab());
    const launcherId = useAppStore.getState().activeWorkPanelTabId;
    assert(launcherId, "launcher tab missing");
    flushSync(() => useAppStore.getState().activateWorkPanelTab("review"));
    await painted();
    assert(
      useAppStore.getState().workPanelContexts[sessionA]?.reviewSelection?.selectedPath === "styles.css",
      "switching panel tabs lost the selected file",
    );
    flushSync(() => useAppStore.getState().closeWorkPanelTab(launcherId));
    assert(container.querySelectorAll(".review-scroll .review-change-card").length === 1, "closing another tab cleared review selection");
    flushSync(() => useAppStore.getState().openNewWorkPanelTab());
    const replacementId = useAppStore.getState().activeWorkPanelTabId;
    assert(replacementId, "replacement launcher missing");
    flushSync(() => useAppStore.getState().replaceWorkPanelTab(replacementId, { id: "new:replacement", kind: "new" }));
    flushSync(() => useAppStore.getState().activateWorkPanelTab("review"));
    await painted();
    assert(container.querySelectorAll(".review-scroll .review-change-card").length === 1, "replacing another tab cleared review selection");

    const selectedHeader = container.querySelector<HTMLButtonElement>(
      ".review-scroll .review-change-card-header",
    );
    assert(selectedHeader, "selected review header missing");
    flushSync(() => selectedHeader.click());
    assert(!container.querySelector(".review-change-card-body"), "selected record did not collapse");
    flushSync(() => summaryButton("styles.css").click());
    await painted();
    assert(container.querySelector(".review-change-card-body"), "repeat click did not reveal collapsed record");

    const rollback = container.querySelector<HTMLButtonElement>(
      ".review-scroll .review-change-rollback",
    );
    assert(rollback, "selected rollback action missing");
    rollback.click();
    await painted();
    const shellMessage = useAppStore.getState().messages.find((item) => item.id === "summary-copy");
    assert(shellMessage, "shell message missing after rollback");
    const states = Object.fromEntries(
      reviewChangesFromMessage(shellMessage).map((change) => [change.snapshotId, change.state]),
    );
    assert(states["snapshot-css"] === "rolledBack", "target snapshot was not rolled back");
    assert(states["snapshot-html"] === "active", "HTML sibling changed unexpectedly");
    assert(states["snapshot-js"] === "active", "JavaScript sibling changed unexpectedly");
    assert(container.querySelector('.review-change-card[data-state="rolledBack"]'), "rollback state not reflected in selected review");

    flushSync(() => summaryButton("index.html").click());
    await painted();
    assert(container.textContent?.includes("created index.html"), "selected HTML hunk missing");
    assert(!container.textContent?.includes("later turn html"), "same path from another turn leaked in");

    const sessionAMessages = useAppStore.getState().messages;
    const toB = switchWorkPanelSession(useAppStore.getState(), sessionB);
    useAppStore.setState({
      ...toB,
      activeSessionId: sessionB,
      messages: sessionBMessages(),
    });
    render("session-b-copy");
    assert(!container.textContent?.includes("created index.html"), "session A selection leaked into session B");
    flushSync(() => summaryButton("styles.css").click());
    await painted();
    assert(container.textContent?.includes("session b css"), "session B selection did not open");

    const toA = switchWorkPanelSession(useAppStore.getState(), sessionA);
    useAppStore.setState({
      ...toA,
      activeSessionId: sessionA,
      messages: sessionAMessages,
    });
    render("summary-copy");
    await painted();
    assert(container.textContent?.includes("created index.html"), "session A selection was not restored");
    assert(!container.textContent?.includes("session b css"), "session B selection leaked on return");

    flushSync(() => useAppStore.getState().closeWorkPanelTab("review"));
    assert(!useAppStore.getState().workPanelContexts[sessionA]?.reviewSelection, "closing review must clear its file selection");
    flushSync(() => useAppStore.getState().openWorkPanelTab({ id: "review", kind: "review" }));
    await painted();
    assert(container.querySelectorAll(".review-scroll .review-change-card").length > 1, "reopened generic review must show session history");

    useAppStore.setState({
      messages: [
        message("partial-shell", "tool", "failed", {
          toolName: "Bash",
          toolStatus: "error",
          toolResult: {
            details: {
              root: "workspace",
              exitCode: 1,
              reviews: [],
              reviewCapture: { status: "partial" },
            },
          },
        }),
        message("partial-answer", "assistant", "Partial", { status: "complete" }),
      ],
      workPanelOpen: false,
    });
    render("partial-shell");
    assert(!container.querySelector(".turn-file-summary"), "empty partial capture rendered a warning summary");

    return { ok: true, navigation };
  } finally {
    flushSync(() => root.unmount());
    useAppStore.setState(previousState, true);
    window.piDesktop = previousBridge;
    container.remove();
  }
}
