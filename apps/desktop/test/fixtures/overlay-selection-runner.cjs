const { app, BrowserWindow, clipboard } = require("electron");
const { join } = require("node:path");
let passed = 0;
const failures = [];
const watchdog = setTimeout(() => { console.error("Overlay selection test exceeded 60 seconds"); app.exit(1); }, 60_000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1100, height: 800, show: true,
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const evaluate = (source) => win.webContents.executeJavaScript(source, true);
  const settle = () => evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  const wait = async (source) => {
    const deadline = Date.now() + 8000;
    while (!(await evaluate(source))) {
      if (Date.now() > deadline) throw Error(`Timed out: ${source}`);
      await settle();
    }
  };
  const check = (name, result) => {
    if (result) { passed++; console.log(`PASS ${name}`); }
    else { failures.push(name); console.error(`FAIL ${name}`); }
  };
  const mouse = async (type, point, modifiers = []) => {
    win.webContents.sendInputEvent({ type, button: "left", clickCount: 1, ...point, modifiers });
    await settle();
  };
  const point = (selector, text = false) => evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) throw Error('Missing ${selector}');
    let r = element.getBoundingClientRect();
    if (${text}) {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let node; while ((node = walker.nextNode())) {
        if (!node.textContent.trim()) continue;
        const offset = Math.min(5, node.textContent.length - 1);
        const range = document.createRange(); range.setStart(node, offset); range.setEnd(node, offset + 1);
        r = range.getBoundingClientRect(); break;
      }
    }
    return { x: Math.round(r.x + (${text} ? 1 : r.width / 2)), y: Math.round(r.y + r.height / 2) };
  })()`);
  const clickAt = async (p) => { await mouse("mouseMove", p); await mouse("mouseDown", p); await mouse("mouseUp", p); };
  const click = async (selector) => clickAt(await point(selector));
  const key = async (keyCode, modifiers = []) => {
    if (keyCode === "c") keyCode = "C";
    win.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
    if (keyCode === "Enter") win.webContents.sendInputEvent({ type: "char", keyCode: "\r", modifiers });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
    await settle();
  };
  const copySelection = async () => {
    clipboard.clear();
    if (process.platform === "darwin") {
      await key("c", ["meta"]);
      const copied = await evaluate("document.execCommand('copy')");
      await settle();
      return copied;
    }
    await key("c", ["control"]);
    return true;
  };
  const drag = async (start, end, held) => {
    await mouse("mouseMove", start);
    await mouse("mouseDown", start);
    for (let step = 1; step <= 8; step++) {
      await mouse("mouseMove", { x: Math.round(start.x + (end.x - start.x) * step / 8),
        y: Math.round(start.y + (end.y - start.y) * step / 8) }, ["leftButtonDown"]);
    }
    if (held) await held();
    await mouse("mouseUp", end);
  };
  const exists = (selector) => evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`);
  const selected = () => evaluate("document.getSelection()?.toString() ?? ''");
  const show = async (kind) => {
    await mouse("mouseMove", { x: 5, y: 5 });
    await evaluate(`window.overlayFixture.show(${JSON.stringify(kind)})`);
    if (kind === "table") await click('button[aria-label="Expand table"]');
    if (kind === "release") await wait("Boolean(document.querySelector('.release-notes-version li'))");
    await evaluate("Promise.all(document.getAnimations().filter(a => a.effect.getComputedTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})))");
  };
  await win.loadFile(join(process.env.PI_OVERLAY_TEST_DIR, "index.html"));
  win.focus(); win.webContents.focus();
  await wait("Boolean(window.overlayFixture) && document.hasFocus()");
  for (const [kind, text, overlay] of [
    ["release", ".release-notes-version li", ".release-notes-overlay"],
    ["table", ".markdown-table-preview th", ".markdown-table-overlay"],
    ["instructions", ".project-instructions-dialog-project", ".project-instructions-dialog-overlay"],
    ["provider", "#provider-setup-title", ".provider-setup-overlay"],
  ]) {
    await show(kind);
    const start = await point(text, true);
    const outside = { x: 5, y: Math.min(740, start.y + 40) };
    await drag(start, outside);
    check(`${kind}: internal-to-external text drag keeps dialog open`, await exists(overlay));
    if (await exists(overlay)) {
      const selection = await selected();
      if (kind === "release" || kind === "table") check(`${kind}: native selection remains nonempty`, selection.length > 0);
      if (selection) {
        const copied = await copySelection();
        check(`${kind}: native Copy preserves the selection`, copied && clipboard.readText().replaceAll("\r\n", "\n") === selection);
      }
      await clickAt(outside);
      check(`${kind}: subsequent deliberate backdrop click closes`, !(await exists(overlay)));
    }
    await show(kind);
    await drag({ x: 5, y: 5 }, await point(text));
    check(`${kind}: external-to-internal drag keeps dialog open`, await exists(overlay));
    await key("Escape");
    check(`${kind}: Escape still closes`, !(await exists(overlay)));
  }
  await show("table");
  await evaluate(`(() => { window.overlayFixture.keyReached = false; document.querySelector('button[aria-label="Close table preview"]').addEventListener('keydown', () => { window.overlayFixture.keyReached = true; }, { once: true }); })()`);
  await key("Enter");
  check("table: native key reaches focused control", await evaluate("window.overlayFixture.keyReached"));
  check("table: Enter activates focused close control", !(await exists(".markdown-table-overlay")));
  for (const reset of ["cancel", "blur"]) {
    await show("release");
    await mouse("mouseDown", { x: 5, y: 350 });
    await evaluate(reset === "cancel"
      ? `document.querySelector('.release-notes-overlay').dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: window.overlayFixture.pointerId }))`
      : `window.dispatchEvent(new Event('blur'))`);
    await mouse("mouseUp", { x: 5, y: 350 });
    check(`backdrop: ${reset} resets pending dismissal`, await exists(".release-notes-overlay"));
    await clickAt({ x: 5, y: 350 });
    check(`backdrop: fresh click works after ${reset}`, !(await exists(".release-notes-overlay")));
  }
  await show("provider");
  await click('.provider-setup-head-actions button');
  await wait("Boolean(document.querySelector('.provider-advanced-overlay'))");
  await drag(await point("#provider-advanced-title", true), { x: 5, y: 350 });
  check("nested advanced: drag closes neither layer", await exists(".provider-advanced-overlay") && await exists(".provider-setup-overlay"));
  if (await exists(".provider-advanced-overlay")) await clickAt({ x: 5, y: 350 });
  check("nested advanced: intentional backdrop closes only inner layer", !(await exists(".provider-advanced-overlay")) && await exists(".provider-setup-overlay"));
  await show("instructions");
  await evaluate(`(() => { const el = document.querySelector('textarea'); const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; setter.call(el, el.value + ' changed'); el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await click(".project-instructions-dialog-actions .btn-primary");
  await wait("document.querySelector('textarea').disabled");
  await clickAt({ x: 5, y: 350 }); await key("Escape");
  check("saving instructions: outside click and Escape remain blocked", await exists(".project-instructions-dialog-overlay"));
  await evaluate("window.overlayFixture.finishSave()");
  await wait("!document.querySelector('textarea').disabled");
  await click(".project-instructions-dialog-close");
  check("instructions: close button works after save", !(await exists(".project-instructions-dialog-overlay")));

  const hover = ".sidebar-session-hover-card";
  const showHover = async () => {
    await show("hover"); await mouse("mouseMove", await point("#hover-trigger"));
    await evaluate("window.overlayFixture.advance(500)");
    await wait("Boolean(document.querySelector('.sidebar-session-hover-card'))");
    await mouse("mouseMove", await point(`${hover}-title`));
  };
  await showHover();
  await drag(await point(`${hover}-title`, true), { x: 700, y: 330 }, async () => {
    await evaluate("window.overlayFixture.advance(161)");
    check("hover card: survives grace timeout during held selection", await exists(hover));
  });
  await evaluate("window.overlayFixture.advance(161)");
  check("hover card: selected text keeps card open after release", await exists(hover));
  if (await exists(hover)) {
    const selection = await selected();
    check("hover card: native selected text is nonempty", selection.length > 0);
    const copied = await copySelection();
    check("hover card: native Copy works outside card", copied && clipboard.readText().replaceAll("\r\n", "\n") === selection && selection.length > 0);
    await mouse("mouseMove", await point("#hover-trigger"));
    await mouse("mouseMove", { x: 700, y: 330 });
    await evaluate("window.overlayFixture.advance(161)");
    check("hover card: row leave cannot dismiss retained selection", await exists(hover));
    await evaluate("document.getSelection().removeAllRanges()"); await settle();
    await evaluate("window.overlayFixture.advance(161)");
    check("hover card: clearing selection resumes dismissal", !(await exists(hover)));
  }
  await showHover();
  await mouse("mouseMove", { x: 700, y: 330 });
  await evaluate("window.overlayFixture.advance(159)");
  check("hover card: ordinary leave preserves 160ms grace", await exists(hover));
  await evaluate("window.overlayFixture.advance(1)");
  check("hover card: ordinary leave dismisses at grace timeout", !(await exists(hover)));
  for (const reset of ["cancel", "blur"]) {
    await showHover();
    await mouse("mouseDown", await point(`${hover}-title`, true));
    await mouse("mouseMove", { x: 700, y: 330 }, ["leftButtonDown"]);
    await evaluate("document.getSelection().removeAllRanges()");
    await evaluate(reset === "cancel"
      ? `document.querySelector('.sidebar-session-hover-card').dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: window.overlayFixture.pointerId }))`
      : `window.dispatchEvent(new Event('blur'))`);
    await evaluate("window.overlayFixture.advance(161)");
    check(`hover card: unselected ${reset} resumes dismissal`, !(await exists(hover)));
    await mouse("mouseUp", { x: 700, y: 330 });
  }
  for (const dismiss of ["Escape", "outside press"]) {
    await showHover();
    await drag(await point(`${hover}-title`, true), { x: 700, y: 330 });
    check(`hover card: selection exists before ${dismiss}`, (await selected()).length > 0 && await exists(hover));
    if (dismiss === "Escape") await key("Escape");
    else await clickAt({ x: 700, y: 330 });
    check(`hover card: ${dismiss} closes selected card`, !(await exists(hover)));
  }
  console.log(`${passed} checks passed; ${failures.length} failed`);
  clearTimeout(watchdog); win.destroy(); app.exit(failures.length ? 1 : 0);
}).catch((error) => { clearTimeout(watchdog); console.error(error); app.exit(1); });
