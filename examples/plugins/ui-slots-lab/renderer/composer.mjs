/**
 * Composer samples: a `composerControl` on each side of the toolbar and a
 * right-side control that crashes when asked.
 */
import { createElement as h } from "react";
import { Button, Outcome, useCrash, useDispatch } from "./lab.mjs";

/** Left: insert text at the caret. Right: a `plugin.call` round trip. */
export function ComposerControl({ position }) {
  const [outcome, run] = useDispatch();
  if (position === "left") {
    return h("span", { className: "lab-action", "data-lab": "composerControl:left" },
      h(Button, {
        lab: "insert",
        onClick: () => run("composer.insertText", { text: "lab: hello from the composer " }, () => "inserted"),
      }, "Lab insert"),
      h(Outcome, { outcome }));
  }
  return h("span", { className: "lab-action", "data-lab": "composerControl:right" },
    h(Button, {
      lab: "echo",
      onClick: () => run("plugin.call", { method: "lab.echo", args: { from: "composer" } }, (answer) =>
        answer?.echo?.from === "composer" ? "echo ✓" : "echo ✗"),
    }, "Lab echo"),
    h(Outcome, { outcome }));
}

export function ComposerCrash() {
  const crash = useCrash("composerControl");
  return h("span", { className: "lab-action", "data-lab": "composerControl:crash" },
    h(Button, { lab: "crash", onClick: crash }, "Crash"));
}
