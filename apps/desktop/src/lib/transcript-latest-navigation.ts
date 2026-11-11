type Geometry = { scrollTop: number; scrollHeight: number; clientHeight: number };
type ScrollPort = {
  geometry: () => Geometry | undefined;
  move: (top: number, behavior: ScrollBehavior) => void;
  onScrollEnd: (listener: () => void) => () => void;
  stop: () => void;
  reducedMotion: () => boolean;
};
type Navigation = { arrive: () => void; detach: () => void };

/** Own the latest intent; let the browser animate it just like a turn-marker jump. */
export function createTranscriptLatestNavigation(port: ScrollPort) {
  let current: Navigation | undefined;
  const cancel = (commit = false) => {
    const previous = current;
    if (!previous) return;
    current = undefined;
    previous.detach();
    port.stop();
    if (commit) previous.arrive();
  };
  const start = (arrive: () => void = () => {}) => {
    cancel();
    const geometry = port.geometry();
    if (!geometry || geometry.clientHeight <= 0) { arrive(); return; }
    const target = Math.max(0, geometry.scrollHeight - geometry.clientHeight);
    if (port.reducedMotion() || Math.abs(target - geometry.scrollTop) <= 1) {
      port.move(target, "auto"); arrive(); return;
    }
    const navigation: Navigation = { arrive, detach: () => {} };
    current = navigation;
    navigation.detach = port.onScrollEnd(() => {
      if (current !== navigation) return;
      const box = port.geometry();
      if (!box || box.clientHeight <= 0) { cancel(true); return; }
      const bottom = Math.max(0, box.scrollHeight - box.clientHeight);
      if (Math.abs(bottom - box.scrollTop) > 1) {
        // Lazy layout or a late card can extend the destination. Finish that
        // distance natively too, without interrupting an animation every frame.
        port.move(bottom, port.reducedMotion() ? "auto" : "smooth");
        return;
      }
      current = undefined;
      navigation.detach();
      navigation.arrive();
    });
    port.move(target, "smooth");
  };
  return { start, cancel, isActive: () => current !== undefined };
}
