/**
 * Composer samples: controls on each side of the toolbar, the `#` trigger,
 * a draft lab panel where the draft is rewritten and attachments are added,
 * and a right-side control that crashes when asked.
 */
import { createElement as h, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Button, Outcome, subscribeDraft, useCrash, useDispatch } from "./lab.mjs";
import { useLayer } from "./layers.mjs";

/** Where a mark sits in a draft snapshot's text. */
const MARK = "\uFFFC";

/** Left: insert text at the caret. Right: a `plugin.call` round trip. */
export function ComposerControl({ position }) {
  const [outcome, run] = useDispatch();
  if (position === "left") {
    return h("span", { className: "lab-action", "data-lab": "composerControl:left" },
      h(Button, {
        lab: "insert",
        onClick: () => run("composer.insertText", { text: "lab: hello from the composer " }, () => "✓"),
      }, "Insert"),
      h(Outcome, { outcome }));
  }
  return h("span", { className: "lab-action", "data-lab": "composerControl:right" },
    h(Button, {
      lab: "echo",
      onClick: () => run("plugin.call", { method: "lab.echo", args: { from: "composer" } }, (answer) =>
        answer?.echo?.from === "composer" ? "✓" : "✗"),
    }, "Echo"),
    h(Outcome, { outcome }));
}

export function ComposerCrash() {
  const crash = useCrash("composerControl");
  return h("span", { className: "lab-action", "data-lab": "composerControl:crash" },
    h(Button, { lab: "crash", onClick: crash }, "Crash"));
}

const ISSUES = [
  { n: 7, title: "Composer loses the caret after a paste" },
  { n: 12, title: "Chart block ignores empty lines" },
  { n: 19, title: "Tool card flickers while running" },
];

/**
 * The `#` trigger's list: the lab's issues matching the query. `#fail`
 * throws, `#slow` answers past the host's budget and `#many` answers with
 * more rows than the host keeps, so each collapse and cut shows on demand.
 */
export async function issueItems({ query }) {
  if (query === "fail") throw new Error("lab: the # list failed on request");
  if (query === "slow") await new Promise((resolve) => setTimeout(resolve, 3_000));
  if (query === "many") {
    return Array.from({ length: 60 }, (_, i) => ({ label: `#${i + 1}`, send: `Lab issue #${i + 1}` }));
  }
  const needle = query.toLowerCase();
  return ISSUES.filter((issue) => `${issue.n} ${issue.title}`.toLowerCase().includes(needle)).map((issue) => ({
    label: `#${issue.n}`,
    send: `Lab issue #${issue.n}: ${issue.title}`,
    detail: issue.title,
  }));
}

/** The mark "Polish" leaves at the end of the draft; one at a time. */
const STAMP = { label: "lab ✓", send: "(tidied by the UI Slots Lab)" };

/**
 * `snapshot` tidied into a `composer.replaceDraft` payload: every mark kept
 * in place by id but the previous stamp, runs of spaces folded, the first
 * letter capitalized, and a fresh stamp at the end.
 */
export function polished(snapshot) {
  let at = 0;
  const marks = [];
  const kept = snapshot.text.replace(new RegExp(MARK, "g"), () => {
    const mark = snapshot.marks[at++];
    // Only the lab's own marks carry `send`, so this finds no one else's.
    if (mark.kind === "plugin" && mark.send === STAMP.send) return "";
    marks.push({ id: mark.id });
    return MARK;
  });
  const tidy = kept.replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").trim();
  const text = tidy.charAt(0).toUpperCase() + tidy.slice(1);
  return {
    expectedGeneration: snapshot.generation,
    text: text ? `${text} ${MARK}` : MARK,
    marks: [...marks, STAMP],
  };
}

/**
 * Left: a toggle for the draft lab that shows the generation it follows. The
 * lab is a panel in its own layer docked above the composer, so the toolbar
 * keeps one button's width however many controls the panel holds.
 */
export function ComposerDraft() {
  const [draft, setDraft] = useState(null);
  const [open, setOpen] = useState(false);
  useEffect(() => subscribeDraft(setDraft), []);
  return h("span", { className: "lab-action", "data-lab": "composerControl:draft" },
    h(Button, { lab: "draft-panel", onClick: () => setOpen((now) => !now) },
      "Draft",
      h("span", { className: "lab-count", "data-lab-draft": draft ? String(draft.generation) : "none" },
        draft ? ` g${draft.generation}` : "")),
    open ? h(DraftPanel, { draft, onClose: () => setOpen(false) }) : null);
}

