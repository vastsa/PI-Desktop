#!/usr/bin/env node
// Real desktop, preload, Host SQLite and agent sidecar; only the model is local SSE.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { Host, resolveHostBinary } from "./e2e/host.mjs";
import { resolveElectronBinary } from "./e2e/boot.mjs";
import { waitFor } from "./e2e/wait.mjs";
import { scheduledModelFixture } from "./e2e/scheduled-model.mjs";

const root = mkdtempSync(join(tmpdir(), "pi-scheduled-e2e-"));
const dataDir = join(root, "data"),
  project = join(root, "project"),
  alternateProject = join(root, "project-alt");
mkdirSync(project);
mkdirSync(alternateProject);
// The Host canonicalizes the workspace path it is given, and macOS hands out
// `TMPDIR` under the `/var` symlink, so compare resolved paths on both sides.
const canonical = (value) => realpathSync(value).replaceAll("\\", "/").toLowerCase();
const evidence = process.env.PI_SCHEDULED_EVIDENCE_DIR;
if (evidence) mkdirSync(evidence, { recursive: true });
const model = scheduledModelFixture();
const server = createServer(model.handler);
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const host = new Host(resolveHostBinary(), dataDir);
await host.start();
await host.call("workspace.set", { path: project });
const { provider } = await host.call("providers.create", {
  name: "Scheduled test model",
  vendorKey: "custom",
  type: "openai_compatible",
  protocol: "openai_compatible",
  baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
  authKind: "none",
  defaultModelId: "fixture",
  apiStyle: "chat_completions",
});
const { provider: alternateProvider } = await host.call("providers.create", {
  name: "Scheduled alternate model",
  vendorKey: "custom",
  type: "openai_compatible",
  protocol: "openai_compatible",
  baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
  authKind: "none",
  defaultModelId: "fixture-alt",
  models: [{ id: "fixture-alt", contextWindow: 128000, maxTokens: 8192,
    thinkingLevels: ["off", "low", "high"], defaultThinkingLevel: "off" }],
  apiStyle: "chat_completions",
});
await host.call("session.create", {
  title: "Alternate project seed",
  mode: "agent",
  projectPath: alternateProject,
});
await host.call("settings.set", {
  language: "en",
  defaultProviderId: provider.id,
  defaultModelId: "fixture",
  defaultMode: "agent",
  defaultPermissionMode: "auto",
});
await host.stop();

