#!/usr/bin/env node
/** Installed File Manager + production Desktop/Host/sidecar; only the provider is synthetic. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertDesktopBuild, resolveElectronBinary } from "./e2e/boot.mjs";
import { Host, resolveHostBinary } from "./e2e/host.mjs";
import { createSession } from "./e2e/session.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagePath = process.argv[2];
assert(packagePath, "Pass the merged File Manager .piplug package path");
const qa = createRequire(join(process.env.PI_FILE_MANAGER_QA_DIR || root, "package.json"));
const { _electron } = qa("playwright");
assertDesktopBuild(root);
const scratch = await realpath(await mkdtemp(join(tmpdir(), "pi-installed-file-lines-")));
const dataDir = join(scratch, "data");
const project = join(scratch, "project");
const source = join(project, "sample.txt");
const requests = [];
const errors = [];
const checks = [];
let application;
let shell;
let plugin;
let passed = false;
const stage = (name) => console.log(`FILE_LINES_STAGE ${name}`);
const stopApplication = async () => {
  const running = application;
  application = undefined;
  if (!running) return;
  // Close dialogs are outside this fixture; bound cleanup of its own process.
  const fallback = setTimeout(() => running.process().kill("SIGKILL"), 5_000);
  try { await running.close(); } finally { clearTimeout(fallback); }
};

const provider = createServer(async (request, response) => {
  if (!request.url.endsWith("/chat/completions")) {
    response.writeHead(404); response.end("{}"); return;
  }
  let body = "";
  for await (const chunk of request) body += chunk;
  const payload = JSON.parse(body);
  requests.push(payload);
  const base = { id: `fixture-${requests.length}`, object: "chat.completion.chunk", created: 1, model: payload.model };
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const chunk of [
    { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Installed file reference received." }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
  ]) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  response.end("data: [DONE]\n\n");
});

try {
  await mkdir(project);
  await writeFile(source, "saved first line\nsaved second line\n");
  await new Promise((done, reject) => { provider.once("error", reject); provider.listen(0, "127.0.0.1", done); });
  const hostBin = resolveHostBinary();
  const host = new Host(hostBin, dataDir, { quiet: true, env: { PI_DESKTOP_AGENTS_DIR: join(scratch, "agents") } });
  let sessionId;
  await host.start();
  try {
    const created = await host.call("providers.create", {
      name: "File lines fixture", type: "openai_compatible", apiStyle: "chat_completions",
      baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, authKind: "api_key", secretValue: "file-lines-fixture-key",
      models: [{ id: "file-lines-fixture", contextWindow: 128000, maxTokens: 4096, thinkingLevels: ["off"] }],
      defaultModelId: "file-lines-fixture",
    });
    await host.call("settings.set", {
      defaultProviderId: created.provider.id, defaultModelId: "file-lines-fixture", defaultMode: "agent", locale: "en",
    });
    await host.call("plugins.installFromPackage", {
      path: resolve(packagePath), enable: true, grantedPermissions: ["ui.view", "fs.read"],
    });
    const installed = (await host.call("plugins.list")).plugins.find((entry) => entry.id === "pi.file-manager");
    assert.equal(installed.source, "installed");
    assert(installed.path.startsWith(join(dataDir, "plugins", "installed")));
    sessionId = (await createSession(host, project, "Installed line references")).id;
    await host.call("session.configure", { id: sessionId, mode: "agent", permissionMode: "auto" });
    checks.push("package installed through Host with declared grants, not a development load");
  } finally { await host.stop(); }
  stage("installed");

  const env = { ...process.env, PI_DESKTOP_DATA_DIR: dataDir, PI_DESKTOP_HOST_BIN: hostBin,
    PI_DESKTOP_AGENTS_DIR: join(scratch, "agents"),
    PI_CODING_AGENT_DIR: join(scratch, "agent"), ELECTRON_RENDERER_URL: "", PI_DESKTOP_START_MAXIMIZED: "0" };
  delete env.ELECTRON_RUN_AS_NODE;
  const launch = async () => {
    application = await _electron.launch({ executablePath: resolveElectronBinary(root).electronBinary,
      args: [`--user-data-dir=${join(scratch, "profile")}`, "."], cwd: join(root, "apps/desktop"), env });
    const deadline = Date.now() + 30_000;
    shell = undefined;
    while (!shell) {
      for (const page of application.windows()) {
        if (await page.evaluate(() => typeof window.__PI_DESKTOP__?.selectSession === "function").catch(() => false)) {
          shell = page; break;
        }
      }
      assert(Date.now() < deadline, "Desktop shell did not initialize");
      if (!shell) await new Promise((done) => setTimeout(done, 50));
    }
    shell.setDefaultTimeout(20_000);
    shell.on("pageerror", (error) => errors.push(String(error)));
    await shell.waitForFunction(() => typeof window.__PI_DESKTOP__?.selectSession === "function");
    await shell.locator(".app-shell:not(.app-shell-boot):not(.is-booting)").waitFor();
    const sessionRow = shell.locator(`[data-sidebar-session-row="${sessionId}"]`);
    await sessionRow.getByText("Installed line references", { exact: true }).click();
    await sessionRow.locator('[aria-current="page"]').waitFor();
    await shell.locator('.composer-input[contenteditable="true"]').waitFor();
  };
  await launch();
  stage("desktop-ready");
  await shell.evaluate(async ({ sessionId, source }) => {
    const { invoke, channels } = window.piDesktop;
    for (const [channel, input] of [
      [channels.invoke.pluginViewOpen, { pluginId: "pi.file-manager", viewId: "manager", sessionId, location: source }],
      [channels.invoke.pluginViewSetBounds, { x: 620, y: 90, width: 560, height: 600 }],
      [channels.invoke.pluginViewSetVisible, { pluginId: "pi.file-manager", viewId: "manager", visible: true, sessionId }],
    ]) {
      const result = await invoke(channel, input);
      if (!result.ok) throw new Error(result.error.message);
    }
  }, { sessionId, source });
  const deadline = Date.now() + 20_000;
  while (!(plugin = application.windows().find((page) => page.url().includes("pi.file-manager")))) {
    assert(Date.now() < deadline, "installed plugin view did not open");
    await new Promise((done) => setTimeout(done, 50));
  }
  plugin.setDefaultTimeout(20_000);
  plugin.on("pageerror", (error) => errors.push(String(error)));
  assert(plugin.url().includes("plugins/installed/"), "view must come from the installed package");
  const editor = plugin.locator(".cm-content");
  await editor.getByText("saved first line", { exact: true }).waitFor();
  assert.equal(await plugin.evaluate(() => window.pluginBridge.capabilities.composerFileLines), true);
  await editor.click();
  await plugin.keyboard.press("ControlOrMeta+a");
  await editor.click({ button: "right" });
  await plugin.getByRole("menuitem", { name: "Add to chat", exact: true }).click();
  await shell.locator(".composer-chip").filter({ hasText: "sample.txt (1:2)" }).waitFor();
  assert.equal(requests.length, 0, "Add to chat must not send a prompt");
  checks.push("saved selection reaches the real Composer through installed plugin authorization");
  stage("reference-added");

  await editor.click();
  await plugin.keyboard.press("ControlOrMeta+a");
  await plugin.keyboard.type("unsaved replacement");
  await plugin.getByRole("status").filter({ hasText: "Save or reload the file to reference its lines." }).waitFor();
  await plugin.keyboard.press("ControlOrMeta+a");
  await editor.click({ button: "right" });
  assert.equal(await plugin.getByRole("menuitem", { name: "Add to chat", exact: true }).count(), 0);
  await plugin.keyboard.press("Escape");
  assert.equal(await readFile(source, "utf8"), "saved first line\nsaved second line\n");
  checks.push("unsaved edits remove Add to chat without changing disk content");

  await writeFile(source, "fresh first line\nfresh second line\nEXCLUDED THIRD LINE\n");
  await shell.evaluate(async (sessionId) => {
    const { invoke, channels } = window.piDesktop;
    const result = await invoke(channels.invoke.pluginViewSetVisible, { pluginId: "pi.file-manager", viewId: "manager", visible: false, sessionId });
    if (!result.ok) throw new Error(result.error.message);
  }, sessionId);
  await shell.locator('.composer-input[contenteditable="true"]').evaluate((element) => {
    element.focus();
    const range = document.createRange(); range.selectNodeContents(element); range.collapse(false);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  });
  await shell.keyboard.type("Read the selected lines.");
  await shell.locator('.composer-input[contenteditable="true"]').press("Enter");
  await shell.getByText("Installed file reference received.", { exact: true }).waitFor();
  assert.equal(requests.length, 1);
  const messages = JSON.stringify(requests[0].messages);
  assert(messages.includes("fresh first line") && messages.includes("fresh second line"));
  assert(!messages.includes("saved first line") && !messages.includes("unsaved replacement"));
  assert(!messages.includes("EXCLUDED THIRD LINE"));
  checks.push("real Host scoped Read supplies current disk lines only to the provider boundary");
  stage("prompt-complete");

  const detail = async () => {
    const result = await shell.evaluate((id) => window.piDesktop.invoke(window.piDesktop.channels.invoke.sessionGet, id), sessionId);
    assert.equal(result.ok, true, result.error?.message);
    return result.data;
  };
  const assertReference = (detail) => {
    const user = detail.session.messages.find((message) => message.role === "user");
    assert.deepEqual(user.attachments.map(({ ref, lineRange }) => ({ ref, lineRange })), [
      { ref: source, lineRange: { start: 1, end: 2 } },
    ]);
    assert.equal(detail.session.messages.some((message) => message.role === "tool" || message.toolCall), false);
  };
  const before = await detail();
  assertReference(before);
  await stopApplication();
  await launch();
  const restored = await detail();
  assertReference(restored);
  assert.equal(requests.length, 1, "restart must not resend the prompt");
  assert.deepEqual(errors, []);
  checks.push("line range survives a full Desktop/Host restart without resending");
  passed = true;
  console.log("INSTALLED_FILE_LINES_E2E " + JSON.stringify({ ok: true, checks }));
} catch (error) {
  if (plugin && !plugin.isClosed()) console.error("PLUGIN_STATE " + (await plugin.locator("body").innerText()).slice(-1500));
  if (shell && !shell.isClosed()) {
    console.error("SHELL_STATE " + (await shell.locator("body").innerText()).slice(-3000));
    await shell.screenshot({ path: join(scratch, "failure.png") }).catch(() => {});
  }
  throw error;
} finally {
  await stopApplication();
  provider.closeAllConnections();
  await new Promise((done) => provider.close(done));
  if (passed && process.env.E2E_KEEP_ARTIFACTS !== "1") await rm(scratch, { recursive: true, force: true });
  else console.log(`File lines artifacts: ${scratch}`);
}
