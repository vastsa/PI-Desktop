import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { GEN_UI_MAX_FRAGMENT_BYTES } from "@pi-desktop/shared";
import { app, BrowserWindow, protocol, session } from "electron";
import {
  GEN_UI_SCHEME_PRIVILEGES, resolveGenUiRequest, genUiResponse,
  resolveGenUiAssetRequest, genUiAssetResponse,
} from "../../apps/desktop/electron/main/gen-ui-protocol.ts";
import { genUiAssetFileFromUrl, loadGenUiKit } from "../../apps/desktop/electron/main/gen-ui-kit.ts";
import { installLiveMicrophonePermissionHandlers } from "../../apps/desktop/electron/main/live-voice/microphone-permissions.ts";
import { createGenUiFragmentReader } from "../../apps/desktop/electron/main/gen-ui-files.ts";

const root = process.env.PI_GEN_UI_E2E_ROOT;
const directory = process.env.PI_GEN_UI_E2E_DIR;
if (!root || !directory) throw new Error("GenUI E2E fixture paths are required");
const dataDir = join(directory, "data");
app.setPath("userData", join(directory, "profile"));
app.commandLine.appendSwitch("disable-background-networking");
protocol.registerSchemesAsPrivileged([GEN_UI_SCHEME_PRIVILEGES]);
let nativeHost;
process.once("exit", () => nativeHost?.child?.kill());

