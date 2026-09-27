/** Real React interaction tests in an isolated headless browser; only IPC is stubbed. */
import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const chrome = process.env.CHROME_BIN ?? [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome",
].find(existsSync);
const root = fileURLToPath(new URL("..", import.meta.url));

// This fixture imports the real UI, primitives, translations, hooks, and API
// facade. No provider calls, web payments, or desktop profile are used.
const fixture = `
import React, {act} from 'react';
import {createRoot} from 'react-dom/client';
import i18n from 'i18next';
import {I18nextProvider} from 'react-i18next';
import {catalogs} from '@pi-desktop/i18n';
import {IPC, AI_PLATFORM_BASE_URL, AI_PLATFORM_VENDOR_KEY, bindingForCustomModel} from '@pi-desktop/shared';
import {PlatformAccountCard} from '${root}/src/components/settings/PlatformAccountCard.tsx';
import {ProviderSetupDialog} from '${root}/src/components/settings/ProviderSetupDialog.tsx';
window.IS_REACT_ACT_ENVIRONMENT = true;
window.fixtureReady = (async () => {
  await i18n.init({lng:'en', resources:Object.fromEntries(Object.entries(catalogs).map(([id, catalog]) => [id,{translation:catalog}]))});
  const errors=[];
  const root = createRoot(document.getElementById('root'),{onUncaughtError(error){errors.push(error.stack)}});
  const calls = [], pending = [];
  let saved, configureCount = 0, linkFails = false;
  const provider = (id, patch={}) => ({id,name:id,vendorKey:AI_PLATFORM_VENDOR_KEY,baseUrl:AI_PLATFORM_BASE_URL,
    authKind:'api_key_and_base_url',apiStyle:'chat_completions',enabled:true,hasSecret:true,
    models:[bindingForCustomModel('chat-model')],defaultModelId:'chat-model',updatedAt:'fixture',...patch});
  window.piDesktop = { invoke: async (channel,...args) => {
    calls.push({channel,args});
    if(channel === IPC.invoke.platformTokenUsage) return new Promise(resolve=>pending.push({id:args[0],resolve}));
    if(channel === IPC.invoke.browserOpenExternal && linkFails) return {ok:false,error:{message:'fixture open failure'}};
    if(channel === IPC.invoke.providersListModels) return {ok:true,data:{source:'remote',models:[{modelId:'chat-model',displayName:'Chat Model',providerId:AI_PLATFORM_VENDOR_KEY,capabilities:['text','tools'],source:'discovered',contextWindow:32000,maxTokens:4000}]}};
    if(channel === IPC.invoke.providersCreate || channel === IPC.invoke.providersUpdate) return {ok:true,data:{provider:provider('saved',args[0])}};
    return {ok:true,data:{}};
  }};
  const render = (element) => root.render(React.createElement(I18nextProvider,{i18n},element));
  const dialog = (props={}) => render(React.createElement(ProviderSetupDialog,{onClose(){},onSaved(value){saved=value},...props}));
  window.fixture = {
    async card(rows, locale='en') { await act(async()=>{await i18n.changeLanguage(locale);render(React.createElement(PlatformAccountCard,{providers:rows.map(([id,patch])=>provider(id,patch)),onConfigure(){configureCount++;dialog()}}))}); },
    async dialog(props={}) {await act(async()=>dialog(props));},
    async edit(id,patch={}) {await act(async()=>dialog({provider:provider(id,patch)}));},
    async unmount() {await act(async()=>render(null));},
    async click(label) {const target=[...document.querySelectorAll('button')].find(el=>el.textContent.trim()===label || el.getAttribute('aria-label')===label);if(!target)throw new Error('Missing button '+label);await act(async()=>target.click());},
    async fill(selector,value) {const el=document.querySelector(selector);if(!el)throw new Error('Missing input '+selector);await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}))});},
    async settle(index,usage,error=false) {await act(async()=>pending[index].resolve(error?{ok:false,error:{message:'secret-do-not-render'}}:{ok:true,data:usage}));},
    linkFailure(value){linkFails=value;},
    state(){return {text:document.documentElement.textContent,errors,calls,pending:pending.map(p=>p.id),saved,configureCount,
      buttons:[...document.querySelectorAll('button')].map(el=>({text:el.textContent.trim(),label:el.getAttribute('aria-label'),disabled:el.disabled})),
      chosen:[...document.querySelectorAll('.provider-chosen-row-id')].map(el=>el.textContent.trim()),
      inputs:[...document.querySelectorAll('input')].map(el=>({type:el.type,value:el.value}))};}
  };
})();`;

