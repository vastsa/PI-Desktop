/**
 * Worker entry for the codemode sandbox. The sidecar bundle builds this file
 * into `chunks/codemode-worker.js` next to `quickjs.wasm`, because a packaged
 * app has no node_modules to resolve the package's own worker from.
 */
import "@earendil-works/pi-codemode/worker";
