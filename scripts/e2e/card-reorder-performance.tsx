import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { useCardReorder } from "../../apps/desktop/src/hooks/use-card-reorder";

/** Count work with a controlled animation clock; do not depend on machine speed. */
export function cardReorderPerformance() {
  const items = Array.from({ length: 200 }, (_, index) => ({ id: String(index) }));
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;inset:0;overflow:hidden";
  document.body.append(host);
  let renders = 0;
  const moves: { id: string; target: string; placement: string }[] = [];
  let geometryReads = 0;
  let nextFrame = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const realFrame = window.requestAnimationFrame;
  const realCancel = window.cancelAnimationFrame;
  const realRect = Element.prototype.getBoundingClientRect;
  window.requestAnimationFrame = (callback) => { frames.set(++nextFrame, callback); return nextFrame; };
  window.cancelAnimationFrame = (id) => { frames.delete(id); };
  Element.prototype.getBoundingClientRect = function () { geometryReads += 1; return realRect.call(this); };
  const tick = () => {
    const callbacks = [...frames.values()];
    frames.clear();
    flushSync(() => { for (const callback of callbacks) callback(performance.now()); });
  };
  function Fixture() {
    renders += 1;
    const reorder = useCardReorder(items, false, (id, target, placement) => { moves.push({ id, target, placement }); });
    return <ul>{items.map(({ id }) => <li key={id} ref={reorder.rowRef(id)}
      style={{ height: 24 }} {...reorder.rowEvents(id)}>{id}</li>)}</ul>;
  }
  const root = createRoot(host);
  try {
    flushSync(() => root.render(<Fixture />));
    const row = host.querySelector("li")!;
    const bounds = row.getBoundingClientRect();
    flushSync(() => row.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 80, button: 0, clientX: bounds.left + 10, clientY: bounds.top + 10, bubbles: true })));
    const readsAtStart = geometryReads;
    const rendersAtStart = renders;
    for (let index = 0; index < 200; index += 1) {
      flushSync(() => window.dispatchEvent(new PointerEvent("pointermove", { pointerId: 80, clientX: bounds.left + 30 + index, clientY: bounds.top + 80, bubbles: true, cancelable: true })));
    }
    tick();
    const rendersAfterBurst = renders;
    for (let index = 0; index < 120; index += 1) tick();
    const result = {
      cards: items.length, pointerEvents: 200,
      burstRenders: rendersAfterBurst - rendersAtStart,
      idleRenders: renders - rendersAfterBurst,
      geometryReadsAfterStart: geometryReads - readsAtStart,
      pendingIdleFrames: frames.size,
    };
    flushSync(() => window.dispatchEvent(new PointerEvent("pointercancel", { pointerId: 80, bubbles: true })));
    if (frames.size) throw new Error("cancelled drag retained animation callbacks");
    if (result.burstRenders > 1 || result.idleRenders !== 0 || result.pendingIdleFrames !== 0 || result.geometryReadsAfterStart !== 0) {
      throw new Error(`drag preview exceeded its work budget: ${JSON.stringify(result)}`);
    }
    // Release before the queued frame still commits the last pointer position.
    const destination = host.querySelectorAll("li")[4].getBoundingClientRect();
    flushSync(() => row.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 81, button: 0, clientX: bounds.left + 10, clientY: bounds.top + 10, bubbles: true })));
    flushSync(() => window.dispatchEvent(new PointerEvent("pointermove", { pointerId: 81, clientX: bounds.left + 30, clientY: destination.bottom - 1, bubbles: true, cancelable: true })));
    flushSync(() => window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 81, bubbles: true })));
    if (moves.length !== 1 || moves[0].id !== "0" || moves[0].target !== "4" || moves[0].placement !== "after" || frames.size) {
      throw new Error("release before paint lost the final destination or retained a callback");
    }
    if ([...host.querySelectorAll<HTMLElement>("li")].some((node) => node.style.transform)) throw new Error("release left transient transforms behind");
    host.style.overflowY = "auto";
    host.style.height = "200px";
    host.style.bottom = "auto";
    const scrollLimit = host.scrollHeight - host.clientHeight;
    host.scrollTop = scrollLimit;
    const lastRow = host.querySelectorAll("li")[199];
    const lastBounds = lastRow.getBoundingClientRect();
    const viewport = host.getBoundingClientRect();
    flushSync(() => lastRow.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 83, button: 0, clientX: lastBounds.left + 10, clientY: lastBounds.top + 5, bubbles: true })));
    flushSync(() => window.dispatchEvent(new PointerEvent("pointermove", { pointerId: 83, clientX: lastBounds.left + 30, clientY: viewport.bottom + 30, bubbles: true, cancelable: true })));
    for (let index = 0; index < 10; index += 1) tick();
    if (host.scrollTop !== scrollLimit || frames.size) throw new Error("drag transforms extended automatic scrolling beyond the original content");
    flushSync(() => window.dispatchEvent(new PointerEvent("pointercancel", { pointerId: 83, bubbles: true })));
    flushSync(() => row.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 82, button: 0, clientX: bounds.left + 10, clientY: bounds.top + 10, bubbles: true })));
    flushSync(() => window.dispatchEvent(new PointerEvent("pointermove", { pointerId: 82, clientX: bounds.left + 30, clientY: destination.bottom - 1, bubbles: true, cancelable: true })));
    flushSync(() => root.render(null));
    if (frames.size) throw new Error("unmount retained an animation callback");
    return result;
  } finally {
    flushSync(() => root.unmount());
    window.requestAnimationFrame = realFrame;
    window.cancelAnimationFrame = realCancel;
    Element.prototype.getBoundingClientRect = realRect;
    host.remove();
  }
}
