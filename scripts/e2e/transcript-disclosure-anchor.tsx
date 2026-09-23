import { AssistantTurn } from "../../apps/desktop/src/features/chat/transcript/AssistantTurn";
import { buildTranscriptEntries } from "../../apps/desktop/src/lib/assistant-turns";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { en } from "@pi-desktop/i18n";
import type { UiMessage } from "@pi-desktop/shared";
import { DisclosureAnchorContext } from "../../apps/desktop/src/lib/disclosure-anchor-context";
import { useTranscriptScroll } from "../../apps/desktop/src/features/chat/transcript/hooks/useTranscriptScroll";
import { ToolRow } from "../../apps/desktop/src/features/chat/transcript/ToolRow";
import { useFollowScroll } from "../../apps/desktop/src/hooks/use-follow-scroll";

declare global {
  var transcriptDisclosureProbe: () => Promise<unknown>;
}

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

const createdAt = "2026-09-16T00:00:00.000Z";

function message(
  id: string,
  role: UiMessage["role"],
  content: string,
  extra: Partial<UiMessage> = {},
): UiMessage {
  return { id, role, content, createdAt, ...extra };
}

/** A tool row whose opened body is far taller than its own header. */
function toolRowMessage(id: string): UiMessage {
  return message(id, "tool", "done", {
    toolName: "Bash",
    toolCallId: `call-${id}`,
    toolStatus: "success",
    toolArgs: { command: "printf 'step'" },
    toolResult: {
      details: {
        stdout: Array.from({ length: 80 }, (_value, index) => `step ${index}`).join(
          "\n",
        ),
        exitCode: 0,
      },
    },
  });
}

type Geometry = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  /** The clicked title's top, relative to the scroller's own top edge. */
  titleTop: number;
  distanceFromBottom: number;
};

function geometry(scroller: HTMLElement, title: HTMLElement): Geometry {
  const scrollerTop = scroller.getBoundingClientRect().top;
  return {
    scrollTop: scroller.scrollTop,
    scrollHeight: scroller.scrollHeight,
    clientHeight: scroller.clientHeight,
    titleTop: title.getBoundingClientRect().top - scrollerTop,
    distanceFromBottom:
      scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight,
  };
}