class BrowserProtocol {
  constructor(socket) {
    this.socket = socket;
    this.sequence = 0;
    this.requests = new Map();
    socket.addEventListener("message", ({ data }) => {
      const message = JSON.parse(data);
      const pending = this.requests.get(message.id);
      if (!pending) return;
      this.requests.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }
  event(method) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { this.socket.removeEventListener("message", listener); reject(new Error(`Timed out waiting for ${method}`)); }, 15000);
      const listener = ({ data }) => {
        const message = JSON.parse(data);
        if (message.method !== method) return;
        this.socket.removeEventListener("message", listener);
        clearTimeout(timeout);
        resolve(message.params);
      };
      this.socket.addEventListener("message", listener);
    });
  }
  send(method, params = {}) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { this.requests.delete(id); reject(new Error(`Browser protocol timeout: ${method}`)); }, 15000);
      this.requests.set(id, { resolve, reject, timeout });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
}

test("platform onboarding, token selection, refresh, and provider setup work through real controls", {
  skip: !chrome && "Set CHROME_BIN to run isolated browser interactions", timeout: 90000,
}, async (t) => {
  const output = await build({
    root, configFile: false, logLevel: "error", define: { "process.env.NODE_ENV": '"development"' }, esbuild: { jsx: "automatic" },
    plugins: [{ name: "platform-settings-fixture", resolveId(id) { if (id === "virtual:platform-settings") return id; }, load(id) { if (id === "virtual:platform-settings") return fixture; } }],
    build: { write: false, minify: false, rollupOptions: { input: "virtual:platform-settings", output: { format: "iife", inlineDynamicImports: true } } },
  });
  const script = output.output.find((entry) => entry.type === "chunk").code;
  const http = createServer((req, res) => {
    res.setHeader("Content-Type", req.url === "/fixture.js" ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8");
    res.end(req.url === "/fixture.js" ? script : '<div id="root"></div><script src="/fixture.js"></script>');
  });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  const profile = await mkdtemp(join(tmpdir(), "pi-platform-settings-"));
  let child;
  let socket;
  t.after(async () => {
    socket?.close();
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      const force = setTimeout(() => child.kill("SIGKILL"), 5000);
      child.kill();
      await exited.finally(() => clearTimeout(force));
    }
    http.closeAllConnections();
    await new Promise((resolve) => http.close(resolve));
    await rm(profile, { recursive: true, force: true });
  });
  child = spawn(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  const endpoint = await new Promise((resolve, reject) => {
    let stderr = "";
    const timeout = setTimeout(() => reject(new Error("Chrome startup timed out")), 15000);
    child.once("exit", () => clearTimeout(timeout));
    child.on("error", reject);
    child.on("exit", (code) => reject(new Error(`Chrome exited ${code}: ${stderr}`)));
    child.stderr.on("data", (data) => { stderr += data; const found = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (found) { clearTimeout(timeout); resolve(found[1]); } });
  });
  const debugOrigin = new URL(endpoint).origin.replace("ws:", "http:");
  const page = await (await fetch(`${debugOrigin}/json/new?about:blank`, { method: "PUT", signal: AbortSignal.timeout(15000) })).json();
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
  const browser = new BrowserProtocol(socket);
  await browser.send("Page.enable");
  const loaded = browser.event("Page.loadEventFired");
  await browser.send("Page.navigate", { url: `http://127.0.0.1:${http.address().port}` });
  await loaded;
  await browser.evaluate("window.fixtureReady");
  const run = (method, ...args) => browser.evaluate(`window.fixture.${method}(${args.map(value => JSON.stringify(value)).join(",")})`);
  const state = () => run("state");
  const usage = { totalGranted: 1200, totalUsed: 200, totalAvailable: 1000, unlimited: false, unit: "quota" };

  await run("card", [["disabled", { enabled: false }], ["other", { vendorKey: "openai" }], ["empty", { hasSecret: false }]]);
  assert.deepEqual((await state()).pending, []);
  assert.match((await state()).text, /Enable a platform provider/);
  await run("click", "Register / Sign in");
  await run("click", "Wallet / Recharge");
  assert.deepEqual((await state()).calls.map(call => call.args[0]), [{ url: "https://ai.yykkj.com" }, { url: "https://ai.yykkj.com/wallet" }]);
  await run("linkFailure", true);
  await run("click", "Wallet / Recharge");
  assert.match((await state()).text, /Could not open the website/);

  await run("card", [["first"], ["second"]]);
  assert.deepEqual((await state()).pending, []);
  await run("click", "Token provider");
  await run("click", "first");
  assert.deepEqual((await state()).pending, ["first"]);
  await run("click", "Token provider");
  await run("click", "second");
  await run("settle", 1, usage);
  assert.match((await state()).text, /1,000 quota units/);
  assert.doesNotMatch((await state()).text, /USD/);
  await run("settle", 0, { ...usage, totalAvailable: 8888 });
  assert.doesNotMatch((await state()).text, /8,888/);
  await run("click", "Refresh allowance");
  await run("settle", 2, null, true);
  assert.match((await state()).text, /Could not load token allowance/);
  assert.doesNotMatch((await state()).text, /secret-do-not-render|1,000 quota units/);
  await run("click", "Refresh allowance");
  await run("settle", 3, { ...usage, unlimited: true, unit: "USD", totalUsed: 0.125 });
  assert.match((await state()).text, /Unlimited token allowance/);
  assert.match((await state()).text, /USD/);
  assert.match((await state()).text, /not your account wallet balance/);
  await run("card", [["second", { enabled: false }]]);
  assert.doesNotMatch((await state()).text, /Unlimited token allowance/);

  for (const [locale, expected] of [["zh-CN", /平台账户与 API 令牌/], ["zh-TW", /平台帳戶與 API 權杖/]]) {
    await run("card", [], locale);
    assert.match((await state()).text, expected);
    assert.doesNotMatch((await state()).text, /settings\./);
  }
  await run("card", []);
  await run("click", "Configure API token");
  assert.equal((await state()).configureCount, 1);
  assert.match((await state()).text, /https:\/\/ai.yykkj.com\/v1/);
  assert.doesNotMatch((await state()).text, /Custom endpoint|Change service|Sign in with/);
  assert.equal((await state()).inputs.some(input => input.type === "url"), false);
  assert.equal((await state()).buttons.find(button => button.text === "Save provider").disabled, true);
  assert.deepEqual((await state()).chosen, ["gpt-image-2.5-flare", "gpt-image-2.5-sunburst", "MiniMax-H3"]);
  assert.match((await state()).text, /No separate setup is needed/);
  assert.equal((await state()).buttons.filter(button => button.label === "Remove model").every(button => button.disabled), true);
  await run("fill", 'input[type="password"]', "fixture-token");
  // The existing discovery hook is debounced. Wait for its observable model
  // state via MutationObserver rather than sleeping for an arbitrary interval.
  const waitForSave = () => browser.evaluate(`new Promise((resolve,reject)=>{const deadline=setTimeout(()=>reject(new Error(JSON.stringify(window.fixture.state()))),8000);const ready=()=>window.fixture.state().chosen.includes('chat-model')&&[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Save provider'&&!b.disabled);if(ready()){clearTimeout(deadline);return resolve();}const observer=new MutationObserver(()=>{if(ready()){observer.disconnect();clearTimeout(deadline);resolve()}});observer.observe(document.documentElement,{subtree:true,childList:true,attributes:true})})`);
  await waitForSave();
  await run("click", "API format");
  const formats = (await state()).text;
  assert.match(formats, /Responses/);
  assert.doesNotMatch(formats, /Google|Codex Responses|OpenCode Go/);
  await run("click", "OpenAI Responses");
  await waitForSave();
  await run("click", "Save provider");
  const saved = (await state()).saved;
  assert.equal(saved.baseUrl, "https://ai.yykkj.com/v1");
  assert.equal(saved.vendorKey, "ai-aggregation-platform");
  assert.equal(saved.secretValue, "fixture-token");
  assert.equal(saved.apiStyle, "responses");
  assert.deepEqual(saved.models.map(model => model.id), ["chat-model", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst", "MiniMax-H3"]);
  assert.equal(saved.defaultModelId, "chat-model");
  assert.deepEqual((await state()).errors, []);
  await run("unmount");
  await run("edit", "existing", { apiStyle: "anthropic_messages" });
  assert.match((await state()).text, /Anthropic Messages/);
  assert.equal((await state()).inputs.find(input => input.type === "password").value, "");
  await run("click", "Save provider");
  const edits = (await state()).calls.filter(call => call.channel === "pi-desktop/providers/update");
  assert.equal(edits.at(-1).args[0].id, "existing");
  assert.equal(Object.hasOwn(edits.at(-1).args[0], "secretValue"), false);
  assert.equal(edits.at(-1).args[0].apiStyle, "anthropic_messages");
  assert.deepEqual(edits.at(-1).args[0].models.map(model => model.id), ["chat-model", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst", "MiniMax-H3"]);
  await run("unmount");
  await run("dialog", { initialDraft: { name: "Copy", baseUrl: "https://unrelated.invalid/v1", apiStyle: "google_generative_ai", models: [{ id: "chat-model", thinkingLevels: [], contextWindow: 32000, maxTokens: 4000 }] } });
  assert.equal((await state()).buttons.find(button => button.text === "Save provider").disabled, true);
  assert.doesNotMatch((await state()).text, /unrelated.invalid|Google/);
  await run("unmount");
});
