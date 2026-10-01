#!/usr/bin/env node
// Real desktop, preload, Host SQLite and agent sidecar; only the model is local SSE.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { Host, resolveHostBinary } from "./e2e/host.mjs";
import { resolveElectronBinary } from "./e2e/boot.mjs";
import { waitFor } from "./e2e/wait.mjs";
import { imageChatModel } from "./e2e/image-chat-model.mjs";

const root = mkdtempSync(join(tmpdir(), "pi-image-chat-e2e-"));
const dataDir = join(root, "data"),
  project = join(root, "project");
mkdirSync(project);
const evidence = process.env.PI_IMAGE_CHAT_EVIDENCE_DIR;
if (evidence) mkdirSync(evidence, { recursive: true });
const model = imageChatModel();
const server = createServer(model.handler);
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const host = new Host(resolveHostBinary(), dataDir);
await host.start();
await host.call("workspace.set", { path: project });
const { provider } = await host.call("providers.create", {
  name: "本地测试服务",
  vendorKey: "custom",
  type: "openai_compatible",
  protocol: "openai_compatible",
  baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
  authKind: "none",
  defaultModelId: "fixture",
  apiStyle: "chat_completions",
});
await host.call("settings.set", {
  language: "zh-CN",
  defaultProviderId: provider.id,
  defaultModelId: "fixture",
  defaultMode: "agent",
  defaultPermissionMode: "auto",
});
const { provider: imageProvider } = await host.call("providers.create", {
  name: "Image-only fixture", vendorKey: "custom", type: "openai_compatible",
  protocol: "openai_compatible", baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
  authKind: "none", defaultModelId: "fixture", apiStyle: "chat_completions",
});
await host.call("settings.set", { imageGeneration: { providerId: imageProvider.id, modelId: "fixture" } });
await host.stop();

