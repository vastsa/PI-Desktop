// MCP-control driver for the trusted extensions E2E run.
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { connectRenderer } from "./renderer.mjs";
import { connectRenderer as connectUiRenderer } from "../plugin-ui-slots/clients.mjs";
import { join } from "node:path";

const root = process.env.E2E_ROOT || "/tmp/pi-ext-e2e";
const dataDir = join(root, "data");
const project = process.env.E2E_PROJECT || "/private/tmp/pi-ext-e2e/project";
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
};

const info = JSON.parse(readFileSync(join(dataDir, "mcp-control.json"), "utf8"));
let mcpSession;
async function rpc(method, params) {
  const res = await fetch(info.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${info.token}`,
      "Content-Type": "application/json",
      ...(mcpSession ? { "Mcp-Session-Id": mcpSession } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
  });
  const sid = res.headers.get("mcp-session-id");
  if (sid) mcpSession = sid;
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}
async function tool(name, args = {}) {
  const result = await rpc("tools/call", { name, arguments: args });
  const text = result?.content?.find((c) => c.type === "text")?.text;
  if (result?.isError) throw new Error(`${name}: ${text}`);
  try { return JSON.parse(text); } catch { return text; }
}
const invoke = (channel, ...args) => tool("pi_desktop_invoke", { operation: channel, args }).then((r) => (r && typeof r === "object" && "result" in r ? r.result : r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function messageText(message) {
  const textFrom = (content) => {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("");
  };
  return textFrom(message?.content) || textFrom(message?.blocks);
}

function readRequests() {
  return readFileSync(join(root, "requests.jsonl"), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function waitForTurn(sessionId, turnId, timeoutMs = 60_000) {
  if (typeof turnId !== "string" || !turnId) throw new Error("prompt was not accepted with a turn id");
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const status = await tool("pi_agent_status", { sessionId });
    const runtimeStatus = status?.status ?? status;
    if (runtimeStatus?.currentTurnId === turnId && runtimeStatus.isRunning === false) return status;
    await sleep(500);
  }
  throw new Error(`turn ${turnId} did not finish`);
}

async function waitForReply(sessionId, userText) {
  const deadline = Date.now() + 10_000;
  let lastSummary = [];
  while (Date.now() < deadline) {
    const detail = await tool("pi_session_get", { id: sessionId });
    const messages = detail?.session?.messages ?? [];
    const index = messages.findLastIndex((message) => message.role === "user" && messageText(message) === userText);
    const reply = index < 0 ? undefined : messages.slice(index + 1).find((message) =>
      message.role === "assistant" && messageText(message).trim());
    if (messageText(reply)) return reply;
    lastSummary = messages.slice(-4).map((message) => ({
      role: message.role,
      keys: Object.keys(message),
      contentType: typeof message.content,
      contentLength: Array.isArray(message.content) ? message.content.length : undefined,
      blocks: Array.isArray(message.blocks) ? message.blocks.map((block) => block.type) : undefined,
    }));
    await sleep(50);
  }
  throw new Error(`Current turn reply was not persisted; recent messages: ${JSON.stringify(lastSummary)}`);
}

await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } });
await tool("pi_project_open", { path: project });
const created = await tool("pi_session_create", { title: "ext e2e", projectPath: project, mode: "agent" });
const sessionId = created?.session?.id ?? created?.id;
check("session created", !!sessionId, sessionId);

// 1) tool + hooks (E2E-242)
const firstPrompt = await tool("pi_agent_prompt", { sessionId, content: "please add 20 and 22" });
await waitForTurn(sessionId, firstPrompt?.turnId);
const firstReply = await waitForReply(sessionId, "please add 20 and 22");
let requests = readRequests();
const fxCall = requests.some((request) => request.payload.messages.some((message) =>
  message.role === "assistant" && message.tool_calls?.some((call) => call.function?.name === "fx_add")));
const fxResult = requests.flatMap((request) => request.payload.messages).find((message) =>
  message.role === "tool" && String(message.content).includes("42 (replaced)"));
check("fx_add tool executed", fxCall && readFileSync(join(root, "hooks.log"), "utf8").includes("fx_add 20+22"));
check("tool_result replacement reached the model", !!fxResult, String(fxResult?.content ?? "undefined").slice(0, 120));
check("the replaced tool result is visible in the assistant reply", /42 \(replaced\)/.test(messageText(firstReply)), messageText(firstReply));

const first = requests[0];
const sys = (first.payload.messages.find((m) => m.role === "system")?.content ?? "");
check("before_agent_start chains two plugins in extension ID order", sys.includes("E2E-MARKER-7f3\n\nE2E-MARKER-greet"));
check("before_provider_headers header sent", first.headers["x-e2e-ext"] === "yes", JSON.stringify(first.headers["x-e2e-ext"]));
check("ToolSearch activation advertised fx_add to a later request", requests.some((r) => (r.payload.tools ?? []).some((t) => t.function?.name === "fx_add")));
check("hooks log has session_start, tool_call fx_add, tool_result, turn_end", (() => { const h = readFileSync(join(root, "hooks.log"), "utf8"); return ["session_start startup", "before_agent_start", "tool_call fx_add", "fx_add 20+22", "tool_result fx_add false", "turn_end", "agent_end", "after_provider_response 200", "before_provider_request object", "context "].every((k) => h.includes(k)); })(), readFileSync(join(root, "hooks.log"), "utf8").split("\n").slice(0, 14).join(" | "));

// 2) tool_call block (E2E-242)
const bashPrompt = await tool("pi_agent_prompt", { sessionId, content: "run bash please" });
await waitForTurn(sessionId, bashPrompt?.turnId);
const bashReply = await waitForReply(sessionId, "run bash please");
requests = readRequests();
const blockedBashResult = requests.flatMap((request) => request.payload.messages).find((message) =>
  message.role === "tool" && String(message.content).includes("E2E blocked bash"));
check("Bash blocked by extension", !!blockedBashResult && messageText(bashReply).includes("E2E blocked bash"),
  String(blockedBashResult?.content ?? messageText(bashReply) ?? "undefined").slice(0, 160));

// 3) plugin rows carry the agent-extension state and diagnostics (E2E-241 / 244)
const listed = await invoke("plugin/list");
const byName = Object.fromEntries((listed.plugins ?? []).filter((p) => p.id.startsWith("e2e.")).map((p) => [p.id.slice(4), p]));
check("seven fixture plugins listed", Object.keys(byName).length === 7, Object.keys(byName).sort().join(","));
check("plugins carry the agentExtension capability and permission", Object.values(byName).every((p) => (p.capabilities ?? []).includes("agentExtension") && (p.permissions ?? []).includes("agent.extension")));
const ax = (n) => byName[n]?.agentExtension;
check("fx loaded with tool + no diagnostics", ax("fx")?.state === "loaded" && ax("fx")?.toolNames?.includes("fx_add") && ax("fx")?.diagnostics?.length === 0, JSON.stringify(ax("fx")));
check("greet loaded with command", ax("greet")?.state === "loaded" && ax("greet")?.commandNames?.includes("greet"));
check("bad in error with load_error", ax("bad")?.state === "error" && ax("bad")?.diagnostics?.some((d) => d.kind === "load_error" && /refuses to load/.test(d.message)), JSON.stringify(ax("bad")?.diagnostics?.map((d) => d.kind)));
const tuiKinds = (ax("tui")?.diagnostics ?? []).map((d) => `${d.kind}:${d.member}`).sort();
check("tui inert with diagnostics", ax("tui")?.state === "loaded" && tuiKinds.includes("stub_symbol:Text") && tuiKinds.includes("unsupported_api:registerShortcut") && tuiKinds.includes("unsupported_api:ui.setWidget"), tuiKinds.join(","));
check("proj plugin is project scoped and registered its tool", byName.proj?.scope?.mode === "projects" && ax("proj")?.state === "loaded" && ax("proj")?.toolNames?.includes("proj_tool"), JSON.stringify([byName.proj?.scope, ax("proj")?.toolNames]));
// A custom agent registered through registerAgent / registerProvider reaches the
// plugin row, and a contributed provider becomes an owned native row (ADR 0259).
check("agent plugin reports its custom agents on the row", (ax("agent")?.agentNames ?? []).sort().join(",") === "cc-alias,commandcode", JSON.stringify([ax("agent")?.agentNames, ax("agent")?.state]));
const providerList = await invoke("providers/list");
const declaredRow = (providerList.providers ?? []).find((p) => p.id === "plugin:e2e.agent:declared");
check("contributed provider is a row owned by its plugin", declaredRow?.ownerPluginId === "e2e.agent", JSON.stringify([declaredRow?.id, declaredRow?.ownerPluginId, declaredRow?.name]));
check("the declared row carries the plugin's endpoint and models", declaredRow?.baseUrl?.endsWith("/v1") === true && (declaredRow?.models ?? []).some((m) => m.id === "stub-1"), JSON.stringify([declaredRow?.baseUrl, declaredRow?.models?.map((m) => m.id)]));
check("agent plugin receives the provider OAuth permission", (byName.agent?.permissions ?? []).includes("provider.oauth"));
const pluginOAuthId = "plugin:e2e.agent:declared-oauth";
const oauthRow = (providerList.providers ?? []).find((p) => p.id === pluginOAuthId);
check("OAuth provider materializes as a plugin-owned row", oauthRow?.ownerPluginId === "e2e.agent" && oauthRow?.authKind === "oauth", JSON.stringify([oauthRow?.id, oauthRow?.ownerPluginId, oauthRow?.authKind]));
check("other plugins keep no owned provider rows", (providerList.providers ?? []).every((p) => !p.ownerPluginId || p.ownerPluginId === "e2e.agent"));

// 4) plugin OAuth through the real Settings page, Host-rendered dialog, and
// provider runtime. The plugin returns only synthetic fixture credentials.
const ui = await connectUiRenderer(Number(process.env.E2E_CDP_PORT));
await ui.click('button[data-nav="settings"]');
await ui.until(() => Boolean(document.querySelector(".settings-shell-full")), null, "Settings page");
const openedModels = await ui.run((label) => {
  const button = [...document.querySelectorAll(".settings-nav-item")].find((entry) => entry.textContent?.includes(label));
  button?.click();
  return Boolean(button);
}, "Models");
check("Model configuration is reachable from Settings navigation", openedModels);
await ui.until(() => Boolean(document.querySelector("button.model-provider-add")), null, "Add provider action");
await ui.click("button.model-provider-add");
await ui.until(
  (id) => [...document.querySelectorAll("[data-subscription-vendor-id]")].some((entry) => entry.getAttribute("data-subscription-vendor-id") === id),
  pluginOAuthId,
  "plugin OAuth provider in the sign-in picker",
);
const oauthTile = `[data-subscription-vendor-id="${pluginOAuthId}"]`;
await ui.click(oauthTile);
const loginSurface = await ui.until(
  () => {
    const dialog = document.querySelector(".oauth-dialog");
    return Boolean(dialog?.textContent?.includes("E2E-OAUTH-42") && dialog.querySelector('input[type="password"]'));
  },
  null,
  "plugin OAuth device-code and secret prompt",
);
check("Host renders the plugin's device code and secure prompt", loginSurface);
const loginCopy = await ui.run(() => document.querySelector(".oauth-dialog")?.textContent ?? "");
check("Host dialog shows fixture code and prompt label", loginCopy.includes("E2E-OAUTH-42") && loginCopy.includes("Approve E2E OAuth fixture"));
await ui.type("e2e-approved");
await ui.click('.oauth-answer button[type="submit"]');
await ui.until(
  (id) => {
    const row = document.querySelector(`[data-provider-id="${id}"]`);
    return Boolean(row?.textContent?.includes("e2e-oauth@example.test"));
  },
  pluginOAuthId,
  "signed-in OAuth account row",
);
const oauthRowText = await ui.run((id) => document.querySelector(`[data-provider-id="${id}"]`)?.textContent ?? "", pluginOAuthId);
check("signed-in provider row shows the non-secret account label", oauthRowText.includes("e2e-oauth@example.test"));
const rendererLeaksCredential = await ui.run(() =>
  document.body.innerText.includes("expired-plugin-access") || document.body.innerText.includes("plugin-refresh"),
);
check("renderer does not display access or refresh tokens", rendererLeaksCredential === false);

const initialSession = await tool("pi_session_get", { id: sessionId });
const initialProviderId = initialSession?.session?.providerId;
const initialModelId = initialSession?.session?.modelId;
if (typeof initialProviderId !== "string" || typeof initialModelId !== "string") {
  throw new Error("E2E session did not have an initial model binding");
}

// Cancel a second login while its Host prompt is open; the plugin signal must
// abort without disturbing the credential from the completed login.
await ui.click("button.model-provider-add");
await ui.click(oauthTile);
await ui.until(
  () => Boolean(document.querySelector('.oauth-dialog input[type="password"]')),
  null,
  "second plugin OAuth prompt",
);
await ui.click(".provider-dialog-actions button");
await ui.until(() => !document.querySelector(".oauth-dialog"), null, "cancelled OAuth dialog to close");
const hookPath = join(root, "hooks.log");
const cancelDeadline = Date.now() + 10_000;
while (Date.now() < cancelDeadline && !readFileSync(hookPath, "utf8").includes("provider_oauth_aborted")) {
  await sleep(50);
}
const cancelledOAuth = readFileSync(hookPath, "utf8").includes("provider_oauth_aborted");
check("cancelling the Host prompt aborts the plugin callback", cancelledOAuth);
const retainedAccount = await ui.run((id) =>
  document.querySelector(`[data-provider-id="${id}"]`)?.textContent?.includes("e2e-oauth@example.test") === true,
  pluginOAuthId,
);
check("cancelling another login keeps the existing account", retainedAccount);

await tool("pi_session_configure", {
  id: sessionId,
  mode: "agent",
  providerId: pluginOAuthId,
  modelId: "oauth-stub-1",
  confirm: true,
});
const oauthTurn = await tool("pi_agent_prompt", { sessionId, content: "use the signed-in plugin OAuth provider" });
await waitForTurn(sessionId, oauthTurn?.turnId);
requests = readRequests();
const oauthRequest = [...requests].reverse().find((request) =>
  request.payload?.model === "oauth-stub-1" && request.headers?.authorization === "Bearer refreshed-plugin-access",
);
check("a model turn refreshes the plugin credential and uses its access token", Boolean(oauthRequest), JSON.stringify(oauthRequest?.headers?.authorization ?? "missing"));
check("the refresh callback ran in the plugin process", readFileSync(hookPath, "utf8").includes("provider_oauth_refresh"));
check("refresh credentials never enter model requests", !JSON.stringify(oauthRequest ?? {}).includes("plugin-refresh"));

// Settings is a dialog: close any instance left from the OAuth step first.
await ui.run(() => document.querySelector('[data-nav="close-settings"]')?.click());
await ui.until(() => !document.querySelector(".settings-dialog"), null, "Settings dialog to close");
await ui.click('button[data-nav="settings"]');
await ui.until(() => Boolean(document.querySelector(".settings-shell-full")), null, "Settings before sign-out");
const reopenedModels = await ui.run((label) => {
  const button = [...document.querySelectorAll(".settings-nav-item")].find((entry) => entry.textContent?.includes(label));
  button?.click();
  return Boolean(button);
}, "Models");
check("Model settings can be reopened after an OAuth-backed turn", reopenedModels);
await ui.until(
  (id) => Boolean(document.querySelector(`[data-provider-id="${id}"] button[aria-haspopup="menu"]`)),
  pluginOAuthId,
  "OAuth account row before sign-out",
);
await ui.click(`[data-provider-id="${pluginOAuthId}"] button[aria-haspopup="menu"]`);
const armedSignOut = await ui.run(() => {
  const item = [...document.querySelectorAll('[role="menuitem"]')].find((entry) => entry.textContent?.includes("Sign out"));
  item?.click();
  return Boolean(item);
});
check("OAuth account row offers a sign-out action", armedSignOut);
const confirmedSignOut = await ui.run(() => {
  const item = [...document.querySelectorAll('[role="menuitem"]')].find((entry) => entry.textContent?.includes("Click again to delete"));
  item?.click();
  return Boolean(item);
});
check("the sign-out action requires its confirmation click", confirmedSignOut);
const disconnected = await ui.until(
  async (id) => {
    const result = await window.piDesktop.invoke(window.piDesktop.channels.invoke.providersOauthVendors);
    if (!result.ok) throw new Error(`Failed to list OAuth vendors: ${result.error.message}`);
    if (!Array.isArray(result.data?.vendors)) throw new Error("OAuth vendor response did not include vendors");
    return result.data.vendors.some((vendor) => vendor.vendorId === id && vendor.accounts.some((account) => !account.connected));
  },
  pluginOAuthId,
  "plugin OAuth sign-out",
);
check("sign-out clears the plugin OAuth credential", disconnected);
await tool("pi_session_configure", {
  id: sessionId,
  mode: "agent",
  providerId: initialProviderId,
  modelId: initialModelId,
  confirm: true,
});
const restoredSession = await tool("pi_session_get", { id: sessionId });
check(
  "OAuth coverage restores the session's original model binding",
  restoredSession?.session?.providerId === initialProviderId && restoredSession?.session?.modelId === initialModelId,
  JSON.stringify([restoredSession?.session?.providerId, restoredSession?.session?.modelId]),
);
ui.close();

// 5) commands in palette/composer (E2E-243)
const palette = await invoke("commandPalette/search", "greet");
check("greet in global search", (palette.commands ?? []).some((c) => c.id === "extension:greet" && c.source === "extension"));
const composer = await invoke("composer/commands");
check("greet in composer slash menu", (composer.commands ?? []).some((c) => c.name === "greet" && c.kind === "extension"));

// 6) command run + prompt round trip (E2E-243), answered through the broker
const runPromise = invoke("extensions/commands/run", { sessionId, name: "greet", args: "now" });
// Prompts go to the renderer dialog; main also audits each prompt id in
// plugin.log, so this driver answers them the way the dialog would.
const answered = new Set();
const seenBefore = new Set((existsSync(join(dataDir, "logs", "app", "plugin.log")) ? readFileSync(join(dataDir, "logs", "app", "plugin.log"), "utf8") : "").split("\n").map((l) => /"promptId":"([^"]+)"/.exec(l)?.[1]).filter(Boolean));
for (const id of seenBefore) answered.add(id);
const answeredNow = () => [...answered].filter((id) => !seenBefore.has(id)).length;
const answers = { input: "Ann", select: "blue", confirm: true };
const logPath = join(dataDir, "logs", "app", "plugin.log");
for (let i = 0; i < 60 && answeredNow() < 3; i++) {
  await sleep(250);
  const lines = existsSync(logPath) ? readFileSync(logPath, "utf8").split("\n").filter((l) => l.includes("extension prompt")) : [];
  for (const line of lines) {
    const m = /"promptId":"([^"]+)".*?"kind":"(input|select|confirm)"/.exec(line);
    if (!m || answered.has(m[1])) continue;
    answered.add(m[1]);
    await invoke("extensions/ui/respond", { promptId: m[1], value: answers[m[2]], confirm: true }).catch(async () => {
      await tool("pi_desktop_invoke", { operation: "extensions/ui/respond", args: [{ promptId: m[1], value: answers[m[2]] }], confirm: true });
    });
  }
}
let runResult;
try { runResult = await Promise.race([runPromise, sleep(15000).then(() => "timeout")]); } catch (e) { runResult = String(e); }
check("greet command completed after three answered prompts", runResult?.ok === true && answeredNow() === 3, JSON.stringify(runResult) + " answered=" + answeredNow());
const hooks = readFileSync(join(root, "hooks.log"), "utf8");
check("greet handler saw answers, args, and exec", hooks.includes("greet Ann blue true args=now exec=exec-ok"), hooks.split("\n").filter((l) => l.startsWith("greet")).join(" | "));
const renamed = await tool("pi_session_get", { id: sessionId });
check("setSessionName renamed the session", (renamed?.session?.title ?? "").startsWith("Hello Ann blue now"), renamed?.session?.title);

// 7) abort while a prompt is open dismisses it with the abort value (spec §9)
const before6 = (existsSync(logPath) ? readFileSync(logPath, "utf8") : "").split("\n").filter((l) => l.includes("extension prompt")).length;
const abortRun = invoke("extensions/commands/run", { sessionId, name: "greet", args: "aborted" });
for (let i = 0; i < 40; i++) {
  await sleep(250);
  const now = readFileSync(logPath, "utf8").split("\n").filter((l) => l.includes("extension prompt")).length;
  if (now > before6) break;
}
// Abort retires the command itself, including later UI and exec calls.
const extensionRenderer = await connectRenderer(process.env.E2E_CDP_PORT);
await extensionRenderer.waitForDialog(true);
writeFileSync(join(root, "prompt-active.png"), Buffer.from(await extensionRenderer.screenshot(), "base64"));
const seen6 = new Set(readFileSync(logPath, "utf8").split("\n").map((l) => /"promptId":"([^"]+)"/.exec(l)?.[1]).filter(Boolean));
await tool("pi_agent_abort", { sessionId });
await extensionRenderer.waitForDialog(false);
writeFileSync(join(root, "prompt-retired.png"), Buffer.from(await extensionRenderer.screenshot(), "base64"));
extensionRenderer.close();
check("Stop removes the extension dialog from the real renderer", true);
let abortResult;
try { abortResult = await Promise.race([abortRun, sleep(20000).then(() => "timeout")]); } catch (e) { abortResult = String(e); }
const hooksAfterAbort = readFileSync(join(root, "hooks.log"), "utf8");
check("abort retires the command before later prompts and exec", abortResult?.ok === true && !hooksAfterAbort.includes("args=aborted"), JSON.stringify(abortResult));
const after6 = readFileSync(logPath, "utf8").split("\n").map((l) => /"promptId":"([^"]+)"/.exec(l)?.[1]).filter(Boolean);
check("aborted command publishes no additional prompts", after6.every((id) => seen6.has(id)));

// 8) sendUserMessage goes through the Host-owned queue (D386) and runs a turn
const queued = await invoke("extensions/commands/run", { sessionId, name: "queue", args: "" });
check("queue command ran", queued?.ok === true, JSON.stringify(queued));
let queuedSeen = false;
for (let i = 0; i < 60 && !queuedSeen; i++) {
  await sleep(500);
  const d = await tool("pi_session_get", { id: sessionId });
  const ms = d?.session?.messages ?? [];
  const idx = ms.findIndex((m) => m.role === "user" && /queued\)/.test(m.content ?? ""));
  if (idx >= 0 && ms.slice(idx).some((m) => m.role === "assistant" && /Sum is 42/.test(m.content ?? ""))) queuedSeen = true;
}
check("queued user message ran as a turn with the extension tool", queuedSeen);

// 9) plugin-owned model transport: registerAgent + registerProvider + setModel
//    (spec 07-plugins/16 §5, E2E-TRUSTED-EXTENSION-custom-agent-stream-and-binding)
const agentHooks = () => readFileSync(join(root, "hooks.log"), "utf8").split("\n");
const lastLine = (prefix) => [...agentHooks()].reverse().find((l) => l.startsWith(prefix)) ?? "";

const agentRun = await invoke("extensions/commands/run", { sessionId, name: "agent_model", args: "" });
check("agent_model command ran", agentRun?.ok === true, JSON.stringify(agentRun));
const registryLine = agentHooks().find((l) => l.startsWith("agent_model registry=")) ?? "";
check(
  "modelRegistry exposes both plugin agents to the extension",
  registryLine.includes("extension-agent:") && registryLine.includes("/cc-1") && registryLine.includes("/cc-alias-1"),
  registryLine,
);
// The registry is a redacted projection: models and auth availability only.
check("modelRegistry exposes no host credential material", lastLine("agent_model registryLeaks=").endsWith("=none"), lastLine("agent_model registryLeaks="));
check("modelRegistry reports auth availability without a secret", /authStatus=\{.*"configured":true.*\}/.test(lastLine("agent_model authStatus=")) && !lastLine("agent_model authStatus=").includes("sk-"), lastLine("agent_model authStatus="));
const setModelLine = lastLine("agent_model setModel=");
check("idle setModel returns true and names the plugin provider", /setModel=true model=cc-1 provider=extension-agent:/.test(setModelLine), setModelLine);
const bound = await tool("pi_session_get", { id: sessionId });
const boundProvider = bound?.session?.providerId ?? "";
check("the session binding is persisted under the extension-agent id", boundProvider.startsWith("extension-agent:") && bound?.session?.modelId === "cc-1", JSON.stringify([boundProvider, bound?.session?.modelId]));

// The next turn must reload the extension and run through the plugin's own
// transport instead of a host adapter.
const ownTransportPrompt = await tool("pi_agent_prompt", { sessionId, content: "say hi through your own transport" });
await waitForTurn(sessionId, ownTransportPrompt?.turnId);
const pluginAssistant = await waitForReply(sessionId, "say hi through your own transport");
check("the plugin's own stream served the turn", /plugin-transport-ok/.test(pluginAssistant?.content ?? ""), pluginAssistant?.content);

// registerProvider is the upstream compatibility alias: the same plugin-owned
// shape, selectable and served by the plugin.
const aliasRun = await invoke("extensions/commands/run", { sessionId, name: "agent_model", args: "cc-alias-1" });
check("agent_model selects the alias provider's model", aliasRun?.ok === true, JSON.stringify(aliasRun));
const aliasLine = lastLine("agent_model setModel=");
check("the alias registers the same plugin-owned shape", /setModel=true model=cc-alias-1 provider=extension-agent:/.test(aliasLine), aliasLine);
const aliasPrompt = await tool("pi_agent_prompt", { sessionId, content: "say hi through the alias" });
await waitForTurn(sessionId, aliasPrompt?.turnId);
const aliasAssistant = await waitForReply(sessionId, "say hi through the alias");
check("the alias provider's transport served the turn", /alias-transport-ok/.test(aliasAssistant?.content ?? ""), aliasAssistant?.content);

console.log("RESULTS " + JSON.stringify(results));
console.log(`SUMMARY ${results.filter((r) => r.ok).length}/${results.length} passed`);
if (results.some((r) => !r.ok)) process.exitCode = 1;
