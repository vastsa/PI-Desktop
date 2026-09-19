// Seeds the E2E data dir: fixture extensions, enablement store, a project,
// and a provider row pointing at the stub server (through host-core's own
// JSON-RPC, since the MCP control plane blocks providers/create).
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = process.env.E2E_ROOT || "/tmp/pi-ext-e2e";
const dataDir = join(root, "data");
const agentDir = join(root, "agent");
const project = join(root, "project");
// Every fixture is a plugin that contributes ExtensionAPI modules (D388): the
// sidecar loads them, the plugin record carries enablement and scope.
const pluginsDir = join(root, "plugins");
const extDir = join(root, "fixtures");
const hostBin = process.env.HOST_BIN;
const stubPort = Number(process.env.STUB_PORT || 47123);

rmSync(dataDir, { recursive: true, force: true });
rmSync(pluginsDir, { recursive: true, force: true });
for (const dir of [dataDir, extDir, pluginsDir, join(project, "src")]) mkdirSync(dir, { recursive: true });
writeFileSync(join(project, "src", "hello.txt"), "hello\n");
writeFileSync(join(root, "hooks.log"), "");

const hookLog = join(root, "hooks.log");
const write = (name, src) => writeFileSync(join(extDir, name), src);

write("fx.ts", `import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { appendFileSync } from "node:fs";
const log = (line: string) => appendFileSync(${JSON.stringify(hookLog)}, line + "\\n");
type P = { a: number; b: number };
export default function (pi: any) {
  pi.registerTool(defineTool({
    name: "fx_add", label: "Add", description: "Adds two numbers",
    parameters: Type.Object({ a: Type.Number(), b: Type.Number() }),
    async execute(_id: string, p: P, _s: any, _u: any, ctx: any) {
      log("fx_add " + p.a + "+" + p.b + " cwd=" + ctx.cwd);
      return { content: [{ type: "text", text: String(p.a + p.b) }], details: { sum: p.a + p.b } };
    },
  }));
  pi.on("session_start", (e: any) => log("session_start " + e.reason));
  pi.on("before_agent_start", (e: any) => { log("before_agent_start"); return { systemPrompt: e.systemPrompt + "\\n\\nE2E-MARKER-7f3" }; });
  pi.on("before_provider_headers", (e: any) => { e.headers["x-e2e-ext"] = "yes"; });
  pi.on("before_provider_request", (e: any) => { log("before_provider_request " + typeof e.payload); });
  pi.on("after_provider_response", (e: any) => log("after_provider_response " + e.response?.status));
  pi.on("tool_call", (e: any) => { log("tool_call " + e.toolName); if (e.toolName === "Bash") return { block: true, reason: "E2E blocked bash" }; });
  pi.on("tool_result", (e: any) => { log("tool_result " + e.toolName + " " + e.isError); if (e.toolName === "fx_add") return { content: [{ type: "text", text: "42 (replaced)" }] }; });
  pi.on("context", (e: any) => { log("context " + e.messages.length); });
  pi.on("turn_start", () => log("turn_start"));
  pi.on("turn_end", () => log("turn_end"));
  pi.on("agent_end", () => log("agent_end"));
  pi.on("session_shutdown", (e: any) => log("session_shutdown " + e.reason));
}
`);

write("greet.ts", `import { appendFileSync } from "node:fs";
const log = (line: string) => appendFileSync(${JSON.stringify(hookLog)}, line + "\\n");
export default function (pi: any) {
  pi.registerCommand("greet", { description: "Greets you", async handler(args: string, ctx: any) {
    const name = await ctx.ui.input("Your name?", "e.g. Ann");
    const color = await ctx.ui.select("Favourite colour", ["red", "blue"]);
    const ok = await ctx.ui.confirm("Rename session?", "Really rename it?");
    ctx.ui.notify("greeting " + name, "info");
    ctx.ui.setStatus("greet", "greeted " + name);
    if (ok) pi.setSessionName("Hello " + name + " " + color + " " + args);
    const r = await pi.exec("node", ["-e", "process.stdout.write('exec-ok')"]);
    log("greet " + name + " " + color + " " + ok + " args=" + args + " exec=" + r.stdout);
  } });
}
`);

