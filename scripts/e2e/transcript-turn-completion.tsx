import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import type { UiMessage } from "@pi-desktop/shared";
import { useTranscriptScroll } from "../../apps/desktop/src/features/chat/transcript/hooks/useTranscriptScroll";
import { TURN_COMPLETION_TOP_INSET_PX } from "../../apps/desktop/src/lib/turn-completion-scroll";

declare global {
  var transcriptTurnCompletionProbe: () => Promise<unknown>;
}

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

const createdAt = "2026-10-28T00:00:00.000Z";
const TOOLBAR_BAND_PX = 46;

function message(
  id: string,
  role: UiMessage["role"],
  content: string,
  extra: Partial<UiMessage> = {},
): UiMessage {
  return { id, role, content, createdAt, ...extra };
}

/** A finished earlier turn, then the prompt and reply this scenario drives. */
function turn(replyLines: number, status: UiMessage["status"]): UiMessage[] {
  return [
    message("old-user", "user", "earlier question"),
    message("old-reply", "assistant", "earlier answer", { status: "complete" }),
    message("prompt", "user", "summarize the change"),
    message(
      "reply",
      "assistant",
      Array.from({ length: replyLines }, (_value, index) => `line ${index}`).join("\n"),
      { status },
    ),
  ];
}

/**
 * The real transcript scroll hook in a real 600 CSS px scroller. Rows are
 * plain blocks carrying the same `data-message-id` the product rows carry, so
 * geometry comes from inline heights, not the app stylesheet.
 */
function Fixture({ messages, isRunning }: { messages: UiMessage[]; isRunning: boolean }) {
  const { scrollRef, wrapRef, contentRef, handleScroll, showJump } = useTranscriptScroll({
    sessionId: undefined,
    messages,
    hasMoreBefore: false,
    isRunning,
    askPending: false,
    approvalPending: false,
    paneVisible: true,
    searchTarget: null,
    readingWindow: false,
  });
  return (
    <div ref={wrapRef} style={{ height: "100%", position: "relative" }}>
      <div
        ref={scrollRef}
        className="thread-scroll"
        data-scroll-owner="transcript"
        onScroll={handleScroll}
        style={{ height: "100%", overflowY: "auto", overflowAnchor: "none" }}
      >
        {/* The product reserves the 46px titlebar band the same way. */}
        <div ref={contentRef} className="thread-content" style={{ paddingTop: TOOLBAR_BAND_PX }}>
          {messages.map((row) => (
            <div
              key={row.id}
              data-message-id={row.id}
              style={{
                whiteSpace: "pre",
                lineHeight: "20px",
                minHeight: row.role === "user" ? 48 : 20,
                margin: "0 0 12px",
              }}
            >
              {row.content}
            </div>
          ))}
        </div>
      </div>
      {showJump ? <div data-jump-to-latest /> : null}
    </div>
  );
}

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** Wait until the scroll offset holds still for several frames (smooth scroll included). */
async function settle(scroller: HTMLElement): Promise<void> {
  let last = Number.NaN;
  let still = 0;
  for (let index = 0; index < 240 && still < 6; index++) {
    await frame();
    still = scroller.scrollTop === last ? still + 1 : 0;
    last = scroller.scrollTop;
  }
}

type Scenario = {
  root: Root;
  container: HTMLElement;
  scroller: HTMLElement;
  render: (messages: UiMessage[], isRunning: boolean) => void;
};

function mount(host: HTMLElement): Scenario {
  const container = document.createElement("div");
  container.style.height = "600px";
  container.style.width = "640px";
  host.append(container);
  const root = createRoot(container);
  const render = (messages: UiMessage[], isRunning: boolean) =>
    flushSync(() => root.render(<Fixture messages={messages} isRunning={isRunning} />));
  render(turn(1, "streaming").slice(0, 3), false);
  const scroller = container.querySelector<HTMLElement>(".thread-scroll");
  assert(scroller, "fixture did not render a scroller");
  return { root, container, scroller, render };
}

