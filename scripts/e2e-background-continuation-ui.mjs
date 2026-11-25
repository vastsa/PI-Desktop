#!/usr/bin/env node
// Real Electron/sidecar/Host acceptance with an isolated profile and a local deterministic provider.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { resolveElectronBinary, desktopPaths } from "./e2e/boot.mjs";
import { Host, resolveHostBinary } from "./e2e/host.mjs";
import { waitFor } from "./e2e/wait.mjs";

const root = mkdtempSync(join(tmpdir(), "pi-continuation-e2e-"));
const dataDir = join(root, "data");
const profile = join(root, "profile");
const project = join(root, "project");
const evidence = process.env.PI_CONTINUATION_EVIDENCE_DIR;
const configuredPort = process.env.PI_CONTINUATION_CDP_PORT
  ? Number(process.env.PI_CONTINUATION_CDP_PORT)
  : null;
mkdirSync(dataDir);
mkdirSync(project);
const host = new Host(resolveHostBinary(), dataDir);
let round = 0,
  job,
  cancelledJob,
  fixtureFailure;
writeFileSync(
  join(project, "test.cjs"),
  "const fs=require('fs');const t=setInterval(()=>{if(!fs.existsSync('release'))return;clearInterval(t);console.error('shipping boundary assertion failed');process.exitCode=7;},50)",
);
const provider = createServer(async (req, res) => {
  try {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw),
      step = round++;
    let value;
    if (step === 0)
      value = {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: "launch-test",
            type: "function",
            function: {
              name: "Bash",
              arguments: JSON.stringify({
                command: "node test.cjs",
                runInBackground: true,
                notifyOnExit: true,
              }),
            },
          },
        ],
      };
    else if (step === 1) {
      const result = JSON.parse(
        body.messages.find(
          (m) => m.role === "tool" && m.tool_call_id === "launch-test",
        ).content,
      );
      job = result.job;
      assert.equal(result.continuationRequested, true);
      value = {
        role: "assistant",
        content:
          "The test is running in the background. This turn is complete; I will continue when the result arrives.",
      };
    } else if (step === 2) {
      const result = body.messages.find(
        (m) =>
          m.role === "tool" &&
          m.tool_call_id === `background-completion-${job.id}`,
      );
      assert(result);
      assert.match(result.content, /shipping boundary assertion failed/);
      assert.match(result.content, /"exitCode":7/);
      assert.equal(body.messages.filter((m) => m.role === "user").length, 1);
      value = {
        role: "assistant",
        content:
          "Automatically resumed after the test finished. The same background job failed with exit code 7: shipping boundary assertion failed. The result arrived without another user message.",
      };
    } else if (step === 3)
      value = {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: "cancel-test",
            type: "function",
            function: {
              name: "Bash",
              arguments: JSON.stringify({
                command: "node waiting.cjs",
                runInBackground: true,
                notifyOnExit: true,
              }),
            },
          },
        ],
      };
    else if (step === 4) {
      const result = JSON.parse(
        body.messages.find(
          (m) => m.role === "tool" && m.tool_call_id === "cancel-test",
        ).content,
      );
      cancelledJob = result.job;
      value = {
        role: "assistant",
        content:
          "The second test is running; you can cancel automatic continuation without stopping the process.",
      };
    } else throw new Error("duplicate continuation");
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const [delta, finish_reason] of [
      [value, null],
      [{}, [0, 3].includes(step) ? "tool_calls" : "stop"],
    ])
      res.write(
        `data: ${JSON.stringify({ id: `fixture-${step}`, object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
      );
    res.end("data: [DONE]\n\n");
  } catch (e) {
    fixtureFailure = e;
    res.writeHead(400);
    res.end(String(e));
  }
});
let owner;
try {
await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
await host.start();
await host.call("workspace.set", { path: project });
await host.call("settings.set", { language: "en" });
const { provider: seededProvider } = await host.call("providers.create", {
  name: "Local deterministic acceptance",
  vendorKey: "custom",
  type: "openai_compatible",
  protocol: "openai_compatible",
  baseUrl: `http://127.0.0.1:${provider.address().port}/v1`,
  authKind: "api_key_and_base_url",
  defaultModelId: "fixture",
  secretValue: "local-fixture",
  apiStyle: "chat_completions",
});
const { session: createdSession } = await host.call("session.create", {
  title: "Background completion · local acceptance",
  mode: "agent",
  providerId: seededProvider.id,
  modelId: "fixture",
  projectPath: project,
});
await host.call("session.configure", {
  id: createdSession.id,
  mode: "agent",
  permissionMode: "auto",
  thinkingLevel: "off",
});
if (process.platform === "win32") {
  await host.call("settings.set", { defaultCommandShell: "cmd" });
}
owner = createdSession;
} catch (error) {
  await new Promise(resolve => provider.close(resolve));
  throw error;
} finally {
  await host.stop();
}
console.log("Continuation fixture Host seeded");
if (evidence) mkdirSync(evidence, { recursive: true });
const { appDir, electronBinary } = process.env.PI_CONTINUATION_ELECTRON_BIN
  ? {
      ...desktopPaths(),
      electronBinary: process.env.PI_CONTINUATION_ELECTRON_BIN,
    }
  : resolveElectronBinary();
