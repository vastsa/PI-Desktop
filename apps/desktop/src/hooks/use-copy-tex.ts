import { useEffect } from "react";
import { texClipboardPayload } from "../lib/selection-tex";

/**
 * Ctrl/Cmd+C over a rendered formula puts its TeX source on the clipboard
 * (issue #414, D619).
 *
 * The listener is on the document because `Markdown` renders no wrapper of its
 * own — answers, a work-panel file preview, and a plugin readme all reach the
 * same formulas through different parents — and because a copy is a document
 * gesture: it is raised wherever the selection is, not where a component
 * happens to be mounted. One listener for the window, installed by the shell
 * and removed with it.
 *
 * It declines exactly one thing — a selection with no formula in it — and
 * deliberately does not ask whether the copy "belongs to" that selection.
 * Chromium derives the event target *from* the selection: it walks the
 * canonicalized start position up to its element, so a non-collapsed
 * selection always raises its copy somewhere inside itself and there is
 * nothing left to check. A `target.contains(anchorNode)` gate only ever
 * misfires, because a `Range` built with `selectNodeContents` leaves
 * `anchorNode` on the element the range was built from while the event lands
 * on a descendant — and that is precisely the range the transcript's own
 * "Select text" item creates, so the gate rejected the app's own copy path
 * and handed the user KaTeX's glyphs back.
 *
 * The case such a gate looks like it is for — a copy raised in the composer
 * while an earlier transcript selection is still on the page — cannot occur:
 * a frame carries one selection, so focusing any field collapses the document
 * selection, and `texClipboardPayload` already declines a collapsed one.
 * `ContextMenu`'s `snapshotSelection` keeps its own row check and is not the
 * same question; see the note there before mirroring either way.
 *
 * `copy` only, and no `cut`: a cut is raised over editable content, and no
 * editable surface here renders math — the composer paints draft text and
 * file chips, never a formula.
 */
export function useCopyTex(): void {
  useEffect(() => {
    const onCopy = (event: ClipboardEvent) => {
      const clipboard = event.clipboardData;
      if (!clipboard) return;
      const text = texClipboardPayload(window.getSelection());
      if (!text) return;
      /*
        `text/plain` alone, on purpose: taking the event over drops the
        platform's `text/html` as well, and `texClipboardPayload` explains why
        none is written back. A rich paste target falls back to this string.
      */
      clipboard.setData("text/plain", text);
      event.preventDefault();
    };
    document.addEventListener("copy", onCopy);
    return () => document.removeEventListener("copy", onCopy);
  }, []);
}
