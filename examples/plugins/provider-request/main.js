/**
 * Provider Request plugin entry point.
 *
 * The plugin ships one contribution: the trusted agent extension in
 * `src/index.ts`, which reads the ready model catalogue and issues one
 * authenticated request to a provider row the user configured. `manifest.json`
 * still requires an entry file, so this one only carries the lifecycle hooks.
 */

/** Host injects the global `pi` before `onLoad` runs. */
function onLoad() {}

module.exports = { onLoad };
