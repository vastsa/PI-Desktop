import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

/** Shared CDP assertions for isolated Electron and already-provisioned Chromium. */
export async function checkGoalBrowser({ js, send, viewport }) {
  const settle = () => js("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await js('new Promise((resolve,reject)=>{const end=setTimeout(()=>reject(Error("Fixture readiness timed out")),15000);const tick=()=>{if(window.goalReady){clearTimeout(end);resolve()}else requestAnimationFrame(tick)};tick()})');
  const result = await js("window.goalProbe.run()");
  await js("document.querySelector('[data-goal-action=edit]').focus()");
  for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
  await settle();
  assert.equal(await js('document.activeElement.matches(":focus-visible")'), true);
  assert.equal(await js("getComputedStyle(document.activeElement).outlineStyle"), "solid");
  for (const [width, theme, lang] of [[960, "dark", "en"], [390, "dark", "zh-CN"], [390, "light", "en"], [320, "light", "zh-CN"]]) {
    await viewport(width, 900);
    await js(`document.documentElement.dataset.theme=${JSON.stringify(theme)};document.documentElement.lang=${JSON.stringify(lang)};window.goalProbe.prepare("budget_exhausted",${JSON.stringify(lang)})`);
    await settle();
    const metrics = await js(`(()=>{const bar=document.querySelector('[data-testid=goal-status-bar]');const header=document.querySelector('.goal-status').getBoundingClientRect();const shell=document.querySelector('.composer-shell').getBoundingClientRect();return {width:innerWidth,scrollWidth:document.documentElement.scrollWidth,barHeight:bar.getBoundingClientRect().height,connectionGap:shell.top-bar.getBoundingClientRect().bottom,leftDelta:shell.left-header.left,rightDelta:shell.right-header.right,shellTopRadius:getComputedStyle(document.querySelector('.composer-shell')).borderTopLeftRadius,outerBorder:getComputedStyle(document.querySelector('.has-goal')).borderLeftWidth,detailsIcon:Boolean(bar.querySelector('[data-goal-action=details] .lucide-circle-ellipsis')),buttons:[...bar.querySelectorAll('button')].map(n=>({label:n.getAttribute('aria-label'),width:n.getBoundingClientRect().width,right:n.getBoundingClientRect().right,left:n.getBoundingClientRect().left}))}})()`);
    assert.equal(metrics.scrollWidth, metrics.width, `Horizontal overflow ${JSON.stringify(metrics)}`);
    assert.ok(metrics.barHeight <= 40, `Header not one line ${JSON.stringify(metrics)}`);
    assert.ok(metrics.connectionGap <= 0 && metrics.connectionGap >= -2, `Detached header ${JSON.stringify(metrics)}`);
    assert.ok(Math.abs(metrics.leftDelta + 14) < .1 && Math.abs(metrics.rightDelta - 14) < .1 && parseFloat(metrics.shellTopRadius) > 0 && metrics.outerBorder === '0px' && metrics.detailsIcon, `Inset header or original input curve missing ${JSON.stringify(metrics)}`);
    for (const button of metrics.buttons) assert.ok(button.width >= 24 && button.left >= 0 && button.right <= width, `Hidden icon ${JSON.stringify(button)}`);
    await js("document.querySelector('[data-goal-action=details]').click()"); await settle();
    const bounds = await js(`(()=>{const n=document.querySelector('[role=dialog]');return {width:innerWidth,viewportHeight:innerHeight,height:n.getBoundingClientRect().height,bottom:n.getBoundingClientRect().bottom,scroll:document.documentElement.scrollWidth}})()`);
    assert.ok(bounds.height <= Math.min(bounds.viewportHeight * .8, 760) + 1 && bounds.bottom <= bounds.viewportHeight + 1, `Unbounded details ${JSON.stringify(bounds)}`);
    assert.equal(bounds.scroll, bounds.width, "Dialog caused overflow");
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    assert.equal(await js("getComputedStyle(document.querySelector('[role=dialog]')).animationName"), "none");
    assert.equal(await js("getComputedStyle(document.querySelector('.goal-dialog-overlay')).animationName"), "none");
    assert.equal(await js("getComputedStyle(document.querySelector('.goal-status button')).transitionDuration"), "0s");
    for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await settle(); assert.equal(await js("document.querySelector('[role=dialog]')===null"), true);
    for (const action of ["edit", "delete", "resume"]) {
      await js(`document.querySelector('[data-goal-action=${action}]').focus()`);
      for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, ...(type === "keyDown" ? { text: "\r", unmodifiedText: "\r" } : {}) });
      await settle();
      const dialogBounds = await js(`(()=>{const n=document.querySelector('[role=dialog]');return n&&{height:n.getBoundingClientRect().height,bottom:n.getBoundingClientRect().bottom,width:innerWidth,scroll:document.documentElement.scrollWidth}})()`);
      assert.ok(dialogBounds && dialogBounds.height <= 721 && dialogBounds.bottom <= 901 && dialogBounds.width === dialogBounds.scroll, `Unbounded keyboard dialog ${action}: ${JSON.stringify(dialogBounds)}`);
      for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
      await settle(); assert.equal(await js(`document.activeElement.dataset.goalAction`), action);
    }
    result.checks.push({ width, theme, lang, ...metrics });
  }
  return result;
}

