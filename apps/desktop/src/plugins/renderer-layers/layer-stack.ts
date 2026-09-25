/**
 * `pi.ui.openLayer` (`docs/plugin-plan/ui/self-dialog/`).
 *
 * A self-drawn dialog cannot live inside the slot that opens it: the slot's
 * ancestors hide it (an action bar fades out until hovered), clip it
 * (`content-visibility` on transcript rows) or trap it in their stacking
 * context. So the host hands out layers instead: zero-size, viewport-fixed
 * elements in one root at the end of the body, each carrying its plugin's style
 * scope, which the plugin fills through a portal.
 *
 * Every layer is its own stacking context one above the topmost open layer,
 * from 600 and capped at 899, so the latest layer is on top whatever z-index
 * a plugin uses inside it, and nothing a plugin draws reaches the host's
 * tooltips and window chrome (1000 and up). Ties at the cap still stack by
 * opening order, since a new layer is appended last.
 *
 * While the host waits on the user's own decision (`host-safety-layer.ts`)
 * the root is `hidden` and `inert`: every layer steps aside without
 * unmounting and comes back as it was. The root exists only while a layer is
 * open, so a window without plugin layers carries no trace of them.
 */
import type { PluginLayer } from "@pi-desktop/plugin-sdk";

export const PLUGIN_LAYER_Z_MIN = 600;
export const PLUGIN_LAYER_Z_MAX = 899;
export const PLUGIN_LAYER_ROOT_ID = "pi-plugin-layers";

/** What the stack uses of the document; the app passes `document`. */
export type LayerDocument = {
  createElement(tagName: "div"): HTMLElement;
  readonly body: HTMLElement;
};

export class PluginLayerStack {
  private readonly document: () => LayerDocument;
  private root: HTMLElement | null = null;
  private readonly layers = new Map<HTMLElement, number>();
  private suspended = false;

  constructor(document: () => LayerDocument) {
    this.document = document;
  }

  /** Open a layer for `pluginId` on top of every open one. */
  open(pluginId: string): PluginLayer {
    const element = this.document().createElement("div");
    const z = Math.min(PLUGIN_LAYER_Z_MAX, Math.max(PLUGIN_LAYER_Z_MIN - 1, ...this.layers.values()) + 1);
    element.setAttribute("data-pi-plugin", pluginId);
    element.setAttribute("data-pi-layer", "");
    Object.assign(element.style, {
      position: "fixed",
      top: "0",
      left: "0",
      width: "0",
      height: "0",
      zIndex: String(z),
    });
    this.ensureRoot().appendChild(element);
    this.layers.set(element, z);
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      this.layers.delete(element);
      element.remove();
      if (this.layers.size === 0) {
        this.root?.remove();
        this.root = null;
      }
    };
    return Object.freeze({ element, close });
  }

  /** Hide every layer from sight, pointer and focus, or bring them back. */
  setSuspended(suspended: boolean): void {
    this.suspended = suspended;
    if (this.root) applySuspension(this.root, suspended);
  }

  private ensureRoot(): HTMLElement {
    if (this.root) return this.root;
    const document = this.document();
    const root = document.createElement("div");
    root.id = PLUGIN_LAYER_ROOT_ID;
    applySuspension(root, this.suspended);
    document.body.appendChild(root);
    this.root = root;
    return root;
  }
}

function applySuspension(root: HTMLElement, suspended: boolean): void {
  root.hidden = suspended;
  root.inert = suspended;
}

/** The app window's layers. */
export const pluginLayers = new PluginLayerStack(() => document);