/** Two ticks: one for the observer-driven layout, one for the follow frame. */
async function settle() {
  for (let tick = 0; tick < 3; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

/**
 * The transcript scroller's own DOM, with the real hook driving it: the real
 * ResizeObserver, follow mode and disclosure hold, in a real 600 CSS px
 * viewport. Only the app's stylesheet is left out, so the geometry comes from
 * inline sizes and the real components' intrinsic height.
 */
function TranscriptFixture({ messages, process = false }: { messages: UiMessage[]; process?: boolean }) {
  const entry = process ? buildTranscriptEntries(messages).entries.find((item) => item.kind === "assistant-turn") : undefined;
  const {
    scrollRef,
    wrapRef,
    contentRef,
    handleScroll,
    disclosureAnchorNotifier,
  } = useTranscriptScroll({
    sessionId: "fixture",
    messages,
    hasMoreBefore: false,
    isRunning: false,
    askPending: false,
    approvalPending: false,
    paneVisible: true,
    searchTarget: null,
    readingWindow: false,
  });
  return (
    <DisclosureAnchorContext.Provider value={disclosureAnchorNotifier}>
      <div
        ref={wrapRef}
        className="thread-wrap"
        style={{ height: "100%", position: "relative" }}
      >
        <div
          ref={scrollRef}
          className="thread-scroll"
          data-scroll-owner="transcript"
          onScroll={handleScroll}
          style={{ height: "100%", overflowY: "auto" }}
        >
          <div ref={contentRef} className="thread-content">
            <div style={{ height: 700 }} />
            {entry?.kind === "assistant-turn"
              ? <AssistantTurn entry={entry} sessionId={undefined} isActive={false} />
              : <ToolRow message={messages[1]} />}
            <div style={{ height: 300 }} />
          </div>
        </div>
      </div>
    </DisclosureAnchorContext.Provider>
  );
}

/** The nested dock scroller (D302), driven by its own follow hook. */
function FollowFixture({ tool }: { tool: UiMessage }) {
  const { scrollRef, contentRef, handleScroll, disclosureAnchorNotifier } =
    useFollowScroll();
  return (
    <DisclosureAnchorContext.Provider value={disclosureAnchorNotifier}>
      <div
        ref={scrollRef}
        className="subagent-run-rows"
        data-scroll-owner="follow"
        onScroll={handleScroll}
        style={{ height: "300px", overflowY: "auto" }}
      >
        <div ref={contentRef}>
          <div style={{ height: 320 }} />
          <ToolRow message={tool} />
          <div style={{ height: 200 }} />
        </div>
      </div>
    </DisclosureAnchorContext.Provider>
  );
}

globalThis.transcriptDisclosureProbe = async () => {
  const i18n = createInstance();
  await i18n.init({
    lng: "en",
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
  });
  const host = document.createElement("div");
  host.style.width = "700px";
  document.body.append(host);
  const renderErrors: unknown[] = [];
  const roots: Array<{ unmount: () => void }> = [];

  const mount = (node: Parameters<typeof I18nextProvider>[0]["children"]) => {
    const container = document.createElement("div");
    container.style.height = "600px";
    container.style.width = "640px";
    host.append(container);
    const root = createRoot(container, {
      onUncaughtError: (error) => {
        renderErrors.push(error);
      },
    });
    flushSync(() =>
      root.render(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>),
    );
    roots.push(root);
    return container;
  };

  try {
    const tool = toolRowMessage("tool");
    const container = mount(
      <TranscriptFixture
        messages={[
          message("user", "user", "Inspect the workspace"),
          tool,
        ]}
      />,
    );
    const scroller = container.querySelector<HTMLElement>(".thread-scroll");
    const title = container.querySelector<HTMLElement>(".tool-row-header");
    assert(scroller, "the transcript scroller did not render");
    assert(title, "the tool title did not render");

    await settle();
    const before = geometry(scroller, title);
    assert(
      Math.abs(before.distanceFromBottom) < 1,
      `the transcript did not start pinned to the bottom: ${JSON.stringify(before)}`,
    );
    assert(
      before.scrollTop > 0 && before.titleTop >= 0 && before.titleTop < 600,
      `the clicked title is not on screen: ${JSON.stringify(before)}`,
    );

    // A plain click on the title, exactly as a reader expands a tool row.
    title.click();
    await settle();
    const expanded = geometry(scroller, title);
    assert(
      expanded.scrollHeight > before.scrollHeight + 100,
      `the disclosure did not change the height, so nothing was measured: ${JSON.stringify({ before, expanded })}`,
    );
    assert(
      Math.abs(expanded.titleTop - before.titleTop) < 2,
      `expanding the tool moved the clicked title by ${expanded.titleTop - before.titleTop}px: ${JSON.stringify({ before, expanded })}`,
    );
    assert(
      expanded.scrollTop <= before.scrollTop + 2,
      `expanding the tool re-bottomed the transcript: ${JSON.stringify({ before, expanded })}`,
    );

    title.click();
    await settle();
    const collapsed = geometry(scroller, title);
    assert(
      Math.abs(collapsed.titleTop - before.titleTop) < 2,
      `collapsing the tool moved the clicked title by ${collapsed.titleTop - before.titleTop}px: ${JSON.stringify({ before, collapsed })}`,
    );
    assert(
      Math.abs(collapsed.scrollTop - before.scrollTop) < 2,
      `collapsing the tool moved the transcript by ${collapsed.scrollTop - before.scrollTop}px: ${JSON.stringify({ before, collapsed })}`,
    );

    const dockContainer = mount(<FollowFixture tool={toolRowMessage("dock")} />);
    const dockScroller = dockContainer.querySelector<HTMLElement>(
      ".subagent-run-rows",
    );
    const dockTitle = dockContainer.querySelector<HTMLElement>(
      ".tool-row-header",
    );
    assert(dockScroller, "the dock scroller did not render");
    assert(dockTitle, "the dock tool title did not render");
    await settle();
    const dockBefore = geometry(dockScroller, dockTitle);
    assert(
      Math.abs(dockBefore.distanceFromBottom) < 1,
      `the dock did not start pinned to the bottom: ${JSON.stringify(dockBefore)}`,
    );
    dockTitle.click();
    await settle();
    const dockExpanded = geometry(dockScroller, dockTitle);
    assert(
      dockExpanded.scrollHeight > dockBefore.scrollHeight + 100,
      "the dock disclosure did not change the height",
    );
    assert(
      Math.abs(dockExpanded.titleTop - dockBefore.titleTop) < 2,
      `expanding the dock moved its own title by ${dockExpanded.titleTop - dockBefore.titleTop}px: ${JSON.stringify({ dockBefore, dockExpanded })}`,
    );
    assert(
      dockExpanded.scrollTop <= dockBefore.scrollTop + 2,
      "expanding the dock re-bottomed the dock scroller",
    );
    const processContainer = mount(<TranscriptFixture process messages={[
      message("process-user", "user", "Inspect"),
      message("progress", "assistant", Array.from({ length: 50 }, (_, i) => `Progress paragraph ${i}.`).join("\n\n")),
      toolRowMessage("process-tool"),
      message("final", "assistant", "Finished."),
    ]} />);
    const processScroller = processContainer.querySelector<HTMLElement>(".thread-scroll");
    const processTitle = processContainer.querySelector<HTMLElement>(".turn-process > button");
    assert(processScroller && processTitle, "process fixture did not render");
    await settle();
    assert(
      processTitle.getAttribute("aria-expanded") === "false",
      "detailed completed process starts collapsed",
    );
    processTitle.click();
    await settle();
    const processBefore = geometry(processScroller, processTitle);
    assert(
      processTitle.getAttribute("aria-expanded") === "true",
      "detailed process can be opened",
    );
    processTitle.click();
    await settle();
    const processCollapsed = geometry(processScroller, processTitle);
    assert(
      processCollapsed.scrollHeight < processBefore.scrollHeight - 100,
      "process did not collapse",
    );
    processTitle.click();
    await settle();
    const processExpanded = geometry(processScroller, processTitle);
    assert(
      processExpanded.scrollHeight > processCollapsed.scrollHeight + 100,
      "process did not expand",
    );
    // Expansion grows content under a pinned bottom, which is the case the held
    // anchor has to compensate; the collapse above may legitimately clamp.
    assert(
      Math.abs(processExpanded.titleTop - processCollapsed.titleTop) < 2,
      "process expansion moved its title",
    );
    assert(renderErrors.length === 0, `React render errors: ${renderErrors.map(String).join("; ")}`);
    return {
      ok: true,
      process: { before: processBefore, collapsed: processCollapsed, expanded: processExpanded },
      transcript: { before, expanded, collapsed },
      dock: { before: dockBefore, expanded: dockExpanded },
    };
  } finally {
    for (const root of roots) flushSync(() => root.unmount());
    host.remove();
  }
};
