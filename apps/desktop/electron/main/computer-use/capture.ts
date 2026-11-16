import { desktopCapturer, systemPreferences } from "electron";
import type { ComputerPermissionState, ComputerRect } from "@pi-desktop/shared";

/**
 * Scope-cropped capture for computer use (ADR 0342 §11).
 *
 * Chromium's `desktopCapturer` is the one part of the capability that is
 * already cross-platform, and a window source is inherently scoped: nothing
 * outside the granted window is ever in the frame, so there is no desktop
 * screenshot to crop and no neighbouring window to leak.
 *
 * A capture that fails is not an error the loop has to handle — pixels are the
 * fallback, not the contract — so every failure here returns `undefined` and
 * lets the accessibility tree carry the step.
 */

/** Longest side of the image handed to the model. */
const MAX_CAPTURE_EDGE = 1_280;

function thumbnailSize(bounds: ComputerRect): { width: number; height: number } {
  const width = Math.max(1, Math.round(bounds.width));
  const height = Math.max(1, Math.round(bounds.height));
  const longest = Math.max(width, height);
  if (longest <= MAX_CAPTURE_EDGE) return { width, height };
  const scale = MAX_CAPTURE_EDGE / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * Match a host `targetId` (`<pid>:<window>`) to a capturer source.
 *
 * Chromium names a window source `window:<native id>:<index>`, so the native
 * window handle the host measured is the join key. A source that does not
 * match is never substituted: capturing a different window would hand the
 * model pixels from outside the grant.
 */
export function captureSourceIdFor(sources: readonly { id: string }[], targetId: string): string | undefined {
  const window = targetId.split(":")[1];
  if (!window) return undefined;
  const prefix = `window:${window}:`;
  return sources.find((source) => source.id.startsWith(prefix))?.id;
}

export async function captureGrantedWindow(input: {
  targetId: string;
  bounds: ComputerRect;
  log?: (message: string, data?: Record<string, unknown>) => void;
}): Promise<{ mimeType: string; base64: string } | undefined> {
  try {
    const sources = await desktopCapturer.getSources({
      types: ["window"],
      thumbnailSize: thumbnailSize(input.bounds),
      fetchWindowIcons: false,
    });
    const id = captureSourceIdFor(sources, input.targetId);
    if (!id) return undefined;
    const source = sources.find((candidate) => candidate.id === id);
    if (!source || source.thumbnail.isEmpty()) return undefined;
    return { mimeType: "image/png", base64: source.thumbnail.toPNG().toString("base64") };
  } catch (error) {
    input.log?.("computer use capture failed", { data: String(error) });
    return undefined;
  }
}

/**
 * What the doctor view can say about capture before anything is attempted.
 * host-core cannot answer this: the capture path is Chromium's, not its.
 */
export function capturePermissionState(): ComputerPermissionState {
  if (process.platform !== "darwin") {
    // Windows needs no grant; Linux depends on the portal, which only answers
    // when a capture is actually requested.
    return "not-requested";
  }
  try {
    const status = systemPreferences.getMediaAccessStatus("screen");
    if (status === "granted") return "granted";
    if (status === "denied" || status === "restricted") return "denied";
    return "not-requested";
  } catch {
    return "not-requested";
  }
}
