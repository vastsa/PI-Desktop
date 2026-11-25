#!/usr/bin/env node
// Exercise the built desktop and its real Host and sidecar with a local
// provider. Chromium and proxy-aware child traffic cannot reach the internet.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { bindingForCustomModel, IPC } from "../packages/shared/dist/index.js";
import { assertDesktopBuild, resolveElectronBinary } from "./e2e/boot.mjs";
import { Host, resolveHostBinary } from "./e2e/host.mjs";

// Check strace output from the whole process tree in a loopback-only Linux
// network namespace. TCP connects and datagram sends count even if they fail.
if (process.argv[2] === "--check-egress-trace") {
  const trace = await readFile(process.argv[3], "utf8");
  let loopback = 0;
  let routeChecks = 0;
  const outside = [];
  for (const line of trace.split("\n")) {
    // A connected datagram socket can send using write() without a sockaddr.
    for (const [, ip] of line.matchAll(/<UDPv6:[^>]*->\[([^\]]+)\]:\d+\]>/g)) {
      if (!/^(?:(?:::ffff:)?127\.|::1$)/i.test(ip)) outside.push(ip);
    }
    const families = line.match(/\bsa_family=AF_INET6?\b/g);
    if (!families) continue;
    const addresses = [...line.matchAll(/inet_addr\("([^"]+)"\)|inet_pton\(AF_INET6, "([^"]+)"/g)];
    assert.equal(addresses.length, families.length, "Unrecognized network address: " + line);
    for (const [, ipv4, ipv6] of addresses) {
      const ip = ipv4 ?? ipv6;
      if (/^(?:(?:::ffff:)?127\.|::1$)/i.test(ip)) loopback++;
      // Chromium uses UDP connect to inspect the kernel's IPv6 route. It
      // emits no packet; any send to that address is still treated as egress.
      else if (ip === "2001:4860:4860::8888" && /\bconnect\(\d+<UDPv6:.*sin6_port=htons\(443\)/.test(line)) {
        routeChecks++;
      } else outside.push(ip);
    }
  }
  assert.deepEqual([...new Set(outside)], [], "Non-loopback network attempts");
  assert.ok(loopback > 0, "Trace did not capture any loopback traffic");
  console.log(`PASS process-tree network trace: only loopback requests (${routeChecks} IPv6 route checks)`);
  process.exit(0);
}

if (process.argv.includes("--require-isolated-network")) {
  assert.equal(process.platform, "linux", "Network isolation check requires Linux");
  assert.ok(Object.values(networkInterfaces()).flat().every((address) => address.internal),
    "Use a network namespace with only loopback enabled");
}

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return "http://127.0.0.1:" + server.address().port;
}

async function until(check, label) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const value = await check();
    if (value) return value;
    await delay(200);
  }
  throw new Error("Timed out: " + label);
}

