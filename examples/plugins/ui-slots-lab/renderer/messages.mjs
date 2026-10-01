/**
 * Message samples: the action-bar items of `userAction` / `assistantAction`
 * and the `entryExtra` blocks under a reply.
 *
 * The assistant bar gets four items on its right side, one more than a side
 * shows, so the fourth sits in the host's ⋯ menu.
 */
import { createElement as h, useState } from "react";
import { Button, Outcome, SessionTag, useCrash, useDispatch } from "./lab.mjs";

function firstLine(text) {
  return String(text ?? "").split("\n").find((line) => line.trim()) ?? "";
}

function ActionItem({ lab, sessionId, children }) {
  return h("span", { className: "lab-action", "data-lab": lab, "data-lab-session": sessionId }, children);
}

/** Left: a local star toggle. Right: quote the message into the composer. */
export function UserAction({ message, sessionId, position }) {
  const [starred, setStarred] = useState(false);
  const [outcome, run] = useDispatch();
  if (position === "left") {
    return h(ActionItem, { lab: "userAction:left", sessionId },
      h(Button, { lab: "star", title: `lab · ${message.id}`, onClick: () => setStarred(!starred) },
        starred ? "★ Starred" : "☆ Star"));
  }
  return h(ActionItem, { lab: "userAction:right", sessionId },
    h(Button, {
      lab: "quote",
      onClick: () => run("composer.insertText", { text: `> ${firstLine(message.content)}\n\n` }, () => "quoted"),
    }, "Quote"),
    h(Outcome, { outcome }));
}

/** Left: a `plugin.call` round trip. Right: quote the reply. */
export function AssistantAction({ message, messageId, sessionId, position }) {
  const [outcome, run] = useDispatch();
  if (position === "left") {
    return h(ActionItem, { lab: "assistantAction:left", sessionId },
      h(Button, {
        lab: "echo",
        onClick: () =>
          run("plugin.call", { method: "lab.echo", args: { messageId } }, (answer) =>
            answer?.echo?.messageId === messageId ? "echo ✓" : "echo ✗"),
      }, "Echo"),
      h(Outcome, { outcome }));
  }
  return h(ActionItem, { lab: "assistantAction:right", sessionId },
    h(Button, {
      lab: "quote",
      onClick: () => run("composer.insertText", { text: `> ${firstLine(message.content)}\n\n` }, () => "quoted"),
    }, "Quote"),
    h(Outcome, { outcome }));
}

/** A call the plugin process refuses: its own code comes back. */
export function AssistantRefuse({ sessionId }) {
  const [outcome, run] = useDispatch();
  return h(ActionItem, { lab: "assistantAction:refuse", sessionId },
    h(Button, { lab: "refuse", onClick: () => run("plugin.call", { method: "lab.refuse" }) }, "Refuse"),
    h(Outcome, { outcome }));
}

/** An item that throws when asked: it leaves the bar, nothing else does. */
export function AssistantCrash({ sessionId }) {
  const crash = useCrash("assistantAction");
  return h(ActionItem, { lab: "assistantAction:crash", sessionId },
    h(Button, { lab: "crash", onClick: crash }, "Crash"));
}

/** The fourth right item, so it lives in the ⋯ menu. */
export function AssistantFolded({ sessionId }) {
  const [outcome, run] = useDispatch();
  return h(ActionItem, { lab: "assistantAction:folded", sessionId },
    h(Button, {
      lab: "folded",
      onClick: () => run("composer.insertText", { text: "lab: sent from the ⋯ menu " }, () => "inserted"),
    }, "Folded"),
    h(Outcome, { outcome }));
}

const GROWN_LINES = 30;

/**
 * The main block under a reply: its ids, dispatch round trips (an echo, a
 * stall past the call budget, a composer insert), a switch that grows it
 * past the host's collapsed height, and a crash switch.
 */
export function EntryPanel({ message, messageId, sessionId }) {
  const [outcome, run] = useDispatch();
  const [grown, setGrown] = useState(false);
  const crash = useCrash("entryExtra");
  return h("div", { className: "lab-card", "data-lab": "entryExtra", "data-lab-session": sessionId },
    h("div", { className: "lab-head" },
      h("strong", null, "UI Slots Lab · entryExtra"),
      h(SessionTag, { sessionId })),
    h("div", { className: "lab-facts" },
      h("span", { "data-lab-message": messageId }, `message ${messageId.slice(0, 8)}`),
      h("span", null, `${message.content.length} chars`)),
    h("div", { className: "lab-row" },
      h(Button, {
        lab: "echo",
        onClick: () =>
          run("plugin.call", { method: "lab.echo", args: { messageId } }, (answer) =>
            answer?.echo?.messageId === messageId ? "echo ✓" : "echo ✗"),
      }, "Echo"),
      h(Button, { lab: "stall", onClick: () => run("plugin.call", { method: "lab.stall" }) }, "Stall"),
      h(Button, {
        lab: "insert",
        onClick: () => run("composer.insertText", { text: `lab: about ${messageId} ` }, () => "inserted"),
      }, "Insert"),
      h(Button, { lab: "grow", onClick: () => setGrown(!grown) }, grown ? "Shrink" : "Grow"),
      h(Button, { lab: "crash", onClick: crash }, "Crash"),
      h(Outcome, { outcome })),
    grown
      ? h("ol", { className: "lab-lines", "data-lab-grown": "true" },
          Array.from({ length: GROWN_LINES }, (_, index) => h("li", { key: index }, `line ${index + 1}`)))
      : null);
}

/** A second block, stacked after the panel and unaffected by its crash. */
export function EntryNotes({ sessionId }) {
  return h("div", { className: "lab-card lab-quiet", "data-lab": "entryExtra:notes", "data-lab-session": sessionId },
    "UI Slots Lab · second entryExtra block. It stays when the panel above crashes.");
}
