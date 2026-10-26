/** Settle fixture navigation/disclosures before capturing a reading baseline. */
export async function waitForScrollLayout(
  scroller: HTMLElement,
  nextFrame: () => Promise<void>,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  let previous = "";
  let stableFrames = 0;
  for (;;) {
    await nextFrame();
    // Force layout before querying transitions: a just-committed disclosure
    // may not have created its CSS transition until style/layout is flushed.
    const geometry = [scroller.scrollTop, scroller.scrollHeight, scroller.clientHeight].join(",");
    const moving = scroller.getAnimations({ subtree: true }).some((animation) =>
      (animation.pending || animation.playState === "running") &&
      Number.isFinite(animation.effect?.getComputedTiming().endTime),
    );
    // Native smooth scrolling is not exposed by getAnimations(). Observe the
    // actual offset too, and let resize/scroll observers deliver corrections.
    stableFrames = !moving && geometry === previous ? stableFrames + 1 : 0;
    previous = moving ? "" : geometry;
    if (stableFrames >= 2) return;
    if (performance.now() >= deadline) {
      throw new Error(`Scroll layout did not settle: geometry=${geometry}, finiteMotion=${moving}`);
    }
  }
}