/**
 * The draft lab: the followed draft read on demand and rewritten, and the
 * lab's attachments. Clicking in it takes focus from the composer, which a
 * rewrite needs; it closes only by its ✕ or the toggle.
 */
function DraftPanel({ draft, onClose }) {
  const element = useLayer();
  if (!element) return null;
  return createPortal(
    h("div", { className: "p-overlay p-overlay__corner lab-dock", "data-lab": "layer:composer" },
      h("div", { className: "p-dialog", role: "dialog", "aria-label": "Lab draft" },
        h("div", { className: "p-dialog-head" },
          h("span", null, "Lab draft"),
          h("button", {
            type: "button",
            className: "p-notice__dismiss",
            "aria-label": "Close",
            "data-lab-button": "draft-close",
            onClick: onClose,
          }, "✕")),
        h("div", { className: "p-dialog__body lab-panel" },
          h(DraftActions, { draft }),
          h(AttachActions)))),
    element,
  );
}

/**
 * A rewrite has to start in the click, so "Polish" uses the draft the
 * subscription already holds; "Polish later" starts outside the click and
 * is refused as remote.
 */
function DraftActions({ draft }) {
  const [outcome, run] = useDispatch();
  const summary = draft
    ? `g${draft.generation} · ${draft.text.length} ch · ${draft.marks.length} marks`
    : "no draft";
  return h("div", { className: "lab-row", "data-lab": "layer:draft" },
    h("span", { className: "lab-pill" }, summary),
    h(Button, {
      lab: "draft-read",
      onClick: () => run("composer.readDraft", {}, (snapshot) => `read g${snapshot.generation}`),
    }, "Read"),
    h(Button, {
      lab: "draft-polish",
      onClick: () => {
        if (draft) run("composer.replaceDraft", polished(draft), (result) => `polished g${result.generation}`);
      },
    }, "Polish"),
    h(Button, {
      lab: "draft-polish-late",
      onClick: () => {
        if (draft) setTimeout(() => run("composer.replaceDraft", polished(draft)), 0);
      },
    }, "Polish later"),
    h(Outcome, { outcome }));
}

const NOTE = "# Lab note\n\nAttached by the UI Slots Lab through `attachments.add`.\n";
const DOT_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAwAAAAMCAIAAADZF8uwAAAAIUlEQVR42mOwbvoGQV/ncUMQpggD9RThkYOLUFHRsPYdACyF7slzscLiAAAAAElFTkSuQmCC";

function dotPng() {
  return Uint8Array.from(atob(DOT_PNG), (char) => char.charCodeAt(0));
}

/**
 * Attachments of the lab's own. A note is a chip in the text, an image
 * joins the draft's images, a path is refused, and "Remove" takes back the
 * last one this panel added.
 */
function AttachActions() {
  const [outcome, run] = useDispatch();
  const [ids, setIds] = useState([]);
  const added = (what) => (answer) => {
    setIds((current) => [...current, answer.id]);
    return `${what} attached`;
  };
  return h("div", { className: "lab-row", "data-lab": "layer:attach" },
    h(Button, {
      lab: "attach-note",
      onClick: () =>
        run("attachments.add", { name: "lab-note.md", mimeType: "text/markdown", content: NOTE }, added("note")),
    }, "Note"),
    h(Button, {
      lab: "attach-image",
      onClick: () =>
        run("attachments.add", { name: "lab-dot.png", mimeType: "image/png", content: dotPng() }, added("image")),
    }, "Image"),
    h(Button, {
      lab: "attach-path",
      onClick: () => run("attachments.add", { name: "passwd.txt", mimeType: "text/plain", content: "/etc/passwd" }),
    }, "Path"),
    h(Button, {
      lab: "attach-list",
      onClick: () =>
        run("attachments.list", {}, (list) => `${list.length}: ${list.map((item) => item.name).join(", ")}`),
    }, "List"),
    h(Button, {
      lab: "attach-remove",
      onClick: () => {
        const id = ids.at(-1) ?? "none";
        setIds((current) => current.slice(0, -1));
        run("attachments.remove", { id }, () => "removed");
      },
    }, "Remove"),
    h(Outcome, { outcome }));
}
