import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "node:module";
import { bindingForCustomModel } from "@pi-desktop/shared";
import { DesktopAgentRuntime } from "@pi-desktop/agent-runtime";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { ExtensionModelCompletionService } = await import("../electron/main/runtime/extension-model-completions.ts");
const { resolveExtensionModelProvider } = await import("../electron/main/runtime/extension-model-provider.ts");
const { extensionHostModels } = await import("../electron/main/runtime/extension-model-catalog.ts");

const catalog = { ensureLoaded: async () => {}, findModel: () => undefined };
const context = { systemPrompt: "Review", messages: [{ role: "user", content: "Say approved", timestamp: 1 }] };
const request = (id, options = {}) => ({ sessionId: "s", extensionId: "ext", requestId: id,
  providerId: "other", modelId: "shared", context, options });
const provider = (baseUrl) => ({ id: "other", name: "Other", baseUrl, authKind: "api_key",
  apiStyle: "chat_completions", hasSecret: true, models: [bindingForCustomModel("shared")] });

test("catalog filters disabled/authless providers, preserves identities, and drops secrets", () => {
  const rows = extensionHostModels([
    { ...provider("https://fixture.invalid/?token=private"), headers: { Authorization: "private" } },
    { ...provider("unused"), id: "same-name", name: "Other" },
    { ...provider("unused"), id: "locked", hasSecret: false },
    { ...provider("unused"), id: "disabled", enabled: false },
  ], catalog);
  assert.deepEqual(rows.map((row) => [row.providerId, row.available]), [["other", true], ["same-name", true], ["locked", false]]);
  assert.equal(JSON.stringify(rows).includes("private"), false);
  assert.equal(rows[0].model.baseUrl, "");
});

test("strict provider resolution never falls back and preserves OAuth endpoint and host headers", async () => {
  let rows = [provider("https://fixture.invalid")];
  let secrets = 0;
  const deps = { listProviders: async () => rows, catalog,
    getSecret: async () => { secrets++; return "fixture-key"; },
    oauth: { bindingFor: async () => ({ baseUrl: "https://account.invalid/v1", apiStyle: "responses" }),
      resolveAuth: async () => ({ apiKey: "oauth-fixture" }) } };
  await assert.rejects(resolveExtensionModelProvider(deps, "missing", "shared"), { errorCode: "MODEL_NOT_CONFIGURED" });
  await assert.rejects(resolveExtensionModelProvider(deps, "other", "missing"), { errorCode: "MODEL_NOT_CONFIGURED" });
  assert.equal(secrets, 0);
  rows = [{ ...rows[0], authKind: "oauth", headers: { "X-Test": "fixture" } }];
  const resolved = await resolveExtensionModelProvider(deps, "other", "shared");
  assert.equal(resolved.baseUrl, "https://account.invalid/v1");
  assert.equal(resolved.apiStyle, "responses");
  assert.deepEqual(resolved.headers, { "X-Test": "fixture" });
  assert.equal(secrets, 0);
});

