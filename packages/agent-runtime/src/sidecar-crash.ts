/**
 * Classify an agent-sidecar crash from the stderr tail the child left behind.
 *
 * A sidecar that dies mid-turn settles its owning turn through
 * `settleCrashedSession`. That settlement used one fixed Plan-family code for
 * every exit, which hid the crash inside unrelated approval vocabulary and
 * gave users no hint that their context was the problem. The classifier turns
 * the child's own dying words — the V8 fatal-error banner in its stderr tail —
 * into the honest terminal code (issue #1077).
 */
import { ErrorCodes } from "@pi-desktop/shared";

/** Codes the classifier can return; both are registered in `ErrorCodes`. */
export type SidecarCrashKind = "oom" | "crashed";

/** V8 prints these lines before exiting on heap exhaustion. */
const OOM_MARKERS = [
  "Last few GCs ---",
  "heap out of memory",
  "Reached heap limit",
  "CALL_AND_RETRY_LAST Allocation failed",
] as const;

export type SidecarCrash = {
  kind: SidecarCrashKind;
  /** The matching OOM marker, when `kind` is `"oom"`. */
  marker?: string;
};

export function sidecarCrashErrorCode(kind: SidecarCrashKind): string {
  // The code lives in the shared registry, so an unregistered code is a
  // compile error here rather than a silent transcript mismatch.
  return kind === "oom"
    ? ErrorCodes.AGENT_SIDECAR_OOM
    : ErrorCodes.AGENT_SIDECAR_CRASHED;
}

/**
 * Read the crash kind from a sidecar's captured stderr tail. Returns
 * `"crashed"` for anything that does not carry a recognizable OOM banner, so
 * an unknown native failure still settles under an honest generic code.
 */
export function classifySidecarCrash(stderrTail: unknown): SidecarCrash {
  // The transport hands the tail over as the `string[]` it buffered
  // (`AgentSidecar.notifyExit`), but older exit payloads and direct callers
  // may pass a joined string; accept both so the real exit path is always
  // inspected (PR #1080 review).
  const text = Array.isArray(stderrTail)
    ? stderrTail.filter((line) => typeof line === "string").join("\n")
    : typeof stderrTail === "string"
      ? stderrTail
      : "";
  for (const marker of OOM_MARKERS) {
    if (text.includes(marker)) return { kind: "oom", marker };
  }
  return { kind: "crashed" };
}
