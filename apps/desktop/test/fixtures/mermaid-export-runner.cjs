const { app, BrowserWindow, clipboard } = require("electron");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const dir = process.env.PI_MERMAID_TEST_DIR;
app.setPath("userData", join(dir, "profile"));
const watchdog = setTimeout(() => app.exit(1), 45_000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: true, width: 900, height: 700,
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const evaluate = (source) => win.webContents.executeJavaScript(source, true);
  const wait = async (source) => {
    const deadline = Date.now() + 10_000;
    while (!await evaluate(source)) {
      if (Date.now() > deadline) throw Error(`Timed out: ${source}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  const click = async (label) => {
    win.focus(); win.webContents.focus();
    await wait("document.hasFocus()");
    const point = await evaluate(`(() => {
      const el = document.querySelector('button[aria-label=' + CSS.escape(${JSON.stringify(label)}) + ']');
      if (!el || el.disabled) throw Error('Control unavailable: ' + ${JSON.stringify(label)});
      const r = el.getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};
    })()`);
    win.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point });
    win.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point });
  };
  await win.loadFile(join(dir, "index.html"));
  await wait("Boolean(window.mermaidFixture)");
  const source = "```mermaid\nflowchart LR\n A[开始] --> B[完成]\n```";
  await evaluate(`window.mermaidFixture.openReadme(${JSON.stringify(source)})`);
  await wait('Boolean(document.querySelector(".mermaid-svg svg"))');
  assert.equal(await evaluate('document.querySelector(".file-viewer-path").textContent'), "README.md");
  assert.equal(await evaluate('Boolean(document.querySelector(".file-viewer-markdown .mermaid-svg svg"))'), true);
  await click("Copy diagram source");
  await wait('document.querySelector(".code-copy-btn.copied, .mermaid-action-btn.copied")');
  assert.equal(clipboard.readText().replaceAll("\r\n", "\n"), "flowchart LR\n A[开始] --> B[完成]");
  await click("Copy diagram as SVG");
  await wait('window.mermaidFixture.toast()?.message === "SVG copied"');
  const svg = clipboard.readText().replaceAll("\r\n", "\n");
  assert.match(svg, /^<svg\b/);
  assert.match(svg, /xmlns="http:\/\/www.w3.org\/2000\/svg"/);
  assert.match(svg, /开始/);
  assert.match(svg, /完成/);
  assert.doesNotMatch(svg, /var\(--font-sans\)/);
  assert.match(svg, /Arial/);
  assert.equal(await evaluate(`(() => {
    const root = new DOMParser().parseFromString(${JSON.stringify(svg)}, 'image/svg+xml').documentElement;
    return root.localName === 'svg' && Number(root.getAttribute('width')) > 0 && Number(root.getAttribute('height')) > 0;
  })()`), true);
  const downloaded = new Promise((resolve, reject) => {
    win.webContents.session.once("will-download", (_event, item) => {
      assert.equal(item.getFilename(), "diagram.svg");
      item.setSavePath(join(dir, "diagram.svg"));
      item.once("done", (_event, state) => state === "completed" ? resolve() : reject(Error(state)));
    });
  });
  await click("Export diagram as SVG");
  await downloaded;
  assert.equal(readFileSync(join(dir, "diagram.svg"), "utf8"), svg);
  await click("Show diagram source");
  await wait('Boolean(document.querySelector(".mermaid-source"))');
  assert.equal(await evaluate('document.querySelector(\'button[aria-label="Copy diagram as SVG"]\').disabled'), false);
  // Source/theme changes must export the newly rendered SVG, even in source view.
  await evaluate(`window.mermaidFixture.render(${JSON.stringify(source.replace("完成", "新版"))}, "zh-CN", "dark")`);
  await wait('document.querySelector(".mermaid-svg svg")?.textContent.includes("新版")');
  await click("复制图表为 SVG");
  await wait('window.mermaidFixture.toast()?.message === "SVG 已复制"');
  assert.match(clipboard.readText(), /新版/);
  assert.doesNotMatch(clipboard.readText(), /完成/);
  // Only the external clipboard/download boundaries are replaced for failures.
  await evaluate('Object.defineProperty(navigator, "clipboard", {configurable:true,value:{writeText:async()=>{throw Error("denied")}}})');
  await click("复制图表为 SVG");
  await wait('window.mermaidFixture.toast()?.message === "复制到剪贴板失败"');
  assert.equal(await evaluate('window.mermaidFixture.toast()?.variant'), "error");
  await evaluate('URL.createObjectURL = () => { throw Error("unavailable") }; void 0');
  await click("导出图表为 SVG");
  await wait('window.mermaidFixture.toast()?.message === "无法导出 SVG 图表"');
  assert.equal(await evaluate('window.mermaidFixture.toast()?.variant'), "error");
  await evaluate('window.mermaidFixture.render("```mermaid\\nthis is invalid\\n```", "zh-CN")');
  await wait('Boolean(document.querySelector(".mermaid-block-error"))');
  assert.equal(await evaluate('[...document.querySelectorAll(".mermaid-block-actions button")].slice(0,2).every(el => el.disabled)'), true);
  await evaluate('window.mermaidFixture.render("```mermaid\\nflowchart LR\\n A --> B")');
  await wait('!document.querySelector(".mermaid-block")');
  assert.equal(await evaluate('Boolean(document.querySelector(".code-block"))'), true);
  assert.equal(await evaluate(`(() => { try { window.mermaidFixture.standaloneMermaidSvg('<svg>'); return false; } catch { return true; } })()`), true);
  console.log("Mermaid SVG user path passed: source, clipboard SVG, real download, locale/theme refresh, failure recovery, invalid/partial fences");
  clearTimeout(watchdog); win.destroy(); app.exit(0);
}).catch((error) => { clearTimeout(watchdog); console.error(error); app.exit(1); });
