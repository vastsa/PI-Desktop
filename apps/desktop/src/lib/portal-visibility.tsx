import { createContext, type ReactNode } from "react";
import { createPortal } from "react-dom";

export const PortalVisibilityContext = createContext(true);

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

export function portalToBody(node: ReactNode) {
  return typeof document === "undefined"
    ? node
    : createPortal(visiblePortalContent(node), document.body);
}