const model = "fixture-discovered";
const manualModel = "fixture-manual";
const marker = "offline-local-file-marker";
const finished = "Read finished without internet";
const mcpName = "local_echo";
const mcpTestName = "connection_probe";
const mcpToolNames = [mcpName];
const mcpTool = "mcp_intranet_local_echo";
const mcpCallId = "call_intranet_mcp";
const mcpPrompt = "Read the intranet fixture marker.";
const mcpMarker = "intranet-mcp-tool-result";
const mcpFinished = "Intranet tool call completed";
const modelRequests = [];
const mcpModelRequests = [];
const blocked = [];
const marketRequests = [];
const mcpRequests = [];
const savedKey = "intranet-fixture-key";
let savedDiscoveryRequests = 0;
const probeHost = "pie-code-offline.invalid";
const provider = createServer(async (req, res) => {
  const json = (body) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(body));
  };
  if (req.url === "/market-sentinel") {
    marketRequests.push(req.url);
    return json({ plugins: [] });
  }
  if (req.url === "/mcp") {
    if (req.method !== "POST") return res.writeHead(405).end();
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    mcpRequests.push(message.method);
    if (message.id === undefined) return res.writeHead(202).end();
    const reply = { jsonrpc: "2.0", id: message.id };
    if (message.method === "initialize") return json({ ...reply, result: {
      protocolVersion: message.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "Internal MCP fixture", version: "1" },
    } });
    if (message.method === "ping") return json({ ...reply, result: {} });
    if (message.method === "tools/list") return json({ ...reply, result: {
      tools: mcpToolNames.map((name) => ({ name, inputSchema: { type: "object", properties: {} } })),
    } });
    if (message.method === "tools/call" && message.params.name === mcpName) return json({ ...reply, result: {
      content: [{ type: "text", text: mcpMarker }],
    } });
    return json({ ...reply, error: { code: -32601, message: "Unexpected MCP request" } });
  }
  if (req.url === "/v1/models") {
    if (req.headers.authorization === "Bearer " + savedKey) savedDiscoveryRequests++;
    modelRequests.push("models");
    return json({ data: [{ id: model }] });
  }
  if (req.url !== "/v1/chat/completions") {
    res.writeHead(404).end();
    return;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  modelRequests.push(request);
  const latestPrompt = request.messages.findLast((message) => message.role === "user");
  const isMcpTurn = JSON.stringify(latestPrompt?.content ?? "").includes(mcpPrompt);
  if (isMcpTurn) mcpModelRequests.push(request);
  const sawTool = request.messages.at(-1)?.role === "tool";
  const toolName = isMcpTurn ? mcpTool : "read";
  const tool = request.tools?.find((entry) => entry.function?.name?.toLowerCase() === toolName);
  const delta = sawTool
    ? { role: "assistant", content: isMcpTurn ? mcpFinished : finished }
    : {
        role: "assistant",
        tool_calls: [{
          index: 0, id: isMcpTurn ? mcpCallId : "call_local_read", type: "function",
          function: { name: tool?.function.name ?? toolName, arguments: JSON.stringify(isMcpTurn ? {} : { path: "note.txt" }) },
        }],
      };
  const frame = (change, reason) => "data: " + JSON.stringify({
    id: "offline-test", object: "chat.completion.chunk", created: 1, model: request.model,
    choices: [{ index: 0, delta: change, finish_reason: reason }],
  }) + "\n\n";
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.end(frame(delta, null) + frame({}, sawTool ? "stop" : "tool_calls") + "data: [DONE]\n\n");
});
const proxy = createServer((req, res) => {
  blocked.push(req.url);
  res.writeHead(502).end();
});
proxy.on("connect", (req, socket) => {
  blocked.push(req.url);
  socket.end("HTTP/1.1 502 Offline\r\n\r\n");
});

const installed = process.env.PI_CODE_E2E_APP_BIN && resolve(process.env.PI_CODE_E2E_APP_BIN);
const { appDir, electronBinary } = installed
  ? { appDir: dirname(installed), electronBinary: installed }
  : { ...assertDesktopBuild(), ...resolveElectronBinary() };
