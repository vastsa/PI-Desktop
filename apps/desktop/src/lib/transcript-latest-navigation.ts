type Geometry = { scrollTop: number; scrollHeight: number; clientHeight: number };
type ScrollPort = {
  geometry: () => Geometry | undefined;
  move: (top: number) => void;
  request: (frame: (now: number) => void) => number;
  cancel: (frame: number) => void;
  now: () => number;
  reducedMotion: () => boolean;
};
type Navigation = { distance: number; startedAt: number; duration: number; arrive: () => void };

/** One viewport owner for a short, interruptible trip through mounted content. */
export function createTranscriptLatestNavigation(port: ScrollPort) {
  let current: Navigation | undefined;
  let frame = 0;
  const cancel = (commit = false) => {
    const previous = current;
    current = undefined;
    port.cancel(frame);
    frame = 0;
    if (commit) previous?.arrive();
  };
  const start = (arrive: () => void = () => {}) => {
    cancel();
    const geometry = port.geometry();
    if (!geometry || geometry.clientHeight <= 0) { arrive(); return; }
    const target = Math.max(0, geometry.scrollHeight - geometry.clientHeight);
    const distance = Math.max(0, target - geometry.scrollTop);
    if (port.reducedMotion() || distance <= 1) { port.move(target); arrive(); return; }
    const navigation: Navigation = { distance,
      startedAt: port.now(), duration: Math.min(420, Math.max(180, distance / 30)), arrive };
    current = navigation;
    const advance = (now: number) => {
      frame = 0;
      if (current !== navigation) return;
      const box = port.geometry();
      if (!box || box.clientHeight <= 0) { cancel(true); return; }
      const bottom = Math.max(0, box.scrollHeight - box.clientHeight);
      const progress = Math.min(1, Math.max(0, (now - navigation.startedAt) / navigation.duration));
      const eased = 1 - (1 - progress) ** 3;
      // Animate remaining viewport distance, not an absolute document offset.
      // Lazy layout above the reader shifts both the target and the visible
      // content; compensate that shift in full rather than easing it as motion.
      const top = Math.max(0, bottom - navigation.distance * (1 - eased));
      port.move(top);
      if (progress === 1) {
        current = undefined;
        navigation.arrive();
      } else frame = port.request(advance);
    };
    frame = port.request(advance);
  };
  return { start, cancel, isActive: () => current !== undefined };
}
