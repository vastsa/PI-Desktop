export type RendererGoneDetails = Readonly<{
  reason: string;
  exitCode: number;
}>;

export type RendererRecoveryDependencies = Readonly<{
  isCurrentWindow: boolean;
  quitting: boolean;
  windowCloseAccepted: boolean;
  windowDestroyed: boolean;
  webContentsDestroyed: boolean;
  reload: () => void;
  log: (details: RendererGoneDetails, reloaded: boolean) => void;
}>;

/** Reload an unexpectedly exited renderer while its owning app window is live. */
export function recoverRendererAfterGone(
  details: RendererGoneDetails,
  dependencies: RendererRecoveryDependencies,
): boolean {
  const reloaded =
    details.reason !== "clean-exit" &&
    dependencies.isCurrentWindow &&
    !dependencies.quitting &&
    !dependencies.windowCloseAccepted &&
    !dependencies.windowDestroyed &&
    !dependencies.webContentsDestroyed;

  dependencies.log(details, reloaded);
  if (!reloaded) return false;

  dependencies.reload();
  return true;
}
