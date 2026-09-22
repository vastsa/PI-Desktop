/** Explicitly authorized opt-in smoke: at most one generation and one edit. */
import assert from "node:assert/strict";
import { register } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
register(new URL("../apps/desktop/test/helpers/ts-import-hooks.mjs", import.meta.url));
const { createImageGenerationTool } = await import(
  "../apps/desktop/electron/main/services/image-generation-service.ts"
);
const { imageGenerationParameters, imageGenerationDescription } = await import(
  "../packages/agent-runtime/src/image-generation/tool.ts"
);
const { imageGenerationItems } = await import("../packages/shared/dist/image-generation.js");

let inputConfig = {};
if (process.argv.includes("--stdin")) {
  const { createInterface } = await import("node:readline");
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  const reader = createInterface({ input: process.stdin, terminal: false });
  const line = await new Promise((resolve) => reader.once("line", resolve));
  reader.close();
  inputConfig = JSON.parse(line);
}
const base = inputConfig.baseUrl || process.env.PI_IMAGE_TEST_BASE_URL;
const chatKey = inputConfig.chatKey || process.env.PI_IMAGE_TEST_CHAT_KEY;
const imageKey = inputConfig.imageKey || process.env.PI_IMAGE_TEST_IMAGE_KEY;
const imageModel = inputConfig.imageModel || process.env.PI_IMAGE_TEST_MODEL;
assert(base && chatKey && imageKey && imageModel, "Set the opt-in image test environment first.");
const apiBase = new URL(base);
if (!apiBase.pathname.replace(/\/+$/, "")) apiBase.pathname = "/v1";
const url = (path) => `${apiBase.href.replace(/\/+$/, "")}/${path}`;
const chatHeaders = { Authorization: `Bearer ${chatKey}`, "Content-Type": "application/json" };
const directory = await mkdtemp(join(tmpdir(), "pi-image-live-"));
let attempts = 0;
try {
  const list = await fetch(url("models"), {
    headers: chatHeaders,
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  assert(list.ok, `Model discovery HTTP ${list.status}`);
  const ids = ((await list.json()).data ?? [])
    .map((row) => row.id)
    .filter((id) => typeof id === "string");
  const chatModel =
    process.env.PI_IMAGE_TEST_CHAT_MODEL ||
    ["deepseek", "deepseek-chat", "deepseek-v3"].find((id) => ids.includes(id)) ||
    ids.find((id) => /deepseek/i.test(id));
  assert(chatModel, "No DeepSeek model was advertised by the supplied endpoint.");
  const chat = await fetch(url("chat/completions"), {
    method: "POST",
    headers: chatHeaders,
    redirect: "error",
    signal: AbortSignal.timeout(90_000),
    body: JSON.stringify({
      model: chatModel,
      messages: [
        {
          role: "user",
          content:
            "Use GenerateImages exactly once to generate ONE simple raster illustration of a blue ceramic cup on a plain white background. No text, no variants, no input images. Return a tool call.",
        },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "generate_images",
            description: imageGenerationDescription,
            parameters: {
              type: "object",
              properties: imageGenerationParameters,
              required: ["items"],
            },
          },
        },
      ],
      tool_choice: "auto",
      max_tokens: 1200,
    }),
  });
  assert(chat.ok, `DeepSeek HTTP ${chat.status}`);
  const call = (await chat.json()).choices?.[0]?.message?.tool_calls?.[0];
  assert.equal(
    call?.function?.name,
    "generate_images",
    "DeepSeek did not return the expected tool call.",
  );
  const input = JSON.parse(call.function.arguments);
  const jobs = imageGenerationItems(input);
  assert(jobs.length === 1 && !jobs[0].images, "Live test refuses more than one initial image.");
  const host = {
    call: async (method) => {
      if (method === "settings.get")
        return { imageGeneration: { providerId: "live-image", modelId: imageModel } };
      if (method === "providers.get")
        return {
          provider: {
            id: "live-image",
            enabled: true,
            authKind: "api_key_and_base_url",
            baseUrl: apiBase.href,
            models: [{ id: imageModel }],
          },
        };
      if (method === "providers.getSecret") return { value: imageKey };
      if (method === "session.getScratchPath") return { path: join(directory, "scratch", "live") };
      if (method === "session.get") return { session: {} };
      throw new Error("Unexpected host method");
    },
  };
  const tool = createImageGenerationTool({
    dataDir: directory,
    getHost: () => host,
    fetchImpl: async (...args) => {
      assert(++attempts <= 2, "Live image request budget exhausted");
      return fetch(...args);
    },
  });
  const run = (args) =>
    tool({
      sessionId: "live",
      toolCallId: String(attempts),
      args,
      signal: new AbortController().signal,
    });
  const generated = await run(input);
  console.log(
    JSON.stringify({
      stage: "generation",
      chatModel,
      imageModel,
      toolCalled: true,
      results: generated.content.results?.map(({ status, errorCode, mimeType }) => ({
        status,
        errorCode,
        mimeType,
      })),
    }),
  );
  assert(generated.ok, "Live generation failed; no retry was attempted.");
  const edited = await run({
    items: [
      {
        prompt:
          "Change only the blue ceramic cup to green. Preserve the plain white background and the composition.",
        images: [generated.content.results[0].path],
      },
    ],
  });
  console.log(
    JSON.stringify({
      stage: "edit",
      imageModel,
      results: edited.content.results?.map(({ status, errorCode, mimeType }) => ({
        status,
        errorCode,
        mimeType,
      })),
      attempts,
    }),
  );
  assert(edited.ok, "Live edit failed; no retry was attempted.");
} finally {
  await rm(directory, { recursive: true, force: true });
}
