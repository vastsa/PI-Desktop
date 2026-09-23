import type { PiRendererReferenceSendInput } from "@pi-desktop/plugin-sdk";
import { pluginSlots } from "./registry";
import { slotDispatchFor } from "../renderer-host/relay";

/** Validate the current reference registrations as one bounded, fail-closed operation. */
export async function validateReferenceSend(
  input: Omit<PiRendererReferenceSendInput, "signal" | "dispatch">,
  signal: AbortSignal,
  timeoutMs = 22_000,
): Promise<void> {
  const registrations = pluginSlots.list("composerReference").filter((entry) => entry.validateSend);
  if (!registrations.length) return;
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason);
  if (signal.aborted) cancel();
  else signal.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("PLUGIN_REFERENCE_TIMEOUT")), timeoutMs);
  const unchanged = () => registrations.every((entry) => pluginSlots.list("composerReference").includes(entry));
  const unsubscribe = pluginSlots.subscribe(() => {
    if (!unchanged()) controller.abort(new Error("PLUGIN_REFERENCE_UNLOADED"));
  });
  let rejectAbort: (reason?: unknown) => void = () => {};
  const cancelled = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(controller.signal.reason ?? new Error("PLUGIN_REFERENCE_CANCELLED"));
  controller.signal.addEventListener("abort", onAbort, { once: true });
  try {
    controller.signal.throwIfAborted();
    const work = (async () => {
      for (const entry of registrations) {
        controller.signal.throwIfAborted();
        const answer = await entry.validateSend!({ ...input, signal: controller.signal,
          dispatch: slotDispatchFor(entry.pluginId) });
        controller.signal.throwIfAborted();
        if (!answer || answer.ok !== true) {
          throw new Error(answer && !answer.ok ? answer.reason : "PLUGIN_REFERENCE_INVALID_RESULT");
        }
      }
    })();
    await Promise.race([work, cancelled]);
    if (!unchanged()) throw new Error("PLUGIN_REFERENCE_UNLOADED");
  } finally {
    clearTimeout(timer);
    unsubscribe();
    signal.removeEventListener("abort", cancel);
    controller.signal.removeEventListener("abort", onAbort);
  }
}
