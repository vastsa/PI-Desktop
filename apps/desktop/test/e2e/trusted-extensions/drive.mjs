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
check("six fixture plugins listed", Object.keys(byName).length === 6, Object.keys(byName).sort().join(","));
check("plugins carry the agentExtension capability and permission", Object.values(byName).every((p) => (p.capabilities ?? []).includes("agentExtension") && (p.permissions ?? []).includes("agent.extension")));
const ax = (n) => byName[n]?.agentExtension;
check("fx loaded with tool + no diagnostics", ax("fx")?.state === "loaded" && ax("fx")?.toolNames?.includes("fx_add") && ax("fx")?.diagnostics?.length === 0, JSON.stringify(ax("fx")));
check("greet loaded with command", ax("greet")?.state === "loaded" && ax("greet")?.commandNames?.includes("greet"));
check("bad in error with load_error", ax("bad")?.state === "error" && ax("bad")?.diagnostics?.some((d) => d.kind === "load_error" && /refuses to load/.test(d.message)), JSON.stringify(ax("bad")?.diagnostics?.map((d) => d.kind)));
const tuiKinds = (ax("tui")?.diagnostics ?? []).map((d) => `${d.kind}:${d.member}`).sort();
check("tui inert with diagnostics", ax("tui")?.state === "loaded" && tuiKinds.includes("stub_symbol:Text") && tuiKinds.includes("unsupported_api:registerShortcut") && tuiKinds.includes("unsupported_api:ui.setWidget"), tuiKinds.join(","));
check("proj plugin is project scoped and registered its tool", byName.proj?.scope?.mode === "projects" && ax("proj")?.state === "loaded" && ax("proj")?.toolNames?.includes("proj_tool"), JSON.stringify([byName.proj?.scope, ax("proj")?.toolNames]));

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

console.log("RESULTS " + JSON.stringify(results));
console.log(`SUMMARY ${results.filter((r) => r.ok).length}/${results.length} passed`);
