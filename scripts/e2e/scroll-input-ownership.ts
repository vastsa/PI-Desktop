function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

/** Exercise the real owner's listeners; synthetic inputs have no default move. */
export function probeScrollInputOwnership(scroller: HTMLElement) {
  const controls = document.createElement("div");
  controls.style.cssText = "position:absolute;width:100px;height:100px";
  const button = document.createElement("button");
  button.textContent = "Fixture control";
  const select = document.createElement("select");
  select.append(document.createElement("option"));
  const nested = document.createElement("div");
  nested.dataset.scrollOwner = "fixture-nested";
  nested.style.cssText = "height:20px;overflow:auto";
  const filler = document.createElement("div");
  filler.style.height = "100px";
  nested.append(filler);
  controls.append(button, select, nested);
  scroller.append(controls);
  const checks: string[] = [];
  const nativeScrollTo = scroller.scrollTo;
  const executeScrollTo = nativeScrollTo.bind(scroller);
  let observingInput = false;
  let cancellations = 0;
  // Observe the browser boundary while still executing every real scroll.
  // Chromium may itself abort an animation on pointer input; that is distinct
  // from the application wrongly attributing a control's input to this owner.
  scroller.scrollTo = (options?: ScrollToOptions | number, y?: number) => {
    if (observingInput && typeof options === "object" && options.behavior === "instant") cancellations++;
    if (typeof options === "number") executeScrollTo(options, y ?? 0);
    else executeScrollTo(options ?? {});
  };
  try {
    const cases = [
      { name: "wheel", target: scroller, event: () => new WheelEvent("wheel", { bubbles: true, deltaY: -1 }), interrupts: true },
      { name: "scroll key", target: scroller, event: () => new KeyboardEvent("keydown", { bubbles: true, key: "PageUp" }), interrupts: true },
      { name: "scroll surface press", target: scroller, event: () => new PointerEvent("pointerdown", { bubbles: true }), interrupts: true },
      { name: "touch start", target: scroller, event: () => new Event("touchstart", { bubbles: true }), interrupts: true },
      { name: "touch move", target: scroller, event: () => new Event("touchmove", { bubbles: true }), interrupts: true },
      { name: "button Space", target: button, event: () => new KeyboardEvent("keydown", { bubbles: true, key: " " }), interrupts: false },
      { name: "button press", target: button, event: () => new PointerEvent("pointerdown", { bubbles: true }), interrupts: false },
      { name: "select ArrowDown", target: select, event: () => new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" }), interrupts: false },
      { name: "nested wheel", target: nested, event: () => new WheelEvent("wheel", { bubbles: true, deltaY: -1 }), interrupts: false },
    ];
    for (const scenario of cases) {
      // Explicit reader input releases any held disclosure before navigation.
      scroller.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -1 }));
      scroller.scrollTo({ top: 120, behavior: "instant" });
      scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
      const top = scroller.scrollTop;
      assert(top > 1, `${scenario.name}: fixture has no scroll range`);
      scroller.scrollTo({ top: 0, behavior: "smooth" });
      cancellations = 0;
      observingInput = true;
      scenario.target.dispatchEvent(scenario.event());
      observingInput = false;
      assert(scenario.interrupts ? cancellations === 1 : cancellations === 0,
        `${scenario.name}: application requested ${cancellations} cancellations`);
      if (scenario.interrupts) {
        assert(Math.abs(scroller.scrollTop - top) < 2,
          `${scenario.name}: cancellation changed the reader's current offset`);
      }
      checks.push(scenario.name);
    }
    return checks;
  } finally {
    scroller.scrollTo = nativeScrollTo;
    controls.remove();
  }
}
