import assert from "node:assert/strict";

/** Public DOM and native input only: no store injection or component fixture. */
export async function verifyFullDesktopTranscript({ send, evaluate, waitFor }) {
  const geometry = () => evaluate(`(() => {
    const el = document.querySelector('.thread-scroll');
    const box = el.getBoundingClientRect();
    return { top: el.scrollTop, bottom: el.scrollHeight - el.clientHeight - el.scrollTop,
      x: box.left + box.width / 2, y: box.top + box.height / 2,
      rows: el.querySelectorAll('.message-row').length };
  })()`);
  const initial = await geometry();
  assert(initial.rows > 0 && initial.rows < 1000, "initial rendering must remain incremental");
  let moved = false;
  let nativeWheelEvents = 0;
  for (let i = 0; i < 256; i++) {
    const before = await geometry();
    await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: before.x, y: before.y,
      deltaX: 0, deltaY: -500 });
    await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    const after = await geometry();
    moved ||= after.top < before.top - 1 || after.bottom > before.bottom + 1;
    nativeWheelEvents++;
    if (after.rows > 100) break;
  }
  assert(moved, "native wheel must move the full product transcript");
  const reading = await geometry();
  assert(reading.bottom > 100, "upward reading must leave the live bottom");
  await waitFor(() => evaluate("Boolean(document.querySelector('.jump-latest-btn'))"), 5000, "return-to-latest control");
  assert(reading.rows > 100 && reading.rows < 1000, "cross the initial Host page without loading the entire conversation");
  const motion = await evaluate(`new Promise(resolve => {
    const el = document.querySelector('.thread-scroll');
    const samples = [];
    const start = performance.now();
    let arrivedAt = null;
    function sample(now) {
      const box = el.getBoundingClientRect();
      const rows = [...el.querySelectorAll('.message-row')];
      const visible = rows.filter(row => { const r = row.getBoundingClientRect();
        return r.bottom > box.top && r.top < box.bottom; });
      const bottom = Math.max(0, el.scrollHeight - el.clientHeight - el.scrollTop);
      const tail = rows.at(-1);
      samples.push({ bottom, visible: visible.length, tailTop: tail?.getBoundingClientRect().top });
      if (bottom <= 2 && arrivedAt === null) arrivedAt = now;
      if ((arrivedAt !== null && now - arrivedAt >= 600) || now - start >= 5000) {
        resolve({ samples, arrived: arrivedAt !== null }); return;
      }
      requestAnimationFrame(sample);
    }
    document.querySelector('.jump-latest-btn').click();
    requestAnimationFrame(sample);
  })`);
  assert(motion.arrived, "return-to-latest must reach the real bottom");
  assert(motion.samples.every(sample => sample.visible > 0), "navigation must not paint a blank transcript");
  const arrival = motion.samples.findIndex(sample => sample.bottom <= 2);
  const settled = motion.samples.slice(arrival);
  const tailTops = settled.map(sample => sample.tailTop);
  const drift = Math.max(...tailTops) - Math.min(...tailTops);
  assert(drift <= 2, `full Desktop bottom handoff drift: ${drift}px`);
  const result = { initial, reading, final: await geometry(), samples: motion.samples.length, drift, nativeWheelEvents };
  console.log("FULL_DESKTOP_INTERACTION " + JSON.stringify(result));
  return result;
}