/** No install/download: the caller explicitly supplies an existing browser executable. */
export async function probeWithChromium(executable, output) {
  const assets = new Map([["/", "index.html"], ["/index.html", "index.html"], ["/fixture.js", "fixture.js"], ["/fixture.css", "fixture.css"], ["/foundation.css", "foundation.css"]]);
  const server = createServer(async (request, response) => {
    const asset = assets.get(request.url);
    if (!asset) { response.writeHead(404); response.end(); return; }
    try {
      const content = await readFile(path.join(output, asset));
      response.writeHead(200, { "Content-Type": asset.endsWith(".js") ? "text/javascript" : asset.endsWith(".css") ? "text/css" : "text/html", "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src data:; connect-src 'none'" });
      response.end(content);
    } catch (error) { response.writeHead(500); response.end(String(error)); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const child = spawn(executable, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${path.join(output, "profile")}`, "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "about:blank"], { stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(child, "exit");
  let log = "";
  let socket;
  const pending = new Map();
  let id = 0;
  try {
    const endpoint = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(Error(`Browser startup timed out: ${log}`)), 15000);
      child.once("error", (error) => { clearTimeout(timeout); reject(error); });
      child.stderr.on("data", (chunk) => {
        log += chunk;
        const match = log.match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match) { clearTimeout(timeout); resolve(match[1]); }
      });
      child.once("exit", (code) => { clearTimeout(timeout); reject(Error(`Browser exited ${code}: ${log}`)); });
    });
    socket = new WebSocket(endpoint);
    await once(socket, "open");
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      const operation = pending.get(message.id);
      if (!operation) return;
      pending.delete(message.id);
      if (message.error) operation.reject(Error(JSON.stringify(message.error))); else operation.resolve(message.result);
    });
    const command = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const key = ++id; pending.set(key, { resolve, reject }); socket.send(JSON.stringify({ id: key, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
    const target = await command("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await command("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    const send = (method, params) => command(method, params, sessionId);
    const js = async (expression) => {
      const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
      if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
      return result.result.value;
    };
    await send("Network.enable");
    await send("Network.setBlockedURLs", { urls: ["https://*"] });
    const viewport = (width, height) => send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    await viewport(960, 900);
    await send("Page.navigate", { url: origin });
    const result = await checkGoalBrowser({ js, send, viewport });
    await writeFile(path.join(output, "result.json"), JSON.stringify(result, null, 2));
    const capture = await send("Page.captureScreenshot", { format: "png" });
    await writeFile(path.join(output, "interim.png"), Buffer.from(capture.data, "base64"));
    await command("Browser.close");
    await exited;
    return result;
  } finally {
    socket?.close();
    for (const operation of pending.values()) operation.reject(Error("Browser probe disposed"));
    if (child.exitCode === null) { child.kill(); await exited; }
    await new Promise((resolve) => server.close(resolve));
  }
}
