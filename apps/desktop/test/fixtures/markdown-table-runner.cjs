const { app, BrowserWindow, clipboard } = require("electron");
const assert = require("node:assert/strict");
const { readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const dir = process.env.PI_TABLE_TEST_DIR;
let passed = 0;
const watchdog = setTimeout(() => {
  console.error("Table interaction test exceeded 45 seconds");
  app.exit(1);
}, 45_000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1100, height: 800, show: true, webPreferences: { sandbox: true, contextIsolation: true } });
  // Keep the app shell's navigation restrictions at the download boundary.
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const evaluate = (source) => win.webContents.executeJavaScript(source, true);
  const wait = async (source) => {
    const deadline = Date.now() + 8000;
    while (!(await evaluate(source))) {
      if (Date.now() > deadline) {
        console.error(await evaluate('JSON.stringify({focus: document.hasFocus(), toast: window.tableFixture.toast(), buttons: [...document.querySelectorAll("button")].map(el => ({label: el.getAttribute("aria-label"), rect: el.getBoundingClientRect().toJSON()}))})'));
        throw new Error(`Timed out: ${source}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
  };
  const check = (name, actual) => { assert.ok(actual, name); passed++; console.log(`PASS ${name}`); };
  const click = async (selector) => {
    win.focus();
    win.webContents.focus();
    await wait('document.hasFocus()');
    await evaluate('Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {})))');
    const point = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw Error('Missing control'); el.scrollIntoView({block:'center'}); const r = el.getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}; })()`);
    win.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point });
    win.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point });
  };
  const key = async (keyCode, modifiers = []) => {
    win.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
  };
  await win.loadFile(join(dir, "index.html"));
  win.webContents.focus();
  await wait('document.querySelectorAll(".markdown-table").length === 2');
  check("production Markdown renders one toolbar per table", await evaluate('document.querySelectorAll(".markdown-table-actions").length === 2'));
  await click('.markdown-table button[aria-label="Copy table as Markdown"]');
  await wait('window.tableFixture.toast()?.message === "Table copied"');
  check("copy preserves this table's inline Markdown and alignment", clipboard.readText() === '| **Product** | Note |\n| :--- | ---: |\n| Pi | 你好, world |\n| ZCode | say "hi"<br>again |');
  const downloaded = new Promise((resolve, reject) => {
    win.webContents.session.once("will-download", (_event, item) => {
      item.setSavePath(join(dir, "table.csv"));
      item.once("done", (_e, state) => state === "completed" ? resolve() : reject(Error(state)));
    });
  });
  await click('.markdown-table button[aria-label="Download table as CSV"]');
  await downloaded;
  check("CSV download contains UTF-8, escaped quotes and cell line breaks", readFileSync(join(dir, "table.csv"), "utf8") === '\uFEFF"Product","Note"\r\n"Pi","你好, world"\r\n"ZCode","say ""hi""\nagain"\r\n');
  await click('.markdown-table button[aria-label="Expand table"]');
  await wait('Boolean(document.querySelector("[role=dialog]"))');
  check("preview uses modal semantics and masks native views", await evaluate('document.querySelector("[role=dialog]").getAttribute("aria-modal") === "true" && window.tableFixture.isBlockingOverlayActive()'));
  check("preview contains only its own table", await evaluate('document.querySelector("[role=dialog]").textContent.includes("你好") && !document.querySelector("[role=dialog]").textContent.includes("untouched")'));
  check("focus starts on close", await evaluate('document.activeElement.getAttribute("aria-label") === "Close table preview"'));
  await key("Tab", ["shift"]);
  check("Shift-Tab stays inside the modal", await evaluate('Boolean(document.activeElement.closest("[role=dialog]"))'));
  await key("Escape");
  await wait('!document.querySelector("[role=dialog]")');
  check("Escape returns focus to expand and releases the overlay", await evaluate('document.activeElement.getAttribute("aria-label") === "Expand table" && !window.tableFixture.isBlockingOverlayActive()'));
  await evaluate('window.tableFixture.render("| A |\\n| --- |\\n| initial |")');
  await click('button[aria-label="Expand table"]');
  await wait('Boolean(document.querySelector("[role=dialog]"))');
  await evaluate('window.tableFixture.render(window.tableFixture.source + "\\n| streamed |")');
  check("an open preview follows streamed rows", await evaluate('document.querySelector("[role=dialog]").textContent.includes("streamed")'));
  const previousToast = await evaluate('window.tableFixture.toast()?.id');
  await click('[role=dialog] button[aria-label="Copy table as Markdown"]');
  await wait(`window.tableFixture.toast()?.id !== ${JSON.stringify(previousToast)} && window.tableFixture.toast()?.message === "Table copied"`);
  check("copy in preview uses the latest rows", clipboard.readText().includes("streamed"));
  check("copy feedback is visible above the preview", await evaluate('(() => { const toast = [...document.querySelectorAll(".toast")].at(-1); const r = toast.getBoundingClientRect(); return document.elementsFromPoint(r.x + r.width / 2, r.y + r.height / 2).some(el => el === toast || el.closest(".toast") === toast); })()'));
  await click('button[aria-label="Close table preview"]');
  await wait('!document.querySelector("[role=dialog]")');
  await evaluate('window.tableFixture.render("| Product | Notes |\\n| --- | --- |\\n" + Array.from({length: 40}, (_, i) => `| Item ${i + 1} | A longer description to check wrapping 中文 |`).join("\\n"))');
  for (const theme of ["light", "dark"]) {
    win.setContentSize(360, 500);
    await evaluate(`window.tableFixture.render(window.tableFixture.source, "zh-CN", ${JSON.stringify(theme)})`);
    await click('button[aria-label="放大表格"]');
    await wait('Boolean(document.querySelector("[role=dialog]"))');
    check(`${theme} narrow preview stays within viewport`, await evaluate('(() => { const r = document.querySelector("[role=dialog]").getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; })()'));
    check(`${theme} long table scrolls inside the preview`, await evaluate('(() => { const body = document.querySelector(".markdown-table-preview-body"); return body.scrollHeight > body.clientHeight && getComputedStyle(body).overflowY === "auto"; })()'));
    check(`${theme} narrow preview scrolls horizontally instead of crushing columns`, await evaluate('(() => { const body = document.querySelector(".markdown-table-preview-body"); const header = document.querySelector("[role=dialog] th"); const range = document.createRange(); range.selectNodeContents(header); return body.scrollWidth > body.clientWidth && range.getClientRects().length === 1; })()'));
    check(`${theme} sticky header is opaque`, await evaluate('(() => { const canvas = document.createElement("canvas"); const context = canvas.getContext("2d"); context.fillStyle = getComputedStyle(document.querySelector("[role=dialog] th")).backgroundColor; context.fillRect(0, 0, 1, 1); return context.getImageData(0, 0, 1, 1).data[3] === 255; })()'));
    await evaluate('document.querySelector(".markdown-table-preview-body").scrollTop = 150');
    check(`${theme} header stays visible while scrolling`, await evaluate('(() => { const body = document.querySelector(".markdown-table-preview-body").getBoundingClientRect(); const head = document.querySelector("[role=dialog] th").getBoundingClientRect(); return Math.abs(body.top - head.top) < 2; })()'));
    await evaluate('Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {}))).then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))');
    writeFileSync(join(dir, `${theme}-preview.png`), (await win.webContents.capturePage()).toPNG());
    await key("Escape");
    await wait('!document.querySelector("[role=dialog]")');
  }
  // Restore the viewport after narrow-layout checks so earlier feedback
  // cannot cover the toolbar and intercept the error-path clicks.
  win.setContentSize(1100, 800);
  await wait('innerWidth === 1100 && innerHeight === 800');
  await evaluate('Object.defineProperty(navigator, "clipboard", {configurable:true,value:{writeText:async()=>{throw Error("denied")}}})');
  await click('button[aria-label="复制表格为 Markdown"]');
  await wait('window.tableFixture.toast()?.message === "无法复制表格"');
  check("clipboard denial produces an error instead of success", await evaluate('window.tableFixture.toast()?.variant === "error"'));
  await evaluate('URL.createObjectURL = () => { throw Error("unavailable") }; void 0');
  await click('button[aria-label="下载表格为 CSV"]');
  await wait('window.tableFixture.toast()?.message === "无法下载表格"');
  check("download setup failure produces an error", await evaluate('window.tableFixture.toast()?.variant === "error"'));
  console.log(`${passed} table interaction checks passed`);
  clearTimeout(watchdog);
  win.destroy(); app.exit(0);
}).catch((error) => { clearTimeout(watchdog); console.error(error); app.exit(1); });
