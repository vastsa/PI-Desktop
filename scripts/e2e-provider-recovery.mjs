import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { resolveElectronBinary } from "./e2e/boot.mjs";
import { resolveHostBinary } from "./e2e/host.mjs";
import { verifyProviderRecovery } from "./e2e/provider-recovery-assertions.mjs";

const root = resolve(import.meta.dirname, "..");
const artifacts = join(root, ".artifacts", "issue-699", String(Date.now()));
await mkdir(join(artifacts, "workspace"), { recursive: true });
await writeFile(
  join(artifacts, "workspace", "fixture.txt"),
  "Network retry test fixture.\n",
);
const results = [];
let scenario;
const server = createServer(async (req, res) => {
  let raw = "";
  for await (const part of req) raw += part;
  if (req.method !== "POST" || !scenario) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "network-fixture", object: "model" }] }));
    return;
  }
  const body = JSON.parse(raw);
  const nth = ++scenario.count;
  const toolResults = body.messages?.filter((m) => m.role === "tool").length ?? 0;
  scenario.requests.push({ nth, at: Date.now(), path: req.url, toolResults });
  console.log("REQUEST", scenario.name, nth, "tools", toolResults);
  if (
    scenario.mode === "always" ||
    (scenario.mode === "recover" && nth <= 2) ||
    (scenario.mode === "cumulative" && nth % 2 === 1)
  ) {
    req.socket.destroy();
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const chunk = (delta, finish_reason = null) =>
    res.write(
      `data: ${JSON.stringify({ id: "chatcmpl-fixture", object: "chat.completion.chunk", created: 1, model: "network-fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
    );
  if (scenario.style === "responses") {
    const response = {
      id: "resp_fixture",
      object: "response",
      status: "in_progress",
      model: "network-fixture",
      output: [],
    };
    const emit = (type, fields) =>
      res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
    const item = {
      id: "msg_fixture",
      type: "message",
      role: "assistant",
      status: "in_progress",
      content: [],
    };
    emit("response.created", { response });
    emit("response.output_item.added", { output_index: 0, item });
    emit("response.content_part.added", {
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    });
    emit("response.output_text.delta", {
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      delta: "RECOVERED_699",
    });
    item.status = "completed";
    item.content = [{ type: "output_text", text: "RECOVERED_699", annotations: [] }];
    emit("response.output_text.done", {
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      text: "RECOVERED_699",
    });
    emit("response.output_item.done", { output_index: 0, item });
    emit("response.completed", {
      response: {
        ...response,
        status: "completed",
        output: [item],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      },
    });
    res.end();
  } else if (scenario.mode === "stream" && nth === 1) {
    chunk({ role: "assistant", content: "PARTIAL_699" });
    // Wait for the screenshot observer to confirm partial content reached the UI.
    scenario.breakStream = () => res.destroy();
  } else if (scenario.mode === "cumulative" && toolResults < 11) {
    chunk({
      role: "assistant",
      tool_calls: [
        {
          index: 0,
          id: `call_${toolResults}`,
          type: "function",
          function: {
            name: "Read",
            arguments: JSON.stringify({
              path: join(artifacts, "workspace", "fixture.txt"),
            }),
          },
        },
      ],
    });
    chunk({}, "tool_calls");
    res.end("data: [DONE]\n\n");
  } else {
    chunk({ role: "assistant", content: "RECOVERED_699" });
    chunk({}, "stop");
    res.end("data: [DONE]\n\n");
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const providerPort = server.address().port;
const debugServer = createServer();
await new Promise((r) => debugServer.listen(0, "127.0.0.1", r));
const debugPort = debugServer.address().port;
await new Promise((r) => debugServer.close(r));
const { appDir, electronBinary } = resolveElectronBinary(root);
const env = {
  ...process.env,
  PI_DESKTOP_DATA_DIR: join(artifacts, "data"),
  PI_DESKTOP_HOST_BIN: resolveHostBinary(),
  ELECTRON_RENDERER_URL: "",
  PI_DESKTOP_START_MAXIMIZED: "0",
};
delete env.ELECTRON_RUN_AS_NODE;
for (const key of [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
])
  delete env[key];
env.NO_PROXY = "localhost,127.0.0.1";
let output = "";
const child = spawn(
  electronBinary,
  [
    `--remote-debugging-port=${debugPort}`,
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    `--user-data-dir=${join(artifacts, "profile")}`,
    ".",
  ],
  { cwd: appDir, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
);
child.stdout.on("data", (b) => (output += b));
child.stderr.on("data", (b) => (output += b));
let ws;
let seq = 0;
const pending = new Map();
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP timeout ${method}`));
    }, 30000);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  const retained = `globalThis.__cdpPromise699 = (async () => { return eval(${JSON.stringify(expression)}); })()`;
  const result = await send("Runtime.evaluate", {
    expression: retained,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
};
async function waitFor(fn, label, timeout = 45000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    if (child.exitCode !== null)
      throw new Error(`Electron exited: ${output.slice(-3000)}`);
    try {
      const value = await fn();
      if (value) return value;
    } catch (e) {
      last = e;
    }
    await delay(100);
  }
  throw new Error(`Timed out: ${label}; ${last ?? ""}`);
}
async function ipc(name, ...args) {
  const result = await evaluate(
    `window.piDesktop.invoke(window.piDesktop.channels.invoke[${JSON.stringify(name)}], ...${JSON.stringify(args)})`,
  );
  assert.equal(result.ok, true, `${name}: ${JSON.stringify(result)}`);
  return result.data;
}
async function screenshot(name) {
  const shot = await send("Page.captureScreenshot", { format: "png" });
  await writeFile(join(artifacts, `${name}.png`), Buffer.from(shot.data, "base64"));
}
const bodyText = () => evaluate("document.body.innerText");
async function run(name, mode, style = "chat_completions") {
  scenario = { name, mode, style, count: 0, requests: [] };
  const provider = await ipc("providersCreate", {
    name,
    vendorKey: "custom",
    type: "openai_compatible",
    protocol: "openai_compatible",
    baseUrl: `http://127.0.0.1:${providerPort}/v1`,
    authKind: "api_key_and_base_url",
    secretValue: "local-fixture-only",
    defaultModelId: "network-fixture",
    apiStyle: style,
    supportsReasoning: false,
    contextWindow: 128000,
    maxOutputTokens: 4096,
  });
  const { session } = await ipc("sessionCreate", {
    title: name,
    mode: "agent",
    projectPath: join(artifacts, "workspace"),
    providerId: provider.provider.id,
    modelId: "network-fixture",
    thinkingLevel: "off",
  });
  await evaluate(`window.__PI_DESKTOP__.refreshProviders()`);
  await evaluate(`window.__PI_DESKTOP__.selectSession(${JSON.stringify(session.id)})`);
  await evaluate(
    `window.__events699 = []; window.__off699?.(); window.__off699 = window.piDesktop.on(window.piDesktop.channels.event.agentMessage, e => window.__events699.push(e));`,
  );
  await waitFor(
    () => evaluate('Boolean(document.querySelector(".composer-input"))'),
    "composer",
  );
  await evaluate(
    `(() => { const input = document.querySelector('.composer-input'); input.focus(); input.textContent = 'Test network recovery ${name}'; input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: input.textContent })); })()`,
  );
  await waitFor(
    () =>
      evaluate(
        `Boolean(document.querySelector('.composer-shell .send-btn:not(:disabled)'))`,
      ),
    "send enabled",
  );
  await evaluate(`document.querySelector('.composer-shell .send-btn').click()`);
  let retryShot = false;
  const statuses = [];
  await waitFor(
    async () => {
      const text = await bodyText();
      if (scenario.breakStream && text.includes("PARTIAL_699")) {
        await screenshot(`${name}-partial`);
        scenario.breakStream();
        scenario.breakStream = undefined;
      }
      if (/重试|Retrying/.test(text) && !retryShot) {
        retryShot = true;
        statuses.push(text);
        await screenshot(`${name}-retry`);
      }
      const events = await evaluate("window.__events699");
      return events.some(
        (e) => e.sessionId === session.id && e.event?.type === "agent_end",
      );
    },
    `${name} terminal lifecycle`,
    150000,
  );
  await waitFor(async () => {
    const detail = await ipc("sessionGet", { id: session.id });
    return detail.session?.messages?.some(
      (m) =>
        m.role === "assistant" &&
        (m.status === "error" || m.content?.includes("RECOVERED_699")),
    );
  }, "durable final assistant");
  // Windows may occlude the test window during a long outage. Bring the
  // rendered surface forward before checking the final user-visible state.
  await send("Page.bringToFront");
  await screenshot(`${name}-settled`);
  await waitFor(async () => {
    const text = await bodyText();
    return mode === "always"
      ? text.includes("NETWORK_ERROR")
      : text.includes("RECOVERED_699");
  }, "final UI");
  await screenshot(`${name}-final`);
  const detail = await ipc("sessionGet", { id: session.id });
  const events = await evaluate("window.__events699");
  const text = await bodyText();
  const record = {
    name,
    mode,
    style,
    sessionId: session.id,
    requests: [...scenario.requests],
    retryShot,
    statuses,
    text,
    detail,
    events,
  };
  results.push(record);
  await writeFile(join(artifacts, "results.json"), JSON.stringify(results, null, 2));
  const errors = events.filter((e) => e.event?.type === "error");
  console.log(
    "RESULT",
    JSON.stringify({
      name,
      requests: scenario.count,
      retryShot,
      errors: errors.map((e) => e.event.error),
      text: text.slice(-450),
    }),
  );
  return record;
}

