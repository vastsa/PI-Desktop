import assert from "node:assert/strict";
import test from "node:test";
import { bindingFromModelInfo, matchNamedPreset } from "@pi-desktop/shared";
import { modelConfigWithBinding } from "@pi-desktop/agent-runtime";
import {
  ModelsDevCatalog, modelConfigFromModelsDev, modelInfoFromModelsDev,
} from "../electron/main/models-dev-catalog.ts";

const baseUrl = "https://api.stepfun.com/v1";
const catalogPath = new URL("../resources/models.dev/api.json", import.meta.url).pathname;
const target = { baseUrl, vendorKey: "stepfun", modelId: "step-5-preview" };

test("StepFun selection retains official capabilities through a saved model binding", async () => {
  const preset = matchNamedPreset({ baseUrl });
  assert.equal(preset?.id, "stepfun");
  assert.equal(preset.apiStyle, "chat_completions");
  const catalog = new ModelsDevCatalog({ catalogPath });
  await catalog.ensureLoaded();
  const model = catalog.findModel(target);
  assert.ok(model);
  assert.equal(model.metadataSource, "provider");
  const info = modelInfoFromModelsDev(model, "saved-stepfun");
  assert.equal(info.catalogSource, "provider");
  assert.deepEqual(info.supportedThinkingLevels, ["low", "medium", "high"]);
  assert.ok(info.capabilities.includes("tools"));
  assert.ok(info.capabilities.includes("vision"));
  const savedBinding = JSON.parse(JSON.stringify(bindingFromModelInfo(info)));
  const config = modelConfigWithBinding(modelConfigFromModelsDev(model, baseUrl), savedBinding);
  assert.equal(config.contextWindow, 1_024_000);
  assert.equal(config.maxTokens, 64_000);
  assert.deepEqual(config.input, ["text", "image"]);
  assert.equal(config.reasoning, true);
  const overridden = modelConfigWithBinding(config, {
    ...savedBinding, contextWindow: 256_000, maxTokens: 4096,
    supportsImages: false, thinkingLevels: ["low"],
  });
  assert.equal(overridden.contextWindow, 256_000);
  assert.equal(overridden.maxTokens, 4096);
  assert.deepEqual(overridden.input, ["text"]);
  assert.deepEqual(overridden.supportedThinkingLevels, ["low"]);
});

test("the StepFun supplement never changes gateways, other models, or lookalike hosts", async () => {
  const catalog = new ModelsDevCatalog({ catalogPath });
  await catalog.ensureLoaded();
  for (const baseUrl of ["https://api.example.com/v1", "https://api.stepfun.com.evil.test/v1", "http://api.stepfun.com/v1", "https://api.stepfun.com/other/v1"]) {
    assert.notEqual(catalog.findModel({ ...target, baseUrl })?.metadataSource, "provider");
  }
  assert.notEqual(catalog.findModel({ ...target, modelId: "step-3.7-flash" })?.metadataSource, "provider");
});

test("a published first-party catalog record supersedes the StepFun supplement after refresh", async () => {
  const catalog = new ModelsDevCatalog({ catalogPath, fetchImpl: async () => new Response(JSON.stringify({
    stepfun: { id: "stepfun", name: "StepFun", api: baseUrl, models: {
      "step-5-preview": { id: "step-5-preview", name: "Updated Step", reasoning: true,
        tool_call: true, modalities: { input: ["text", "image"], output: ["text"] },
        limit: { context: 1_048_576, output: 32_768 } },
    } },
  }), { status: 200 }) });
  await catalog.ensureLoaded();
  assert.equal(catalog.findModel(target)?.limit.context, 1_024_000);
  assert.equal(await catalog.refresh(), true);
  const updated = catalog.findModel(target);
  assert.notEqual(updated.metadataSource, "provider");
  assert.equal(updated.limit.context, 1_048_576);
  assert.equal(modelConfigFromModelsDev(updated).source, "models.dev");
});

