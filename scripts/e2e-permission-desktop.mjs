#!/usr/bin/env node
/** Windows desktop user path with isolated user/native-Pi profiles and a localhost model. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { createServer as createPortServer } from "node:net";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Host, resolveHostBinary } from "./e2e/host.mjs";
import { assertDesktopBuild, resolveElectronBinary } from "./e2e/boot.mjs";
import { waitFor } from "./e2e/wait.mjs";

assert.equal(process.platform, "win32", "This full-app fixture isolates Windows USERPROFILE; use the portable host/card suites on other platforms.");
assertDesktopBuild();
const settingsOnly = process.env.PI_PERMISSION_DESKTOP_SETTINGS_ONLY === "1";
const settingsLocale = process.env.PI_PERMISSION_DESKTOP_LANGUAGE ?? "en";
assert(["en", "zh-CN"].includes(settingsLocale), "Unknown settings screenshot locale");
const scenarioNames = ["approved", "manual", "stopped", "resumed"];
const selectedScenario = process.env.PI_PERMISSION_DESKTOP_SCENARIO;
assert(!selectedScenario || scenarioNames.includes(selectedScenario), "Unknown permission desktop scenario");
const scenarios = selectedScenario ? [selectedScenario] : scenarioNames;
const scratch = await mkdtemp(join(tmpdir(), "pi-permission-desktop-"));
const workspace = join(scratch, "workspace");
const dataDir = join(scratch, "data");
const userProfile = join(scratch, "user");
await Promise.all([mkdir(workspace), mkdir(userProfile)]);
const artifacts = process.env.PI_PERMISSION_DESKTOP_ARTIFACTS;
if (artifacts) await mkdir(artifacts, { recursive: true });
let phase = "approved";
let pendingTool;
let heldReview;
const reviewRequests = [];
const failures = [];
const streamReply = (response, model, delta, stop) => {
  response.writeHead(200, { "content-type": "text/event-stream" });
  const frame = (value, finish_reason) => `data: ${JSON.stringify({ id: "permission-fixture", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: value, finish_reason }] })}\n\n`;
  response.write(frame({ role: "assistant", ...delta }, null));
  response.write(frame({}, stop));
  response.write(`data: ${JSON.stringify({ id: "permission-fixture", object: "chat.completion.chunk", model, choices: [], usage: { prompt_tokens: 24, completion_tokens: 12, total_tokens: 36 } })}\n\n`);
  response.end("data: [DONE]\n\n");
};
const model = createServer(async (request, response) => {
  try {
    if (request.method === "GET") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "permission-fixture", object: "model" }] }));
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const system = body.messages?.filter((message) => message.role === "system" || message.role === "developer")
      .map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content)).join("\n") ?? "";
    if (system.includes("You review a proposed tool action")) {
      assert.equal(body.tools?.length ?? 0, 0);
      reviewRequests.push({ phase, model: body.model });
      heldReview = () => streamReply(response, body.model, {
        content: phase !== "manual"
          ? JSON.stringify({ decision: "allow_once", risk: "low", authorization: "explicit", reason: "The fixture file is explicitly requested." })
          : "invalid fixture review",
      }, "stop");
      return;
    }
    const write = body.tools?.find((tool) => tool.function?.name?.toLowerCase() === "write");
    if (!write) { streamReply(response, body.model, { content: "Permission review fixture" }, "stop"); return; }
    if (pendingTool && body.messages?.some((message) => message.role === "tool" && message.tool_call_id === pendingTool)) {
      pendingTool = undefined;
      streamReply(response, body.model, { content: `PERMISSION_${phase.toUpperCase()}_DONE` }, "stop");
      return;
    }
    pendingTool = `permission-${phase}`;
    streamReply(response, body.model, { tool_calls: [{ index: 0, id: pendingTool, type: "function", function: {
      name: write.function.name,
      arguments: JSON.stringify({ path: join(workspace, `${phase}.txt`), content: phase }),
    } }] }, "tool_calls");
  } catch (error) {
    failures.push(String(error));
    if (!response.headersSent) response.writeHead(500);
    response.end();
  }
});
await new Promise((done, reject) => { model.once("error", reject); model.listen(0, "127.0.0.1", done); });
const seed = new Host(resolveHostBinary(), dataDir);
let child;
let ws;
let output = "";
let captureFailure = async () => {};
try {
  await seed.start();
  await seed.call("workspace.set", { path: workspace });
  const { provider } = await seed.call("providers.create", {
    name: "Local permission fixture", vendorKey: "custom", type: "openai_compatible",
    protocol: "openai_compatible", apiStyle: "chat_completions", authKind: "none",
    baseUrl: `http://127.0.0.1:${model.address().port}/v1`, defaultModelId: "permission-fixture",
    ...(settingsOnly ? { models: [
      { id: "permission-fixture", thinkingLevels: ["off", "low", "high"] },
      { id: "plain-fixture", thinkingLevels: ["off"] },
    ] } : {}),
  });
  await seed.call("settings.set", { language: settingsOnly ? settingsLocale : "en", defaultProviderId: provider.id,
    defaultModelId: "permission-fixture", defaultMode: "agent", defaultPermissionMode: "ask",
    approvalReviewer: settingsOnly ? "user" : "auto_review", onboardingDismissed: true,
  });
  await seed.stop();
  const allocator = createPortServer();
  await new Promise((done) => allocator.listen(0, "127.0.0.1", done));
  const port = allocator.address().port;
  await new Promise((done) => allocator.close(done));
  const { appDir, electronBinary } = resolveElectronBinary();
  const env = { ...process.env, PI_DESKTOP_DATA_DIR: dataDir, USERPROFILE: userProfile,
    PI_DESKTOP_START_MAXIMIZED: "0", ELECTRON_RENDERER_URL: "" };
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(electronBinary, [`--remote-debugging-port=${port}`, `--user-data-dir=${join(scratch, "profile")}`, "."],
    { cwd: appDir, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { output = (output + chunk).slice(-12000); });
  let target;
  await waitFor(async () => {
    try {
      target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json())
        .find((entry) => entry.type === "page" && entry.url.includes("index.html") && !entry.url.includes("plugin-launcher"));
      return Boolean(target);
    } catch { return false; }
  }, 30000, "isolated desktop page");
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await once(ws, "open");
  let sequence = 0;
  const pending = new Map();
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    const call = pending.get(message.id);
    if (!call) return;
    pending.delete(message.id);
    clearTimeout(call.timer);
    if (message.error) call.reject(new Error(JSON.stringify(message.error)));
    else call.resolve(message.result);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 10000);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? "Renderer evaluation failed");
    return result.result.value;
  };
  const screenshot = async (name) => {
    if (artifacts) await writeFile(join(artifacts, name), Buffer.from((await send("Page.captureScreenshot", { format: "png" })).data, "base64"));
  };
  captureFailure = async () => {
    console.error(JSON.stringify({ rendererText: await evaluate("document.body.innerText.slice(-5000)") }));
    console.error(JSON.stringify({ permissionMenu: await evaluate(`(() => {
      const trigger = document.querySelector('.composer-permission button');
      const menu = document.querySelector('.composer-permission-menu');
      const matches = [...document.querySelectorAll('[aria-label="Recent permission reviews"]')];
      return { trigger: trigger && { expanded: trigger.getAttribute('aria-expanded'),
        disabled: trigger.disabled, rect: trigger.getBoundingClientRect().toJSON() },
        menu: menu && { className: menu.className, text: menu.textContent.slice(-750),
          visibility: getComputedStyle(menu).visibility, rect: menu.getBoundingClientRect().toJSON() },
        matches: matches.map((node) => ({ html: node.outerHTML.slice(0, 650),
          innerText: node.innerText.slice(-750), textContent: node.textContent.slice(-750) })) };
    })()`) }));
    console.error(JSON.stringify({ agentEvents: await evaluate("globalThis.permissionFixtureEvents ?? []") }));
    const sessionIds = [...output.matchAll(/"sessionId":"([^"]+)"/g)];
    const failedSession = sessionIds.at(-1)?.[1];
    if (failedSession) console.error(JSON.stringify({ runtimeStatus: await evaluate(
      `window.piDesktop.invoke("pi-desktop/agent/getStatus", ${JSON.stringify(failedSession)})`,
    ) }));
    await screenshot("failure.png");
  };
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await waitFor(() => evaluate("!!document.querySelector('.composer-input[contenteditable=\"true\"]') && !document.querySelector('.startup-splash')"), 30000, "Composer readiness");
  if (settingsOnly) {
    const reviewModelLabel = settingsLocale === "zh-CN" ? "审核模型" : "Review model";
    const savedSettings = async () => {
      const result = await evaluate('window.piDesktop.invoke("pi-desktop/settings/get")');
      assert.equal(result.ok, true, "settings.get must succeed");
      return result.data;
    };
    const openPermissionSettings = async () => {
      await evaluate('document.querySelector("[data-nav=settings]").click()');
      const label = settingsLocale === "zh-CN" ? "权限" : "Permissions";
      await waitFor(() => evaluate(`[...document.querySelectorAll('.settings-nav-item')].some((item) => item.textContent.trim() === ${JSON.stringify(label)})`), 10000, "Settings navigation");
      await evaluate("[...document.querySelectorAll('.settings-nav-item')].find((item) => item.textContent.trim() === 'AI').click()");
      assert.equal(await evaluate("!!document.getElementById('permission-review-policy-draft')"), false,
        "review policy must not remain under AI");
      await evaluate(`[...document.querySelectorAll('.settings-nav-item')].find((item) => item.textContent.trim() === ${JSON.stringify(label)}).click()`);
      await waitFor(() => evaluate("!!document.getElementById('permission-review-policy-draft')"), 10000, "Permissions settings");
    };
    await openPermissionSettings();
    assert.equal(await evaluate("document.getElementById('permission-review-policy-draft').value"), "");
    assert.equal(await evaluate("!!document.querySelector('.permission-review-policy button, .permission-review-policy summary, .permission-review-policy .settings-row-detail')"), false);
    assert.equal(await evaluate("document.getElementById('permission-review-policy-draft').placeholder"),
      settingsLocale === "zh-CN" ? "不填写使用默认策略" : "Leave empty to use the default policy");
    await evaluate("document.getElementById('permission-review-policy-draft').scrollIntoView({ block: 'center' })");
    await screenshot(`${settingsLocale}-default-policy.png`);

    const trigger = `document.querySelector('button[aria-label=${JSON.stringify(reviewModelLabel)}]')`;
    const modelControlReady = (label) => waitFor(() => evaluate(`(() => {
      const trigger = ${trigger};
      const draft = document.getElementById('permission-review-policy-draft');
      return !!trigger && !trigger.disabled && !!draft && !draft.disabled && trigger.textContent.includes(${JSON.stringify(label)});
    })()`), 10000, `review model control settled: ${label}`);
    const policyControlReady = (value) => waitFor(() => evaluate(`(() => {
      const draft = document.getElementById('permission-review-policy-draft');
      return !!draft && draft.value === ${JSON.stringify(value)} &&
        !document.querySelector('.permission-review-policy [role=alert]');
    })()`), 10000, "review policy control settled");
    const followLabel = settingsLocale === "zh-CN" ? "跟随当前对话" : "Follow current chat";
    await modelControlReady(followLabel);
    const thinkingLabel = settingsLocale === "zh-CN" ? "审核思考等级" : "Review thinking";
    const thinkingTrigger = `document.querySelector('button[aria-label=${JSON.stringify(thinkingLabel)}]')`;
    assert.equal(await evaluate(`${thinkingTrigger}.disabled && ${thinkingTrigger}.textContent.includes('off')`), true);
    assert.equal((await savedSettings()).autoReview?.thinkingLevel, undefined);
    await evaluate(`${trigger}.scrollIntoView({ block: 'center' })`);
    await evaluate(`${trigger}.click()`);
    await waitFor(() => evaluate("(() => { const input = document.querySelector('.settings-menu-select-search input'); return !!input && input.closest('.settings-menu-select-menu')?.classList.contains('is-open') && document.activeElement === input; })()"), 5000,
      "focused reviewer model search input");
    await send("Input.insertText", { text: "permission-fixture" });
    await waitFor(() => evaluate("[...document.querySelectorAll('.settings-menu-select-menu [role=option]')].filter((item) => item.textContent.includes('Local permission fixture /')).length === 1"),
      5000, "filtered reviewer model option");
    await screenshot(`${settingsLocale}-model-menu.png`);
    await evaluate("[...document.querySelectorAll('[role=option]')].find((item) => item.textContent.includes('Local permission fixture / permission-fixture')).click()");
    await waitFor(async () => (await savedSettings()).autoReview?.modelId === "permission-fixture", 10000, "fixed reviewer model persisted");
    await modelControlReady("Local permission fixture / permission-fixture");
    assert.equal((await savedSettings()).autoReview?.providerId, provider.id);
    assert.equal((await savedSettings()).autoReview?.thinkingLevel, "off");
    assert.equal(await evaluate(`!${thinkingTrigger}.disabled && ${thinkingTrigger}.textContent.includes('off')`), true);
    await evaluate(`${thinkingTrigger}.click()`);
    await waitFor(() => evaluate("document.querySelectorAll('.settings-menu-select-menu [role=option]').length === 3"), 5000, "model-specific thinking levels");
    assert.deepEqual(await evaluate("[...document.querySelectorAll('.settings-menu-select-menu [role=option]')].map((item) => item.textContent.trim())"),
      ["off", "low", "high"]);
    await screenshot(`${settingsLocale}-thinking-menu.png`);
    await evaluate("[...document.querySelectorAll('.settings-menu-select-menu [role=option]')].find((item) => item.textContent.trim() === 'high').click()");
    await waitFor(async () => (await savedSettings()).autoReview?.thinkingLevel === "high", 5000, "review thinking level persisted");
    await waitFor(() => evaluate("!document.querySelector('.settings-menu-select-menu')"), 5000,
      "thinking menu closes before policy editing");
    await evaluate(`${trigger}.click()`);
    await waitFor(() => evaluate("[...document.querySelectorAll('[role=option]')].some((item) => item.textContent.includes('Local permission fixture / plain-fixture'))"), 5000,
      "non-reasoning reviewer model option");
    await evaluate("[...document.querySelectorAll('[role=option]')].find((item) => item.textContent.includes('Local permission fixture / plain-fixture')).click()");
    await waitFor(async () => (await savedSettings()).autoReview?.modelId === "plain-fixture", 5000,
      "non-reasoning reviewer model persisted");
    assert.equal((await savedSettings()).autoReview?.thinkingLevel, "off");
    assert.equal(await evaluate(`${thinkingTrigger}.disabled && ${thinkingTrigger}.textContent.includes('off')`), true);
    await evaluate(`${trigger}.click()`);
    await waitFor(() => evaluate("[...document.querySelectorAll('[role=option]')].some((item) => item.textContent.includes('Local permission fixture / permission-fixture'))"), 5000,
      "reasoning reviewer model option restored");
    await evaluate("[...document.querySelectorAll('[role=option]')].find((item) => item.textContent.includes('Local permission fixture / permission-fixture')).click()");
    await waitFor(async () => (await savedSettings()).autoReview?.modelId === "permission-fixture", 5000,
      "reasoning reviewer model restored");
    assert.equal((await savedSettings()).autoReview?.thinkingLevel, "off");

    const policy = "Review only the current, explicitly authorized local fixture action. Ask the user when the scope is unclear.";
    await evaluate("document.getElementById('permission-review-policy-draft').scrollIntoView({ block: 'center' }); document.getElementById('permission-review-policy-draft').focus()");
    await waitFor(() => evaluate("document.activeElement?.id === 'permission-review-policy-draft'"), 5000,
      "policy editor receives keyboard focus");
    await send("Input.insertText", { text: policy });
    await waitFor(async () => (await savedSettings()).autoReview?.policyPrompt === policy, 10000,
      "custom review policy auto-saved");
    await policyControlReady(policy);
    await evaluate("document.getElementById('permission-review-policy-draft').scrollIntoView({ block: 'center' })");
    await screenshot(`${settingsLocale}-custom-policy.png`);
    // Model changes must keep the policy already saved by the editor.
    await evaluate(`${trigger}.click()`);
    await waitFor(() => evaluate("[...document.querySelectorAll('[role=option]')].some((item) => item.textContent.includes('Follow') || item.textContent.includes('跟随'))"), 5000, "follow session option");
    await evaluate("[...document.querySelectorAll('[role=option]')].find((item) => item.textContent.includes('Follow') || item.textContent.includes('跟随')).click()");
    await waitFor(async () => !(await savedSettings()).autoReview?.providerId, 10000, "model refresh while editing");
    await modelControlReady(followLabel);
    assert.equal((await savedSettings()).autoReview?.thinkingLevel, "off");
    assert.equal(await evaluate(`${thinkingTrigger}.disabled && ${thinkingTrigger}.textContent.includes('off')`), true);
    assert.equal((await savedSettings()).autoReview?.policyPrompt, policy,
      "following the session model must retain the custom policy");
    await evaluate(`${trigger}.click()`);
    await waitFor(() => evaluate("[...document.querySelectorAll('[role=option]')].some((item) => item.textContent.includes('Local permission fixture / permission-fixture'))"), 5000, "fixture model option again");
    await evaluate("[...document.querySelectorAll('[role=option]')].find((item) => item.textContent.includes('Local permission fixture / permission-fixture')).click()");
    await waitFor(async () => (await savedSettings()).autoReview?.modelId === "permission-fixture", 10000, "fixture model restored");
    await modelControlReady("Local permission fixture / permission-fixture");
    assert.equal((await savedSettings()).autoReview?.thinkingLevel, "off");
    assert.equal((await savedSettings()).autoReview?.policyPrompt, policy,
      "returning to the fixed model must retain the custom policy");
    await evaluate("document.querySelector('[data-nav=back-to-app]').click()");
    await waitFor(() => evaluate("!!document.querySelector('[data-nav=settings]')"), 5000, "return to desktop");
    await openPermissionSettings();
    assert.equal(await evaluate("document.getElementById('permission-review-policy-draft').value"), policy,
      "saved policy must reload after leaving settings");
    assert.equal((await savedSettings()).autoReview?.modelId, "permission-fixture", "policy save must retain fixed model");
    await evaluate("document.getElementById('permission-review-policy-draft').focus(); document.getElementById('permission-review-policy-draft').select()");
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
    await waitFor(async () => (await savedSettings()).autoReview?.policyPrompt === undefined, 10000,
      "clearing input restores the built-in policy automatically");
    await policyControlReady("");
    assert.equal(await evaluate("document.getElementById('permission-review-policy-draft').value"), "");
    await evaluate("document.getElementById('permission-review-policy-draft').scrollIntoView({ block: 'center' })");
    await screenshot(`${settingsLocale}-restored-policy.png`);
    await evaluate(`${trigger}.scrollIntoView({ block: 'center' })`);
    await evaluate(`${trigger}.click()`);
    await waitFor(() => evaluate("[...document.querySelectorAll('[role=option]')].some((item) => item.textContent.includes('Follow') || item.textContent.includes('跟随'))"), 5000, "follow session option");
    await evaluate("[...document.querySelectorAll('[role=option]')].find((item) => item.textContent.includes('Follow') || item.textContent.includes('跟随')).click()");
    await waitFor(async () => !(await savedSettings()).autoReview?.providerId, 10000, "follow session model persisted");
    await modelControlReady(followLabel);
    assert.equal((await savedSettings()).autoReview?.policyPrompt, undefined, "model selection must preserve restored default");
    console.log(JSON.stringify({ ok: true, settingsOnly, locale: settingsLocale,
      actions: ["open Permissions settings", "search and select fixture model", "select supported thinking", "clear unsupported thinking", "auto-save policy", "reopen settings", "clear policy to restore default", "follow session"],
      environment: "Windows full desktop, isolated Host/profile/native-Pi home, local fixture provider" }));
  } else {
  await evaluate(`globalThis.permissionFixtureEvents = [];
    window.piDesktop.on(window.piDesktop.channels.event.agentMessage, (envelope) => {
      if (!["agent_start", "turn_start", "agent_end", "turn_end", "tool_end", "tool_permission_request", "status"].includes(envelope.event?.type)) return;
      globalThis.permissionFixtureEvents.push({ type: envelope.event.type, sessionId: envelope.sessionId,
        turnId: envelope.turnId, parentToolCallId: envelope.parentToolCallId, ts: envelope.ts,
        isRunning: envelope.event.status?.isRunning });
      if (globalThis.permissionFixtureEvents.length > 100) globalThis.permissionFixtureEvents.shift();
    });`);
  for (const scenario of scenarios) {
    phase = scenario;
    pendingTool = undefined;
    heldReview = undefined;
    await evaluate("document.querySelector('.composer-input').focus()");
    await send("Input.insertText", { text: `Create ${join(workspace, `${phase}.txt`)} with the text ${phase}.` });
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await waitFor(() => Boolean(heldReview), 30000, "real desktop reviewer model request");
    await waitFor(() => evaluate("document.querySelector('.permission-card')?.innerText.includes('Reviewing')"), 5000, "reviewing card");
    await screenshot(`${phase}-reviewing.png`);
    const releaseReview = heldReview;
    heldReview = undefined;
    if (phase === "stopped") {
      await evaluate("document.querySelector('.stop-btn').click()");
      await waitFor(() => evaluate("!document.querySelector('.permission-card')"), 5000,
        "Stop cancels the pending permission");
      await assert.rejects(readFile(join(workspace, "stopped.txt")), { code: "ENOENT" });
      await waitFor(() => evaluate("!document.querySelector('.stop-btn')"),
        10000, "Stop settles the visible turn state");
      releaseReview();
      await assert.rejects(readFile(join(workspace, "stopped.txt")), { code: "ENOENT" });
      await screenshot("stopped.png");
      continue;
    }
    releaseReview();
    if (phase === "manual") {
      await waitFor(() => evaluate("[...document.querySelectorAll('.permission-card button')].some(e => e.textContent.trim() === 'Allow once' && !e.disabled)"), 5000, "manual fallback card");
      await assert.rejects(readFile(join(workspace, "manual.txt")), { code: "ENOENT" });
      await screenshot("manual-fallback.png");
      await evaluate("[...document.querySelectorAll('.permission-card button')].find(e => e.textContent.trim() === 'Allow once').click()");
    }
    await waitFor(() => evaluate(`document.body.innerText.includes(${JSON.stringify(`PERMISSION_${phase.toUpperCase()}_DONE`)}) && !document.querySelector('.stop-btn')`), 30000, "tool result and turn settlement");
    assert.equal(await readFile(join(workspace, `${phase}.txt`), "utf8"), phase);
    await screenshot(`${phase}-completed.png`);
    assert.equal(await evaluate("document.querySelector('.composer-permission button')?.getAttribute('aria-expanded')"),
      "false", "a previous permission menu must be closed before reopening it");
    await evaluate("document.querySelector('.composer-permission button').click()");
    // AnchoredMenu is portaled and revealed on its measurement frame. Wait for
    // the actual visible menu before asserting the asynchronously loaded audit.
    await waitFor(() => evaluate(`(() => {
      const trigger = document.querySelector('.composer-permission button');
      const menu = document.querySelector('.composer-permission-menu.is-open');
      return trigger?.getAttribute('aria-expanded') === 'true' && menu &&
        getComputedStyle(menu).visibility === 'visible';
    })()`), 5000, "permission menu opens and is visible");
    await waitFor(() => evaluate("document.querySelector('.composer-permission-menu.is-open [aria-label=\"Recent permission reviews\"]')?.innerText.includes('36 tokens')"),
      5000, "retained review outcome and separate usage in the permission menu");
    await screenshot(`${phase}-review-history.png`);
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await waitFor(() => evaluate("document.querySelector('.composer-permission button')?.getAttribute('aria-expanded') === 'false' && !document.querySelector('.composer-permission-menu')"),
      5000, "permission menu closes before the next turn");
  }
  assert.deepEqual(failures, []);
  assert.equal(reviewRequests.length, scenarios.length);
  console.log(JSON.stringify({ ok: true, scenarios, reviewRequests,
    environment: "Windows full desktop, isolated Host/profile/native-Pi home, local HTTP model fixture" }));
  }
} catch (error) {
  await captureFailure().catch((failure) => console.error(`Could not capture failed fixture: ${String(failure)}`));
  console.error(output.slice(-5000));
  console.error(JSON.stringify({ fixtureFailures: failures, reviewRequests }));
  throw error;
} finally {
  heldReview?.();
  ws?.close();
  if (child && child.exitCode === null) { child.kill(); await Promise.race([once(child, "close"), new Promise((done) => setTimeout(done, 5000))]); }
  await seed.stop();
  model.closeAllConnections();
  await new Promise((done) => model.close(done));
  await rm(scratch, { recursive: true, force: true });
}
