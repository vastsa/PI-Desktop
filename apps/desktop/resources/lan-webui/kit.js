// LAN WebUI shared helpers: DOM building, Lucide icons and clipboard.
// Plain DOM only: text always goes through textContent, never innerHTML.
"use strict";

(() => {
  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === "text") node.textContent = value;
      else if (key === "class") node.className = value;
      else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else if (value === true) node.setAttribute(key, "");
      else node.setAttribute(key, String(value));
    }
    for (const child of [].concat(children)) if (child) node.append(child);
    return node;
  }

  // Lucide outlines (ISC) on a 24px grid — the icon set Desktop ships.
  const SVG_NS = "http://www.w3.org/2000/svg";
  const ICONS = {
    back: [["path", { d: "m15 18-6-6 6-6" }]],
    chevron: [["path", { d: "m9 18 6-6-6-6" }]],
    down: [["path", { d: "M12 5v14" }], ["path", { d: "m19 12-7 7-7-7" }]],
    more: [["circle", { cx: 12, cy: 12, r: 1 }], ["circle", { cx: 19, cy: 12, r: 1 }], ["circle", { cx: 5, cy: 12, r: 1 }]],
    close: [["path", { d: "M18 6 6 18" }], ["path", { d: "m6 6 12 12" }]],
    search: [["circle", { cx: 11, cy: 11, r: 8 }], ["path", { d: "m21 21-4.3-4.3" }]],
    check: [["path", { d: "M20 6 9 17l-5-5" }]],
    copy: [["rect", { width: 14, height: 14, x: 8, y: 8, rx: 2 }], ["path", { d: "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" }]],
    send: [["path", { d: "m5 12 7-7 7 7" }], ["path", { d: "M12 19V5" }]],
    stop: [["rect", { x: 6, y: 6, width: 12, height: 12, rx: 2 }]],
    folder: [["path", { d: "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" }]],
    temporary: [["circle", { cx: 12, cy: 12, r: 10 }], ["path", { d: "M12 6v6l4 2" }]],
    chat: [["path", { d: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" }]],
    newChat: [["path", { d: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" }], ["path", { d: "M12 7v6" }], ["path", { d: "M9 10h6" }]],
    pin: [["path", { d: "M12 17v5" }], ["path", { d: "M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" }]],
    unpin: [["path", { d: "M12 17v5" }], ["path", { d: "M15 9.34V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H7.89" }], ["path", { d: "m2 2 20 20" }], ["path", { d: "M9 9v1.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h11" }]],
    pencil: [["path", { d: "M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" }], ["path", { d: "m15 5 4 4" }]],
    archive: [["rect", { width: 20, height: 5, x: 2, y: 3, rx: 1 }], ["path", { d: "M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" }], ["path", { d: "M10 12h4" }]],
    restore: [["rect", { width: 20, height: 5, x: 2, y: 3, rx: 1 }], ["path", { d: "M4 8v11a2 2 0 0 0 2 2h2" }], ["path", { d: "M20 8v11a2 2 0 0 1-2 2h-2" }], ["path", { d: "m9 15 3-3 3 3" }], ["path", { d: "M12 12v9" }]],
    laptop: [["path", { d: "M20 16V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9m16 0H4m16 0 1.28 2.55a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45L4 16" }]],
    tool: [["path", { d: "M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" }]],
    logout: [["path", { d: "m16 17 5-5-5-5" }], ["path", { d: "M21 12H9" }], ["path", { d: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" }]],
    pair: [["path", { d: "M18 8V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h8" }], ["path", { d: "M10 19v-3.96 3.15" }], ["path", { d: "M7 19h5" }], ["rect", { width: 6, height: 10, x: 16, y: 12, rx: 2 }]],
    image: [["rect", { width: 18, height: 18, x: 3, y: 3, rx: 2 }], ["circle", { cx: 9, cy: 9, r: 2 }], ["path", { d: "m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" }]],
  };
  function icon(name, size = "") {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("class", size ? `icon ${size}` : "icon");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    for (const [tag, attrs] of ICONS[name]) {
      const node = document.createElementNS(SVG_NS, tag);
      for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
      svg.append(node);
    }
    return svg;
  }

  /**
   * The page is plain HTTP on the LAN, which is not a secure context, so the
   * async Clipboard API is usually missing. Fall back to a selected textarea
   * and the legacy copy command, which phones still honour inside a tap.
   */
  async function copyText(text) {
    if (window.isSecureContext && navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        // Fall through to the legacy path.
      }
    }
    const area = el("textarea", { readonly: true, "aria-hidden": "true", class: "copy-buffer" });
    area.value = text;
    document.body.append(area);
    const active = document.activeElement;
    area.select();
    area.setSelectionRange(0, text.length);
    let copied = false;
    try {
      copied = document.execCommand("copy");
    } catch {
      copied = false;
    }
    area.remove();
    if (active instanceof HTMLElement) active.focus({ preventScroll: true });
    return copied;
  }

  window.LanKit = { el, icon, copyText };
})();
