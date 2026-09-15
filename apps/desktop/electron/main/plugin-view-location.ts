import { pathToFileURL } from "node:url";

/**
 * How a plugin-contributed work panel view is told what to show (ADR 0104).
 *
 * A view is opened either from the tool launcher, which has no subject, or
 * from a chat file reference, which names one. The value is opaque to the
 * host — the plugin decides what it means — but the *transport* is not:
 *
 *   - on creation it travels as the entry URL's `piViewOpen` query parameter,
 *     the only channel that cannot race the page, because a document that has
 *     not run yet can always read its own URL;
 *   - once the view has loaded it travels as the `view:open` preload event,
 *     because the host must not navigate a live view: a plugin can hold
 *     unsaved edits in its editor, and a reload would discard them silently.
 *
 * Kept free of Electron imports so the transport rules stay unit-testable.
 */

/** Query parameter carrying the initial location into a view's entry URL. */
export const PLUGIN_VIEW_LOCATION_PARAM = "piViewOpen";

/** Event carrying a later location into an already loaded view. */
export const PLUGIN_VIEW_LOCATION_EVENT = "view:open";

/** What a request for a location means for the view that receives it. */
export type PluginViewLocationDelivery =
  /** Nothing to do: no location, or the view already shows this one. */
  | { kind: "none" }
  /** The document has not run yet, so restart it against the new URL. */
  | { kind: "reload"; location: string }
  /** The document is live and subscribed, so hand the location over. */
  | { kind: "event"; location: string };

/** Trim to a usable value; `undefined`, `""` and whitespace all mean "none". */
export function normalizeLocation(location: string | undefined): string | null {
  const value = String(location ?? "").trim();
  return value || null;
}

/**
 * The entry URL, with the location as a query parameter when there is one.
 *
 * `URLSearchParams` percent-encodes the value, so a path containing spaces,
 * `#`, `?` or `&` survives the round trip instead of truncating at the first
 * reserved character. A relative `./assets/...` reference still resolves
 * against the path, so the query does not disturb the plugin's own assets.
 */
export function viewEntryUrl(
  htmlPath: string,
  location: string | null,
): string {
  const url = pathToFileURL(htmlPath);
  if (location) url.searchParams.set(PLUGIN_VIEW_LOCATION_PARAM, location);
  return url.toString();
}

/**
 * Decide how a location reaches a view, given what it currently shows.
 *
 * `loaded` is the view's own `did-finish-load` state: before it flips, nothing
 * has run inside the document, so nothing can have subscribed to the event and
 * a restart is lossless.
 */
export function planLocationDelivery(
  previous: string | null,
  next: string | null,
  loaded: boolean,
): PluginViewLocationDelivery {
  if (!next || next === previous) return { kind: "none" };
  if (!loaded) return { kind: "reload", location: next };
  return { kind: "event", location: next };
}
