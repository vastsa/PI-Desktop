import type { BrowserWindow, Session, WebContents } from "electron";
import { GEN_UI_SCHEME } from "@pi-desktop/shared";
import { liveOwnerFromWebContents, isTrustedRendererUrl } from "./owner";
import type { LiveOwner } from "./call-service";

type PermissionDecision = {
  permission: string;
  ownerValid: boolean;
  leaseActive: boolean;
  requestKind: "request" | "check";
  mediaTypes?: readonly string[];
  mediaType?: string;
};

export function allowsLiveMicrophonePermission(input: PermissionDecision): boolean {
  if (input.permission !== "media" || !input.ownerValid || !input.leaseActive) return false;
  if (input.requestKind === "request") {
    return Boolean(input.mediaTypes?.length) && input.mediaTypes?.every((type) => type === "audio") === true;
  }
  return input.mediaType === "audio" || input.mediaType === "unknown";
}

const GEN_UI_PREFIX = `${GEN_UI_SCHEME}:`;

/**
 * Visualization frames (ADR gen-ui-inline-visualization) run model-written
 * code in this same session. They get no permission at all — not even the
 * ones this handler otherwise leaves to the platform default. The frame is
 * sandboxed without `allow-same-origin`, so its origin may read as "null";
 * the frame URL still carries the scheme, so both are checked.
 */
export function isGenUiPermissionRequester(...urls: ReadonlyArray<string | undefined>): boolean {
  return urls.some((url) => typeof url === "string" && url.toLowerCase().startsWith(GEN_UI_PREFIX));
}

export function installLiveMicrophonePermissionHandlers(input: {
  targetSession: Session;
  getMainWindow: () => BrowserWindow | null;
  hasReservation: (owner: LiveOwner) => boolean;
}): void {
  input.targetSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    if (isGenUiPermissionRequester(details.requestingUrl)) {
      callback(false);
      return;
    }
    // Installing a handler replaces the platform default for every permission on
    // the session, and this session also carries the main renderer. Keep the
    // microphone policy to `media` so unrelated web APIs keep working: denying
    // the rest silently broke the app's own copy buttons, which need
    // `clipboard-sanitized-write`.
    if (permission !== "media") {
      callback(true);
      return;
    }
    const owner = requestOwner(input.getMainWindow(), contents, details.requestingUrl, details.isMainFrame);
    const allowed = allowsLiveMicrophonePermission({
      permission,
      ownerValid: owner !== null,
      leaseActive: owner !== null && input.hasReservation(owner),
      requestKind: "request",
      mediaTypes: "mediaTypes" in details ? details.mediaTypes : undefined,
    });
    callback(allowed);
  });

  input.targetSession.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
    if (isGenUiPermissionRequester(requestingOrigin, details.requestingUrl)) return false;
    // Same scope rule as the request handler above.
    if (permission !== "media") return true;
    const owner = contents ? checkOwner(input.getMainWindow(), contents, requestingOrigin) : null;
    return allowsLiveMicrophonePermission({
      permission,
      ownerValid: owner !== null,
      leaseActive: owner !== null && input.hasReservation(owner),
      requestKind: "check",
      mediaType: details.mediaType,
    });
  });
}

function requestOwner(
  window: BrowserWindow | null,
  contents: WebContents,
  requestingUrl: string,
  isMainFrame: boolean,
): LiveOwner | null {
  if (!isMainFrame) return null;
  const owner = liveOwnerFromWebContents(window, contents);
  return owner && owner.url === requestingUrl ? owner : null;
}

function checkOwner(window: BrowserWindow | null, contents: WebContents, requestingOrigin: string): LiveOwner | null {
  const owner = liveOwnerFromWebContents(window, contents);
  if (!owner || !isTrustedRendererUrl(owner.url)) return null;
  let protocol: string;
  let origin: string;
  try {
    const parsed = new URL(owner.url);
    protocol = parsed.protocol;
    origin = parsed.origin;
  } catch {
    return null;
  }
  const validOrigin = protocol === "file:"
    ? requestingOrigin === "file://" || requestingOrigin === "null"
    : requestingOrigin === origin;
  return validOrigin ? owner : null;
}
