import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { i18n } from "i18next";
import { I18nextProvider } from "react-i18next";
import type { UiMessage } from "@pi-desktop/shared";
import { Composer } from "../../apps/desktop/src/components/Composer";
import { SessionPane } from "../../apps/desktop/src/components/SessionPane";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import { writeComposerDraft, deleteComposerDraft } from "../../apps/desktop/src/lib/composer-draft-cache";

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** Real retained panes and docked composer, with no host or provider calls. */
export async function verifyShortSessionEntry(i18n: i18n, messages: UiMessage[]) {
  const original = useAppStore.getState();
  const ids = ["scroll-entry-long-draft", "scroll-entry-empty-draft"];
  const host = document.createElement("div");
  host.style.cssText = "position:absolute;inset:0;display:flex;flex-direction:column;min-height:0";
  document.body.append(host);
  const originalReserve = document.documentElement.style.getPropertyValue("--composer-dock-height");
  const errors: unknown[] = [];
  const root = createRoot(host, { onUncaughtError: (error) => errors.push(String(error)) });
  let active = ids[0];
  let retained = [active];
  const render = () => flushSync(() => root.render(
    <I18nextProvider i18n={i18n}>
      <div className="chat-surface" style={{ flex: 1, minHeight: 0 }}>
        <div className="session-panes">
          {retained.map((id) => <SessionPane key={id} sessionId={id} visible={id === active} />)}
        </div>
        <Composer variant="docked" />
      </div>
    </I18nextProvider>,
  ));
  const sample = () => {
    const pane = host.querySelector<HTMLElement>(`[data-session-pane="${active}"]`)!;
    const scroll = pane?.querySelector<HTMLElement>(".thread-scroll");
    const tail = [...pane?.querySelectorAll<HTMLElement>(".thread-content > .message-row") ?? []].at(-1);
    if (!scroll || !tail) throw new Error(`entry pane missing: ${errors.join(", ")}`);
    const dock = host.querySelector<HTMLElement>(".composer-dock")!;
    return { top: scroll.scrollTop, max: scroll.scrollHeight - scroll.clientHeight,
      tailTop: tail.getBoundingClientRect().top, dock: dock.getBoundingClientRect().height,
      reserve: document.documentElement.style.getPropertyValue("--composer-dock-height") };
  };
  const reports: unknown[] = [];
  const failures: string[] = [];
  try {
    writeComposerDraft(ids[0], { text: Array.from({ length: 9 }, (_, i) => `Draft line ${i}`).join("\n"), fileReferences: [] });
    writeComposerDraft(ids[1], { text: "", fileReferences: [] });
    useAppStore.setState({
      activeSessionId: active, messages, retainedSessionIds: retained,
      retainedTranscripts: { [ids[0]]: messages, [ids[1]]: messages },
      sessions: ids.map((id) => ({ id, title: id, messageCount: messages.length,
        mode: "agent", permissionMode: "ask", thinkingLevel: "off",
        createdAt: "2026-09-22T00:00:00Z", updatedAt: "2026-09-22T00:00:00Z" })),
    });
    render();
    for (let i = 0; i < 16; i++) await frame();
    for (const next of [ids[1], ids[0], ids[1]]) {
      active = next;
      retained = [next, ...retained.filter((id) => id !== next)];
      flushSync(() => useAppStore.setState({ activeSessionId: next, messages, retainedSessionIds: retained }));
      render();
      const samples = [sample()];
      const reserve = Number.parseFloat(samples[0].reserve);
      if (!Number.isFinite(reserve) || Math.abs(reserve - Math.round(samples[0].dock)) > 1) {
        failures.push(`short pane ${next}: first commit reserved ${samples[0].reserve} for a ${samples[0].dock}px composer`);
      }
      for (let i = 0; i < 16; i++) { await frame(); samples.push(sample()); }
      const visible = samples.slice(1);
      const range = Math.max(...visible.map((s) => s.tailTop)) - Math.min(...visible.map((s) => s.tailTop));
      const bottomMiss = Math.max(...visible.map((s) => Math.abs(s.max - s.top)));
      if (range > 2 || bottomMiss > 2) failures.push(`short pane ${next}: visible movement ${range}px, bottom miss ${bottomMiss}px`);
      reports.push({ next, range, bottomMiss, samples });
    }
    if (errors.length) failures.push(`short entry render errors: ${errors.join(", ")}`);
    return { name: "short-session-with-composer", failures, reports };
  } finally {
    flushSync(() => root.unmount());
    host.remove();
    ids.forEach(deleteComposerDraft);
    if (originalReserve) document.documentElement.style.setProperty("--composer-dock-height", originalReserve);
    else document.documentElement.style.removeProperty("--composer-dock-height");
    useAppStore.setState(original, true);
  }
}
