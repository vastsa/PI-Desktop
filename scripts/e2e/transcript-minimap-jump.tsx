/**
 * Real React/Chromium regression for the conversation outline's turn jump.
 *
 * Clicking a dash scrolls the transcript to that turn. While the transcript is
 * still in follow mode, the jump's own upward scroll event carries no input
 * gesture, so the scroller reads it as a layout clamp, re-pins and re-bottoms
 * one frame later — the click looks ignored. The jump therefore has to leave
 * follow mode before it scrolls, exactly like the outline's earlier-history
 * control already does.
 *
 * Scenario: E2E-CONVERSATION-minimap-jump-leaves-follow.
 */
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { I18nextProvider } from "react-i18next";
import { en } from "@pi-desktop/i18n";
import type { SessionSummary, UiMessage } from "@pi-desktop/shared";
import { ChatTranscript } from "../../apps/desktop/src/features/chat/transcript/ChatTranscript";
import { api } from "../../apps/desktop/src/lib/api";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

const createdAt = "2026-09-01T00:00:00.000Z";
const SESSION_ID = "minimap-jump";
const TURNS = 12;

declare global {
  var transcriptMinimapJumpProbe: () => Promise<unknown>;
}

function assert(value: unknown, label: string): asserts value {
  if (!value) throw new Error(`Minimap jump: ${label}`);
}

const frame = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

async function until(
  predicate: () => boolean,
  label: string,
  diagnostic?: () => unknown,
): Promise<void> {
  for (let attempt = 0; attempt < 240; attempt++) {
    if (predicate()) return;
    await frame();
  }
  throw new Error(
    `Minimap jump never settled: ${label} ${JSON.stringify(diagnostic?.() ?? {})}`,
  );
}

function row(id: string, role: UiMessage["role"], content: string): UiMessage {
  return { id, role, content, createdAt, status: "complete" };
}

/** Alternating turns, long enough that the transcript overflows one viewport. */
function transcriptMessages(): UiMessage[] {
  const messages: UiMessage[] = [];
  for (let turn = 0; turn < TURNS; turn++) {
    messages.push(
      row(`u${turn}`, "user", `Question ${turn}. ${"Synthetic question body. ".repeat(6)}`),
    );
    messages.push(
      row(`a${turn}`, "assistant", `Answer ${turn}. ${"Synthetic answer body. ".repeat(24)}`),
    );
  }
  return messages;
}

function sessionSummary(): SessionSummary {
  return {
    id: SESSION_ID,
    title: "Minimap jump",
    mode: "agent",
    permissionMode: "ask",
    thinkingLevel: "off",
    providerId: "fixture",
    modelId: "fixture",
    createdAt,
    updatedAt: createdAt,
    messageCount: TURNS * 2,
  };
}

