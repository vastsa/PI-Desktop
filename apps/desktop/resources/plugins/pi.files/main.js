/**
 * Files — a first-party PI-Desktop plugin (ADR 0104).
 *
 * The whole surface is the work panel view; this entry exists because every
 * plugin has a `main`, and because it is the proof that a bundled first-party
 * plugin needs no host privileges a third-party one lacks. All file access
 * happens from the view over the ordinary `fs.list` / `fs.readPreview` /
 * `fs.glob` / `fs.openDefault` / `fs.reveal` bridge channels, gated by the
 * `fs.read` permission and the declared scope.
 */
export function onLoad() {}
