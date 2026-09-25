import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import type { UiMessage, SessionDetail } from "@pi-desktop/shared";
import { en } from "@pi-desktop/i18n";
import { MessageRow } from "../../apps/desktop/src/features/chat/transcript/MessageRow";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import { api } from "../../apps/desktop/src/lib/api";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const painted = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** Enter from the actual Edit control; replace only the Host and prompt APIs. */
export async function transcriptEditProbe() {
  const initial = useAppStore.getState();
  const originalRead = api.getSession;
  const originalPrompt = api.prompt;
  const i18n = createInstance();
  await i18n.init({ lng: "en", resources: { en: { translation: en } } });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const sessionId = "full-edit-fixture";
  const full: UiMessage = {
    id: "long-log", role: "user", createdAt: "2026-09-23T00:00:00Z",
    content: "INFO normal request\n".repeat(4000) + "FATAL payment timeout",
    attachments: [{ ref: "/fixture/screenshot.png", name: "screenshot.png", kind: "image", mimeType: "image/png" }],
  };
  const session: SessionDetail = {
    id: sessionId, title: "Log review", source: "pi-native", mode: "agent",
    permissionMode: "ask", thinkingLevel: "off", messageCount: 1,
    createdAt: full.createdAt, updatedAt: full.createdAt, messages: [full],
  };
  function Row() {
    const message = useAppStore((s) => s.messages[0]);
    return message ? <MessageRow message={message} isRunning={false} /> : null;
  }
  const sent: Parameters<typeof api.prompt>[0][] = [];
  const toasts: string[] = [];
  api.prompt = async (input) => { sent.push(input); return { accepted: true }; };
  try {
    for (const scenario of ["long", "slash", "read-failure", "switch", "round-trip"] as const) {
      const canonical = scenario === "slash" ? { ...full, command: "/review logs" } : full;
      let finish!: () => void;
      const readGate = new Promise<void>((resolve) => { finish = resolve; });
      api.getSession = async () => {
        await readGate;
        if (scenario === "read-failure") throw new Error("fixture read failed");
        return { session: { ...session, messages: [canonical] } };
      };
      flushSync(() => useAppStore.setState({
        activeSessionId: sessionId, selectingSessionId: null, isRunning: false,
        messages: [{ ...canonical, content: full.content.slice(0, 65500) + "[truncated for display]" }],
        sessionHistory: { [sessionId]: { messageStart: 0, hasMoreBefore: false, contentLimited: true } },
        pendingPlans: {}, showToast: (message) => { toasts.push(String(message)); },
      }));
      flushSync(() => root.render(<I18nextProvider i18n={i18n}><Row key={scenario} /></I18nextProvider>));
      host.querySelector<HTMLButtonElement>('[aria-label="Edit and resend"]')!.click();
      await painted();
      assert(!host.querySelector(".message-edit-input"), "Edit must wait for full text instead of exposing clipped display text");
      if (scenario === "switch") flushSync(() => useAppStore.setState({ activeSessionId: "other-chat" }));
      const originalMessages = useAppStore.getState().messages;
      if (scenario === "round-trip") flushSync(() => {
        // Retained panes can return with the exact same message-array identity.
        useAppStore.setState({ activeSessionId: "other-chat" });
        useAppStore.setState({ activeSessionId: sessionId, messages: originalMessages });
      });
      finish();
      await painted();
      await painted();
      let editor = host.querySelector<HTMLTextAreaElement>(".message-edit-input");
      if (scenario === "round-trip") {
        assert(!editor, "A→B→A must invalidate the pending edit even when the message array is unchanged");
        assert(useAppStore.getState().messages === originalMessages, "cancelled edit must not publish stale history");
        host.querySelector<HTMLButtonElement>('[aria-label="Edit and resend"]')!.click();
        await painted();
        await painted();
        editor = host.querySelector<HTMLTextAreaElement>(".message-edit-input");
      }
      if (scenario === "read-failure" || scenario === "switch") {
        assert(!editor, `${scenario}: stale or failed read must not open an editor`);
        continue;
      }
      const expected = canonical.command || canonical.content;
      assert(editor?.value === expected, `${scenario}: editor must contain canonical text or the original slash invocation`);
      const revised = expected + "\nPlease focus on payment failures.";
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(editor, revised);
      flushSync(() => editor.dispatchEvent(new Event("input", { bubbles: true })));
      host.querySelector<HTMLButtonElement>(".message-edit-submit")!.click();
      await painted();
      await painted();
      const request = sent.at(-1);
      assert(request?.content === revised && request.truncateFromMessageId === full.id,
        `${scenario}: resend must preserve the complete edited content`);
      assert(request.attachments?.[0]?.path === full.attachments?.[0]?.ref,
        "editing must preserve image attachments");
    }
    assert(toasts.includes("fixture read failed"), "failed hydration must remain visible");
    return { fullTextAndResend: true, slashSeed: true, failedRead: true, sessionSwitch: true, roundTripNavigation: true };
  } finally {
    flushSync(() => root.unmount());
    host.remove();
    api.getSession = originalRead;
    api.prompt = originalPrompt;
    useAppStore.setState(initial, true);
  }
}
