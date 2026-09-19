// MCP-control driver for the trusted extensions E2E run.
import { readFileSync, existsSync } from "node:fs";
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

async function waitForTurn(sessionId, timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const status = await tool("pi_agent_status", { sessionId });
    if (status?.status?.isRunning === false || status?.isRunning === false) return status;
    await sleep(500);
  }
  throw new Error("turn did not finish");
}

await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } });
await tool("pi_project_open", { path: project });
const created = await tool("pi_session_create", { title: "ext e2e", projectPath: project, mode: "agent" });
const sessionId = created?.session?.id ?? created?.id;
check("session created", !!sessionId, sessionId);

// 1) tool + hooks (E2E-242)
await tool("pi_agent_prompt", { sessionId, content: "please add 20 and 22" });
await waitForTurn(sessionId);
let detail = await tool("pi_session_get", { id: sessionId });
let messages = detail?.session?.messages ?? [];
const toolRow = messages.find((m) => m.role === "tool" && m.toolName === "fx_add");
const assistant = [...messages].reverse().find((m) => m.role === "assistant");
check("fx_add tool executed", !!toolRow, JSON.stringify(toolRow?.content ?? toolRow).slice(0, 120));
check("tool_result replacement reached the model", /42 \(replaced\)/.test(assistant?.content ?? ""), assistant?.content);

const requests = readFileSync(join(root, "requests.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const first = requests[0];
const sys = (first.payload.messages.find((m) => m.role === "system")?.content ?? "");
check("before_agent_start marker in system prompt", sys.includes("E2E-MARKER-7f3"));
check("before_provider_headers header sent", first.headers["x-e2e-ext"] === "yes", JSON.stringify(first.headers["x-e2e-ext"]));
check("ToolSearch activation advertised fx_add to a later request", requests.some((r) => (r.payload.tools ?? []).some((t) => t.function?.name === "fx_add")));
check("hooks log has session_start, tool_call fx_add, tool_result, turn_end", (() => { const h = readFileSync(join(root, "hooks.log"), "utf8"); return ["session_start startup", "before_agent_start", "tool_call fx_add", "fx_add 20+22", "tool_result fx_add false", "turn_end", "agent_end", "after_provider_response 200", "before_provider_request object", "context "].every((k) => h.includes(k)); })(), readFileSync(join(root, "hooks.log"), "utf8").split("\n").slice(0, 14).join(" | "));

// 2) tool_call block (E2E-242)
await tool("pi_agent_prompt", { sessionId, content: "run bash please" });
await waitForTurn(sessionId);
detail = await tool("pi_session_get", { id: sessionId });
messages = detail?.session?.messages ?? [];
const bashRow = messages.find((m) => m.role === "tool" && m.toolName === "Bash");
check("Bash blocked by extension", JSON.stringify(bashRow ?? {}).includes("E2E blocked bash"), JSON.stringify(bashRow?.content ?? bashRow).slice(0, 160));

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
check("other plugins keep no owned provider rows", (providerList.providers ?? []).every((p) => !p.ownerPluginId || p.ownerPluginId === "e2e.agent"));

// 4) commands in palette/composer (E2E-243)
const palette = await invoke("commandPalette/search", "greet");
check("greet in global search", (palette.commands ?? []).some((c) => c.id === "extension:greet" && c.source === "extension"));
const composer = await invoke("composer/commands");
check("greet in composer slash menu", (composer.commands ?? []).some((c) => c.name === "greet" && c.kind === "extension"));

// 5) command run + prompt round trip (E2E-243), answered through the broker
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

// 6) abort while a prompt is open dismisses it with the abort value (spec §9)
const before6 = (existsSync(logPath) ? readFileSync(logPath, "utf8") : "").split("\n").filter((l) => l.includes("extension prompt")).length;
const abortRun = invoke("extensions/commands/run", { sessionId, name: "greet", args: "aborted" });
for (let i = 0; i < 40; i++) {
  await sleep(250);
  const now = readFileSync(logPath, "utf8").split("\n").filter((l) => l.includes("extension prompt")).length;
  if (now > before6) break;
}
// The open input prompt resolves undefined on abort; the handler's later
// prompts open normally and are answered here like the dialog would.
const seen6 = new Set(readFileSync(logPath, "utf8").split("\n").map((l) => /"promptId":"([^"]+)"/.exec(l)?.[1]).filter(Boolean));
await tool("pi_agent_abort", { sessionId });
for (let i = 0; i < 40; i++) {
  await sleep(250);
  for (const line of readFileSync(logPath, "utf8").split("\n").filter((l) => l.includes("extension prompt"))) {
    const m = /"promptId":"([^"]+)".*?"kind":"(input|select|confirm)"/.exec(line);
    if (!m || seen6.has(m[1])) continue;
    seen6.add(m[1]);
    await tool("pi_desktop_invoke", { operation: "extensions/ui/respond", args: [{ promptId: m[1], value: answers[m[2]] }], confirm: true });
  }
  if (readFileSync(join(root, "hooks.log"), "utf8").includes("args=aborted")) break;
}
let abortResult;
try { abortResult = await Promise.race([abortRun, sleep(20000).then(() => "timeout")]); } catch (e) { abortResult = String(e); }
const hooksAfterAbort = readFileSync(join(root, "hooks.log"), "utf8");
// The handler's own log line is the product evidence; the command's reply can
// trail it when the MCP session is busy, so it is reported but not asserted.
check("abort dismissed the open prompt and the command finished", /greet undefined blue true args=aborted exec=exec-ok/.test(hooksAfterAbort), JSON.stringify(abortResult) + " " + hooksAfterAbort.split("\n").filter((l) => l.includes("args=aborted")).join(" | "));

