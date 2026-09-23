import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { i18n } from "i18next";
import { I18nextProvider } from "react-i18next";
import type { SessionSummary, UiMessage } from "@pi-desktop/shared";
import { Composer } from "../../apps/desktop/src/components/Composer";
import { SessionPane } from "../../apps/desktop/src/components/SessionPane";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import { createTranscriptReadingRuntime } from "../../apps/desktop/src/stores/runtime/transcript-reading-runtime";
import { deleteComposerDraft, readComposerDraft, writeComposerDraft } from "../../apps/desktop/src/lib/composer-draft-cache";

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
type ReadSession = Parameters<typeof createTranscriptReadingRuntime>[1];
type ReadResult = Awaited<ReturnType<ReadSession>>;

/** Exercise real pane/composer/reader wiring; only the asynchronous session read is gated. */
export async function verifyUnderfilledEntry(i18n: i18n, tail: UiMessage[], older: UiMessage[]) {
  const original = useAppStore.getState();
  const style = document.documentElement.style;
  const reserve = style.getPropertyValue("--composer-dock-height");
  const priority = style.getPropertyPriority("--composer-dock-height");
  const failures: string[] = [];
  const reports: unknown[] = [];
  const cases = ["single-page-overflow", "multi-page-overflow", "exhausted-underfill",
    "hidden-pending-reveal", "draft-switch-entry", "complete-short"] as const;
  try {
    for (const name of cases) {
      const id = `underfilled-entry-${name}`;
      const awayId = `${id}-away`;
      const drafts = [id, awayId].map((key) => ({ key, value: readComposerDraft(key) }));
      const paged = name !== "complete-short";
      const tiny = (suffix: string): UiMessage[] => [
        { id: `${id}-${suffix}-user`, role: "user", content: "Earlier request", createdAt: tail[0].createdAt },
        { id: `${id}-${suffix}-answer`, role: "assistant", content: "Earlier answer.", createdAt: tail[0].createdAt },
      ];
      const messages = tail.map((message) => ({ ...message, id: `${id}-${message.id}` }));
      const large = older.map((message) => ({ ...message, id: `${id}-${message.id}` }));
      const multiple = name === "multi-page-overflow" || name === "hidden-pending-reveal";
      // Leave a third genuine page unread: overflow, not exhaustion, must stop auto-paging.
      const pages = !paged ? [] : multiple ? [tiny("near"), large, tiny("oldest")]
        : name === "exhausted-underfill" ? [tiny("only")] : [large];
      let messageStart = pages.reduce((sum, page) => sum + page.length, 0);
      let expected = messages;
      let visible = true;
      let mounted = name !== "draft-switch-entry";
      const host = document.createElement("div");
      // Fixed pane geometry remains useful at the default viewport; the runner can
      // additionally prove an actual 858x1166 CSS viewport at either native scale.
      host.style.cssText = "position:absolute;left:0;top:0;width:858px;height:1166px;display:flex;flex-direction:column;min-height:0";
      document.body.append(host);
      const root = createRoot(host);
      const reads: { sessionId: string; options: Parameters<ReadSession>[1];
        finish: (result: ReadResult) => void; promise: Promise<ReadResult> }[] = [];
      const summary: SessionSummary = { id, title: id, messageCount: messages.length + messageStart,
        mode: "agent", permissionMode: "ask", thinkingLevel: "off",
        createdAt: "2026-09-23T00:00:00Z", updatedAt: "2026-09-23T00:00:00Z" };
      const awayMessages = tiny("away");
      const runtime = createTranscriptReadingRuntime({ get: useAppStore.getState, set: useAppStore.setState }, (sessionId, options) => {
        let finish!: (result: ReadResult) => void;
        const promise = new Promise<ReadResult>((resolve) => { finish = resolve; });
        reads.push({ sessionId, options, finish, promise });
        return promise;
      });
      const check = (condition: boolean, message: string) => {
        if (!condition) failures.push(`${name}: ${message}`);
      };
      const render = (before?: () => void) => flushSync(() => {
        before?.();
        root.render(<I18nextProvider i18n={i18n}>
        <div className="chat-surface" style={{ flex: 1, minHeight: 0 }}>
          <div className="session-panes">
            {mounted && <SessionPane key={id} sessionId={id} visible={visible} />}
            <SessionPane key={awayId} sessionId={awayId} visible={!mounted || !visible} />
          </div>
          <Composer variant="docked" />
        </div>
      </I18nextProvider>);
      });
      const sample = (phase: string) => {
        const pane = host.querySelector<HTMLElement>(`[data-session-pane="${id}"]`)!;
        if (!visible) return { phase, visible, top: 0, max: 0, rowBottom: 0,
          dockTop: 0, gap: 0, height: 0,
          tailPresent: Boolean(pane.querySelector(`[data-message-id="${messages.at(-1)!.id}"]`)),
          reads: reads.length };
        const scroll = pane.querySelector<HTMLElement>(".thread-scroll")!;
        const row = [...pane.querySelectorAll<HTMLElement>(".thread-content > .message-row")].at(-1)!;
        const dock = host.querySelector<HTMLElement>(".composer-dock")!;
        const rowBottom = row.getBoundingClientRect().bottom;
        return { phase, visible, top: scroll.scrollTop, max: scroll.scrollHeight - scroll.clientHeight,
          rowBottom, dockTop: dock.getBoundingClientRect().top,
          gap: dock.getBoundingClientRect().top - rowBottom, height: scroll.clientHeight,
          tailPresent: Boolean(pane.querySelector(`[data-message-id="${messages.at(-1)!.id}"]`)),
          reads: reads.length };
      };
      const samples: ReturnType<typeof sample>[] = [];
      const capture = (phase: string) => { const value = sample(phase); samples.push(value); return value; };
      const frames = async (count: number, phase: string) => {
        for (let i = 0; i < count; i++) { await frame(); capture(phase); }
      };
      const verifyMessages = () => {
        const view = useAppStore.getState().transcriptViews[id];
        check(view?.messageStart === messageStart, `reader cursor ${view?.messageStart} != ${messageStart}`);
        check(view?.hasMoreBefore === (messageStart > 0), "reader exhaustion does not match cursor");
        check(JSON.stringify(view?.messages.map((message) => message.id)) === JSON.stringify(expected.map((message) => message.id)),
          "loaded history identity/order differs from the real page results");
      };
      const deliver = async (index: number) => {
        const request = reads[index];
        if (!request) throw new Error(`missing gated read ${index + 1}`);
        check(request.sessionId === id && request.options.messageBefore === messageStart,
          `read ${index + 1} did not request the genuine preceding cursor ${messageStart}`);
        const page = pages[index];
        const end = messageStart;
        messageStart -= page.length;
        expected = [...page, ...expected];
        request.finish({ session: { ...summary, messages: page, messageStart,
          messageEnd: end, hasMoreBefore: messageStart > 0, hasMoreAfter: true } });
        await request.promise;
        await frames(16, `page-${index + 1}`);
        verifyMessages();
      };
      try {
        writeComposerDraft(id, { text: "", fileReferences: [] });
        writeComposerDraft(awayId, { text: name === "draft-switch-entry" ? "A retained multiline draft.\n".repeat(12) : "", fileReferences: [] });
        useAppStore.setState({ ...runtime.actions, activeSessionId: mounted ? id : awayId,
          messages: mounted ? messages : awayMessages, sessions: [summary, { ...summary, id: awayId }],
          retainedSessionIds: [id, awayId], retainedTranscripts: { [id]: messages, [awayId]: awayMessages },
          sessionHistory: { [id]: { messageStart, hasMoreBefore: paged }, [awayId]: { messageStart: 0, hasMoreBefore: false } },
          transcriptViews: {}, runningSessions: {}, pendingPermissions: {}, pendingAsks: {}, planningStates: {}, isRunning: false });
        render();
        let tallDockHeight = 0;
        if (!mounted) {
          for (let i = 0; i < 8; i++) await frame();
          tallDockHeight = host.querySelector<HTMLElement>(".composer-dock")!.getBoundingClientRect().height;
          check(reads.length === 0, "unmounted partial session paged before entry");
          mounted = true;
          render(() => useAppStore.setState({ activeSessionId: id, messages }));
        }
        capture("first-commit");
        await frames(16, "pending");
        check(samples[0].max === 0, "fixture must initially underfill");
        if (name === "draft-switch-entry") {
          const height = host.querySelector<HTMLElement>(".composer-dock")!.getBoundingClientRect().height;
          check(tallDockHeight > height + 40, "draft switch did not materially shrink the real composer");
        }
        check(reads.length === (paged ? 1 : 0), `expected ${paged ? 1 : 0} read while first gate is pending, got ${reads.length}`);
        if (name === "hidden-pending-reveal") {
          visible = false;
          render(() => useAppStore.setState({ activeSessionId: awayId, messages: awayMessages }));
          capture("hidden-commit");
          await frames(8, "hidden-pending");
          check(reads.length === 1, "hidden pending pane issued another read");
          await deliver(0);
          check(reads.length === 1, "hidden pane continued paging after a pending result");
          visible = true;
          render(() => useAppStore.setState({ activeSessionId: id, messages }));
          capture("reveal-commit");
          check(samples.at(-1)!.max === 0, "revealed first earlier page must still underfill");
          await frames(16, "revealed-pending");
          check(reads.length === 2, "reveal did not resume exactly one earlier read");
          await deliver(1);
        } else if (paged) {
          await deliver(0);
          if (multiple) {
            check(samples.at(-1)!.max === 0, "first earlier page must still underfill");
            check(reads.length === 2, "underfilled first page did not automatically request exactly one next page");
            await frames(8, "second-pending");
            check(reads.length === 2, "second pending gate was requested more than once");
            await deliver(1);
          }
        }
        await frames(8, "idle");
        const final = samples.at(-1)!;
        if (paged) {
          const completesHistory = name === "single-page-overflow" || name === "exhausted-underfill";
          check(name === "exhausted-underfill" ? final.max === 0 : final.max >= 100,
            "final geometry did not reach the intended underfill/overflow state");
          check(reads.length === (multiple ? 2 : 1), "paging continued after overflow or exhaustion");
          const visibleSamples = samples.filter((item) => item.visible);
          if (completesHistory) {
            const first = host.querySelector<HTMLElement>(`[data-session-pane="${id}"] .thread-content > .message-row`)!;
            check(first.getBoundingClientRect().top <= 100, "exhausted short conversation lost ordinary top alignment");
            reports.push({ name, reads: reads.length, messageStart, samples });
          } else {
            const worstGap = Math.max(...visibleSamples.map((item) => Math.abs(item.gap - 16)));
            check(worstGap <= 2, `dock-to-answer gap departed from 16±2px by ${worstGap}px`);
            const drift = Math.max(...visibleSamples.map((item) => Math.abs(item.rowBottom - final.rowBottom)));
            check(drift <= 2, `underfilled tail moved ${drift}px while older history loaded`);
            reports.push({ name, drift, worstGap, reads: reads.length, messageStart, samples });
          }
        } else {
          const first = host.querySelector<HTMLElement>(`[data-session-pane="${id}"] .thread-content > .message-row`)!;
          check(first.getBoundingClientRect().top <= 100, "complete short conversation lost ordinary top alignment");
          reports.push({ name, reads: reads.length, samples });
        }
        check(samples.every((item) => item.tailPresent), "the actual final answer disappeared during paging");
      } catch (error) {
        failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
        reports.push({ name, samples, reads: reads.length });
      } finally {
        try {
          flushSync(() => root.unmount());
        } finally {
          runtime.actions.returnToLatestTranscript(id);
          for (const read of reads) read.finish({ session: null });
          await Promise.all(reads.map((read) => read.promise));
          await Promise.resolve();
          for (const { key, value } of drafts) {
            deleteComposerDraft(key);
            if (value) writeComposerDraft(key, value, value.workspacePath);
          }
          host.remove();
          useAppStore.setState(original, true);
          if (reserve) style.setProperty("--composer-dock-height", reserve, priority);
          else style.removeProperty("--composer-dock-height");
        }
      }
    }
  } finally {
    useAppStore.setState(original, true);
    if (reserve) style.setProperty("--composer-dock-height", reserve, priority);
    else style.removeProperty("--composer-dock-height");
  }
  return { name: "underfilled-tail-entry", failures, reports };
}