test("discover, select, restore and stream a StepFun tool round trip through the real adapter", async (t) => {
  const { discoverProviderModels } = await import("../electron/main/model-discovery.ts");
  const { buildProviderModel, createProviderModels } = await import("../../../packages/agent-runtime/dist/provider-binding.js");
  const discovery = t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url, `${baseUrl}/models`);
    assert.equal(init.headers.Authorization, "Bearer test-credential");
    return Response.json({ data: [{ id: "step-5-preview", object: "model" }] });
  });
  const preset = matchNamedPreset({ baseUrl });
  const listed = await discoverProviderModels({ ...preset, apiKey: "test-credential" });
  discovery.mock.restore();
  const catalog = new ModelsDevCatalog({ catalogPath });
  await catalog.ensureLoaded();
  const metadata = catalog.findModel({ ...target, modelId: listed[0].modelId });
  const savedBinding = JSON.parse(JSON.stringify(bindingFromModelInfo(modelInfoFromModelsDev(metadata, "stepfun-row"))));
  const provider = { id: "stepfun-row", name: preset.name, vendorKey: preset.vendorKey, baseUrl,
    apiStyle: preset.apiStyle, modelId: savedBinding.id, apiKey: "test-credential",
    supportsReasoning: true, supportedThinkingLevels: savedBinding.thinkingLevels,
    modelConfig: modelConfigWithBinding(modelConfigFromModelsDev(metadata, baseUrl), savedBinding) };
  const model = buildProviderModel(provider);
  const models = createProviderModels(provider, model);
  const sse = (delta, finishReason) => new Response(
    `data: ${JSON.stringify({ id: "test-stream", object: "chat.completion.chunk", model: model.id,
      choices: [{ index: 0, delta, finish_reason: null }] })}\n\n` +
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } })}\n\n` +
    "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } },
  );
  for (const reasoning of ["low", "medium", "high"]) {
    let turn = 0;
    const context = { systemPrompt: "Use the test tool.", messages: [{ role: "user", timestamp: 1,
      content: [{ type: "text", text: "Read the probe." }, { type: "image", data: "dGVzdA==", mimeType: "image/png" }] }],
      tools: [{ name: "read_probe", description: "Read the probe", parameters: { type: "object", properties: {} } }] };
    const fetch = async (url, init) => {
      assert.equal(String(url), `${baseUrl}/chat/completions`);
      const body = JSON.parse(init.body);
      assert.equal(body.model, "step-5-preview");
      assert.equal(body.reasoning_effort, reasoning);
      assert.equal(body.max_completion_tokens ?? body.max_tokens, 64_000);
      assert.equal(body.messages[0].role, "system");
      assert.ok(body.messages[1].content.some(part => part.type === "image_url"));
      if (turn++ === 0) return sse({ role: "assistant", reasoning_content: "Read the probe first.",
        tool_calls: [{ index: 0, id: "probe-call", type: "function", function: { name: "read_probe", arguments: "{}" } }] }, "tool_calls");
      const assistant = body.messages.find(message => message.role === "assistant");
      assert.equal(assistant.reasoning_content, "Read the probe first.");
      assert.equal(body.messages.at(-1).role, "tool");
      assert.equal(body.messages.at(-1).tool_call_id, "probe-call");
      assert.equal(body.messages.at(-1).content, "42");
      return sse({ role: "assistant", content: "42" }, "stop");
    };
    const first = await models.streamSimple(model, context, { reasoning, fetch }).result();
    assert.equal(first.stopReason, "toolUse");
    const call = first.content.find(block => block.type === "toolCall");
    assert.equal(call.name, "read_probe");
    // Reloaded transcript data must retain the reasoning field and tool identity.
    context.messages.push(JSON.parse(JSON.stringify(first)), {
      role: "toolResult", toolCallId: call.id, toolName: call.name,
      content: [{ type: "text", text: "42" }], isError: false, timestamp: 2,
    });
    const second = await models.streamSimple(model, context, { reasoning, fetch }).result();
    assert.equal(second.stopReason, "stop");
    assert.equal(second.content.find(block => block.type === "text").text, "42");
    assert.equal(second.usage.totalTokens, 20);
  }
});

test("an unavailable catalog keeps an explicitly selected StepFun model usable without inventing availability", async () => {
  const catalog = new ModelsDevCatalog({ catalogPath: "missing-stepfun-test-catalog.json" });
  assert.equal(await catalog.ensureLoaded(), false);
  assert.equal(catalog.findModel(target)?.limit.context, 1_024_000);
  assert.deepEqual(catalog.modelsForProvider({ ...target, providerId: "stepfun-row" }), []);
});