test("loaded extension selects a second provider and completes through the real pi adapter", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-extension-complete-"));
  const received = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    received.push({ url: req.url, authorization: req.headers.authorization, body: JSON.parse(raw) });
    const base = { id: "fixture", object: "chat.completion.chunk", created: 1, model: "shared" };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "approved" }, finish_reason: null }] })}\n\n`);
    res.end(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const rows = [provider(`http://127.0.0.1:${server.address().port}/v1`)];
  const entry = join(root, "extension.ts");
  writeFileSync(entry, `export default function(pi) {
    pi.registerCommand("review", { async handler(_, ctx) {
      const model = ctx.modelRegistry.find("other", "shared");
      const result = await ctx.modelRegistry.complete(model, ${JSON.stringify(context)}, { maxTokens: 32, temperature: 0 });
      await ctx.ui.notify(JSON.stringify({ result, current: ctx.model.id }));
    } });
  }`);
  const audited = [];
  const service = new ExtensionModelCompletionService({
    authorize: async () => "fixture",
    resolveProvider: (providerId, modelId) => resolveExtensionModelProvider({
      listProviders: async () => rows, getSecret: async () => "fixture-only-key", catalog,
      oauth: { bindingFor: async () => undefined, resolveAuth: async () => ({}) },
    }, providerId, modelId), audit: (event) => audited.push(event),
  });
  const notices = [];
  const methods = [];
  const runtime = new DesktopAgentRuntime({ sessionId: "s", mode: "agent", thinkingLevel: "off",
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    provider: { id: "current", name: "Current", modelId: "current", authKind: "none", apiKey: "",
      supportsReasoning: false, supportedThinkingLevels: ["off"] },
    extensionModels: extensionHostModels(rows, catalog),
    trustedExtensions: [{ id: entry, entry, root, label: "Reviewer", source: "plugin" }],
    onEvent() {}, host: { async call(method, params) {
      methods.push(method);
      if (method === "extensions.model.complete") return service.complete(params);
      if (method === "extensions.model.cancel") return service.cancel(params);
      if (method === "extensions.ui.request") notices.push(params.request.message);
      return {};
    } },
  });
  try {
    await runtime.loadTrustedExtensions();
    await runtime.runTrustedExtensionCommand("review", "");
    assert.equal(notices.length, 1, "command must reach its visible result");
    const { result, current } = JSON.parse(notices[0]);
    assert.equal(result.content[0].text, "approved");
    assert.equal(result.provider, "other");
    assert.equal(result.usage.totalTokens, 4);
    assert.equal(current, "current");
    assert.equal(received[0].authorization, "Bearer fixture-only-key");
    assert.equal(received[0].url, "/v1/chat/completions");
    assert.equal(received[0].body.model, "shared");
    assert.equal(received[0].body.messages.at(-1).content, "Say approved");
    assert.equal(methods.some((method) => ["session.configure", "session.appendMessage", "session.replaceMessages"].includes(method)), false);
    assert.equal(JSON.stringify([...notices, ...audited]).includes("fixture-only-key"), false);
    runtime.setExtensionModels([]);
    assert.equal(runtime.getStatus().modelId, "current");
  } finally {
    await runtime.dispose(); service.dispose();
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});

test("cancellation, timeout and disposal interrupt credential resolution before any provider request", async () => {
  for (const action of ["cancel", "timeout", "dispose"]) {
    let release;
    let started;
    const ready = new Promise((resolve) => { started = resolve; });
    const service = new ExtensionModelCompletionService({ authorize: async () => "fixture", audit() {},
      resolveProvider: () => { started(); return new Promise((resolve) => { release = resolve; }); } });
    const pending = service.complete(request(action, action === "timeout" ? { timeoutMs: 5 } : {}));
    const rejected = assert.rejects(pending, { errorCode: action === "timeout" ? "TIMEOUT" : "TURN_ABORTED" });
    await ready;
    if (action === "cancel") service.cancel({ sessionId: "s", extensionId: "ext", requestId: action });
    if (action === "dispose") service.dispose();
    await rejected;
    release({}); // A late resolver must not start a provider call.
    service.dispose();
  }
});

test("invalid options, unauthorized extensions and resolver failures remain bounded and redacted", async () => {
  const service = new ExtensionModelCompletionService({ authorize: async () => "fixture", audit() {},
    resolveProvider: async () => { throw new Error("Authorization: fixture-private"); } });
  await assert.rejects(service.complete(request("headers", { headers: { Authorization: "evil" } })), { errorCode: "INVALID_ARGUMENT" });
  await assert.rejects(service.complete({ ...request("tools"), context: { ...context, tools: [{ name: "Bash" }] } }), { errorCode: "INVALID_ARGUMENT" });
  await assert.rejects(service.complete(request("error")), (error) => error.errorCode === "PROVIDER_ERROR" && !error.message.includes("fixture-private"));
  service.dispose();
});

test("text and image requests share plugin quota and revoked grants prevent provider execution", async () => {
  let calls = 0;
  let authorized = true;
  const service = new ExtensionModelCompletionService({
    authorize: async () => {
      if (!authorized) throw Object.assign(new Error("revoked"), { errorCode: "PERMISSION_DENIED" });
      return "same-plugin";
    }, audit() {}, resolveProvider: async () => { calls++; throw new Error("fixture provider unavailable"); },
  });
  const imageRequest = (id) => ({ ...request(id), context: { input: [{ type: "text", text: "A circle" }] } });
  for (let index = 0; index < 8; index++) {
    const pending = index % 2 ? service.generateImages(imageRequest(String(index))) : service.complete(request(String(index)));
    await assert.rejects(pending, { errorCode: "PROVIDER_ERROR" });
  }
  await assert.rejects(service.generateImages(imageRequest("limited")), { errorCode: "RATE_LIMITED" });
  assert.equal(calls, 8);
  authorized = false;
  await assert.rejects(service.generateImages(imageRequest("revoked")), { errorCode: "PERMISSION_DENIED" });
  assert.equal(calls, 8);
  service.dispose();
});