async function continueAfterFailure(record) {
  scenario.mode = "success";
  await evaluate("window.__events699 = []");
  const clicked = await evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find(node => node.textContent.trim() === '继续');
    if (!button) return false;
    button.click(); return true;
  })()`);
  assert(clicked, "Continue is reachable on the terminal error card");
  await waitFor(async () => {
    const events = await evaluate("window.__events699");
    return (
      events.some(
        (e) => e.sessionId === record.sessionId && e.event?.type === "agent_end",
      ) && (await bodyText()).includes("RECOVERED_699")
    );
  }, "Continue completes after provider recovery");
  await screenshot(`${record.name}-continued`);
  record.continuation = {
    requests: scenario.count - record.requests.length,
    events: await evaluate("window.__events699"),
    text: await bodyText(),
  };
  assert.equal(record.continuation.requests, 1);
  assert(!record.continuation.events.some((e) => e.event?.type === "error"));
  await writeFile(join(artifacts, "results.json"), JSON.stringify(results, null, 2));
}
try {
  const target = await waitFor(async () => {
    const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
    return list.find(
      (t) =>
        t.type === "page" &&
        t.url.includes("index.html") &&
        !t.url.includes("launcher") &&
        !t.url.includes("plugin"),
    );
  }, "desktop CDP");
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    const p = pending.get(data.id);
    if (!p) return;
    pending.delete(data.id);
    clearTimeout(p.timer);
    if (data.error) p.reject(new Error(JSON.stringify(data.error)));
    else p.resolve(data.result);
  };
  await waitFor(
    () =>
      evaluate(
        'Boolean(window.__PI_DESKTOP__ && window.piDesktop && !document.querySelector(".app-shell.is-booting"))',
      ),
    "desktop ready",
  );
  const settings = await ipc("settingsGet");
  await ipc("settingsSet", { ...settings, language: "zh-CN", autoGenerateTitle: false });
  console.log("ARTIFACTS", artifacts);
  await run("01-network-recovery", "recover");
  await run("02-stream-recovery", "stream");
  await run("03-responses-recovery", "recover", "responses");
  await continueAfterFailure(await run("04-network-exhaustion", "always"));
  await run("05-cumulative-budget", "cumulative");
  const summary = verifyProviderRecovery(results);
  await writeFile(
    join(artifacts, "verified-summary.json"),
    JSON.stringify(summary, null, 2),
  );
  console.log("VERIFIED", JSON.stringify(summary));
} catch (error) {
  console.error(error);
  if (ws?.readyState === 1) {
    await screenshot("failure").catch(() => {});
    console.error(await bodyText().catch(() => ""));
    await writeFile(
      join(artifacts, "failure-events.json"),
      JSON.stringify(
        (await evaluate("window.__events699").catch(() => null)) ?? null,
        null,
        2,
      ),
    );
  }
  process.exitCode = 1;
} finally {
  await writeFile(join(artifacts, "electron.log"), output);
  console.log("ARTIFACTS", artifacts);
  ws?.close();
  if (child.exitCode === null) {
    if (process.platform === "win32")
      await new Promise((r) => {
        const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
        killer.on("exit", r);
      });
    else {
      // On macOS the Electron app can outlive the launcher after SIGTERM and
      // keep the isolated profile lock held. This process belongs to the
      // fixture, so force cleanup after the recovery assertions finish.
      child.kill(process.platform === "darwin" ? "SIGKILL" : "SIGTERM");
    }
  }
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
}
