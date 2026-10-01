/**
 * Self-drawn layers (`pi.ui.openLayer`): a composer control that opens a
 * modal wizard, and from it a corner notice on top. Each is an ordinary
 * component that draws through `createPortal` into its own layer; it opens
 * the layer when it mounts and closes it when it unmounts, and only its ✕
 * closes it — Escape does not.
 */
import { createElement as h, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Button, openLayer } from "./lab.mjs";

/** The element of a layer held open while the caller is mounted. */
export function useLayer() {
  const [layer, setLayer] = useState(null);
  useEffect(() => {
    const opened = openLayer();
    setLayer(opened);
    return opened.close;
  }, []);
  return layer?.element ?? null;
}

function LayerZ({ element }) {
  return h("span", { className: "lab-pill", "data-lab-layer-z": element.style.zIndex }, `z ${element.style.zIndex}`);
}

function Wizard({ onClose, onNotice }) {
  const element = useLayer();
  const [step, setStep] = useState(1);
  if (!element) return null;
  return createPortal(
    h("div", { className: "p-overlay", "data-lab": "layer:wizard" },
      h("div", { className: "p-dialog", role: "dialog", "aria-modal": "true", "aria-label": "Lab wizard" },
        h("div", { className: "p-dialog-head" },
          h("span", null, "Lab wizard"),
          h("button", {
            type: "button",
            className: "p-notice__dismiss",
            "aria-label": "Close",
            "data-lab-button": "wizard-close",
            onClick: onClose,
          }, "✕")),
        h("div", { className: "p-dialog__body lab-row" },
          h("span", { "data-lab-step": step }, `Step ${step}`),
          h(LayerZ, { element })),
        h("div", { className: "p-dialog__foot" },
          h(Button, { lab: "wizard-notice", onClick: onNotice }, "Notice"),
          h(Button, { lab: "wizard-next", onClick: () => setStep((n) => n + 1) }, "Next")))),
    element,
  );
}

function Notice({ onClose }) {
  const element = useLayer();
  if (!element) return null;
  return createPortal(
    h("div", { className: "p-overlay p-overlay__corner", "data-lab": "layer:notice" },
      h("div", { className: "p-notice", role: "status" },
        h("span", { className: "p-notice-icon", "aria-hidden": "true" }, "●"),
        h("div", { className: "p-notice__msg lab-row" }, "Lab notice", h(LayerZ, { element })),
        h("button", {
          type: "button",
          className: "p-notice__dismiss",
          "aria-label": "Dismiss",
          "data-lab-button": "notice-dismiss",
          onClick: onClose,
        }, "✕"))),
    element,
  );
}

export function LayerLauncher() {
  const [wizard, setWizard] = useState(false);
  const [notice, setNotice] = useState(false);
  return h("span", { className: "lab-action", "data-lab": "composerControl:layers" },
    h(Button, { lab: "wizard", onClick: () => setWizard(true) }, "Wizard"),
    wizard ? h(Wizard, { onClose: () => setWizard(false), onNotice: () => setNotice(true) }) : null,
    notice ? h(Notice, { onClose: () => setNotice(false) }) : null);
}