async function run() {
  const { Host, resolveHostBinary } = await import(pathToFileURL(join(root, "scripts/e2e/host.mjs")).href);
  nativeHost = new Host(resolveHostBinary(), dataDir, { quiet: true });
  await nativeHost.start();
  const readFragment = createGenUiFragmentReader(() => nativeHost);
  const networkRequests = [];
  const server = createServer((request, response) => {
    networkRequests.push(request.url);
    response.end("unexpected network access");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const localUrl = `http://127.0.0.1:${address.port}/blocked`;
  const fragment = `<div><input id="slider" type="range" min="0" max="20" value="5"><output id="value"></output></div>
<script src="https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js"></script>
<script>const slider=document.getElementById('slider');const update=()=>d3.select('#value').text(slider.value);slider.addEventListener('input',update);update();window.fixtureValue=()=>document.getElementById('value').textContent;fetch(${JSON.stringify(localUrl)}).then(()=>{window.fixtureNetworkBlocked=false},()=>{window.fixtureNetworkBlocked=true});parent.postMessage({type:'fixture:loaded'},'*');</script>`;
  const sessionDir = join(dataDir, "visualizations", "probe_session");
  await mkdir(sessionDir, { recursive: true });
  for (let index = 0; index < 8; index += 1) await writeFile(join(sessionDir, `chart${index}.html`), fragment);
  await mkdir(join(dataDir, "visualizations", "victim"), { recursive: true });
  await writeFile(join(dataDir, "visualizations", "victim", "secret.html"),
    "<p>CROSS_SESSION_PRIVATE_MARKER</p><script>parent.postMessage({type:'fixture:loaded'},'*')</script>");
  await writeFile(join(sessionDir, "attacker.html"), `<p>attacker</p><script>addEventListener('message',event=>{if(event.data!=='attack')return;try{parent.postMessage({type:'cross-read',stolen:parent.frames[1].document.querySelector('p').textContent},'*')}catch(error){parent.postMessage({type:'cross-read',error:error.name},'*')}});parent.postMessage({type:'fixture:loaded'},'*')</script>`);
  await writeFile(join(sessionDir, "limit.html"), Buffer.alloc(GEN_UI_MAX_FRAGMENT_BYTES, 0x20));
  const limit = await readFragment({ sessionId: "probe_session", fileName: "limit.html" });
  assert.equal(limit.ok, true);
  assert.equal(limit.fragment.length, GEN_UI_MAX_FRAGMENT_BYTES);
  await writeFile(join(sessionDir, "limit.html"), Buffer.alloc(GEN_UI_MAX_FRAGMENT_BYTES + 1, 0x20));
  assert.deepEqual(await readFragment({ sessionId: "probe_session", fileName: "limit.html" }), { ok: false, status: 413, code: "too-large" });

  await app.whenReady();
  const kit = await loadGenUiKit(join(root, "apps/desktop/resources/gen-ui"));
  const loadKit = async () => kit;
  protocol.handle("pi-genui", async (request) => genUiAssetFileFromUrl(request.url)
    ? genUiAssetResponse(await resolveGenUiAssetRequest({ method: request.method, url: request.url, loadKit }))
    : genUiResponse(await resolveGenUiRequest({ method: request.method, url: request.url, readFragment, loadKit })));
  const window = new BrowserWindow({
    show: false, width: 900, height: 700,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  installLiveMicrophonePermissionHandlers({ targetSession: session.defaultSession, getMainWindow: () => window, hasReservation: () => false });
  const host = async (expression) => {
    try { return await window.webContents.executeJavaScript(expression); }
    catch (error) { throw new Error(`Host probe ${expression}: ${error.message}`, { cause: error }); }
  };
  const guests = () => window.webContents.mainFrame.framesInSubtree.filter((frame) => frame.url.startsWith("pi-genui://session/"));
  const message = (index) => `Chart\n::visualize${JSON.stringify({ path: join(sessionDir, `chart${index}.html`), title: `Chart ${index}` })}`;
  const checks = [];
  checks.push("real native Host reads bounded two-megabyte fragments");
  const timeout = setTimeout(() => { console.error("GenUI E2E timed out"); app.exit(1); }, 90_000);
  try {
    await window.loadFile(join(directory, "index.html"));
    await host("window.genUiProbe.ready");
    await host(`window.genUiProbe.mount(${JSON.stringify(message(0))},true)`);
    assert.equal(await host('document.querySelectorAll("iframe").length'), 0);
    assert.equal(await host('document.getElementById("prose").textContent'), "Chart");
    checks.push("streaming reference hidden");

    await host(`window.genUiProbe.mount(${JSON.stringify(message(0))});window.genUiProbe.waitLoaded(1)`);
    const inline = guests()[0];
    assert.equal(await inline.executeJavaScript("d3.version"), "7.9.0");
    // The `viz` helpers are preloaded and draw a container-sized chart.
    assert.equal(
      await inline.executeJavaScript(
        '(async()=>{const el=document.createElement("div");el.style.width="300px";document.body.append(el);viz.chart(el,({svg,width})=>svg.append("rect").attr("width",width),{label:"probe"});await Promise.resolve();return el.querySelector("svg").getAttribute("viewBox")})()',
      ),
      "0 0 300 240",
    );
    // A declarative `viz.render` spec draws marks, axes, and a legend.
    assert.equal(
      await inline.executeJavaScript(
        '(async()=>{const el=document.createElement("div");el.style.width="400px";document.body.append(el);viz.render(el,{mark:"bar",data:[{k:"a",v:1,s:"x"},{k:"b",v:2,s:"y"}],x:"k",y:"v",color:"s",label:"probe"});await Promise.resolve();return [el.querySelectorAll("rect").length,el.querySelectorAll(".viz-axis").length>0,el.querySelectorAll(".viz-legend-item").length].join()})()',
      ),
      "2,true,2",
    );
    assert.equal(await host('document.querySelector("iframe").getAttribute("sandbox")'), "allow-scripts");
    await inline.executeJavaScript('document.getElementById("slider").value="17";document.getElementById("slider").dispatchEvent(new Event("input",{bubbles:true}));');
    assert.equal(await inline.executeJavaScript("window.fixtureValue()"), "17");
    assert.equal(await inline.executeJavaScript("window.fixtureNetworkBlocked"), true);
    checks.push("bundled D3 and slider work; network fetch denied");

    await host('document.documentElement.dataset.theme="dark";document.documentElement.style.setProperty("--ds-text-primary","rgb(9, 8, 7)");');
    await inline.executeJavaScript('new Promise((resolve,reject)=>{const deadline=performance.now()+10000;const check=()=>{if(document.documentElement.style.getPropertyValue("--color-text-primary")==="rgb(9, 8, 7)")return resolve(true);if(performance.now()>deadline)return reject(new Error("theme timeout"));requestAnimationFrame(check);};check();})');
    checks.push("theme updates without guest reload");

    await host('document.querySelector(".gen-ui-card .gen-ui-action").click();window.genUiProbe.waitLoaded(2)');
    assert.equal(await host('document.querySelectorAll("[role=dialog]").length'), 1);
    const expanded = guests().at(-1);
    await expanded.executeJavaScript('document.body.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));');
    await host('window.genUiProbe.wait(()=>!document.querySelector("[role=dialog]"),"guest Escape closes dialog")');
    assert.equal(await inline.executeJavaScript("window.fixtureValue()"), "17");
    checks.push("expand and guest Escape preserve inline state");

    await host('window.scrollTo(0,4000);window.genUiProbe.wait(()=>document.querySelectorAll("iframe").length===0,"release offscreen")');
    await host("window.scrollTo(0,0);window.genUiProbe.waitLoaded(1)");
    checks.push("offscreen release and automatic reload");
    await host(`window.genUiProbe.mount(${JSON.stringify(message(0))},false,true)`);
    assert.equal(await host('document.querySelectorAll("iframe").length'), 0);
    assert.equal(await host('!!document.querySelector(".is-unavailable")'), true);
    const missing = message(0).replace("chart0.html", "missing.html");
    await host(`window.genUiProbe.mount(${JSON.stringify(missing)});window.genUiProbe.wait(()=>!!document.querySelector(".is-unavailable"),"missing error shell")`);
    checks.push("remote and missing files show unavailable cards");

    window.setContentSize(900, 2600);
    const all = Array.from({ length: 8 }, (_, index) => message(index)).join("\n");
    await host(`window.genUiProbe.mount(${JSON.stringify(all)});window.genUiProbe.waitLoaded(8)`);
    const retained = guests()[0];
    await retained.executeJavaScript('document.getElementById("slider").value="19";document.getElementById("slider").dispatchEvent(new Event("input",{bubbles:true}));');
    await host('document.querySelector(".gen-ui-card .gen-ui-action").click();window.genUiProbe.wait(()=>!!document.querySelector("[role=dialog] iframe"),"expanded frame mounts").then(()=>window.genUiProbe.waitLoaded(8))');
    assert.equal(await host('document.querySelectorAll("iframe").length'), 8, "expanded frame must share the global quota");
    assert.equal(await host("window.genUiProbe.poolSize()"), 8);
    assert.equal(await retained.executeJavaScript("window.fixtureValue()"), "19", "quota eviction must retain the source inline frame");
    assert.equal(await host('document.querySelectorAll("[role=dialog]").length'), 1);
    checks.push("expanded frame shares eight-frame quota and retains source state");

    await host("window.genUiProbe.unmount()");
    assert.equal(await host("window.genUiProbe.poolSize()"), 0);
    assert.equal(await host('document.querySelectorAll("iframe").length'), 0);
    checks.push("unmount releases all frame slots");

    // Use intentionally unsandboxed callers, as a renderer plugin can. The
    // response itself must force distinct opaque origins between sessions.
    await host('for(const [id,url] of [["attacker","pi-genui://session/probe_session/attacker.html"],["victim","pi-genui://session/victim/secret.html"]]){const frame=document.createElement("iframe");frame.id=id;frame.src=url;document.body.appendChild(frame)};window.genUiProbe.waitLoaded(2)');
    await host('document.getElementById("attacker").contentWindow.postMessage("attack","*");window.genUiProbe.wait(()=>window.genUiProbe.messages.some(message=>message?.type==="cross-read"),"cross-frame sandbox result")');
    const crossRead = await host('window.genUiProbe.messages.find(message=>message?.type==="cross-read")');
    assert.equal(crossRead.error, "SecurityError");
    assert.equal(crossRead.stolen, undefined);
    checks.push("response sandbox rejects cross-session DOM read without caller sandbox");
    assert.deepEqual(networkRequests, []);
    window.destroy();
    clearTimeout(timeout);
    server.close();
    await nativeHost.stop();
    process.stdout.write(`GENUI_E2E ${JSON.stringify({ ok: true, checks })}\n`, () => app.exit(0));
  } catch (error) {
    clearTimeout(timeout);
    server.close();
    window.destroy();
    await nativeHost.stop();
    throw error;
  }
}

run().catch(async (error) => { await nativeHost?.stop(); console.error(error.stack || error); app.exit(1); });
