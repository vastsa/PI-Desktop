import { randomUUID } from "node:crypto";
import type { TrustedExtensionUiRequestEnvelope, TrustedExtensionUiResponse } from "@pi-desktop/shared";

/** Request identity scopes cancellation to one invocation, including queued prompts. */
export async function requestExtensionUi(
  send: (envelope: TrustedExtensionUiRequestEnvelope) => Promise<TrustedExtensionUiResponse>,
  envelope: TrustedExtensionUiRequestEnvelope,
  signal?: AbortSignal,
): Promise<TrustedExtensionUiResponse> {
  signal?.throwIfAborted();
  const requestId = randomUUID();
  const cancel = () => {
    void send({ ...envelope, request: { kind: "cancel", requestId } }).catch(() => {
      console.error("[extensions] failed to retire an extension UI request");
    });
  };
  const response = send({ ...envelope, requestId });
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  try { return await response; }
  finally { signal?.removeEventListener("abort", cancel); }
}