const hostBinary = resolveHostBinary();
const scratch = await realpath(await mkdtemp(join(tmpdir(), "pie-code-offline-")));
const workspace = join(scratch, "offline-test-project");
let app;
let socket;
let output = "";
try {
  await mkdir(workspace);
  await writeFile(join(workspace, "note.txt"), marker + "\n");
  const [providerUrl, proxyUrl] = await Promise.all([listen(provider), listen(proxy)]);
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    DISPLAY: process.env.DISPLAY,
    XAUTHORITY: process.env.XAUTHORITY,
    HOME: scratch,
    USERPROFILE: scratch,
    PI_DESKTOP_DATA_DIR: join(scratch, "data"),
    PI_DESKTOP_HOST_BIN: hostBinary,
    PI_CODING_AGENT_DIR: join(scratch, "agent"),
    PI_DESKTOP_PLUGIN_MARKET_URL: providerUrl + "/market-sentinel",
    ELECTRON_RENDERER_URL: "",
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    ALL_PROXY: proxyUrl,
    NO_PROXY: "127.0.0.1,localhost",
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    all_proxy: proxyUrl,
    no_proxy: "127.0.0.1,localhost",
    NODE_USE_ENV_PROXY: "1",
  };
  // Set the fixture proxy through the same settings that boot applies to
  // Chromium. An inherited process proxy alone would miss browser traffic.
  let legacyProviderId;
  let savedTaskId;
  const setupHost = new Host(hostBinary, env.PI_DESKTOP_DATA_DIR, {
    env: { ...env, PI_DESKTOP_DISABLE_PLUGIN_MARKET: "1", PI_DESKTOP_DISABLE_SCHEDULED_TASKS: "0" }, quiet: true,
  });
  try {
    await setupHost.start();
    await setupHost.call("workspace.set", { path: workspace });
    await setupHost.call("settings.set", {
      closeBehavior: "quit",
      language: "en",
      scheduledTasksEnabled: true,
      defaultPermissionMode: "auto",
      networkProxy: { mode: "custom", url: proxyUrl, bypass: "127.0.0.1,localhost" },
    });
    const { provider: legacy } = await setupHost.call("providers.create", {
      name: "Saved intranet provider", vendorKey: "openai", baseUrl: providerUrl + "/v1",
      authKind: "api_key_and_base_url", apiStyle: "responses", secretValue: savedKey,
      defaultModelId: model, models: [bindingForCustomModel(model)],
    });
    legacyProviderId = legacy.id;
    await setupHost.call("providers.create", {
      name: "Previously enabled public provider", vendorKey: "custom",
      baseUrl: "https://previous-provider.invalid/v1", authKind: "none",
      apiStyle: "chat_completions", defaultModelId: model, models: [bindingForCustomModel(model)],
    });
    const { task } = await setupHost.call("scheduled.create", {
      title: "Existing schedule", prompt: "Keep this record", cadence: "manual",
    });
    savedTaskId = task.id;
  } finally {
    await setupHost.stop();
  }
  const offlineHost = new Host(hostBinary, env.PI_DESKTOP_DATA_DIR, {
    env: { ...env, PI_DESKTOP_DISABLE_PLUGIN_MARKET: "1", PI_DESKTOP_DISABLE_SCHEDULED_TASKS: "1" }, quiet: true,
  });
  try {
    await offlineHost.start();
    const { tools } = await offlineHost.call("tools.list");
    assert.ok(tools.every((tool) => !/^ScheduledTask/.test(tool.name)));
    const { session: savedSession } = await offlineHost.call("session.create", { mode: "agent", projectPath: workspace });
    const denied = await offlineHost.call("tools.execute", {
      sessionId: savedSession.id, toolCallId: "offline-schedule", toolName: "ScheduledTaskCreate", mode: "agent",
      args: { title: "Must not persist", prompt: "No run", cadence: "manual" },
    });
    assert.equal(denied.ok, false);
    assert.equal(denied.errorCode, "INVALID_PARAMS");
    const { tasks } = await offlineHost.call("scheduled.list");
    assert.deepEqual(tasks.map((task) => task.id), [savedTaskId]);
    assert.equal((await offlineHost.call("settings.get")).scheduledTasksEnabled, true);
  } finally {
    await offlineHost.stop();
  }
  app = spawn(electronBinary, [
    "--remote-debugging-port=0",
    "--user-data-dir=" + join(scratch, "profile"),
    "--proxy-server=" + proxyUrl,
    ...(installed ? [] : ["."]),
  ], { cwd: appDir, env, stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(app, "exit");
  for (const stream of [app.stdout, app.stderr]) stream.on("data", (chunk) => { output += chunk; });
  const endpoint = await until(() => {
    if (app.exitCode !== null) throw new Error("Desktop exited during startup");
    return /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(output)?.[1];
  }, "desktop debugger");
  const renderer = await until(async () => {
    const pages = await fetch("http://127.0.0.1:" + endpoint + "/json/list").then((res) => res.json());
    return pages.find((page) => page.type === "page" && /renderer\/index\.html$/.test(page.url));
  }, "desktop renderer");

  socket = new WebSocket(renderer.webSocketDebuggerUrl);
  await once(socket, "open");
  let sequence = 0;
  const cdp = async (method, params) => {
    const id = ++sequence;
    const result = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        socket.removeEventListener("message", receive);
        reject(new Error("Desktop evaluation timed out"));
      }, 10_000);
      const receive = (event) => {
        const reply = JSON.parse(event.data);
        if (reply.id !== id) return;
        clearTimeout(timeout);
        socket.removeEventListener("message", receive);
        resolve(reply);
      };
      socket.addEventListener("message", receive);
      socket.send(JSON.stringify({ id, method, params }));
    });
    assert.ok(result.result && !result.result.exceptionDetails, JSON.stringify(result));
    return result.result;
  };
  const evaluate = async (expression) => (await cdp("Runtime.evaluate", {
    expression, awaitPromise: true, returnByValue: true,
  })).result.value;
  const wire = (channel, ...args) =>
    evaluate("window.piDesktop.invoke(..." + JSON.stringify([channel, ...args]) + ")");
  const invoke = async (channel, ...args) => {
    const result = await wire(channel, ...args);
    assert.equal(result.ok, true, channel + ": " + JSON.stringify(result.error));
    return result.data;
  };
  const clickText = (selector, label) => until(() => evaluate(
    "(() => { const button = Array.from(document.querySelectorAll(" + JSON.stringify(selector) + "))" +
    ".find(el => !el.disabled && el.textContent.trim() === " + JSON.stringify(label) + ");" +
    "if (!button) return false; button.click(); return true; })()",
  ), label);
  await until(async () => (await wire(IPC.invoke.appGetVersion)).data?.hostVersion, "healthy host");
  const status = await invoke(IPC.invoke.providersModelCatalogStatus);
  assert.equal(status.status.source, "bundled");
  assert.ok(status.status.modelCount > 0);
  assert.equal((await invoke(IPC.invoke.providersRefreshModelCatalog)).refreshed, false);
  assert.equal((await invoke(IPC.invoke.updatesGetState)).mode, "disabled");
  for (const channel of [
    IPC.invoke.updatesCheck, IPC.invoke.updatesOpenReleases, IPC.invoke.marketBrowse,
    IPC.invoke.mcpMarketSearch, IPC.invoke.skillMarketSearch, IPC.invoke.providersOauthStart,
    IPC.invoke.scheduledList, IPC.invoke.liveVoiceStatus, IPC.invoke.computerCapabilities,
  ]) assert.equal((await wire(channel)).ok, false, channel);

  await invoke(IPC.invoke.projectSet, workspace);
  const { provider: configured } = await invoke(IPC.invoke.providersCreate, {
    name: "Offline fixture", vendorKey: "custom", baseUrl: providerUrl + "/v1",
    authKind: "none", apiStyle: "chat_completions", defaultModelId: manualModel,
    models: [bindingForCustomModel(manualModel)],
  });
  const discovered = await invoke(IPC.invoke.providersListModels, {
    providerId: configured.id, source: "refresh",
  });
  assert.ok(discovered.models.some((entry) => entry.modelId === model), JSON.stringify(discovered));

  const { session } = await invoke(IPC.invoke.sessionCreate, {
    title: "Offline coding", projectPath: workspace, mode: "agent",
    providerId: configured.id, modelId: manualModel,
  });
  await invoke(IPC.invoke.agentPrompt, { sessionId: session.id, content: "Read note.txt." });
  await until(async () => {
    const current = await invoke(IPC.invoke.sessionGet, session.id);
    return JSON.stringify(current).includes(finished);
  }, "completed local coding turn");
  const [first, second] = modelRequests.filter((request) => typeof request === "object");
  assert.equal(first.model, manualModel);
  assert.ok(first.tools.every((tool) => !/^ScheduledTask/i.test(tool.function?.name ?? "")));
  assert.ok(first.tools.every((tool) => !/^mcp_/i.test(tool.function?.name ?? "")));
  assert.ok(second.messages.some((message) =>
    message.role === "tool" && JSON.stringify(message.content).includes(marker)));
  assert.ok(modelRequests.includes("models"));
  assert.deepEqual(mcpRequests, [], "Coding without MCP contacted the MCP fixture");

  await evaluate("document.querySelector('[data-surface=startup-guide] button[aria-label=Skip]')?.click()");
  await until(() => evaluate("Boolean(document.querySelector('.composer-model-thinking-chip'))"), "model picker");
  await evaluate("document.querySelector('.composer-model-thinking-chip').click()");
  await until(() => evaluate("Boolean(document.querySelector('.composer-model-rail'))"), "open model menu");
  await evaluate("document.querySelector('[data-nav=plugins]').click()");
  await until(() => evaluate("Boolean(document.getElementById('plugins-tab-installed'))"), "installed plugins view");
  assert.equal(await evaluate("Boolean(document.getElementById('plugins-tab-market'))"), false);
  assert.equal(await evaluate("Boolean(document.querySelector('[data-nav=scheduled]'))"), false);
  await evaluate("document.querySelector('[data-nav=settings]').click()");
  await clickText(".settings-nav-item", "Models");
  await until(() => evaluate(
    "(() => { const row = Array.from(document.querySelectorAll('.model-provider-list > li'))" +
    ".find(el => el.textContent.includes('Saved intranet provider')); if (!row) return false; row.click(); return true; })()",
  ), "open saved intranet provider");
  await until(() => evaluate(
    "Array.from(document.querySelectorAll('.provider-setup-fields input')).some(el => el.value === " +
    JSON.stringify(providerUrl + "/v1") + ")",
  ), "saved address in provider editor");
  await until(() => savedDiscoveryRequests > 0, "discovery using the saved key on the intranet fixture");
  await clickText(".provider-setup-head-actions button", "Save provider");
  await until(() => evaluate("!document.querySelector('.provider-setup-fields')"), "close saved provider editor");
  const savedProviders = await invoke(IPC.invoke.providersList);
  assert.equal(savedProviders.providers.find((entry) => entry.id === legacyProviderId).baseUrl, providerUrl + "/v1");
  await clickText(".settings-content button", "Add provider");
  await until(() => evaluate("Boolean(document.querySelector('[data-service-id=custom]'))"), "custom model service");
  assert.deepEqual(await evaluate(
    "Array.from(document.querySelectorAll('[data-service-id]'), el => el.dataset.serviceId)",
  ), ["custom"]);
  assert.equal(await evaluate(
    "Array.from(document.querySelectorAll('.settings-nav-item')).some(el => el.textContent.includes('Voice'))",
  ), false);
  await clickText(".provider-setup-dialog button", "Cancel");

  // Configure the HTTP MCP server through the same editor used for Milku.
  const click = (selector) => until(() => evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el || el.disabled) return false;
    el.click();
    return true;
  })()`), selector);
  const fill = (selector, value) => until(() => evaluate(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    if (!input) return false;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`), selector);
  await clickText(".settings-nav-item", "MCP");
  await until(() => evaluate(
    "document.querySelector('.agent-capability-project-select .settings-menu-select-trigger-label')?.textContent === 'offline-test-project'",
  ), "isolated project selected in MCP settings");
  await clickText(".settings-content button", "Add");
  await clickText(".ext-sheet [role=radio]", "HTTP endpoint");
  await fill('.ext-sheet input[placeholder="Context7"]', "Intranet");
  await fill('.ext-sheet input[placeholder="https://mcp.example.com/sse"]', providerUrl + "/mcp");
  await clickText(".ext-sheet button", "Save");
  await click('.settings-content button[aria-label="Edit Intranet"]');
  const mcpReady = (name) => evaluate(`document.querySelector(".ext-sheet [role=status].is-ready .ext-test-tools")
    ?.textContent.split(" · ").includes(${JSON.stringify(name)})`);
  await until(() => mcpReady(mcpName), "initial MCP connection after saving");
  // Only a fresh tools/list result can contain the extra tool.
  mcpToolNames.push(mcpTestName);
  await clickText(".ext-sheet button", "Test connection");
  await until(async () => await evaluate(`Array.from(document.querySelectorAll(".toast.success .toast-message"))
    .some(toast => toast.textContent === "Connected · 2 tools")`) && await mcpReady(mcpTestName),
    "completed manual MCP test with fresh tools");
  await click(".ext-sheet-close");
  await click(".settings-dialog-close");
  await click(`[data-sidebar-session-row="${session.id}"]`);
  await until(() => evaluate("Boolean(document.querySelector('.composer-input[contenteditable=true]'))"), "session composer");
  await click('.composer-permission button[aria-haspopup="menu"]');
  await clickText('.composer-permission-menu button[role="menuitemradio"]', "Ask every time");
  await until(() => evaluate("document.querySelector('.composer-permission .mode-chip')?.innerText.trim() === 'Ask every time'"),
    "session permission mode is Ask");
  const typeComposer = (text) => cdp("Input.insertText", { text });
  const command = `/mcp:intranet:${mcpName}`;
  const menuOpen = () => evaluate('Boolean(document.querySelector(".composer-autocomplete.is-open"))');
  await evaluate('document.querySelector(".composer-input").focus()');
  await typeComposer(command.slice(0, -1));
  await until(async () => {
    await until(menuOpen, "slash command menu");
    const selected = await evaluate(`(() => {
      const option = Array.from(document.querySelectorAll(".composer-autocomplete.is-open [role=option]"))
        .find(row => row.getClientRects().length &&
          row.querySelector(".composer-ac-name")?.textContent === ${JSON.stringify(command)});
      if (!option) return false;
      option.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      return true;
    })()`);
    if (selected) return true;
    // A just-opened menu can still use the catalog cached before MCP was saved.
    // Reopen through the editor so it can reload the catalog when that cache expires.
    await evaluate(`(() => {
      window.getSelection().selectAllChildren(document.querySelector(".composer-input"));
      document.execCommand("delete");
    })()`);
    await until(async () => !(await menuOpen()), "slash command menu closed");
    await typeComposer(command.slice(0, -1));
    return false;
  }, "select the discovered MCP tool from autocomplete");
  await until(() => evaluate(`document.querySelector(".composer-input")?.textContent.trim() === ${JSON.stringify(command)}`),
    "MCP menu inserted the full command");
  await typeComposer(mcpPrompt);
  await click(".send-btn");
  await until(() => evaluate(`document.querySelector(".permission-card")?.innerText.includes(${JSON.stringify(mcpTool)})`),
    "permission card for the MCP tool");
  const firstMcpRequest = mcpModelRequests[0];
  assert.deepEqual(
    firstMcpRequest?.tools?.map((tool) => tool.function?.name).filter((name) => /^mcp_/i.test(name ?? "")),
    [mcpTool],
    "First MCP turn request must expose only the selected MCP tool",
  );
  assert.ok(!mcpRequests.includes("tools/call"), "MCP ran before approval");
  await clickText(".permission-card button", "Allow once");
  await until(async () => JSON.stringify(await invoke(IPC.invoke.sessionGet, session.id)).includes(mcpFinished),
    "completed MCP turn");
  const toolRow = `.tool-row.status-success[data-message-id="${mcpCallId}"]`;
  await until(() => evaluate(`(() => {
    const row = document.querySelector(${JSON.stringify(toolRow)});
    if (!row) return false;
    for (const selector of [".turn-process", ".process-activity-group", ".tool-row"]) {
      const toggle = row.closest(selector)?.querySelector(
        ':scope > button[aria-expanded=false], :scope > .tool-row-head > button[aria-expanded=false]',
      );
      if (toggle && !toggle.disabled) {
        toggle.click();
        return false;
      }
    }
    const body = row.querySelector(".tool-row-body");
    return body?.getClientRects().length && body.innerText.includes(${JSON.stringify(mcpMarker)});
  })()`), "expand successful MCP tool row");
  assert.equal(mcpRequests.filter((method) => method === "tools/call").length, 1);
  assert.ok(mcpModelRequests.some((request) => request.messages?.some((message) =>
    message.role === "tool" && JSON.stringify(message.content).includes(mcpMarker))));

  // An explicit browser request to a reserved test domain proves the
  // rejecting proxy is really in Chromium's path. Test it after measuring
  // the default startup and coding requests.
  assert.deepEqual(marketRequests, [], "Host fetched the market catalog");
  assert.deepEqual(blocked, [], "outbound request attempted through the offline proxy");
  await wire(IPC.invoke.browserNavigate, { url: "https://" + probeHost + "/", sessionId: session.id });
  await until(() => blocked.some((request) => request === probeHost + ":443"), "offline proxy positive control");
  assert.ok(blocked.every((request) => request === probeHost + ":443"), JSON.stringify(blocked));
  socket.close();
  app.kill("SIGTERM");
  await Promise.race([exited, delay(5000, undefined, { ref: false })]);
} catch (error) {
  console.error(output.slice(-6000));
  throw error;
} finally {
  socket?.close();
  if (app && app.exitCode === null && app.signalCode === null) {
    const exited = once(app, "exit");
    app.kill("SIGKILL");
    await exited;
  }
  for (const server of [provider, proxy]) {
    server.close();
    server.closeAllConnections();
  }
  await rm(scratch, { recursive: true, force: true, maxRetries: 3 });
}
console.log("PASS offline boot, saved model editing, coding and MCP, and disabled scheduling");
