/**
 * The out-of-order gate for plugin session pushes (#1753): within one
 * renderer load a slower push must never undo a newer one, and a renderer
 * reload (the automatic recovery for render-process-gone) restarts the
 * renderer's counter — so a changed boot id resets the high-water mark
 * instead of silently dropping every push afterwards. The boot id is per
 * renderer load, so with two windows open the ordering guarantee is per
 * window; only one window's session is on screen at a time. Kept dependency
 * free so `plugin-session-follow.test.mjs` can drive it directly.
 */
export function createSessionPushGate() {
  let activeSessionSeq = 0;
  let activeSessionBootId: string | null = null;
  return (push: { seq: number; bootId?: string | null }): { ok: boolean; ignored?: boolean } => {
    if (push.seq > 0) {
      if (push.bootId && push.bootId !== activeSessionBootId) {
        activeSessionBootId = push.bootId;
        activeSessionSeq = push.seq;
      } else if (push.seq >= activeSessionSeq) {
        activeSessionSeq = push.seq;
      } else {
        return { ok: true, ignored: true };
      }
    }
    return { ok: true };
  };
}