function promptTop(scenario: Scenario): number {
  const row = scenario.container.querySelector<HTMLElement>('[data-message-id="prompt"]');
  assert(row, "prompt row missing");
  return row.getBoundingClientRect().top - scenario.scroller.getBoundingClientRect().top;
}

function distanceFromBottom(scroller: HTMLElement): number {
  return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
}

function jumpShown(scenario: Scenario): boolean {
  return scenario.container.querySelector("[data-jump-to-latest]") !== null;
}

/** Start a turn, stream a reply of `lines`, and end it with `status`. */
async function runTurn(
  scenario: Scenario,
  lines: number,
  status: UiMessage["status"],
  duringRun?: () => Promise<void>,
): Promise<void> {
  scenario.render(turn(1, "streaming"), true);
  await settle(scenario.scroller);
  scenario.render(turn(lines, "streaming"), true);
  await settle(scenario.scroller);
  assert(
    Math.abs(distanceFromBottom(scenario.scroller)) < 1,
    `the streaming reply was not followed: ${distanceFromBottom(scenario.scroller)}`,
  );
  await duringRun?.();
  scenario.render(turn(lines, status), false);
  await settle(scenario.scroller);
}

globalThis.transcriptTurnCompletionProbe = async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const roots: Root[] = [];
  const open = () => {
    const scenario = mount(host);
    roots.push(scenario.root);
    return scenario;
  };
  try {
    // A long reply the reader followed ends with its prompt at the top.
    const followed = open();
    await runTurn(followed, 120, "complete");
    const followedTop = promptTop(followed);
    const expectedTop = TOOLBAR_BAND_PX + TURN_COMPLETION_TOP_INSET_PX;
    assert(
      Math.abs(followedTop - expectedTop) < 2,
      `the prompt should sit ${expectedTop}px below the top, clear of the titlebar band, got ${followedTop}`,
    );
    assert(jumpShown(followed), "leaving follow mode should offer jump to latest");
    assert(distanceFromBottom(followed.scroller) > 1000, "the view should have left the bottom");

    // A reply short enough that its prompt is already visible does not move.
    const short = open();
    await runTurn(short, 3, "complete");
    assert(Math.abs(distanceFromBottom(short.scroller)) < 1, "a short reply should stay at the bottom");
    assert(!jumpShown(short), "a short reply should stay in follow mode");

    // A reader who scrolled up during the run keeps their own position.
    const reading = open();
    let readingTop = 0;
    await runTurn(reading, 120, "complete", async () => {
      reading.scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -400, bubbles: true }));
      reading.scroller.scrollTop -= 400;
      await settle(reading.scroller);
      readingTop = reading.scroller.scrollTop;
    });
    assert(
      Math.abs(reading.scroller.scrollTop - readingTop) < 1,
      `a reader's own position moved from ${readingTop} to ${reading.scroller.scrollTop}`,
    );

    // An aborted turn is not a completed answer to read from the top.
    const aborted = open();
    await runTurn(aborted, 120, "aborted");
    assert(Math.abs(distanceFromBottom(aborted.scroller)) < 1, "an aborted turn should stay at the bottom");

    // A queued follow-up that starts at once keeps following the new turn.
    const queued = open();
    queued.render(turn(1, "streaming"), true);
    await settle(queued.scroller);
    queued.render(turn(120, "streaming"), true);
    await settle(queued.scroller);
    // Both commits land in one task, before the completion frame runs.
    queued.render(turn(120, "complete"), false);
    queued.render([...turn(120, "complete"), message("next", "user", "next prompt")], true);
    await settle(queued.scroller);
    assert(
      Math.abs(distanceFromBottom(queued.scroller)) < 1,
      `a follow-up turn should stay at the bottom: ${distanceFromBottom(queued.scroller)}`,
    );

    return {
      ok: true,
      followed: { promptTop: followedTop, scrollTop: followed.scroller.scrollTop },
      reading: { scrollTop: reading.scroller.scrollTop },
    };
  } finally {
    for (const root of roots) flushSync(() => root.unmount());
    host.remove();
  }
};
