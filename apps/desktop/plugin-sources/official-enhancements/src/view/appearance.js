/**
 * Theme tokens for the configuration view.
 *
 * A plugin view is a sandboxed page, so it does not receive the host's design
 * tokens directly; it reads the appearance the preload reports and sets
 * `data-base` on `<html>` in the same way the bundled plugins do.
 */

export function applyAppearance(appearance) {
  const reported = appearance?.base;
  const base =
    reported === "light" || reported === "dark"
      ? reported
      : window.matchMedia("(prefers-color-scheme: light)").matches
        ? "light"
        : "dark";
  document.documentElement.dataset.base = base;
  document.documentElement.style.colorScheme = base;
}

/** Subscribe once without letting a late initial read replace a newer event. */
export function watchAppearance(bridge, onLocale) {
  let active = true;
  let eventSeen = false;
  const apply = (appearance) => {
    if (!active) return;
    applyAppearance(appearance);
    onLocale?.(appearance);
  };
  const onAppearance = (appearance) => { eventSeen = true; apply(appearance); };
  const unsubscribe = bridge?.on?.("appearance:changed", onAppearance);
  Promise.resolve().then(() => bridge?.invoke?.("app.getAppearance", {}))
    .catch(() => null)
    .then((appearance) => { if (!eventSeen) apply(appearance); });
  return () => {
    active = false;
    if (typeof unsubscribe === "function") unsubscribe();
    else bridge?.off?.("appearance:changed", onAppearance);
  };
}