const { appDir, electronBinary } = resolveElectronBinary();
const port = Number(process.env.PI_IMAGE_CHAT_CDP_PORT || 9386);
// CDP viewport emulation only changes the renderer's CSS viewport. It does not
// resize the native window created by the desktop bootstrap (1200x800), so the
// full-size image-chat scenario must keep those dimensions in sync or the
// lower Composer area is laid out below the visible E2E window.
const desktopViewport = { width: 1200, height: 800 };
const env = {
  ...process.env,
  PI_DESKTOP_DATA_DIR: dataDir,
  PI_DESKTOP_START_MAXIMIZED: "0",
  ELECTRON_RENDERER_URL: "",
};
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(
  electronBinary,
  [`--remote-debugging-port=${port}`, `--user-data-dir=${join(root, "profile")}`, "."],
  { cwd: appDir, env, stdio: ["ignore", "pipe", "pipe"] },
);
let output = "";
child.stdout.on("data", (data) => {
  output += data;
});
child.stderr.on("data", (data) => {
  output += data;
});
let ws;
try {
  let target;
  await waitFor(
    async () => {
      try {
        target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(
          (entry) =>
            entry.type === "page" &&
            entry.url.includes("index.html") &&
            !entry.url.includes("plugin-launcher"),
        );
        return !!target;
      } catch {
        return false;
      }
    },
    30_000,
    "desktop CDP target",
  );
  ws = new WebSocket(target.webSocketDebuggerUrl);
  console.log("Desktop target", target.url);
  await once(ws, "open");
  let sequence = 0;
  const pending = new Map();
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data),
      entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
    else entry.resolve(message.result);
  };
  const send = (method, params = {}) =>
    new Promise((resolveCall, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve: resolveCall, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails)
      throw new Error(
        result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails),
      );
    return result.result.value;
  };
  const watchImageContinuity = (rootSelector, imageSelector) => evaluate(`(() => {
    const root = document.querySelector(${JSON.stringify(rootSelector)});
    if (!root) return false;
    window.__imageContinuity = [];
    const sample = () => window.__imageContinuity.push(!!root.querySelector(${JSON.stringify(imageSelector)}));
    window.__imageContinuityObserver = new MutationObserver(sample);
    window.__imageContinuityObserver.observe(root, { childList: true, subtree: true });
    return true;
  })()`);
  const imageStayedVisible = () => evaluate(`(() => {
    window.__imageContinuityObserver.disconnect();
    return window.__imageContinuity;
  })()`);
  const watchViewerSizing = () => evaluate(`(() => {
    const image = document.querySelector('.generated-image-viewer-viewport img');
    if (image?.dataset.sized !== 'true') return false;
    window.__viewerSizing = [];
    window.__viewerSizingObserver = new MutationObserver(() => {
      window.__viewerSizing.push(document.querySelector('.generated-image-viewer-viewport img')?.dataset.sized === 'true');
    });
    window.__viewerSizingObserver.observe(image, { attributes: true, attributeFilter: ['src', 'data-sized', 'style'] });
    return true;
  })()`);
  const viewerStayedSized = () => evaluate(`(() => {
    window.__viewerSizingObserver.disconnect();
    return window.__viewerSizing;
  })()`);
  const invoke = (name, ...args) =>
    evaluate(
      `(async () => { const r = await window.piDesktop.invoke(window.piDesktop.channels.invoke[${JSON.stringify(name)}], ...${JSON.stringify(args)}); if (!r.ok) throw new Error(JSON.stringify(r.error)); return r.data; })()`,
    );
  await send("Page.enable");
  const click = async (text, selector = "button", byLabel = false) => {
    await waitFor(
      () =>
        evaluate(
          `(() => { const e = [...document.querySelectorAll(${JSON.stringify(selector)})].find(e => (${byLabel} ? e.getAttribute('aria-label') : e.textContent.trim()) === ${JSON.stringify(text)}); return !!e && !e.disabled; })()`,
        ),
      5000,
      `enabled ${text}`,
    );
    const point = await evaluate(
      `(() => { const button = [...document.querySelectorAll(${JSON.stringify(selector)})].find(e => (${byLabel} ? e.getAttribute('aria-label') : e.textContent.trim()) === ${JSON.stringify(text)}); if (!button || button.disabled) return null; button.scrollIntoView({block:'nearest'}); const r=button.getBoundingClientRect(), x=r.x+r.width/2, y=r.y+r.height/2; return button.contains(document.elementFromPoint(x,y)) ? {x,y} : null; })()`,
    );
    assert.ok(point, `button hit target: ${text}`);
    await send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      ...point,
      button: "left",
      clickCount: 1,
    });
    await send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      ...point,
      button: "left",
      clickCount: 1,
    });
  };
  const key = async (name, code) => {
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: name, code: name, windowsVirtualKeyCode: code, ...(name === "Enter" ? { text: "\r" } : {}) });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: name, code: name, windowsVirtualKeyCode: code });
  };
  const screenshot = async (name) => {
    if (evidence) {
      const result = await send("Page.captureScreenshot", { format: "png" });
      writeFileSync(join(evidence, name), Buffer.from(result.data, "base64"));
    }
  };
  await send("Emulation.setDeviceMetricsOverride", { ...desktopViewport, deviceScaleFactor: 1, mobile: false });
  const viewportBounds = await evaluate(
    `({ innerWidth: window.innerWidth, innerHeight: window.innerHeight, outerWidth: window.outerWidth, outerHeight: window.outerHeight })`,
  );
  assert.ok(
    viewportBounds.innerWidth <= viewportBounds.outerWidth &&
      viewportBounds.innerHeight <= viewportBounds.outerHeight,
    `desktop E2E viewport exceeds native window: ${JSON.stringify(viewportBounds)}`,
  );
  await waitFor(() => evaluate(`!!document.querySelector('[data-nav="settings"]') && !document.querySelector('.startup-splash')`),30000,"desktop ready");
  await evaluate(`document.querySelector('[data-nav="settings"]').click()`);
  await waitFor(() => evaluate(`!![...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='AI')`),10000,"AI settings");
  await click("AI");
  await click("模型");
  await waitFor(() => evaluate(`!!document.querySelector('.model-default-row')`),10000,"model defaults");
  const gap = await evaluate(`(() => {const rows=[...document.querySelectorAll('.settings-row')];const image=rows.find(e=>e.innerText.includes('生图模型'));return image.getBoundingClientRect().top-document.querySelector('.model-default-row').getBoundingClientRect().bottom})()`);
  await screenshot("settings.png");
  assert.ok(gap>=11 && gap<=13, `defaults gap ${gap}px`);
  await evaluate(`document.querySelector('.model-default-trigger').click()`);
  await waitFor(() => evaluate(`!!document.querySelector('.model-default-option')`),5000,"default option ready");
  await evaluate(`document.querySelector('.model-default-option').click()`);
  await waitFor(() => evaluate(`document.body.innerText.includes('默认 AI 服务已更新')`),5000,"settings save success feedback");
  await waitFor(async () => (await invoke("settingsGet")).infiniteProviderRetry === false,5000,"normalized settings save round trip");
  assert.ok(await evaluate(`!document.body.innerText.includes('infiniteProviderRetry is invalid')`));
  await click("返回应用");
  await evaluate(`document.querySelector('.composer-model-thinking-chip').click()`);
  await waitFor(() => evaluate(`!!document.querySelector('.composer-menu-entry')`),5000,"composer model root");
  await evaluate(`document.querySelector('.composer-menu-entry').click()`);
  await waitFor(() => evaluate(`document.querySelectorAll('.composer-model-option').length>0`),5000,"composer model options");
  assert.equal(await evaluate(`document.querySelectorAll('.composer-model-option').length`),1,"image-only provider must not be a chat candidate");
  assert.ok(await evaluate(`![...document.querySelectorAll('.composer-model-group-label')].some(e=>e.textContent.includes('Image-only fixture'))`));
  await key("Escape",27);
  await key("Escape",27);
  const prompt = async (content) => {
    await waitFor(() => evaluate(`!!document.querySelector('.composer-input[contenteditable="true"]')`),10000,"composer ready");
    await evaluate(`document.querySelector('.composer-input').focus()`);
    await send("Input.insertText",{text:content});
    await key("Enter",13);
  };
  await prompt("请生成两张橙色球体、蓝色背景的图片。");
  await waitFor(() => evaluate(`document.querySelectorAll('.generated-image-preview img').length===1 && document.querySelector('.generated-image-preview img')?.naturalWidth===480 && [...document.querySelectorAll('.generated-image-thumbnails img')].length===2 && document.body.innerText.includes('已生成两张图片')`),60000,"batch images decoded in chat");
  assert.ok(await evaluate(`document.querySelector('.generated-image-preview img')?.checkVisibility() && !document.querySelector('.generated-image-set')?.closest('[inert]')`), "selected image remains visible outside collapsed tool details");
  assert.equal(await evaluate(`document.querySelectorAll('.generated-image-thumbnails button').length`),2);
  assert.equal(await evaluate(`document.querySelectorAll('.generated-image-thumbnails button[aria-current="true"]').length`),1);
  const downloadDir = join(root, "downloads");
  mkdirSync(downloadDir);
  await send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: downloadDir });
  assert.ok(await evaluate(`document.querySelector('.generated-image-actions a[download="generated-image-1.png"]')?.href.startsWith('data:image/png;base64,')`));
  await click("下载", ".generated-image-actions a", true);
  const downloadedImage = join(downloadDir, "generated-image-1.png");
  const originalImage = model.results[0].value.results[0].path;
  await waitFor(() => existsSync(downloadedImage) && statSync(downloadedImage).size === statSync(originalImage).size,10000,"generated image download");
  assert.deepEqual(readFileSync(downloadedImage),readFileSync(originalImage));
  await screenshot("chat-batch.png");
  await send("Emulation.setDeviceMetricsOverride", {width:700,height:700,deviceScaleFactor:1,mobile:false});
  await waitFor(() => evaluate(`innerWidth === 700`),5000,"narrow chat viewport");
  await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
  await screenshot("chat-batch-narrow.png");
  assert.ok(await evaluate(`document.querySelector('.generated-image-thumbnails')?.getBoundingClientRect().right <= innerWidth`),"batch thumbnails stay inside narrow window");
  await send("Emulation.setDeviceMetricsOverride", { ...desktopViewport, deviceScaleFactor: 1, mobile: false });
  assert.ok(await watchImageContinuity('.generated-image-set', '.generated-image-preview img'));
  await click("生成图片 2", ".generated-image-thumbnails button", true);
  await waitFor(() => evaluate(`(() => {const selected=document.querySelectorAll('.generated-image-thumbnails button')[1];const featured=document.querySelector('.generated-image-preview img');return selected?.getAttribute('aria-current')==='true' && featured?.naturalWidth===480 && featured.src===selected.querySelector('img')?.src})()`),5000,"second image selected in chat");
  const cardContinuity = await imageStayedVisible();
  assert.ok(cardContinuity.every(Boolean), `batch image remains painted while switching selection: ${JSON.stringify(cardContinuity)}`);
  assert.ok(await evaluate(`document.querySelector('.generated-image-actions a[download="generated-image-2.png"]')?.href.startsWith('data:image/png;base64,')`));
  await click("下载", ".generated-image-actions a", true);
  const secondDownload = join(downloadDir, "generated-image-2.png");
  const secondOriginal = model.results[0].value.results[1].path;
  await waitFor(() => existsSync(secondDownload) && statSync(secondDownload).size === statSync(secondOriginal).size,10000,"selected image download");
  assert.deepEqual(readFileSync(secondDownload),readFileSync(secondOriginal));
  await screenshot("chat-batch-selected-2.png");
  await click("生成图片 2", ".generated-image-preview", true);
  await waitFor(() => evaluate(`!!document.querySelector('.generated-image-viewer[open]')`),5000,"image viewer opens");
  assert.equal(await evaluate(`document.querySelectorAll('.generated-image-viewer-thumb').length`),2);
  assert.ok(await evaluate(`document.querySelectorAll('.generated-image-viewer-thumb')[1]?.getAttribute('aria-current') === 'true'`));
  assert.ok(await evaluate(`!!document.querySelector('.generated-image-viewer-header-actions button[aria-label="在文件夹中显示"]')`));
  await waitFor(() => evaluate(`document.querySelector('.generated-image-viewer-viewport img')?.dataset.sized === 'true'`),5000,"viewer image sized");
  await evaluate(`(() => {
    const target = document.querySelectorAll('.generated-image-viewer-thumb img')[0];
    const originalDecode = HTMLImageElement.prototype.decode;
    HTMLImageElement.prototype.decode = function () {
      if (this === target) return new Promise((resolve) => { window.__releaseViewerDecode = resolve; });
      return originalDecode.call(this);
    };
    window.__restoreViewerDecode = () => { HTMLImageElement.prototype.decode = originalDecode; };
  })()`);
  await evaluate(`document.querySelectorAll('.generated-image-viewer-thumb')[0].click()`);
  await waitFor(() => evaluate(`typeof window.__releaseViewerDecode === 'function'`),5000,"pending viewer decode");
  await evaluate(`document.querySelectorAll('.generated-image-viewer-thumb')[1].click()`);
  await evaluate(`window.__restoreViewerDecode(); window.__releaseViewerDecode()`);
  await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
  assert.ok(await evaluate(`document.querySelectorAll('.generated-image-viewer-thumb')[1].getAttribute('aria-current') === 'true'`), "reselecting the current image cancels a pending decode");
  assert.ok(await watchImageContinuity('.generated-image-viewer-viewport', 'img'));
  assert.ok(await watchViewerSizing());
  await click("上一张图片", ".generated-image-viewer-navigation button", true);
  await waitFor(() => evaluate(`document.querySelectorAll('.generated-image-viewer-thumb')[0]?.getAttribute('aria-current') === 'true'`),5000,"first thumbnail selected");
  const viewerContinuity = await imageStayedVisible();
  assert.ok(viewerContinuity.every(Boolean), `viewer image remains painted while switching selection: ${JSON.stringify(viewerContinuity)}`);
  const viewerSizing = await viewerStayedSized();
  assert.ok(viewerSizing.length > 0 && viewerSizing.every(Boolean), `viewer image stays fitted while switching selection: ${JSON.stringify(viewerSizing)}`);
  await evaluate(`document.querySelector('.generated-image-viewer-header button').focus()`);
  await key("ArrowRight",39);
  await waitFor(() => evaluate(`document.querySelectorAll('.generated-image-viewer-thumb')[1]?.getAttribute('aria-current') === 'true'`),5000,"second thumbnail selected");
  assert.ok(await evaluate(`(() => {const image=document.querySelector('.generated-image-viewer-viewport img');const thumb=document.querySelectorAll('.generated-image-viewer-thumb')[1]?.querySelector('img');return !image || image.src === thumb?.src})()`),"viewer never shows a stale selected image");
  await waitFor(() => evaluate(`(() => {const thumb=document.querySelectorAll('.generated-image-viewer-thumb')[1];const image=document.querySelector('.generated-image-viewer-viewport img');return thumb?.getAttribute('aria-current') === 'true' && image?.naturalWidth === 480 && image.src === thumb.querySelector('img')?.src})()`),5000,"viewer navigates to second image");
  await click("放大", ".generated-image-viewer-zoom button", true);
  await waitFor(() => evaluate(`document.querySelector('.generated-image-viewer-zoom output')?.textContent === '125%'`),5000,"viewer zooms in");
  await screenshot("image-viewer.png");
  await send("Emulation.setDeviceMetricsOverride", {width:600,height:700,deviceScaleFactor:1,mobile:false});
  await waitFor(() => evaluate(`getComputedStyle(document.querySelector('.generated-image-viewer-thumbs')).flexDirection === 'row'`),5000,"narrow viewer thumbnail layout");
  assert.ok(await evaluate(`document.querySelector('.generated-image-viewer-header-actions a')?.getBoundingClientRect().right <= innerWidth`),"download stays reachable in narrow viewer");
  await screenshot("image-viewer-narrow.png");
  await send("Emulation.setDeviceMetricsOverride", { ...desktopViewport, deviceScaleFactor: 1, mobile: false });
  await key("Escape",27);
  await waitFor(() => evaluate(`!document.querySelector('.generated-image-viewer')`),5000,"image viewer closes");
  assert.ok(await evaluate(`document.activeElement?.classList.contains('generated-image-preview')`),"viewer restores card focus");
  assert.ok(await evaluate(`document.querySelectorAll('.generated-image-thumbnails button')[1]?.getAttribute('aria-current') === 'true'`),"viewer selection stays selected in chat");
  const source = model.results[0].value.results[0].path;
  const sourceBytes = readFileSync(source);
  assert.equal(model.imageRequests.length,2);
  model.setScenario("edit");
  await prompt("把第一张图片背景改成绿色，保留橙色球体和原图。");
  await waitFor(() => evaluate(`document.querySelectorAll('.generated-image-preview img').length===2 && [...document.querySelectorAll('.generated-image-preview img')].every(e=>e.naturalWidth===480) && document.body.innerText.includes('已将第一张图的背景改为绿色')`),60000,"edited image decoded in chat");
  await waitFor(() => evaluate(`!document.querySelector('.assistant-turn.streaming')`),10000,"turn completed");
  await evaluate(`document.querySelectorAll('.turn-process > button[aria-expanded="true"]').forEach(e=>e.click())`);
  await evaluate(`Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))`);
  assert.ok(await evaluate(`[...document.querySelectorAll('.generated-image-preview img')].every(e=>e.checkVisibility() && !e.closest('[inert]'))`), "collapse preserves generated and edited previews");
  await evaluate(`[...document.querySelectorAll('.message-row.user')].at(-1)?.scrollIntoView({block:'start'})`);
  await screenshot("chat-edit.png");
  assert.equal(model.imageRequests.length,3);
  assert.ok(model.imageRequests[2].edited);
  assert.deepEqual(readFileSync(source),sourceBytes,"editing preserves the original file");
  assert.notEqual(model.results[1].value.results[0].path,source,"editing creates a new file");
  await invoke("settingsSet", {...await invoke("settingsGet"),imageGeneration:null});
  model.setScenario("unset");
  await prompt("再生成一张图片。");
  await waitFor(() => evaluate(`!![...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='配置生图模型' && e.checkVisibility())`),60000,"visible setup action");
  await waitFor(() => evaluate(`!document.querySelector('.stop-btn') && document.body.innerText.includes('请先到模型设置选择生图模型，再重试。')`),10000,"configuration error turn completed");
  await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
  await screenshot("chat-unconfigured.png");
  await click("配置生图模型");
  await waitFor(() => evaluate(`!!document.querySelector('.model-default-row')`),10000,"setup action opens model settings");
  assert.equal(model.imageRequests.length,3,"unconfigured generation makes no image request");
  assert.deepEqual(model.failures,[]);
  console.log(JSON.stringify({ok:true,gap,scenarios:["image-excluded-from-composer","settings-spacing","composer-batch-generation","result-download","composer-edit-generated-image","collapsed-previews","unconfigured-setup-navigation"],imageRequests:model.imageRequests,evidence}));
} catch (error) {
  console.error("MODEL_FIXTURE_ERRORS",JSON.stringify(model.failures));
  console.error(output.slice(-4000));
  throw error;
} finally {
  ws?.close();
  child.kill();
  server.close();
}
