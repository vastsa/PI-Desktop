import assert from "node:assert/strict";
import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export const SEARCH_ITEM = {
  id: "ws_offline_search", type: "web_search_call", status: "completed",
  action: {
    type: "search", query: "offline hosted search fixture",
    sources: [{ type: "url", url: "http://127.0.0.1/offline-source", title: "Offline source" }],
  },
};

export function assertReplay(body) {
  const items = body.input.filter((item) => item.type === "web_search_call");
  assert.deepEqual(items, [SEARCH_ITEM], "the next real provider request must preserve the nameless search wire item");
  assert.equal(Object.hasOwn(items[0], "name"), false);
  assert.equal(body.input.some((item) => item.type === "function_call" && /search/i.test(item.name)), false,
    "hosted search must not become a local function call");
}

export function functionResult(body, name) {
  const call = body.input.find((item) => item.type === "function_call" && item.name === name);
  assert.ok(call, `${name} function call missing from provider history`);
  const result = body.input.find((item) => item.type === "function_call_output" && item.call_id === call.call_id);
  assert.ok(result, `${name} result missing from provider history`);
  return result.output;
}

export function providerConfig(baseUrl, modelId = "offline-parent") {
  const url = new URL(baseUrl);
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.protocol, "http:");
  return {
    id: "offline-provider", name: "Offline Responses fixture", baseUrl,
    apiKey: "offline-test", authKind: "api_key", apiStyle: "responses",
    modelId, supportsReasoning: false, supportedThinkingLevels: ["off"],
    modelConfig: {
      id: modelId, name: modelId, api: "openai-responses", provider: "offline-provider",
      baseUrl, reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000, maxTokens: 4096, webSearch: true,
    },
  };
}

// These are provider wire fixtures, not Agent/estimator mocks. The production
// Responses adapter must parse every item and serialize it again on continuation.
function respondSse(res, model, plan, serial) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  let sequence = 0;
  const emit = (type, fields) => res.write(
    `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...fields })}\n\n`,
  );
  const response = {
    id: `resp_offline_${serial}`, object: "response", created_at: 1,
    model, status: "in_progress", output: [], error: null, incomplete_details: null,
  };
  emit("response.created", { response });
  emit("response.in_progress", { response });
  const output = [];
  if (plan.search) {
    const output_index = output.length;
    emit("response.output_item.added", {
      output_index, item: { id: SEARCH_ITEM.id, type: "web_search_call", status: "in_progress" },
    });
    for (const status of ["in_progress", "searching", "completed"]) {
      emit(`response.web_search_call.${status}`, { output_index, item_id: SEARCH_ITEM.id });
    }
    emit("response.output_item.done", { output_index, item: SEARCH_ITEM });
    output.push(SEARCH_ITEM);
  }
  if (plan.text) {
    const output_index = output.length;
    const item = {
      id: `msg_offline_${serial}`, type: "message", role: "assistant", status: "in_progress", content: [],
    };
    const locator = { output_index, item_id: item.id, content_index: 0 };
    emit("response.output_item.added", { output_index, item });
    emit("response.content_part.added", { ...locator, part: { type: "output_text", text: "", annotations: [] } });
    emit("response.output_text.delta", { ...locator, delta: plan.text });
    const part = { type: "output_text", text: plan.text, annotations: [] };
    emit("response.output_text.done", { ...locator, text: plan.text });
    emit("response.content_part.done", { ...locator, part });
    const completed = { ...item, status: "completed", content: [part] };
    emit("response.output_item.done", { output_index, item: completed });
    output.push(completed);
  }
  if (plan.tool) {
    const output_index = output.length;
    const args = JSON.stringify(plan.tool.args);
    const item = {
      id: `fc_offline_${serial}`, call_id: `call_offline_${serial}`, type: "function_call",
      name: plan.tool.name, arguments: "", status: "in_progress",
    };
    const locator = { output_index, item_id: item.id };
    emit("response.output_item.added", { output_index, item });
    emit("response.function_call_arguments.delta", { ...locator, delta: args });
    emit("response.function_call_arguments.done", { ...locator, arguments: args });
    const completed = { ...item, status: "completed", arguments: args };
    emit("response.output_item.done", { output_index, item: completed });
    output.push(completed);
  }
  emit("response.completed", {
    response: {
      ...response, status: "completed", output,
      usage: {
        input_tokens: 1000, output_tokens: 30, total_tokens: 1030,
        input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 },
      },
    },
  });
  res.end();
}

export async function startProvider(dir, handler) {
  const requests = [];
  let failure;
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.socket.remoteAddress, "127.0.0.1", "non-loopback connection rejected");
      assert.equal(req.headers.host, `127.0.0.1:${server.address().port}`);
      assert.equal(req.method, "POST");
      assert.equal(req.url, "/v1/responses");
      assert.equal(req.headers.authorization, "Bearer offline-test");
      let raw = "";
      for await (const chunk of req) {
        raw += chunk;
        assert.ok(Buffer.byteLength(raw) < 2_000_000, "fixture request size limit");
      }
      const body = JSON.parse(raw);
      requests.push(body);
      assert.equal(body.stream, true);
      assert.ok(body.tools.some((tool) => tool.type === "web_search"), "native search must be enabled on the real request");
      const plan = await handler(body, requests);
      respondSse(res, body.model, plan, requests.length);
    } catch (error) {
      failure ??= error;
      if (!res.headersSent) res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: error.message, type: "invalid_request_error" } }));
    }
  });
  server.requestTimeout = 5000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, requests,
    check() { if (failure) throw failure; },
    async close() {
      const closed = new Promise((resolve) => server.close(resolve));
      server.closeAllConnections();
      await closed;
      await writeFile(join(dir, "provider-requests.json"), JSON.stringify(requests, null, 2));
    },
  };
}