let session;
let electronChild;

/** Reserve an ephemeral port: each launch gets its own DevTools server. */
async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port: available } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return available;
}

let launchCount = 0;

async function launch() {
  // A fresh port and profile per launch: the previous instance's DevTools
  // server and single-instance lock can outlive the 5s close window, which made
  // the restart assertions talk to the instance that was shutting down.
  const port = configuredPort ?? (await freePort());
  const userDataDir = `${profile}-${++launchCount}`;
  mkdirSync(userDataDir);
  const env = {
    ...process.env,
    PI_DESKTOP_DATA_DIR: dataDir,
    PI_DESKTOP_PLAN_UI_PROBE: "1",
    PI_DESKTOP_START_MAXIMIZED: "0",
    ELECTRON_RENDERER_URL: "",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = (electronChild = spawn(
    electronBinary,
    [`--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`, "."],
    { cwd: appDir, env, stdio: ["ignore", "pipe", "pipe"] },
  ));
  let output = "";
  child.stdout.on("data", (chunk) => {
    output = (output + chunk).slice(-4000);
  });
  child.stderr.on("data", (chunk) => {
    output = (output + chunk).slice(-4000);
  });
  let target;
  await waitFor(
    async () => {
      if (child.exitCode !== null) throw new Error(output);
      try {
        target = (
          await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
        ).find(
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
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await once(ws, "open");
  console.log("Continuation desktop CDP target ready");
  let sequence = 0;
  const pending = new Map();
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
    else entry.resolve(message.result);
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP ${method} timed out`));
      }, 10_000);
      timer.unref();
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails)
      throw new Error(result.exceptionDetails.exception?.description);
    return result.result.value;
  };
  await send("Page.enable");
  return { child, ws, send, evaluate, output: () => output };
}

async function close() {
  const child = electronChild;
  try {
    session?.ws.close();
  } finally {
    session = null;
    electronChild = null;
    if (child && child.exitCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await Promise.race([exited, delay(15_000)]);
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await Promise.race([exited, delay(5_000)]);
      }
    }
  }
}

async function click(selector) {
  let point;
  await waitFor(
    async () => {
      point = await session.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el || el.disabled) return null;
      el.scrollIntoView({ block: 'nearest' });
      const rect = el.getBoundingClientRect();
      const x = Math.round(rect.left + rect.width / 2);
      const y = Math.round(rect.top + rect.height / 2);
      return el.contains(document.elementFromPoint(x, y)) ? { x, y } : null;
    })()`);
      return !!point;
    },
    10_000,
    `clickable ${selector}`,
  );
  assert.ok(point, `clickable ${selector}`);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await session.send("Input.dispatchMouseEvent", {
      type,
      ...point,
      button: "left",
      clickCount: 1,
    });
  }
}

async function openSettings() {
  try {
    await waitFor(
      () =>
        session.evaluate(`!!document.querySelector('[data-nav="settings"]')`),
      15_000,
      "settings navigation",
    );
    await waitFor(
      () => session.evaluate(`!document.querySelector('.startup-splash')`),
      20_000,
      "startup splash exit",
    );
  } catch (error) {
    await screenshot("continuation-navigation-failure.png").catch(
      (captureError) => {
        console.error(
          "navigation failure screenshot unavailable",
          captureError,
        );
      },
    );
    const state = await session.evaluate(
      `({ title: document.title, body: document.body.innerText.slice(0, 1500), nav: [...document.querySelectorAll('[data-nav]')].map(el => el.dataset.nav) })`,
    );
    throw new Error(`${error.message}: ${JSON.stringify(state)}`);
  }
  await click('[data-nav="settings"]');
  await waitFor(
    () =>
      session.evaluate(
        `(() => { const el = [...document.querySelectorAll("button")].find(el => el.textContent.trim() === "Behavior"); if (!el) return false; el.click(); return true; })()`,
      ),
    10000,
    "Behavior navigation",
  );
  try {
    await waitFor(
      () =>
        session.evaluate(
          `!!document.querySelector('button[aria-label="Continue after background jobs"]')`,
        ),
      10_000,
      "continuation setting",
    );
  } catch (error) {
    await screenshot("continuation-setting-failure.png");
    const state = await session.evaluate(
      `({ body: document.body.innerText.slice(0, 1500), switches: [...document.querySelectorAll('[role="switch"]')].map(el => el.getAttribute('aria-label')) })`,
    );
    throw new Error(`${error.message}: ${JSON.stringify(state)}`);
  }
  console.log("Continuation Settings page ready");
}

async function setting() {
  return session.evaluate(`(async () => {
    const r = await window.piDesktop.invoke(window.piDesktop.channels.invoke.settingsGet);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    return r.data.backgroundJobContinuationEnabled;
  })()`);
}

async function screenshot(name) {
  if (!evidence) return;
  const result = await session.send("Page.captureScreenshot", {
    format: "png",
  });
  writeFileSync(join(evidence, name), Buffer.from(result.data, "base64"));
}

async function centerControls() {
  await session.evaluate(`document.querySelector('button[aria-label="Continue after background jobs"]')
    ?.closest('.settings-card-block')?.scrollIntoView({ block: 'center', behavior: 'instant' })`);
}

const toggle = 'button[aria-label="Continue after background jobs"]';
try {
  session = await launch();
  await openSettings();
  assert.equal(await setting(), false);
  await centerControls();
  await screenshot("01-default-off.png");
  await click(toggle);
  await waitFor(
    async () => (await setting()) === true,
    5000,
    "continuation enabled",
  );
  await screenshot("02-enabled.png");
  await session.evaluate(
    `[...document.querySelectorAll('button')].find(el=>el.textContent.includes('Back to app'))?.click()`,
  );
  await waitFor(
    () => session.evaluate("!!window.__PI_DESKTOP__"),
    10000,
    "renderer state",
  );
  await session.evaluate(
    `window.__PI_DESKTOP__.refreshProviders().then(()=>window.__PI_DESKTOP__.selectSession(${JSON.stringify(owner.id)}))`,
  );
  const invoke = (key, ...args) =>
    session.evaluate(
      `piDesktop.invoke(piDesktop.channels.invoke[${JSON.stringify(key)}],...${JSON.stringify(args)})`,
    );
  const launched = await invoke("agentPrompt", {
    sessionId: owner.id,
    content:
      "Run the shipping test in the background and continue after it finishes.",
    viewingSessionId: owner.id,
  });
  assert.equal(launched.ok, true, JSON.stringify(launched));
  await waitFor(
    () => {
      if (fixtureFailure) throw fixtureFailure;
      return round === 2;
    },
    20000,
    "first turn final response",
  );
  await waitFor(
    () =>
      session.evaluate(
        `document.body.innerText.includes('This turn is complete')`,
      ),
    10000,
    "first turn visible",
  );
  await delay(1000);
  await click('.dock-toggle[aria-expanded="false"]');
  await waitFor(
    () =>
      session.evaluate(
        `!!document.querySelector(".task-row") && document.body.innerText.includes("Continue when finished")`,
      ),
    10000,
    "pending continuation row",
  );
  await delay(400);
  await screenshot("03-turn-ended-job-running.png");
  writeFileSync(join(project, "release"), "ready");
  await waitFor(
    () => {
      if (fixtureFailure) throw fixtureFailure;
      return round === 3;
    },
    20000,
    "automatic continuation",
  );
  await waitFor(
    () =>
      session.evaluate(
        `document.body.innerText.includes('Automatically resumed after')`,
      ),
    10000,
    "continuation visible",
  );
  await delay(1000);
  await screenshot("04-automatically-resumed.png");
  await delay(500);
  assert.equal(round, 3);
  writeFileSync(
    join(project, "waiting.cjs"),
    "const fs=require('fs');const t=setInterval(()=>{if(!fs.existsSync('release-second'))return;clearInterval(t);console.log('second test finished');},50)",
  );
  assert.equal(
    (
      await invoke("agentPrompt", {
        sessionId: owner.id,
        content: "Run a second background test with continuation.",
        viewingSessionId: owner.id,
      })
    ).ok,
    true,
  );
  await waitFor(
    () => {
      if (fixtureFailure) throw fixtureFailure;
      return round === 5;
    },
    20000,
    "second launch",
  );
  await waitFor(
    () =>
      session.evaluate(
        `document.body.innerText.includes('second test is running')`,
      ),
    10000,
    "second final response",
  );
  await session.evaluate(
    `document.querySelector('.dock-toggle[aria-expanded="false"]')?.click()`,
  );
  await waitFor(
    () =>
      session.evaluate(
        `(() => { const b=[...document.querySelectorAll('button')].find(el=>el.textContent.trim()==='Cancel continuation');if(!b)return false;b.click();return true;})()`,
      ),
    10000,
    "cancel button",
  );
  await waitFor(
    async () => {
      const r = await invoke("backgroundTasksList");
      return (
        r.data.tasks.find((t) => t.id === cancelledJob.id)?.continuation ===
        "cancelled"
      );
    },
    10000,
    "cancel continuation",
  );
  const cancelled = (await invoke("backgroundTasksList")).data.tasks.find(
    (t) => t.id === cancelledJob.id,
  );
  assert.equal(cancelled.state, "running");
  await screenshot("05-cancelled-process-still-running.png");
  writeFileSync(join(project, "release-second"), "ready");
  await waitFor(
    async () => {
      const r = await invoke("backgroundTasksList");
      return (
        r.data.tasks.find((t) => t.id === cancelledJob.id)?.state === "exited"
      );
    },
    10000,
    "cancelled job exits normally",
  );
  await delay(500);
  assert.equal(round, 5, "cancelled continuation never starts a model turn");
  console.log(
    JSON.stringify({
      ok: true,
      evidence,
      rounds: round,
      checks: [
        "real Electron default-off setting",
        "UI toggle persisted through real Host",
        "real sidecar automatic continuation after original turn ended",
        "same job exit code and final output",
        "one user message and one automatic turn",
        "cancel continuation keeps process running and prevents model restart",
      ],
    }),
  );
} finally {
  try {
    await close();
  } finally {
    await new Promise((resolve) => provider.close(resolve));
  }
}