// 7) sendUserMessage goes through the Host-owned queue (D386) and runs a turn
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

// 8) plugin-owned model transport: registerAgent + registerProvider + setModel
//    (spec 07-plugins/16 §5, E2E-TRUSTED-EXTENSION-custom-agent-stream-and-binding)
const agentHooks = () => readFileSync(join(root, "hooks.log"), "utf8").split("\n");
const lastLine = (prefix) => [...agentHooks()].reverse().find((l) => l.startsWith(prefix)) ?? "";

const beforeComplete = await tool("pi_session_get", { id: sessionId });
const hostComplete = await invoke("extensions/commands/run", { sessionId, name: "host_complete", args: "" });
check("host completion command ran", hostComplete?.ok === true, JSON.stringify(hostComplete));
const completionLine = lastLine("host_complete=");
const completion = completionLine ? JSON.parse(completionLine.slice("host_complete=".length)) : {};
check("extension discovers and calls another configured model", completion.model === "reviewer-only" && completion.text === "Hello from the stub." && completion.tokens > 0, completionLine);
const afterComplete = await tool("pi_session_get", { id: sessionId });
check("independent completion preserves session binding and transcript",
  afterComplete?.session?.providerId === beforeComplete?.session?.providerId &&
  afterComplete?.session?.modelId === beforeComplete?.session?.modelId &&
  JSON.stringify(afterComplete?.session?.messages) === JSON.stringify(beforeComplete?.session?.messages));

const imageCommand = await invoke("extensions/commands/run", { sessionId, name: "host_images", args: "" });
check("image generation and edit command ran", imageCommand?.ok === true, JSON.stringify(imageCommand));
const imageLine = lastLine("host_images=");
const imageResult = imageLine ? JSON.parse(imageLine.slice("host_images=".length)) : {};
check("extension receives generated and edited image blocks", imageResult.generated === "stop" && imageResult.edited === "stop" && imageResult.mimeType === "image/png" && imageResult.bytes > 0 && imageResult.editImages === 1, imageLine);
const afterImages = await tool("pi_session_get", { id: sessionId });
check("image calls preserve the active session and transcript",
  afterImages?.session?.providerId === beforeComplete?.session?.providerId &&
  afterImages?.session?.modelId === beforeComplete?.session?.modelId &&
  JSON.stringify(afterImages?.session?.messages) === JSON.stringify(beforeComplete?.session?.messages));

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
await tool("pi_agent_prompt", { sessionId, content: "say hi through your own transport" });
await waitForTurn(sessionId);
const pluginTurn = await tool("pi_session_get", { id: sessionId });
const pluginAssistant = [...(pluginTurn?.session?.messages ?? [])].reverse().find((m) => m.role === "assistant");
check("the plugin's own stream served the turn", /plugin-transport-ok/.test(pluginAssistant?.content ?? ""), pluginAssistant?.content);

// registerProvider is the upstream compatibility alias: the same plugin-owned
// shape, selectable and served by the plugin.
const aliasRun = await invoke("extensions/commands/run", { sessionId, name: "agent_model", args: "cc-alias-1" });
check("agent_model selects the alias provider's model", aliasRun?.ok === true, JSON.stringify(aliasRun));
const aliasLine = lastLine("agent_model setModel=");
check("the alias registers the same plugin-owned shape", /setModel=true model=cc-alias-1 provider=extension-agent:/.test(aliasLine), aliasLine);
await tool("pi_agent_prompt", { sessionId, content: "say hi through the alias" });
await waitForTurn(sessionId);
const aliasTurn = await tool("pi_session_get", { id: sessionId });
const aliasAssistant = [...(aliasTurn?.session?.messages ?? [])].reverse().find((m) => m.role === "assistant");
check("the alias provider's transport served the turn", /alias-transport-ok/.test(aliasAssistant?.content ?? ""), aliasAssistant?.content);

console.log("RESULTS " + JSON.stringify(results));
console.log(`SUMMARY ${results.filter((r) => r.ok).length}/${results.length} passed`);
if (results.some((r) => !r.ok)) process.exitCode = 1;
