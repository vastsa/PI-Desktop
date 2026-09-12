/**
 * Resolve the settings request independently from the rest of renderer
 * bootstrap. A failure in an unrelated startup read must not discard settings
 * that are still able to render the configuration surface.
 */
export async function settleBootstrapRequests<TSettings, TSnapshot>(
  settingsRequest: Promise<TSettings>,
  snapshotRequest: Promise<TSnapshot>,
): Promise<
  | { ok: true; settings: TSettings; snapshot: TSnapshot }
  | { ok: false; settings?: TSettings; error: unknown }
> {
  const [settingsResult, snapshotResult] = await Promise.allSettled([
    settingsRequest,
    snapshotRequest,
  ]);

  if (settingsResult.status === "fulfilled" && snapshotResult.status === "fulfilled") {
    return {
      ok: true,
      settings: settingsResult.value,
      snapshot: snapshotResult.value,
    };
  }

  return {
    ok: false,
    ...(settingsResult.status === "fulfilled"
      ? { settings: settingsResult.value }
      : {}),
    error:
      settingsResult.status === "rejected"
        ? settingsResult.reason
        : snapshotResult.status === "rejected"
          ? snapshotResult.reason
          : new Error("renderer bootstrap failed"),
  };
}
