import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { once } from "node:events";

const require = createRequire(new URL("../apps/desktop/package.json", import.meta.url));
const { _electron } = require(process.env.PI_TEST_PLAYWRIGHT ?? "playwright");
const root = resolve(import.meta.dirname, "..");
const output = join(root, ".artifacts", `regenerate-quit-${Date.now()}`);
const workspace = join(output, "workspace");
await mkdir(workspace, { recursive: true });
await writeFile(join(workspace, "build.log"), "Build completed successfully\n");
const checks = [];
let app, page, requestCount = 0, sawLog = false;
const server = createServer(async (req, res) => {
  if (req.url !== "/v1/chat/completions") { res.writeHead(404).end(); return; }
  const raw = []; for await (const chunk of req) raw.push(chunk);
  const body = JSON.parse(Buffer.concat(raw).toString());
  requestCount++;
  const lastUser = body.messages.findLastIndex((message) => message.role === "user");
  const results = body.messages.slice(lastUser).filter((message) => message.role === "tool");
  const tool = results.length === 0;
  if (!tool) sawLog ||= JSON.stringify(results).includes("Build completed successfully");
  const chunk = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({
    id: `controlled-${requestCount}`, object: "chat.completion.chunk", created: 1, model: body.model,
    choices: [{ index: 0, delta, finish_reason }],
  })}\n\n`);
  res.writeHead(200, { "content-type": "text/event-stream" });
  chunk({ role: "assistant" });
  if (tool) chunk({ tool_calls: [{ index: 0, id: `read-${requestCount}`, type: "function",
    function: { name: "Read", arguments: JSON.stringify({ path: join(workspace, "build.log") }) } }] });
  else chunk({ content: `REGRESSION_REPLY_${requestCount}` });
  chunk({}, tool ? "tool_calls" : "stop");
  res.end("data: [DONE]\n\n");
});
server.listen(0, "127.0.0.1"); await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`;
const check = (name, value = true) => { assert.ok(value, name); checks.push(name); console.log(`PASS ${name}`); };
async function until(probe, label, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await probe(); if (result) return result;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(`Timed out: ${label}`);
}
const invoke = (name, ...args) => page.evaluate(async ({ name, args }) => {
  const result = await window.piDesktop.invoke(`pi-desktop/${name}`, ...args);
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.data;
}, { name, args });
async function launch() {
  const env = { ...process.env, PI_DESKTOP_DATA_DIR: join(output, "data"),
    ELECTRON_RENDERER_URL: "" };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await _electron.launch({ executablePath: require("electron"),
    args: [join(root, "apps/desktop"), `--user-data-dir=${join(output, "profile")}`], env, timeout: 60_000 });
  page = await until(async () => {
    for (const candidate of app.windows()) if (await candidate.locator(".app-shell").count()) return candidate;
  }, "desktop shell", 60_000);
  await page.locator(".app-shell:not(.app-shell-boot)").waitFor();
}
async function close() {
  if (!app) return;
  await app.evaluate(() => { process.env.PI_DESKTOP_BOOT_PROBE = "1"; });
  await app.close(); app = undefined;
}
try {
  await launch();
  const { provider } = await invoke("providers/create", {
    name: "Controlled local provider", type: "openai_compatible",
    baseUrl: `${origin}/v1`, apiStyle: "chat_completions", authKind: "none",
    models: [{ id: "fixture-model", contextWindow: 128000, maxTokens: 4096, thinkingLevels: ["off"] }],
    defaultModelId: "fixture-model",
  });
  assert.ok(provider);
  await invoke("settings/set", { ...await invoke("settings/get"), language: "en", theme: "dark",
    onboardingDismissed: true, autoGenerateTitle: false, defaultProviderId: provider.id, defaultModelId: "fixture-model" });
  const { session } = await invoke("session/create", { title: "Regenerate quit regression", projectPath: workspace,
    mode: "agent", providerId: provider.id, modelId: "fixture-model", thinkingLevel: "off", permissionMode: "bypass" });
  await invoke("project/set", workspace);
  await page.reload(); await page.locator(".app-shell:not(.app-shell-boot)").waitFor();
  await page.evaluate((id) => window.__PI_DESKTOP__.selectSession(id), session.id);
  await page.evaluate((id) => {
    window.__firstReplyEnded = false;
    window.piDesktop.on("pi-desktop/agent/event/message", (envelope) => {
      if (envelope.sessionId === id && envelope.event.type === "agent_end" && !envelope.parentToolCallId) {
        window.__firstReplyEnded = true;
      }
    });
  }, session.id);
  await invoke("agent/prompt", { sessionId: session.id, content: "Read the build log and report that it was inspected." });
  await page.getByText("REGRESSION_REPLY_2", { exact: true }).waitFor({ timeout: 30_000 });
  await until(() => page.evaluate(() => window.__firstReplyEnded), "initial turn completion");
  check("native Read delivers the fixture log to the real sidecar", sawLog);
  await page.screenshot({ path: join(output, "log-read.png") });
  await app.evaluate(() => { process.env.PI_DESKTOP_BOOT_PROBE = "1"; });
  await page.evaluate((id) => {
    window.piDesktop.on("pi-desktop/agent/event/message", (envelope) => {
      if (envelope.sessionId === id && envelope.event.type === "agent_end" && !envelope.parentToolCallId) {
        void window.piDesktop.invoke("pi-desktop/app/quit");
      }
    });
  }, session.id);
  const processExit = once(app.process(), "exit");
  await page.getByText("REGRESSION_REPLY_2", { exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: /Regenerate/i }).click();
  await processExit; app = undefined;
  check("regenerate finishes and exits through the native quit path", requestCount === 4);
  await launch();
  await page.evaluate((id) => window.__PI_DESKTOP__.selectSession(id), session.id);
  await page.getByText("REGRESSION_REPLY_4", { exact: true }).waitFor();
  const detail = (await invoke("session/get", { id: session.id })).session;
  const user = detail.messages.find((message) => message.role === "user");
  const rootUserId = user.revisionRootId ?? user.id;
  const revisions = await invoke("session/listRevisions", { sessionId: session.id, rootUserId });
  check("restarted conversation retains both regenerate branches", revisions.revisions.length === 2);
  const original = await invoke("session/activateRevision", { sessionId: session.id, rootUserId, revisionIndex: 1, prefix: [] });
  check("original branch remains readable", original.messages.some((message) => message.content === "REGRESSION_REPLY_2"));
  const regenerated = await invoke("session/activateRevision", { sessionId: session.id, rootUserId, revisionIndex: 2, prefix: [] });
  check("regenerated branch remains readable", regenerated.messages.some((message) => message.content === "REGRESSION_REPLY_4"));
  await page.screenshot({ path: join(output, "regenerated-after-restart.png") });
  await close();
  const logs = await readFile(join(output, "data/logs/app/persistence.log"), "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  check("quit produces no disposed-host archive error", !logs.includes("host-core disposed") && !logs.includes("save.active.regenerate.branch.failed"));
  await writeFile(join(output, "result.json"), JSON.stringify({ checks, requestCount, output }, null, 2));
  console.log(JSON.stringify({ output, checks: checks.length }));
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: join(output, "failure.png") }).catch(() => undefined);
  throw error;
} finally {
  await close(); server.closeAllConnections(); server.close();
}
