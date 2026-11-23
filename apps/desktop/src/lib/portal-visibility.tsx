import { createContext, type ReactNode, useState } from "react";
import { createPortal } from "react-dom";

export const PortalVisibilityContext = createContext(true);

/**
 * Where body-level layers (menus, popovers, sheets) mount. Outside a modal it
 * is `document.body`. Inside a modal on the overlay host (Settings, startup
 * guide) the modal supplies a host stacked above itself; a layer portaled to
 * `document.body` would otherwise paint under the modal and swallow no clicks.
 */
export const PortalLayerContext = createContext<HTMLElement | null>(null);

export function PortalVisibilityProvider({
  visible,
  children,
}: {
  visible: boolean;
  children: ReactNode;
}) {
  return (
    <PortalVisibilityContext.Provider value={visible}>
      {children}
    </PortalVisibilityContext.Provider>
  );
}

export function visiblePortalContent(node: ReactNode) {
  return (
    <PortalVisibilityContext.Consumer>
      {(visible) => (visible ? node : null)}
    </PortalVisibilityContext.Consumer>
  );
}

/**
 * Mount a floating layer at body level — or, inside a modal, on the modal's
 * layer host so it stays above that modal.
 */
export function portalToBody(node: ReactNode) {
  if (typeof document === "undefined") return node;
  return (
    <PortalLayerContext.Consumer>
      {(host) => createPortal(visiblePortalContent(node), host ?? document.body)}
    </PortalLayerContext.Consumer>
  );
}

/**
 * Wrap a modal's overlay content. Renders the layer host right after the
 * modal (`.modal-layer-host`, one step above the dialog layer) and points
 * every `portalToBody` call inside the modal at it.
 */
export function ModalLayer({ children }: { children: ReactNode }) {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  return (
    <>
      <PortalLayerContext.Provider value={host}>{children}</PortalLayerContext.Provider>
      <div ref={setHost} className="modal-layer-host" data-modal-layer-host="" />
    </>
  );
}
