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
import { probeScrollInputOwnership } from "./scroll-input-ownership";

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
    // A non-run tool so the row stays inside the process disclosure; a Bash row
    // is standalone and would not own the process's live tail.
    toolName: "Read",
    toolCallId: `call-${id}`,
    toolStatus: "success",
    toolArgs: { path: "src/example.ts" },
    toolResult: {
      details: {
        stdout: Array.from({ length: 80 }, (_value, index) => `step ${index}`).join("\n"),
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

type LayoutDirection = "initial" | "grow" | "shrink" | "change";

type LayoutHistoryEntry = {
  phase: "baseline" | "resize" | "frame";
  at: number;
  contentHeight: number;
  expected: boolean;
  geometry: Geometry;
};

function contentHeight(content: HTMLElement): number {
  return content.getBoundingClientRect().height;
}

function observedBorderBoxHeight(entry: ResizeObserverEntry): number {
  const borderBox = entry.borderBoxSize?.[0];
  return borderBox ? borderBox.blockSize : entry.contentRect.height;
}

function geometrySnapshot(sample: Geometry): string {
  return [
    sample.scrollTop,
    sample.scrollHeight,
    sample.clientHeight,
    sample.titleTop,
    sample.distanceFromBottom,
  ]
    .map((value) => Math.round(value * 1000) / 1000)
    .join(",");
}

function layoutTransitioned(
  direction: LayoutDirection,
  baselineHeight: number,
  observedHeight: number,
): boolean {
  const delta = observedHeight - baselineHeight;
  if (direction === "initial") return observedHeight > 0;
  if (direction === "grow") return delta > 0.5;
  if (direction === "shrink") return delta < -0.5;
  return Math.abs(delta) > 0.5;
}

/**
 * A real layout barrier for one fixture action.
 *
 * It is armed before `trigger`, on the owning content's border box: the same
 * element the product observes. Once the delivered content resize matches the
 * expected disclosure state and direction, geometry is sampled in an animation
 * frame scheduled from that delivery, and must hold for two consecutive frames.
 * Any later resize cancels that window. The watchdog only bounds a hung
 * fixture; it never retries the product assertion, so a mismatch reported after
 * this returns is witnessed after the layout correction, not before it.
 */
async function waitForLayout({
  label,
  scroller,
  content,
  title,
  expected,
  direction,
  trigger,
  timeoutMs = 10_000,
}: {
  label: string;
  scroller: HTMLElement;
  content: HTMLElement;
  title: HTMLElement;
  expected: () => boolean;
  direction: LayoutDirection;
  trigger?: () => void;
  timeoutMs?: number;
}): Promise<void> {
  const baselineHeight = contentHeight(content);
  const history: LayoutHistoryEntry[] = [];
  const record = (phase: LayoutHistoryEntry["phase"], height: number) => {
    history.push({
      phase,
      at: Math.round(performance.now()),
      contentHeight: Math.round(height * 100) / 100,
      expected: expected(),
      geometry: geometry(scroller, title),
    });
    if (history.length > 48) history.splice(0, history.length - 48);
  };
  record("baseline", baselineHeight);

  let targetSeen = false;
  let stableFrames = 0;
  let lastSignature = "";
  let frame = 0;
  let watchdog = 0;
  let finished = false;
  let observer: ResizeObserver | null = null;

  const cleanup = () => {
    if (watchdog !== 0) window.clearTimeout(watchdog);
    watchdog = 0;
    cancelAnimationFrame(frame);
    frame = 0;
    observer?.disconnect();
    observer = null;
  };

  await new Promise<void>((resolve, reject) => {
    const fail = (reason: string) => {
      if (finished) return;
      finished = true;
      cleanup();
      let current: { contentHeight: number; geometry: Geometry } | null = null;
      try {
        current = {
          contentHeight: Math.round(contentHeight(content) * 100) / 100,
          geometry: geometry(scroller, title),
        };
      } catch {
        // Keep the history from before the owning elements disappeared.
      }
      reject(new Error(
        `${label}: ${reason}; ${JSON.stringify({
          direction,
          baselineHeight,
          targetSeen,
          expected: expected(),
          current,
          history,
        })}`,
      ));
    };

    const sample = () => {
      frame = 0;
      if (finished) return;
      const height = contentHeight(content);
      record("frame", height);
      const signature = geometrySnapshot(geometry(scroller, title));
      if (signature === lastSignature) {
        stableFrames += 1;
      } else {
        lastSignature = signature;
        stableFrames = 1;
      }
      if (stableFrames >= 2) {
        finished = true;
        cleanup();
        resolve();
        return;
      }
      frame = requestAnimationFrame(sample);
    };

    const instance = new ResizeObserver((entries) => {
      if (finished) return;
      const entry = entries[entries.length - 1];
      const height = observedBorderBoxHeight(entry);
      record("resize", height);
      stableFrames = 0;
      lastSignature = "";
      if (
        !targetSeen &&
        expected() &&
        layoutTransitioned(direction, baselineHeight, height)
      ) {
        targetSeen = true;
      }
      if (targetSeen && frame === 0) frame = requestAnimationFrame(sample);
    });
    observer = instance;

    watchdog = window.setTimeout(() => {
      fail(targetSeen
        ? "geometry did not hold for two consecutive frames after the resize"
        : `no ${direction} content resize was delivered`);
    }, timeoutMs);

    instance.observe(content, { box: "border-box" });
    try {
      trigger?.();
    } catch (error) {
      finished = true;
      cleanup();
      reject(error);
    }
  });
}

/**
 * The transcript scroller's own DOM, with the real hook driving it: the real
 * ResizeObserver, follow mode and disclosure hold, in a real 600 CSS px
 * viewport. Only the app's stylesheet is left out, so the geometry comes from
 * inline sizes and the real components' intrinsic height.
 */
function TranscriptFixture({
  messages,
  process = false,
  isActive = false,
  sessionId = "fixture",
}: {
  messages: UiMessage[];
  process?: boolean;
  isActive?: boolean;
  sessionId?: string;
}) {
  const entry = process ? buildTranscriptEntries(messages).entries.find((item) => item.kind === "assistant-turn") : undefined;
  const {
    scrollRef,
    wrapRef,
    contentRef,
    handleScroll,
    disclosureAnchorNotifier,
  } = useTranscriptScroll({
    sessionId,
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
          style={{ height: "100%", overflowY: "auto", overflowAnchor: "none" }}
        >
          <div ref={contentRef} className="thread-content">
            <div style={{ height: 700 }} />
            {entry?.kind === "assistant-turn"
              ? <AssistantTurn entry={entry} isActive={isActive} />
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
        style={{ height: "300px", overflowY: "auto", overflowAnchor: "none" }}
      >
        <div ref={contentRef} data-layout-content="dock">
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
    const content = container.querySelector<HTMLElement>(".thread-content");
    const title = container.querySelector<HTMLElement>(".tool-row-header");
    assert(scroller, "the transcript scroller did not render");
    assert(content, "the transcript content did not render");
    assert(title, "the tool title did not render");

    await waitForLayout({
      label: "transcript mount",
      scroller,
      content,
      title,
      expected: () => title.isConnected,
      direction: "initial",
    });
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
    await waitForLayout({
      label: "transcript tool expansion",
      scroller,
      content,
      title,
      expected: () => title.getAttribute("aria-expanded") === "true",
      direction: "grow",
      trigger: () => title.click(),
    });
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

    await waitForLayout({
      label: "transcript tool collapse",
      scroller,
      content,
      title,
      expected: () => title.getAttribute("aria-expanded") === "false",
      direction: "shrink",
      trigger: () => title.click(),
    });
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
    const dockContent = dockContainer.querySelector<HTMLElement>(
      "[data-layout-content='dock']",
    );
    assert(dockScroller, "the dock scroller did not render");
    assert(dockContent, "the dock content did not render");
    assert(dockTitle, "the dock tool title did not render");
    await waitForLayout({
      label: "dock mount",
      scroller: dockScroller,
      content: dockContent,
      title: dockTitle,
      expected: () => dockTitle.isConnected,
      direction: "initial",
    });
    const dockBefore = geometry(dockScroller, dockTitle);
    assert(
      Math.abs(dockBefore.distanceFromBottom) < 1,
      `the dock did not start pinned to the bottom: ${JSON.stringify(dockBefore)}`,
    );
    await waitForLayout({
      label: "dock tool expansion",
      scroller: dockScroller,
      content: dockContent,
      title: dockTitle,
      expected: () => dockTitle.getAttribute("aria-expanded") === "true",
      direction: "grow",
      trigger: () => dockTitle.click(),
    });
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
    const processMessages = [
      message("process-user", "user", "Inspect"),
      message("progress", "assistant", Array.from({ length: 50 }, (_, i) => `Progress paragraph ${i}.`).join("\n\n")),
      toolRowMessage("process-tool"),
    ];
    const processContainer = document.createElement("div");
    processContainer.style.height = "600px";
    processContainer.style.width = "640px";
    host.append(processContainer);
    const processRoot = createRoot(processContainer, {
      onUncaughtError: (error) => renderErrors.push(error),
    });
    roots.push(processRoot);
    const renderProcess = (isActive: boolean) => flushSync(() =>
      processRoot.render(
        <I18nextProvider i18n={i18n}>
          <TranscriptFixture
            process
            isActive={isActive}
            messages={processMessages}
            sessionId="process-fixture"
          />
        </I18nextProvider>,
      ),
    );
    renderProcess(true);
    const processScroller = processContainer.querySelector<HTMLElement>(".thread-scroll");
    const processContent = processContainer.querySelector<HTMLElement>(".thread-content");
    const processTitle = processContainer.querySelector<HTMLElement>(".turn-process > button");
    assert(processScroller && processContent && processTitle, "process fixture did not render");
    await waitForLayout({
      label: "process mount",
      scroller: processScroller,
      content: processContent,
      title: processTitle,
      expected: () => processTitle.getAttribute("aria-expanded") === "true",
      direction: "initial",
    });
    const processBefore = geometry(processScroller, processTitle);
    assert(
      processTitle.getAttribute("aria-expanded") === "true",
      "an active detailed process should start open",
    );
    assert(
      Math.abs(processBefore.distanceFromBottom) < 1,
      `the process fixture did not start pinned to the bottom: ${JSON.stringify(processBefore)}`,
    );
    await waitForLayout({
      label: "process automatic collapse",
      scroller: processScroller,
      content: processContent,
      title: processTitle,
      expected: () => processTitle.getAttribute("aria-expanded") === "false",
      direction: "shrink",
      trigger: () => renderProcess(false),
    });
    const processCollapsed = geometry(processScroller, processTitle);
    assert(
      processCollapsed.titleTop >= 0 && processCollapsed.titleTop < 600,
      `the process title is not on screen for the expansion test: ${JSON.stringify(processCollapsed)}`,
    );
    assert(
      processTitle.getAttribute("aria-expanded") === "false",
      `an untouched process should collapse when its turn completes (expanded=${processTitle.getAttribute("aria-expanded")}, active=${processContainer.querySelector(".turn-process")?.classList.contains("active") ?? false}, bodyHidden=${processContainer.querySelector<HTMLElement>(".turn-process-body")?.hidden ?? true}, focusInside=${processContainer.querySelector(".turn-process-body")?.contains(document.activeElement) ?? false}, selected=${window.getSelection()?.isCollapsed === false})`,
    );
    assert(
      processCollapsed.scrollHeight < processBefore.scrollHeight - 100,
      "completed process content remained visible",
    );
    await waitForLayout({
      label: "process manual expansion",
      scroller: processScroller,
      content: processContent,
      title: processTitle,
      expected: () => processTitle.getAttribute("aria-expanded") === "true",
      direction: "grow",
      trigger: () => processTitle.click(),
    });
    const processExpanded = geometry(processScroller, processTitle);
    assert(
      processTitle.getAttribute("aria-expanded") === "true",
      "a completed process should expand on user request",
    );
    assert(
      processExpanded.scrollHeight > processCollapsed.scrollHeight + 100,
      "process did not expand",
    );
    // Expansion grows content under a pinned bottom, which is the case the held
    // anchor has to compensate; the automatic collapse above may legitimately clamp.
    assert(
      Math.abs(processExpanded.titleTop - processCollapsed.titleTop) < 2,
      `process expansion moved its title by ${processExpanded.titleTop - processCollapsed.titleTop}px: ${JSON.stringify({ processBefore, processCollapsed, processExpanded })}`,
    );
    // Both renders are flushSync commits and this check reads state only, so it
    // needs no layout barrier.
    renderProcess(true);
    renderProcess(false);
    assert(
      processTitle.getAttribute("aria-expanded") === "true",
      "a user-expanded process should stay open after completion",
    );

    // A fresh process starts active. Its automatic collapse and the reader's
    // immediate manual expansion commit in the same task, so the pending
    // collapse layout and follow work must not drag the clicked title away.
    const rapidContainer = document.createElement("div");
    rapidContainer.style.height = "600px";
    rapidContainer.style.width = "640px";
    host.append(rapidContainer);
    const rapidRoot = createRoot(rapidContainer, {
      onUncaughtError: (error) => renderErrors.push(error),
    });
    roots.push(rapidRoot);
    const renderRapid = (isActive: boolean) => flushSync(() =>
      rapidRoot.render(
        <I18nextProvider i18n={i18n}>
          <TranscriptFixture
            process
            isActive={isActive}
            messages={processMessages}
            sessionId="rapid-process-fixture"
          />
        </I18nextProvider>,
      ),
    );
    renderRapid(true);
    const rapidScroller = rapidContainer.querySelector<HTMLElement>(".thread-scroll");
    const rapidContent = rapidContainer.querySelector<HTMLElement>(".thread-content");
    const rapidTitle = rapidContainer.querySelector<HTMLElement>(".turn-process > button");
    assert(rapidScroller && rapidContent && rapidTitle, "rapid process fixture did not render");
    await waitForLayout({
      label: "rapid process mount",
      scroller: rapidScroller,
      content: rapidContent,
      title: rapidTitle,
      expected: () => rapidTitle.getAttribute("aria-expanded") === "true",
      direction: "initial",
    });
    const rapidBefore = geometry(rapidScroller, rapidTitle);
    assert(
      Math.abs(rapidBefore.distanceFromBottom) < 1,
      `the rapid process did not start pinned to the bottom: ${JSON.stringify(rapidBefore)}`,
    );
    const rapid = {
      collapsedHeight: 0,
      atExpansion: null as Geometry | null,
    };
    await waitForLayout({
      label: "rapid automatic collapse then immediate manual expansion",
      scroller: rapidScroller,
      content: rapidContent,
      title: rapidTitle,
      expected: () => rapidTitle.getAttribute("aria-expanded") === "true",
      direction: "change",
      trigger: () => {
        renderRapid(false);
        rapid.collapsedHeight = rapidScroller.scrollHeight;
        rapidTitle.click();
        rapid.atExpansion = geometry(rapidScroller, rapidTitle);
      },
    });
    const rapidExpanded = geometry(rapidScroller, rapidTitle);
    assert(
      rapidTitle.getAttribute("aria-expanded") === "true",
      "the immediate manual expansion should win over the automatic collapse",
    );
    assert(
      rapid.collapsedHeight > 0 && rapidExpanded.scrollHeight > rapid.collapsedHeight + 100,
      `the rapid manual expansion did not restore the process height: ${JSON.stringify({ rapidBefore, rapidExpanded, collapsedHeight: rapid.collapsedHeight })}`,
    );
    assert(rapid.atExpansion, "the rapid expansion did not record its click geometry");
    assert(
      Math.abs(rapidExpanded.titleTop - rapid.atExpansion.titleTop) < 2,
      `pending collapse work moved the rapidly expanded title by ${rapidExpanded.titleTop - rapid.atExpansion.titleTop}px: ${JSON.stringify({ rapidBefore, atExpansion: rapid.atExpansion, rapidExpanded })}`,
    );

    // A minimap navigation can still be animating when the reader takes over.
    // Exercise the browser-owned animation separately from queued follow rAFs.
    const interruption = mount(<TranscriptFixture sessionId="scroll-interruption" messages={[
      message("interrupt-user", "user", "Read history"), toolRowMessage("interrupt-tool"),
    ]} />);
    const interruptScroller = interruption.querySelector<HTMLElement>(".thread-scroll")!;
    const interruptContent = interruption.querySelector<HTMLElement>(".thread-content")!;
    const interruptTitle = interruption.querySelector<HTMLElement>(".tool-row-header")!;
    await waitForLayout({ label: "interruption mount", scroller: interruptScroller,
      content: interruptContent, title: interruptTitle,
      expected: () => interruptTitle.isConnected, direction: "initial" });
    const beforeDisclosureNavigation = geometry(interruptScroller, interruptTitle);
    await waitForLayout({ label: "interruption disclosure", scroller: interruptScroller,
      content: interruptContent, title: interruptTitle,
      expected: () => interruptTitle.getAttribute("aria-expanded") === "true", direction: "grow",
      trigger: () => {
        interruptScroller.scrollTo({ top: 0, behavior: "smooth" });
        interruptTitle.click();
      } });
    assert(Math.abs(geometry(interruptScroller, interruptTitle).titleTop - beforeDisclosureNavigation.titleTop) < 2,
      "a pending navigation moved the manually toggled disclosure title");
    assert(interruptScroller.scrollTop > 0, "interruption fixture has no scroll range");
    interruptScroller.scrollTo({ top: 0, behavior: "smooth" });
    const interruptedTop = interruptScroller.scrollTop;
    interruptScroller.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -1 }));
    // Interrupt before yielding: hidden Linux windows can finish a smooth
    // navigation between two rAF callbacks, so waiting for a mid-point races it.
    // Synthetic input has no native default scroll. Any later movement is the
    // old animation, which the production input handler must relinquish.
    for (let frame = 0; frame < 6; frame++) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      assert(Math.abs(interruptScroller.scrollTop - interruptedTop) < 2,
        `interrupted navigation moved the reader: ${interruptedTop} -> ${interruptScroller.scrollTop}`);
    }
    const interruptionResult = { interruptedTop, finalTop: interruptScroller.scrollTop };
    // Space activates a focused disclosure button; it does not scroll its
    // ancestor. A synthetic key has no default activation, isolating ownership.
    interruptScroller.scrollTo({ top: 0, behavior: "smooth" });
    interruptTitle.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    const controlDeadline = performance.now() + 5000;
    while (interruptScroller.scrollTop > 1 && performance.now() < controlDeadline) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    assert(interruptScroller.scrollTop <= 1,
      `button Space cancelled transcript navigation at ${interruptScroller.scrollTop}`);
    const nestedInterruption = mount(<FollowFixture tool={toolRowMessage("interrupt-dock")} />);
    const nestedScroller = nestedInterruption.querySelector<HTMLElement>(".subagent-run-rows")!;
    const nestedContent = nestedInterruption.querySelector<HTMLElement>("[data-layout-content]")!;
    const nestedTitle = nestedInterruption.querySelector<HTMLElement>(".tool-row-header")!;
    await waitForLayout({ label: "nested interruption mount", scroller: nestedScroller,
      content: nestedContent, title: nestedTitle,
      expected: () => nestedTitle.isConnected, direction: "initial" });
    const beforeNestedDisclosureNavigation = geometry(nestedScroller, nestedTitle);
    await waitForLayout({ label: "nested interruption disclosure", scroller: nestedScroller,
      content: nestedContent, title: nestedTitle,
      expected: () => nestedTitle.getAttribute("aria-expanded") === "true", direction: "grow",
      trigger: () => {
        nestedScroller.scrollTo({ top: 0, behavior: "smooth" });
        nestedTitle.click();
      } });
    assert(Math.abs(geometry(nestedScroller, nestedTitle).titleTop - beforeNestedDisclosureNavigation.titleTop) < 2,
      "a pending nested navigation moved the manually toggled disclosure title");
    const nestedTop = nestedScroller.scrollTop;
    assert(nestedTop > 0, "nested fixture has no scroll range");
    nestedScroller.scrollTo({ top: 0, behavior: "smooth" });
    nestedScroller.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -1 }));
    for (let frame = 0; frame < 6; frame++) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      assert(Math.abs(nestedScroller.scrollTop - nestedTop) < 2,
        `interrupted nested navigation moved the reader: ${nestedTop} -> ${nestedScroller.scrollTop}`);
    }
    const nestedInterruptionResult = { interruptedTop: nestedTop, finalTop: nestedScroller.scrollTop };
    const inputOwnership = {
      transcript: probeScrollInputOwnership(interruptScroller),
      nested: probeScrollInputOwnership(nestedScroller),
    };
    assert(renderErrors.length === 0, `React render errors: ${renderErrors.map(String).join("; ")}`);
    return {
      ok: true,
      inputOwnership,
      interruption: interruptionResult,
      nestedInterruption: nestedInterruptionResult,
      process: { before: processBefore, collapsed: processCollapsed, expanded: processExpanded },
      rapid: { before: rapidBefore, expanded: rapidExpanded },
      transcript: { before, expanded, collapsed },
      dock: { before: dockBefore, expanded: dockExpanded },
    };
  } finally {
    for (const root of roots) flushSync(() => root.unmount());
    host.remove();
  }
};
