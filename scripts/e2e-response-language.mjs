#!/usr/bin/env node
/** Production Desktop/Host/sidecar language dispatch; only the provider is synthetic. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertDesktopBuild, repositoryRoot } from "./e2e/boot.mjs";
import { Host, resolveHostBinary } from "./e2e/host.mjs";
import { isolatedEnv } from "./e2e/hosted-search-sidecar.mjs";
import { launchLiveVoiceDesktop as launchDesktop } from "./e2e/live-voice-desktop.mjs";
import { createSession } from "./e2e/session.mjs";
import { waitFor } from "./e2e/wait.mjs";

const root = repositoryRoot();
assertDesktopBuild(root);
const scratch = await realpath(await mkdtemp(join(tmpdir(), "pi-response-language-")));
const project = join(scratch, "project");
const dataDir = join(scratch, "data");
const persona = "RESPONSE-LANGUAGE-FIXTURE-PERSONA";
const requests = [];
const checks = [];
let desktop;
let passed = false;
let sessionId;
const env = {
  ...await isolatedEnv(scratch),
  PI_DESKTOP_AGENTS_DIR: join(scratch, "agents"),
  PI_DESKTOP_HOST_BIN: resolveHostBinary(),
};

const provider = createServer(async (request, response) => {
  try {
    assert.equal(request.url, "/v1/chat/completions");
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    const base = { id: `language-${requests.length}`, object: "chat.completion.chunk", created: 1, model: body.model };
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const value of [
      { choices: [{ index: 0, delta: { role: "assistant", content: `Language fixture answer ${requests.length}.` }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
    ]) response.write(`data: ${JSON.stringify({ ...base, ...value })}\n\n`);
    response.end("data: [DONE]\n\n");
  } catch (error) {
    response.writeHead(500); response.end(String(error));
  }
});

const selectSession = async () => {
  await desktop.evaluate(`window.__PI_DESKTOP__.selectSession(${JSON.stringify(sessionId)})`);
  await waitFor(() => desktop.evaluate(`Boolean(document.querySelector('.composer-input[contenteditable="true"]'))`), 20_000, "session Composer");
};
const launch = async () => {
  desktop = await launchDesktop({
    root, dataDir, profile: join(scratch, "profile"), home: env.HOME,
    env, syntheticMicrophone: false,
  });
  await waitFor(() => desktop.evaluate(`Boolean(document.querySelector('.app-shell:not(.app-shell-boot):not(.is-booting)'))`), 30_000, "Desktop bootstrap");
  await selectSession();
};
const chooseLanguage = async (locale, label) => {
  await desktop.evaluate(`window.__PI_DESKTOP__.setSettingsTab("appearance"); window.__PI_DESKTOP__.setPage("settings")`);
  await desktop.clickSelector(".settings-language-trigger");
  await desktop.clickText(label, ".settings-language-option-native");
  await waitFor(async () => (await desktop.invoke("settingsGet")).language === locale, 10_000, "persisted language setting");
  await waitFor(() => desktop.evaluate(`document.documentElement.lang === ${JSON.stringify(locale)}`), 10_000, "renderer language");
  await selectSession();
};
const submit = async (locale, prompt) => {
  const count = requests.length + 1;
  console.log(`RESPONSE_LANGUAGE_STAGE submitting ${locale} request ${count}`);
  await desktop.clickSelector('.composer-input[contenteditable="true"]');
  await desktop.send("Input.insertText", { text: prompt });
  await desktop.clickSelector(".composer-shell .send-btn");
  await waitFor(() => requests.length === count, 30_000, "provider-bound language request");
  await waitFor(() => desktop.evaluate(`document.body.innerText.includes(${JSON.stringify(`Language fixture answer ${count}.`)})`), 20_000, "completed fixture response");
  const request = requests.at(-1);
  const system = JSON.stringify(request.messages.filter(message => message.role === "system"));
  const guidance = `Use the current application language (${locale})`;
  assert(system.includes(guidance), `provider system prompt is missing ${locale} application-language guidance`);
  assert.equal(system.split(guidance).length - 1, 1, "language policy is injected once");
  assert(!system.includes(`Use the current application language (${locale === "en" ? "zh-CN" : "en"})`), "previous language policy leaked into the new system prompt");
  assert(system.includes(persona), "project SYSTEM.md replacement survived language dispatch");
  assert(system.includes("thinking, reasoning, progress updates, and final responses"));
  assert(system.includes("unless the user explicitly requests a different language"));
  assert(system.includes("Keep code, identifiers, paths, commands, and quoted text in their required language"));
  assert(JSON.stringify(request.messages.filter(message => message.role === "user").at(-1)).includes(prompt), "user text reaches the provider unchanged");
  console.log(`RESPONSE_LANGUAGE_STAGE ${locale} request ${count} passed`);
};

try {
  await mkdir(join(project, ".pi"), { recursive: true });
  await writeFile(join(project, ".pi", "SYSTEM.md"), persona);
  await new Promise((resolve, reject) => { provider.once("error", reject); provider.listen(0, "127.0.0.1", resolve); });
  const host = new Host(env.PI_DESKTOP_HOST_BIN, dataDir, { quiet: true, env });
  try {
    await host.start();
    const created = await host.call("providers.create", {
      name: "Language fixture", type: "openai_compatible", apiStyle: "chat_completions",
      baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, authKind: "api_key", secretValue: "language-fixture-key",
      models: [{ id: "language-fixture", contextWindow: 128000, maxTokens: 4096, thinkingLevels: ["off"] }],
      defaultModelId: "language-fixture",
    });
    await host.call("settings.set", {
      language: "zh-CN", defaultProviderId: created.provider.id,
      defaultModelId: "language-fixture", defaultMode: "agent",
    });
    sessionId = (await createSession(host, project, "Response language acceptance")).id;
    await host.call("session.configure", { id: sessionId, mode: "agent", permissionMode: "auto" });
  } finally { await host.stop(); }

  await launch();
  assert.equal(await desktop.evaluate("document.documentElement.lang"), "zh-CN");
  await submit("zh-CN", "Summarize this synthetic fixture.");
  checks.push("resolved Chinese application language reaches the provider despite an English task and custom SYSTEM.md");
  await chooseLanguage("en", "English");
  await submit("en", "Continue in the same session.");
  checks.push("changing language through Settings replaces the policy on the next turn in the same Session");
  await chooseLanguage("zh-CN", "简体中文");
  await submit("zh-CN", "Please answer in English: explain this fixture.");
  checks.push("explicit user-language requests and their precedence remain present in the provider request");
  await desktop.close(); desktop = undefined;
  await launch();
  assert.equal((await desktop.invoke("settingsGet")).language, "zh-CN");
  assert.equal(requests.length, 3, "restart must not resend prior turns");
  await submit("zh-CN", "Continue after restarting the application.");
  checks.push("persisted language and custom persona survive a full Desktop/Host restart without resending");
  passed = true;
  console.log("RESPONSE_LANGUAGE_E2E " + JSON.stringify({ ok: true, requests: requests.length, checks }));
} finally {
  try { await desktop?.close(); }
  finally {
    provider.closeAllConnections();
    await new Promise(resolve => provider.close(resolve));
    if (passed) await rm(scratch, { recursive: true, force: true });
    else console.error(`Response language artifacts: ${scratch}`);
  }
}
