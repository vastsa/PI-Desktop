/**
 * Ordering guarantees for the optional Jev classifier configuration.
 *
 * The remote endpoint is checked before either credential or settings move.
 * A successful add stores the key first, then atomically writes the non-secret
 * endpoint/model and enables the tool. Removal disables and clears the binding
 * before deleting the credential, so an enabled classifier never lacks a key.
 */
import type {
  JevClassifierBinding,
  JevKeyCheckResult,
} from "@pi-desktop/shared";

export type JevConfigDeps = {
  /** Ask the configured System One endpoint whether the key works. */
  probe: (
    key: string,
    binding: JevClassifierBinding,
  ) => Promise<JevKeyCheckResult>;
  storeKey: (key: string) => Promise<void>;
  deleteKey: () => Promise<void>;
  /** Persist this non-secret binding and enable Jev in one settings write. */
  configure: (binding: JevClassifierBinding) => Promise<void>;
  /** Disable Jev and remove any explicit binding in one settings write. */
  disableAndClear: () => Promise<void>;
};

export type JevAddOutcome =
  | { ok: true }
  | { ok: false; reason: "missing-key" }
  | { ok: false; reason: "cancelled" }
  | { ok: false; reason: "check-failed"; status?: number; message?: string };

/** Check, store, then configure Jev, or leave settings untouched. */
export async function addJevService(
  deps: JevConfigDeps,
  apiKey: string,
  binding: JevClassifierBinding,
  signal?: AbortSignal,
): Promise<JevAddOutcome> {
  const key = apiKey.trim();
  if (!key) return { ok: false, reason: "missing-key" };
  const check = await deps.probe(key, binding);
  if (signal?.aborted) return { ok: false, reason: "cancelled" };
  if (!check.ok) {
    return {
      ok: false,
      reason: "check-failed",
      status: check.status,
      message: check.message,
    };
  }
  await deps.storeKey(key);
  try {
    await deps.configure(binding);
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    try {
      await deps.disableAndClear();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    try {
      await deps.deleteKey();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        "Jev configuration failed and could not be cleaned up completely",
      );
    }
    throw error;
  }
  return { ok: true };
}

/** Disable/clear Jev before deleting its key. */
export async function removeJevService(
  deps: Pick<JevConfigDeps, "deleteKey" | "disableAndClear">,
): Promise<void> {
  await deps.disableAndClear();
  await deps.deleteKey();
}