write("tui.ts", `import { Text } from "@earendil-works/pi-tui";
export default function (pi: any) {
  new Text("x");
  pi.registerShortcut("ctrl+x", { handler() {} });
  pi.on("session_start", (_e: any, ctx: any) => { ctx.ui.setWidget("w", () => null); });
}
`);

write("bad.ts", `throw new Error("bad extension refuses to load");\n`);
write("queue.ts", `export default function (pi: any) {
  pi.registerCommand("queue", { description: "Queues a follow-up prompt", async handler() {
    await pi.sendUserMessage("please add 20 and 22 (queued)");
  } });
}
`);
write("proj.ts", `export default function (pi: any) {
  pi.registerTool({ name: "proj_tool", label: "Proj", description: "project scoped", parameters: { type: "object", properties: {} }, async execute() { return { content: [{ type: "text", text: "proj" }], details: {} }; } });
}
`);

// A plugin that owns its own model transport (registerAgent / registerProvider)
// and also publishes an endpoint into the native provider list.
write("agent.ts", `import { appendFileSync } from "node:fs";
const log = (line: string) => appendFileSync(${JSON.stringify(hookLog)}, line + "\\n");
const reply = (model: any, text: string) => ({
  role: "assistant" as const,
  content: [{ type: "text" as const, text }],
  api: model.api, provider: model.provider, model: model.id,
  usage: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 1,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: "stop" as const, timestamp: Date.now(),
});
export default function (pi: any) {
  pi.registerAgent({
    id: "commandcode",
    name: "Command Code",
    models: [{ id: "cc-1", name: "Command Code 1" }],
    complete: async (model: any) => reply(model, "plugin-transport-ok"),
  });
  // The upstream compatibility alias registers the same plugin-owned shape.
  pi.registerProvider({
    id: "cc-alias",
    name: "CC Alias",
    models: [{ id: "cc-alias-1" }],
    complete: async (model: any) => reply(model, "alias-transport-ok"),
  });
  pi.registerCommand("host_images", { async handler(_, ctx) {
    const model = ctx.modelRegistry.getAvailable().find((m) => m.id === "image-fixture");
    const generated = await ctx.modelRegistry.generateImages(model, { input: [{ type: "text", text: "A blue circle" }] });
    const image = generated.output.find((part) => part.type === "image");
    if (!image) throw new Error("No generated fixture image");
    const edited = await ctx.modelRegistry.generateImages(model, { input: [{ type: "text", text: "Make the circle red" }, image] });
    log("host_images=" + JSON.stringify({ generated: generated.stopReason, edited: edited.stopReason,
      mimeType: image.mimeType, bytes: image.data.length,
      editImages: edited.output.filter((part) => part.type === "image").length, current: ctx.model.id }));
  } });
  pi.registerCommand("host_complete", { async handler(_, ctx) {
    const target = ctx.modelRegistry.getAvailable().find((m) => m.id === "reviewer-only");
    const found = ctx.modelRegistry.find(target?.provider, "reviewer-only");
    const result = await ctx.modelRegistry.complete(found, {
      messages: [{ role: "user", content: "Reply with a greeting", timestamp: 1 }],
    });
    log("host_complete=" + JSON.stringify({ provider: result.provider, model: result.model,
      text: result.content.filter((c) => c.type === "text").map((c) => c.text).join(""),
      tokens: result.usage.totalTokens, current: ctx.model.id }));
  } });
  pi.registerCommand("agent_model", { description: "Selects the plugin agent model", async handler(args: string, ctx: any) {
    const models = await ctx.modelRegistry.getAvailable();
    log("agent_model registry=" + models.map((m: any) => m.provider + "/" + m.id).sort().join(","));
    // The registry is a read-only projection: no credential material of any
    // kind may appear in it (spec 07-plugins/16 §5).
    const raw = JSON.stringify(models).toLowerCase();
    // Only real credential material counts: a model legitimately carries
    // maxTokens and capability flags.
    const leaks = ["sk-e2e", "secret:provider:", "authorization", "bearer "].filter((k) => raw.includes(k));
    log("agent_model registryLeaks=" + (leaks.length ? leaks.join("|") : "none"));
    log("agent_model authStatus=" + JSON.stringify(ctx.modelRegistry.getProviderAuthStatus(models[0].provider)));
    const wanted = (args ?? "").trim() || "cc-1";
    const target = models.find((m: any) => m.id === wanted);
    const ok = await pi.setModel(target);
    log("agent_model setModel=" + ok + " model=" + wanted + " provider=" + (target?.provider ?? "none"));
  } });
}
`);