/** Credential-free production React/store integration for the outline's jump. */
export async function transcriptMinimapJumpProbe() {
  await i18n.init({ lng: "en", resources: { en: { translation: en } } });
  const initial = useAppStore.getState();
  const originals = {
    getSession: api.getSession,
    listSessions: api.listSessions,
    pendingPlans: api.pendingPlans,
    listQueuedPrompts: api.listQueuedPrompts,
    composerCommands: api.composerCommands,
  };
  const messages = transcriptMessages();
  const errors: unknown[] = [];
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;inset:0;display:flex;flex-direction:column";
  document.body.append(host);
  const root = createRoot(host, {
    onUncaughtError: (error) => errors.push(error),
  });
  const element = <T extends HTMLElement = HTMLElement>(selector: string): T => {
    const found = host.querySelector<T>(selector);
    assert(found, `missing ${selector}; render errors: ${errors.map(String)}`);
    return found;
  };
  try {
    // Only Host reads are fixtures; no running Desktop, native host or provider.
    api.getSession = async (id) => {
      assert(id === SESSION_ID, `unexpected session read ${id}`);
      return {
        session: {
          ...sessionSummary(),
          messages,
          messageStart: 0,
          hasMoreBefore: false,
        },
      };
    };
    api.listSessions = async () => ({ sessions: [sessionSummary()] });
    api.pendingPlans = async () => ({ plans: [], state: "inactive" });
    api.listQueuedPrompts = async () => ({ entries: [] });
    api.composerCommands = async () => ({ commands: [] });
    useAppStore.setState({
      sessions: [sessionSummary()],
      providers: [],
      providerModels: {},
      retainedTranscripts: {},
      retainedSessionIds: [],
      sessionHistory: {},
      sessionCompactions: {},
      pendingPlans: {},
      pendingAsks: {},
      pendingPermissions: {},
      planningStates: {},
      agentStatuses: {},
      latestTurnResults: {},
      queuedPrompts: {},
      notifications: [],
      workspace: undefined,
      runningSessions: {},
      isRunning: false,
      page: "chat",
      selectingSessionId: undefined,
      settings: {
        ...initial.settings,
        theme: "dark",
        enterToSend: true,
        onboardingDismissed: true,
        smoothStreaming: false,
      },
      activeSessionId: SESSION_ID,
      messages,
    });
    flushSync(() =>
      root.render(
        <I18nextProvider i18n={i18n}>
          <div style={{ position: "relative", display: "flex", flex: 1, minHeight: 0 }}>
            <ChatTranscript
              sessionId={SESSION_ID}
              messages={messages}
              isRunning={false}
            />
          </div>
        </I18nextProvider>,
      ),
    );
    await frame();
    await until(
      () => !host.querySelector('[data-transcript-settling="true"]'),
      "transcript settles",
    );
    await until(
      () => host.querySelector(".minimap-rail") !== null,
      "outline mounts",
    );
    const scroller = element(".thread-scroll");
    const distanceFromBottom = () =>
      scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
    // The transcript mounts pinned to the bottom: that is the state the reported
    // click happens in.
    await until(() => Math.abs(distanceFromBottom()) < 2, "follow is pinned");
    const rail = element(".minimap-rail");
    const dashes = [
      ...rail.querySelectorAll<HTMLButtonElement>(".minimap-marker.user"),
    ];
    assert(dashes.length >= 2, `outline needs user dashes, saw ${dashes.length}`);
    const firstTurn = element<HTMLElement>(".message-row.user[data-minimap-id]");
    const turnTop = () =>
      firstTurn.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    assert(
      turnTop() < -100,
      `the first turn has to start above the viewport, saw ${turnTop()}`,
    );
    const readout = () => ({
      distanceFromBottom: distanceFromBottom(),
      turnTop: turnTop(),
      scrollTop: scroller.scrollTop,
    });
    flushSync(() => dashes[0]!.click());
    await until(
      () => distanceFromBottom() > 100,
      "the jump scrolled away from the bottom",
      readout,
    );
    // The jump lands first; follow mode answers it on the following frames.
    // Settle that exchange before asserting, or a re-bottom passes as success.
    // Smooth scrolling finishes on its own schedule and a hidden Electron
    // window drops frames, so wait for a stable offset instead of a fixed
    // frame count.
    let settledTop = Number.NaN;
    let stableFrames = 0;
    for (let index = 0; index < 400 && stableFrames < 3; index++) {
      await frame();
      const top = scroller.scrollTop;
      stableFrames = Math.abs(top - settledTop) < 0.5 ? stableFrames + 1 : 0;
      settledTop = top;
    }
    for (let index = 0; index < 3; index++) await frame();
    assert(
      distanceFromBottom() > 100,
      `the jump was undone by follow: ${JSON.stringify(readout())}`,
    );
    assert(
      turnTop() > -8 && turnTop() < 96,
      `the clicked turn is not on screen: ${JSON.stringify(readout())}`,
    );
    assert(errors.length === 0, `render errors: ${errors.map(String)}`);
    return { ok: true, dashes: dashes.length, ...readout() };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    };
  } finally {
    flushSync(() => root.unmount());
    host.remove();
    Object.assign(api, originals);
    useAppStore.setState({
      sessions: initial.sessions,
      activeSessionId: initial.activeSessionId,
      messages: initial.messages,
      settings: initial.settings,
    });
  }
}

globalThis.transcriptMinimapJumpProbe = transcriptMinimapJumpProbe;
