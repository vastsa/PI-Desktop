import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { i18n } from "i18next";
import { I18nextProvider } from "react-i18next";
import { Composer } from "../../apps/desktop/src/components/Composer";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import { api } from "../../apps/desktop/src/lib/api";
import { writeComposerDraft, deleteComposerDraft } from "../../apps/desktop/src/lib/composer-draft-cache";
import type { ComposerDraftSnapshot } from "../../apps/desktop/src/lib/composer-smart-stop";

const assert = (value: unknown, message: string) => { if (!value) throw new Error(message); };
const painted = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** Exercise the complete composer with only the send service replaced. */
export async function verifyComposerSubmission(imagePath: string, i18n: i18n) {
  const previous = useAppStore.getState();
  const sessionId = "submission-fixture";
  const host = document.createElement("div");
  host.style.cssText = "position: relative; width: 360px; height: 500px; overflow: hidden";
  document.body.append(host);
  const errors: unknown[] = [];
  const root = createRoot(host, { onUncaughtError: (error) => errors.push(error) });
  const attachment = { path: imagePath, name: "image.png", kind: "image" as const, mimeType: "image/png" };
  const sent: { content: string; draft: ComposerDraftSnapshot | undefined }[] = [];
  let accepted = false;
  const prefill = (text: string, fileReferences = [attachment]) => {
    flushSync(() => useAppStore.setState({ composerPrefill: { sessionId, text, fileReferences } }));
  };
  const sendButton = () => host.querySelector<HTMLButtonElement>(".send-btn")!;
  const editor = () => host.querySelector<HTMLElement>(".composer-input")!;
  try {
    writeComposerDraft(sessionId, { text: "retry draft", fileReferences: [attachment] });
    useAppStore.setState({
      activeSessionId: sessionId, isRunning: false,
      sessions: [{
        id: sessionId, title: "Submission fixture", source: "pi-native", messageCount: 0,
        mode: "agent", permissionMode: "ask", thinkingLevel: "off",
        createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
        capabilities: { canPrompt: true, canStop: true, canRefresh: true },
      }],
      sendPrompt: async (content, draft) => { sent.push({ content, draft }); return accepted; },
    });
    flushSync(() => root.render(<I18nextProvider i18n={i18n}><Composer /></I18nextProvider>));
    await painted();
    assert(errors.length === 0, `composer render failed: ${errors.map(String)}`);
    // Do not flush the click: an immediate rejection must beat React's next render.
    sendButton().click();
    await painted();
    assert(sent.length === 1 && editor().textContent === "retry draft" && host.querySelectorAll(".composer-image-attachment").length === 1,
      "immediately rejected submission must restore text and image attachments");

    prefill("");
    await painted();
    assert(!sendButton().disabled, "image-only draft must enable the actual send button");
    accepted = true;
    sendButton().click();
    await painted();
    assert(sent.length === 2 && sent[1].content === "" && sent[1].draft?.fileReferences[0]?.path === imagePath,
      "image-only send must preserve the attachment at the submission boundary");
    assert(!host.querySelector(".composer-image-attachment") && sendButton().disabled,
      "accepted image-only submission must clear the composer");

    prefill("", Array.from({ length: 20 }, (_, index) => ({ ...attachment, name: `image-${index}.png` })));
    await painted();
    const tray = host.querySelector<HTMLElement>(".composer-image-attachments")!;
    assert(tray.scrollHeight > tray.clientHeight && ["auto", "scroll"].includes(getComputedStyle(tray).overflowY),
      "many image attachments must use a bounded scroll region");
    assert(tray.getBoundingClientRect().top >= host.getBoundingClientRect().top,
      "attachment list must stay inside the chat pane");
    tray.scrollTop = tray.scrollHeight;
    const last = tray.lastElementChild as HTMLElement;
    assert(last.getBoundingClientRect().bottom <= tray.getBoundingClientRect().bottom + 1,
      "last image must be reachable by scrolling");
    flushSync(() => last.querySelector<HTMLButtonElement>(".composer-image-attachment-remove")!.click());
    assert(tray.children.length === 19 && !sendButton().disabled, "scrolled attachment removal must preserve other images");

    // A restarted renderer has only the Host queue entry, not the cached draft.
    const originalRemoveQueuedPrompt = api.removeQueuedPrompt;
    api.removeQueuedPrompt = async () => undefined;
    try {
      prefill("", []);
      await painted();
      flushSync(() => useAppStore.getState().applyQueueChanged({
        sessionId,
        entries: [{
          id: "restored-attachment-entry", sessionId,
          content: "Review @/scratch/notes.txt",
          attachments: [attachment, { path: "/scratch/notes.txt", name: "notes.txt", kind: "file", mimeType: "text/plain" }],
          position: 1, createdAt: "2026-01-01T00:00:00Z",
        }],
      }));
      host.querySelector<HTMLButtonElement>(".composer-queued-prompt-edit")!.click();
      await painted();
      assert(editor().textContent === "Review @/scratch/notes.txt" && host.querySelectorAll(".composer-image-attachment").length === 1,
        "editing a restored queue entry must recover text and image attachments");
      editor().textContent = "Review";
      flushSync(() => editor().dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" })));
      await painted();
      sendButton().click();
      await painted();
      const restoredSubmission = sent.at(-1);
      assert(restoredSubmission?.content === "Review" && restoredSubmission.draft?.fileReferences.length === 1 && restoredSubmission.draft.fileReferences[0].path === imagePath,
        "deleting a restored inline file must remove that attachment while preserving the image");
    } finally {
      api.removeQueuedPrompt = originalRemoveQueuedPrompt;
    }

    // Issue #795: a command source that cannot be read must refuse the
    // submission, instead of handing `/compact` to the model as prompt text.
    const toasts: string[] = [];
    const originalComposerCommands = api.composerCommands;
    const originalShowToast = useAppStore.getState().showToast;
    api.composerCommands = async () => {
      throw new Error("composer/commands unavailable");
    };
    useAppStore.setState({
      showToast: (message) => {
        toasts.push(String(message));
      },
    });
    try {
      prefill("/compact", []);
      await painted();
      const attempted = sent.length;
      sendButton().click();
      await painted();
      await painted();
      await painted();
      assert(
        sent.length === attempted,
        `a refused slash submission must not reach the send path: ${JSON.stringify(sent.map((entry) => entry.content))}`,
      );
      assert(
        editor().textContent === "/compact",
        `a refused submission must keep the draft: ${JSON.stringify(editor().textContent)}`,
      );
      assert(
        toasts.includes(i18n.t("chat.slashCommandSourceUnavailable")),
        `the refusal must be visible: ${JSON.stringify(toasts)}`,
      );
    } finally {
      api.composerCommands = originalComposerCommands;
      useAppStore.setState({ showToast: originalShowToast });
    }
    // A local command can finish after the user has started their next draft.
    // Keep the real command dispatcher/store; delay only the compact API edge.
    const originalCompact = api.compact;
    const originalCommands = api.composerCommands;
    api.composerCommands = async () => ({ commands: [{
      id: "builtin.agent.compact", name: "compact", title: "Compact", kind: "builtin",
    }] });
    try {
      for (const change of ["text", "attachment", "switch", "unchanged", "reentered"] as const) {
        let finish!: () => void;
        let started!: () => void;
        const entered = new Promise<void>((resolve) => { started = resolve; });
        api.compact = async () => {
          started();
          await new Promise<void>((resolve) => { finish = resolve; });
          return { accepted: true };
        };
        flushSync(() => useAppStore.setState({ activeSessionId: sessionId, isRunning: false }));
        prefill("/compact", []);
        await painted();
        sendButton().click();
        await entered;
        await painted();
        if (change === "attachment") {
          prefill("/compact", [attachment]);
        } else if (change === "reentered") {
          editor().textContent = "Temporary draft during compaction";
          flushSync(() => editor().dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" })));
          editor().textContent = "/compact";
          flushSync(() => editor().dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" })));
        } else if (change !== "unchanged") {
          editor().textContent = "Next message written during compaction";
          flushSync(() => editor().dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" })));
        }
        await painted();
        if (change === "switch") {
          flushSync(() => useAppStore.setState({ activeSessionId: "other-draft-session" }));
          await painted();
          editor().textContent = "Destination draft";
          flushSync(() => editor().dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" })));
        }
        finish();
        await painted();
        await painted();
        if (change === "switch") {
          assert(editor().textContent === "Destination draft", "command completion must not clear the destination draft");
          flushSync(() => useAppStore.setState({ activeSessionId: sessionId }));
          await painted();
        }
        const expectedDraft = change === "unchanged"
          ? ""
          : change === "attachment" || change === "reentered"
            ? "/compact"
            : "Next message written during compaction";
        assert(editor().textContent === expectedDraft,
          `completed command must preserve the expected ${change} draft: ${JSON.stringify(editor().textContent)}`);
        if (change === "attachment") assert(host.querySelectorAll(".composer-image-attachment").length === 1,
          "completed command must preserve an image added while it was running");
      }
    } finally {
      api.compact = originalCompact;
      api.composerCommands = originalCommands;
      deleteComposerDraft("other-draft-session");
    }
  } finally {
    flushSync(() => root.unmount());
    host.remove();
    deleteComposerDraft(sessionId);
    useAppStore.setState(previous, true);
  }
}
