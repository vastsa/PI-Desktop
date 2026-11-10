#!/usr/bin/env node
/** Production provider registry and real loopback HTTP; no model account. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { normalizeContext } from "../packages/agent-runtime/node_modules/@earendil-works/pi-ai/dist/index.js";
import { Type } from "../packages/agent-runtime/node_modules/typebox/build/index.mjs";
import { buildProviderModel, createProviderModels } from "../packages/agent-runtime/dist/provider-binding.js";
import { scheduledToolParameters } from "../packages/agent-runtime/dist/scheduled-tools.js";

const requests = [];
const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  requests.push(body);
  if (JSON.stringify(body).includes('"uniqueItems":true')) {
    response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({
      error: { message: "Invalid schema: unsupported uniqueItems", code: "invalid_json_schema" },
    }));
    return;
  }
  response.writeHead(200, { "content-type": "text/event-stream" }).end(
    'data: {"type":"response.completed","response":{"id":"resp_fixture","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":0,"total_tokens":1}}}\n\n',
  );
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
try {
  const provider = { id: "fixture", name: "Fixture", modelId: "gpt-5.4", apiKey: "synthetic-key",
    apiStyle: "responses", baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    supportsReasoning: false, supportedThinkingLevels: ["off"] };
  for (const method of ["stream", "streamSimple"]) {
    for (const replay of ["none", "additions", "changes"]) {
      const tools = ["ScheduledTaskCreate", "ScheduledTaskUpdate"].map(name => ({
        name, description: name, parameters: Type.Object(scheduledToolParameters[name]),
      }));
      const context = normalizeContext({ messages: [
        { role: "system", content: "Synthetic policy", timestamp: 1 },
        { role: "user", content: "Hello", timestamp: 2 },
        { role: "system", content: "", timestamp: 3, toolsAdded: tools },
        { role: "user", content: "Continue", timestamp: 4 },
      ] });
      const original = structuredClone(context);
      const model = buildProviderModel(provider);
      model.compat = { ...model.compat, supportsMidConvoSystemMessages: true,
        supportsAdditionalTools: replay === "changes", supportsToolSearch: replay === "additions" };
      const before = requests.length;
      const result = await createProviderModels(provider, model)[method](model, context, { maxRetries: 0 }).result();
      assert.equal(result.errorMessage, undefined);
      assert.equal(result.stopReason, "stop");
      assert.equal(requests.length, before + 1);
      const body = requests.at(-1);
      assert.ok(JSON.stringify(body).includes("ScheduledTaskCreate"));
      if (replay !== "none") assert.ok(body.input.some(item => item.type === (replay === "changes" ? "additional_tools" : "tool_search_output")));
      assert.deepEqual(context, original);
      console.log(`PASS ${method} / ${replay}: real HTTP schema accepted; history unchanged`);
    }
  }
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
