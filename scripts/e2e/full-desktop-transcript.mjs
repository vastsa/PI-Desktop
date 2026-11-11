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
  const readingAnchor = await verifyReadingAnchor({ send, evaluate });
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
  const result = { initial, reading, final: await geometry(), samples: motion.samples.length, drift, nativeWheelEvents, readingAnchor };
  console.log("FULL_DESKTOP_INTERACTION " + JSON.stringify(result));
  return result;
}

async function verifyReadingAnchor({ send, evaluate }) {
  const prepared = await evaluate(`(async () => {
    const el = document.querySelector('.thread-scroll');
    for (const row of el.querySelectorAll('.message-row')) row.style.contentVisibility = 'visible';
    let previous = -1, stable = 0;
    while (stable < 6) {
      await new Promise(resolve => requestAnimationFrame(resolve));
      stable = previous === el.scrollTop ? stable + 1 : 0;
      previous = el.scrollTop;
    }
    const viewport = el.getBoundingClientRect();
    const rows = [...el.querySelectorAll('.message-row')];
    const above = rows.find(row => row.getBoundingClientRect().bottom < viewport.top);
    const below = rows.at(-1);
    const point = [...el.querySelectorAll('.prose-chat p, .message-user-text')].find(node => {
      const rect = node.getBoundingClientRect();
      return rect.height > 0 && rect.top > viewport.top + 30 && rect.bottom < viewport.bottom - 30;
    });
    if (!above || !below || !point) throw new Error('Full Desktop reading probe needs above/visible/below content');
    const range = document.createRange(); range.selectNodeContents(point);
    const line = [...range.getClientRects()].find(rect => rect.width >= 200 && rect.height >= 12);
    if (!line) throw new Error('Full Desktop reading probe needs a rendered text line');
    const padding = parseFloat(getComputedStyle(above).paddingBottom);
    globalThis.fullDesktopReadingProbe = { el, above, point, padding, baseline: point.getBoundingClientRect().top - viewport.top };
    return { x: Math.ceil(line.left), y: Math.ceil(line.top), width: 200, height: 12, scale: 1 };
  })()`);
  const baseline = await send('Page.captureScreenshot', { format: 'png', clip: prepared });
  let maxDrift = 0;
  try {
    for (let amount = 20; amount <= 120; amount += 20) {
      await evaluate(`(() => { const p = globalThis.fullDesktopReadingProbe; p.above.style.paddingBottom = (p.padding + ${amount}) + 'px'; })()`);
      const frame = await send('Page.captureScreenshot', { format: 'png', clip: prepared });
      assert.equal(frame.data, baseline.data, 'full Desktop painted reading text moved during late layout');
      const drift = await evaluate(`(() => { const p = globalThis.fullDesktopReadingProbe;
        return Math.abs(p.point.getBoundingClientRect().top - p.el.getBoundingClientRect().top - p.baseline); })()`);
      maxDrift = Math.max(maxDrift, drift);
    }
    assert(maxDrift <= 1, 'full Desktop late layout changed the reading anchor');
  } finally { await evaluate('delete globalThis.fullDesktopReadingProbe'); }
  const result = { captures: 6, identical: true, maxDrift };
  console.log('FULL_DESKTOP_READING_ANCHOR ' + JSON.stringify(result));
  return result;
}