const { appDir, electronBinary } = resolveElectronBinary();
const port = Number(process.env.PI_SCHEDULED_CDP_PORT || 9378);
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
  let acceptDelete = false;
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data),
      entry = pending.get(message.id);
    if (acceptDelete && message.method === "Page.javascriptDialogOpening") {
      ws.send(JSON.stringify({ id: ++sequence, method: "Page.handleJavaScriptDialog", params: { accept: true } }));
      return;
    }
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
  const openSelect = async (label) => {
    await click(label, "button[aria-haspopup]", true);
    await waitFor(() => evaluate(`!!document.querySelector('.settings-menu-select-menu.is-open') && document.activeElement?.getAttribute('role') === 'option'`), 5000, "open menu focus");
  };
  const choose = async (label, option) => {
    await openSelect(label);
    await click(option, '[role="option"]');
    await waitFor(() => evaluate(`!document.querySelector('.settings-menu-select-menu')`), 5000, "closed single select");
  };
  const selectedDays = () => evaluate(`[...document.querySelectorAll('[aria-multiselectable] [role="option"][aria-selected="true"]')].map(e=>e.textContent.trim())`);
  const fill = (selector, value) =>
    evaluate(
      `(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) throw new Error('field missing'); Object.getOwnPropertyDescriptor(e instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set.call(e, ${JSON.stringify(value)}); e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); })()`,
    );
  const screenshot = async (name) => {
    if (evidence) {
      const result = await send("Page.captureScreenshot", { format: "png" });
      writeFileSync(join(evidence, name), Buffer.from(result.data, "base64"));
    }
  };
  try {
    await waitFor(
      () => evaluate(`!!document.querySelector('[data-nav="scheduled"]')`),
      30_000,
      "scheduled sidebar entry",
    );
    await waitFor(
      () => evaluate(`!document.querySelector('.startup-splash')`),
      20_000,
      "startup splash exit",
    );
  } catch (error) {
    console.log(
      await evaluate(
        `({ title:document.title, text:document.body.innerText.slice(0,1500), nav:[...document.querySelectorAll('[data-nav]')].map(e=>e.dataset.nav) })`,
      ),
    );
    await screenshot("failure.png");
    throw error;
  }
  await evaluate(`document.querySelector('[data-nav="scheduled"]').click()`);
  await waitFor(
    () => evaluate(`document.querySelector('.page-title')?.textContent === 'Scheduled'`),
    10_000,
    "scheduled page",
  );
  await click("Create task");
  await fill("form input", "Daily project review");
  await fill("form textarea", "Summarize the current project status.");
  assert.equal(await evaluate(`document.querySelector('button[aria-label="Cadence"]').textContent.trim()`), "Manual");
  await choose("Cadence", "Daily");
  await choose("Select project", "project-alt");
  await click("Permission mode", "button[aria-haspopup]", true);
  await waitFor(() => evaluate(`!!document.querySelector('.composer-permission-menu.is-open')`), 5000, "shared permission menu");
  await click("Auto", '.composer-permission-menu [role="menuitemradio"]');
  assert.ok(await evaluate(`document.body.innerText.includes('Auto can run restricted actions')`));
  await click(await evaluate(`document.querySelector('.scheduled-execution-toolbar .composer-model-thinking-chip').getAttribute('aria-label')`), 'button[aria-haspopup]', true);
  await waitFor(() => evaluate(`!!document.querySelector('.composer-model-menu.is-open .composer-menu-root')`), 5000, "measured root menu");
  await evaluate(`document.querySelector('.composer-menu-root .composer-menu-entry').click()`);
  await waitFor(() => evaluate(`document.activeElement?.getAttribute('aria-label') === 'Search models'`), 5000, "model search focus");
  await fill('.composer-model-search input', 'fixture-alt');
  await waitFor(() => evaluate(`document.querySelectorAll('.composer-model-option').length === 1`), 5000, "filtered model");
  await key("ArrowDown", 40);
  await key("Enter", 13);
  await waitFor(() => evaluate(`!!document.querySelector('.composer-menu-root')`), 5000, "task model selection returns to root");
  await evaluate(`[...document.querySelectorAll('.composer-menu-entry')].find(e => e.textContent.includes('Reasoning')).click()`);
  await click("high", '.composer-thinking-list [role="menuitemradio"]');
  await key("Escape", 27);
  const unchangedDefaults = await invoke("settingsGet");
  assert.equal(unchangedDefaults.defaultProviderId, provider.id, "task selection cannot change the conversation default provider");
  assert.equal(unchangedDefaults.defaultModelId, "fixture", "task selection cannot change the conversation default model");
  assert.equal(
    await evaluate(`document.querySelector('.scheduled-instruction-shell > .scheduled-execution-toolbar') !== null`),
    true,
    "task execution controls stay inside the instruction composer",
  );
  assert.equal(
    await evaluate(`[...document.querySelectorAll('form label')].some((label) => label.innerText.trim().startsWith('Instruction'))`),
    true,
    "the task prompt is presented as an instruction",
  );
  await openSelect("Time");
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('[role="option"]')].map(e=>e.textContent.trim())`), ["Morning", "Afternoon", "Evening", "Night"]);
  await key("ArrowDown", 40);
  await key("Enter", 13);
  assert.equal(await evaluate(`document.querySelector('button[aria-label="Time"]').textContent.trim()`), "Afternoon");
  for (const [period, time] of [["Night","22:00"],["Evening","19:00"],["Afternoon","14:00"],["Morning","09:00"]]) {
    await choose("Time",period);
    assert.ok(await evaluate(`document.querySelector('form').innerText.includes(${JSON.stringify(time)})`));
  }
  assert.equal(await evaluate(`document.querySelectorAll('form input[type="number"],form input[type="time"]').length`),0);
  await screenshot("after-editor.png");
  const previousTheme = await evaluate(`document.documentElement.dataset.theme`);
  await evaluate(`document.documentElement.dataset.theme = 'dark'`);
  await waitFor(() => evaluate(`getComputedStyle(document.querySelector('.scheduled-instruction-input')).resize === 'none'`), 5000, "instruction resize disabled");
  assert.equal(await evaluate(`(() => {
    const input = document.querySelector('.scheduled-instruction-input');
    const style = getComputedStyle(input);
    return style.backgroundColor !== 'rgba(0, 0, 0, 0)' &&
      style.backgroundColor !== getComputedStyle(input.parentElement).backgroundColor &&
      parseFloat(style.borderBottomWidth) > 0 &&
      getComputedStyle(input, '::placeholder').opacity === '1';
  })()`), true, "instruction has its own background, border and visible placeholder");
  await screenshot("after-editor-dark.png");
  await evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(previousTheme)}`);
  await send("Emulation.setDeviceMetricsOverride", {
    width: 760,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await waitFor(() => evaluate(`window.innerWidth <= 780`), 5000, "narrow scheduled editor");
  assert.equal(
    await evaluate(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`),
    true,
  );
  await screenshot("after-editor-narrow.png");
  await send("Emulation.clearDeviceMetricsOverride");
  await waitFor(() => evaluate(`window.innerWidth > 780`), 5000, "wide scheduled editor");
  await click("Save task");
  let task;
  await waitFor(
    async () => {
      task = (await invoke("scheduledList")).tasks[0];
      return !!task && !(await evaluate("!!document.querySelector('form')"));
    },
    10_000,
    "persisted scheduled task",
  );
  assert.equal(task.schedule.minute, 0);
  assert.equal(task.schedule.hour, 9);
  assert.ok(task.nextRunAt);
  assert.equal(canonical(task.workspacePath), canonical(alternateProject));
  assert.equal(task.permissionMode, "auto");
  assert.equal(task.providerId, alternateProvider.id);
  assert.equal(task.modelId, "fixture-alt");
  assert.equal(task.thinkingLevel, "high");
  await click("Edit task");
  assert.equal(await evaluate(`document.querySelector('button[aria-label="Select project"]').textContent.trim()`), "project-alt");
  assert.equal(await evaluate(`document.querySelector('button[aria-label="Permission mode"]').textContent.trim()`), "Auto");
  assert.equal(await evaluate(`document.querySelector('.scheduled-execution-toolbar .composer-model-thinking-model').textContent.trim()`), "fixture-alt");
  assert.equal(await evaluate(`document.querySelector('.scheduled-execution-toolbar .composer-model-thinking-level').textContent.trim()`), "high");
  await click(await evaluate(`document.querySelector('.scheduled-execution-toolbar .composer-model-thinking-chip').getAttribute('aria-label')`), 'button[aria-haspopup]', true);
  await waitFor(() => evaluate(`!!document.querySelector('.composer-model-menu.is-open')`), 5000, "composer model menu");
  await screenshot("after-model-menu.png");
  await evaluate(`document.querySelector('.composer-menu-root .composer-menu-entry').click()`);
  await waitFor(() => evaluate(`!!document.querySelector('.composer-model-search')`), 5000, "shared model submenu");
  await screenshot("after-model-search.png");
  await key("Escape", 27);
  await choose("Cadence", "Weekly");
  await openSelect("Day of the week");
  assert.equal(await evaluate(`document.querySelectorAll('[role="option"]').length`), 7);
  await click("Sat", '[role="option"]');
  await click("Sun", '[role="option"]');
  assert.deepEqual(await selectedDays(), ["Mon", "Sat", "Sun"]);
  await screenshot("after-weekly.png");
  await key("Escape", 27);
  await waitFor(() => evaluate(`document.activeElement?.getAttribute('aria-label') === 'Day of the week'`), 5000, "weekday focus restoration");
  await click("Save task");
  await waitFor(async () => (await invoke("scheduledList")).tasks[0].schedule.weekdays?.length === 3 && !(await evaluate("!!document.querySelector('form')")), 5000, "saved custom weekdays");
  assert.deepEqual((await invoke("scheduledList")).tasks[0].schedule.weekdays, [0,5,6]);
  await click("Edit task");
  await openSelect("Day of the week");
  assert.deepEqual(await selectedDays(), ["Mon", "Sat", "Sun"]);
  for (const day of ["Mon", "Sat", "Sun"]) await click(day, '[role="option"]');
  assert.equal(await evaluate(`document.querySelector('button[type="submit"]').disabled`), true);
  await key("Home", 36);
  await key("Enter", 13);
  assert.deepEqual(await selectedDays(), ["Mon"]);
  await key("End", 35);
  await key("Enter", 13);
  assert.deepEqual(await selectedDays(), ["Mon", "Sun"]);
  await key("Tab", 9);
  await waitFor(() => evaluate(`!document.querySelector('.scheduled-weekday-menu')`), 5000, "tab closes weekdays");
  await openSelect("Day of the week");
  await click("Edit task", "form h2");
  await waitFor(() => evaluate(`!document.querySelector('.scheduled-weekday-menu')`), 5000, "outside click dismisses weekdays");
  await choose("Cadence", "Hourly");
  assert.equal(await evaluate(`document.querySelectorAll('button[aria-label="Time"]').length`), 0);
  await screenshot("after-hourly.png");
  const savedAfter = Date.now();
  await click("Save task");
  await waitFor(async () => (await invoke("scheduledList")).tasks[0].cadence === "hourly" && !(await evaluate("!!document.querySelector('form')")), 5000, "hourly interval saved");
  const hourlyNext = Date.parse((await invoke("scheduledList")).tasks[0].nextRunAt);
  assert.ok(hourlyNext >= savedAfter + 3_600_000 && hourlyNext <= Date.now() + 3_600_000);
  await click("Pause");
  await waitFor(async () => !(await invoke("scheduledList")).tasks[0].enabled, 5000, "pause");
  await waitFor(() => evaluate(`document.body.innerText.includes('Resume')`), 5000, "paused UI");
  await click("Resume");
  await waitFor(async () => (await invoke("scheduledList")).tasks[0].enabled, 5000, "resume");
  await click("Edit task");
  await fill("form input", "Project review");
  await click("Save task");
  await waitFor(
    async () =>
      (await invoke("scheduledList")).tasks[0].title === "Project review" &&
      !(await evaluate("!!document.querySelector('form')")),
    5000,
    "edit",
  );
  await screenshot("after-tasks.png");
  await click("Run now");
  let runs;
  await waitFor(
    async () => {
      runs = (await invoke("scheduledListRuns")).runs;
      return runs[0]?.status === "completed";
    },
    30_000,
    "manual run completion",
  );
  const executedSession = await invoke("sessionGet", { id: runs[0].sessionId });
  assert.equal(executedSession.session.thinkingLevel, "high", "saved thinking level reaches the executed session");
  assert.ok(model.calls > 0, "real sidecar reached the local model");
  assert.ok(model.requestedModels.includes("fixture-alt"), "task-owned model reached the sidecar");
  await waitFor(
    () => evaluate(`document.body.innerText.includes('Completed')`),
    15_000,
    "visible run result",
  );
  await screenshot("after-runs.png");
  await click("Open conversation");
  await waitFor(
    () => evaluate(`document.body.innerText.includes('Scheduled review complete.')`),
    10_000,
    "result transcript",
  );
  // Arm the next real minute. Poll on conditions; no arbitrary sleeps or live API.
  const next = new Date(Math.ceil((Date.now() + 5000) / 60_000) * 60_000);
  await invoke("scheduledUpdate", {
    id: task.id,
    cadence: "daily",
    schedule: { hour: next.getHours(), minute: next.getMinutes(), weekday: 0 },
  });
  const manualCount = runs.length;
  await waitFor(
    async () => {
      runs = (await invoke("scheduledListRuns")).runs;
      return runs.length > manualCount && runs[0].status === "completed";
    },
    100_000,
    "automatic real-clock run",
    250,
  );
  assert.equal(runs.length, manualCount + 1);
  await invoke("scheduledUpdate", { id: task.id, enabled: false });
  await evaluate(`document.querySelector('[data-nav="scheduled"]').click()`);
  await waitFor(() => evaluate(`document.querySelector('.page-title')?.textContent === 'Scheduled'`), 5000, "return to tasks");
  acceptDelete = true;
  await click("Delete");
  await waitFor(async () => (await invoke("scheduledList")).tasks.length === 0, 5000, "confirmed deletion");
  await evaluate(`document.querySelector('[data-nav="home"]').click()`);
  await waitFor(() => evaluate(`document.querySelector('.page-title')?.textContent !== 'Scheduled'`), 5000, "leave tasks before conversation CRUD");
  const chat = (await invoke("sessionCreate", { title: "Scheduled AI CRUD", mode: "agent", projectPath: project, providerId: provider.id, modelId: "fixture", permissionMode: "auto" })).session;
  for (const scenario of ["create", "read", "update", "delete"]) {
    model.setScenario(scenario);
    await invoke("agentPrompt", { sessionId: chat.id, content: `${scenario} the scheduled task; for update use 15:30.`, viewingSessionId: chat.id });
    await waitFor(async () => {
      const session = (await invoke("sessionGet", chat.id)).session;
      return session.messages.some(message => message.role === "assistant" && JSON.stringify(message).includes(`SCHEDULE_AI_${scenario.toUpperCase()}_OK`));
    }, 60_000, `AI ${scenario} turn`);
    const tasks = (await invoke("scheduledList")).tasks;
    if (scenario === "delete") assert.equal(tasks.length, 0);
    else { assert.equal(tasks[0].id, model.taskId); assert.equal(tasks[0].enabled, false); }
    if (scenario === "update") {
      assert.equal(tasks[0].schedule.hour,15);
      assert.equal(tasks[0].schedule.minute,30);
      await evaluate(`document.querySelector('[data-nav="scheduled"]').click()`);
      await waitFor(() => evaluate(`document.body.innerText.includes('AI managed task')`),15000,"AI task appears on page");
      await click("Edit task");
      assert.equal(await evaluate(`document.querySelector('button[aria-label="Time"]').textContent.trim()`),'Custom · 15:30');
      await screenshot('after-ai-custom-time.png');
      await fill('form input','AI managed task renamed');
      await click('Save task');
      await waitFor(() => evaluate(`!document.querySelector('form')`),5000,'save without resetting AI time');
      assert.equal((await invoke('scheduledList')).tasks[0].schedule.minute,30);
      assert.equal((await invoke('scheduledList')).tasks[0].enabled,false);
    }
  }
  assert.ok(model.results.some(result => result.name === 'ScheduledTaskDelete' && result.value.ok));
  if (evidence) writeFileSync(join(evidence,'ai-crud.json'),JSON.stringify(model.results,null,2));
  console.log('PASS normal conversation AI tools: discover, create, list, update exact time, preserve UI custom time, delete');
  console.log(
    "PASS scheduled user path: create, time, weekday dropdown/multiple selection, validation, keyboard, hourly interval, edit, pause/resume, manual run, transcript, automatic run, delete",
  );
  console.log(`Evidence: ${evidence ?? "not requested"}; isolated profile: ${root}`);
} catch (error) {
  console.error(output.slice(-4000));
  throw error;
} finally {
  ws?.close();
  child.kill();
  server.close();
  // Preserve this uniquely named fixture profile for diagnosing failures.
}