/** Wrap one fixture module in a plugin directory holding `agent.extension`. */
function pluginFor(name) {
  const dir = join(pluginsDir, name);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", `${name}.ts`), readFileSync(join(extDir, `${name}.ts`)));
  writeFileSync(join(dir, "main.js"), "module.exports = {};\n");
  const permissions = ["agent.extension"];
  const contributes = { agentExtensions: [`src/${name}.ts`] };
  // The agent fixture also declares a provider row (ADR 0259): the declaration
  // materializes in the native provider list, owned by this plugin.
  if (name === "agent") {
    permissions.push("provider.register");
    contributes.providers = [{
      id: "declared",
      name: "E2E declared",
      baseUrl: `http://127.0.0.1:${stubPort}/v1`,
      apiStyle: "chat_completions",
      authKind: "api_key",
      models: [{ id: "stub-1", name: "Stub 1", contextWindow: 128000, maxTokens: 4096 }],
    }];
  }
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({
    schemaVersion: 1,
    id: `e2e.${name}`,
    name: `E2E ${name}`,
    version: "0.0.1",
    main: "main.js",
    permissions,
    contributes,
  }, null, 2));
  return dir;
}
const pluginDirs = Object.fromEntries(["fx", "greet", "tui", "bad", "queue", "proj", "agent"].map((n) => [n, pluginFor(n)]));

// --- provider row through host-core ---
const host = spawn(hostBin, [], { env: { ...process.env, PI_DESKTOP_DATA_DIR: dataDir }, stdio: ["pipe", "pipe", "inherit"] });
let buf = ""; const pending = new Map(); let nextId = 1;
host.stdout.on("data", (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  }
});
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, (msg) => (msg.error ? reject(new Error(method + ": " + JSON.stringify(msg.error))) : resolve(msg.result)));
  host.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
});

await call("app.handshake", { protocolVersion: 11 });
const created = await call("providers.create", {
  name: "E2E stub",
  type: "openai_compatible",
  baseUrl: `http://127.0.0.1:${stubPort}/v1`,
  apiStyle: "chat_completions",
  authKind: "api_key",
  secretValue: "sk-e2e",
  models: [{ id: "stub-1", contextWindow: 128000, maxTokens: 4096, thinkingLevels: ["off"] }],
  defaultModelId: "stub-1",
});
await call("providers.create", {
  name: "E2E reviewer", type: "openai_compatible",
  baseUrl: `http://127.0.0.1:${stubPort}/v1`, apiStyle: "chat_completions",
  authKind: "api_key", secretValue: "sk-e2e-reviewer",
  models: [{ id: "reviewer-only", contextWindow: 32000, maxTokens: 4096, thinkingLevels: ["off"] }],
  defaultModelId: "reviewer-only",
});
await call("providers.create", {
  name: "E2E images", type: "openai_compatible",
  baseUrl: `http://127.0.0.1:${stubPort}/v1`, apiStyle: "responses",
  authKind: "api_key", secretValue: "sk-e2e-images",
  models: [{ id: "image-fixture", contextWindow: 32000, maxTokens: 4096, thinkingLevels: ["off"] }],
  defaultModelId: "image-fixture",
});
const providerId = created.provider?.id ?? created.id;
await call("settings.set", { defaultProviderId: providerId, defaultModelId: "stub-1", defaultMode: "agent" });
// Register the fixture plugins as development plugins; dev loads enable them
// with their declared permissions. `proj` is limited to the fixture project.
for (const [name, dir] of Object.entries(pluginDirs)) {
  await call("plugins.loadDev", { path: dir });
  if (name === "proj") {
    await call("plugins.setScope", { id: "e2e.proj", scope: { mode: "projects", projects: [realpathSync(project)] } });
  }
}
console.log(JSON.stringify({ providerId, project: realpathSync(project), agentDir, dataDir }));
host.stdin.end(); host.kill();
