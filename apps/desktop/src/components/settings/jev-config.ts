/**
 * The order Jev's credential and its switch move in.
 *
 * Adding Jev means "a key that works is stored, and the classifier is on", in
 * that order: the key is checked against TypeSafe first, nothing is written
 * when the check fails, and only a key that answered becomes `jevEnabled`. So
 * an enabled Jev always has a key the Agent can actually spend.
 *
 * Removing Jev takes the switch down before the key is deleted, so no state in
 * between can leave an enabled classifier without a key. Closing the dialog
 * abandons an in-flight check the same way: cancel means nothing was kept.
 *
 * This lives outside the components because the settings card and the service
 * dialog both drive it, and because the order is the part worth testing. It
 * imports nothing at runtime: the caller supplies the effects.
 */
import type { JevKeyCheckResult } from "@pi-desktop/shared";

export type JevConfigDeps = {
  /** Ask TypeSafe whether the key works; never stores anything. */
  probe: (key: string) => Promise<JevKeyCheckResult>;
  storeKey: (key: string) => Promise<void>;
  deleteKey: () => Promise<void>;
  setEnabled: (enabled: boolean) => Promise<void>;
};

export type JevAddOutcome =
  | { ok: true }
  | { ok: false; reason: "missing-key" }
  | { ok: false; reason: "cancelled" }
  | { ok: false; reason: "check-failed"; status?: number; message?: string };

/**
 * Store `apiKey` and turn Jev on, or leave everything untouched.
 *
 * `signal` abandons the whole action: a dialog the user closed while the check
 * was still in flight must not come back later with a stored credential and an
 * enabled classifier. The check is the long part, so it is the only step that
 * needs the guard — everything after it has already been decided.
 */
export async function addJevService(
  deps: JevConfigDeps,
  apiKey: string,
  signal?: AbortSignal,
): Promise<JevAddOutcome> {
  const key = apiKey.trim();
  if (!key) return { ok: false, reason: "missing-key" };
  const check = await deps.probe(key);
  if (signal?.aborted) return { ok: false, reason: "cancelled" };
  if (!check.ok) {
    return { ok: false, reason: "check-failed", status: check.status, message: check.message };
  }
  await deps.storeKey(key);
  await deps.setEnabled(true);
  return { ok: true };
}

/** Turn Jev off and drop the key; disabled first, so neither step is orphaned. */
export async function removeJevService(
  deps: Pick<JevConfigDeps, "deleteKey" | "setEnabled">,
): Promise<void> {
  await deps.setEnabled(false);
  await deps.deleteKey();
}
