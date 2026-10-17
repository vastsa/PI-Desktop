/**
 * Controllable stand-in loaded in place of `@huggingface/hub` by
 * helpers/hub-stub-hook.mjs. A test installs a behavior function via
 * `setBehavior` and `downloadFile` forwards to it, so tests can stream
 * success bytes, fail mid-stream, or simulate any Response-like shape
 * without network access.
 */
let behavior = () => {
  throw new Error("hub-stub: no behavior installed");
};

export function setBehavior(next) {
  behavior = next;
}

export async function downloadFile(args) {
  return behavior(args);
}
