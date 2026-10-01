import { expect, it, vi } from "vitest";
import { createModels, createProvider, type AssistantImages, type ImageModel } from "@earendil-works/pi-ai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { createImageBinding, generateImageBatch, type ImageOperationMetadata } from "./index.js";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8=";
const input = { items: [{ prompt: "draw" }] };
const signal = () => new AbortController().signal;
const save = vi.fn(async (_image: unknown, index: number) => `/scratch/${index}.png`);
const endpoint = { baseUrl: "https://images.example/v1", modelId: "custom-image", apiKey: "fixture" };
const nativeResponse = () => Response.json({ id: "response-1", choices: [{ message: {
  content: "Two views", images: [{ image_url: { url: `data:image/png;base64,${png}` } }, { image_url: { url: `data:image/png;base64,${png}` } }],
} }], usage: { prompt_tokens: 10, completion_tokens: 20 } });

it("dispatches native OpenRouter through Pi once, preserving every image, text and usage", async () => {
  const known = openrouterProvider().getAllModels!().find((model): model is ImageModel<string> => model.type === "image");
  expect(known).toBeDefined();
  const binding = createImageBinding({ ...endpoint, vendorKey: "openrouter", modelId: known!.id });
  const generate = vi.spyOn(binding.models, "generateImages");
  const transport = vi.fn<typeof fetch>().mockResolvedValue(nativeResponse());
  const operations: ImageOperationMetadata[] = [];
  const result = await generateImageBatch({ binding, input, signal: signal(), save, fetchImpl: transport, onOperation: op => operations.push(op) });
  expect(generate).toHaveBeenCalledTimes(1);
  expect(generate.mock.calls[0][2]).toMatchObject({ maxRetries: 0 });
  expect(transport).toHaveBeenCalledTimes(1);
  expect(String(transport.mock.calls[0][0])).toContain("/chat/completions");
  expect(JSON.parse(String(transport.mock.calls[0][1]?.body))).toMatchObject({ model: known!.id, stream: false });
  expect(result.map(item => item.status)).toEqual(["succeeded", "succeeded"]);
  expect(operations).toHaveLength(1);
  expect(operations[0]).toMatchObject({ text: ["Two views"], responseId: "response-1", usage: { inputTokens: 10, outputTokens: 20 } });
});

it("never retries native billable failures or falls back to the OpenAI adapter", async () => {
  for (const status of [401, 429, 500]) {
    const transport = vi.fn<typeof fetch>().mockImplementation(async () => new Response("secret", { status }));
    const results = await generateImageBatch({ endpoint: { ...endpoint, vendorKey: "openrouter" }, input, signal: signal(), save, fetchImpl: transport });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(results[0].errorCode).toBe(status === 401 ? "IMAGE_AUTH_FAILED" : `IMAGE_HTTP_${status}`);
    expect(JSON.stringify(results)).not.toContain("secret");
  }
});

it("keeps same-vendor accounts isolated through actual Models auth resolution", async () => {
  const auths: string[] = [];
  await Promise.all(["account-a", "account-b"].map(key => generateImageBatch({
    endpoint: { ...endpoint, providerId: key, vendorKey: "custom", apiKey: key }, input, signal: signal(), save,
    fetchImpl: async (_url, init) => { auths.push(new Headers(init?.headers).get("authorization")!); return Response.json({ data: [{ b64_json: png }] }); },
  })));
  expect(auths.sort()).toEqual(["Bearer account-a", "Bearer account-b"]);
});

it("requires real native image capability for OAuth and resolves supported auth via the shared seam", async () => {
  const resolveAuth = vi.fn(async () => ({ apiKey: "oauth-fixture" }));
  expect(() => createImageBinding({ ...endpoint, authKind: "oauth", resolveAuth })).toThrow("IMAGE_AUTH_UNSUPPORTED");
  const known = openrouterProvider().getAllModels!().find(model => model.type === "image")!;
  const binding = createImageBinding({ ...endpoint, vendorKey: "openrouter", modelId: known.id, nativeModel: known, authKind: "oauth", resolveAuth });
  const transport = vi.fn<typeof fetch>().mockResolvedValue(nativeResponse());
  await generateImageBatch({ binding, input, signal: signal(), save, fetchImpl: transport });
  expect(resolveAuth).toHaveBeenCalledTimes(1);
  expect(new Headers(transport.mock.calls[0][1]?.headers).get("authorization")).toBe("Bearer oauth-fixture");
});

it("retains multiple OpenAI outputs in stable operation order without extra requests", async () => {
  const transport = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ data: [{ b64_json: png }, { b64_json: png }] }));
  const results = await generateImageBatch({ endpoint, input: { items: [{ prompt: "a", count: 2 }] }, signal: signal(), save, fetchImpl: transport });
  expect(results.map(result => result.index)).toEqual([0, 1, 2, 3]);
  expect(transport).toHaveBeenCalledTimes(2);
});

it("honors returned error/aborted and rejects text-only successful responses without paid retries", async () => {
  const model: ImageModel<string> = { type: "image", id: "m", name: "m", api: "fixture", provider: "fixture", baseUrl: endpoint.baseUrl,
    input: ["text"], output: ["image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  for (const stopReason of ["error", "aborted", "stop"] as const) {
    const generate = vi.fn(async (): Promise<AssistantImages> => ({ api: "fixture", provider: "fixture", model: "m", output: [{ type: "text", text: "no image" }], stopReason, timestamp: 0, errorMessage: "private token" }));
    const models = createModels();
    models.setProvider(createProvider({ id: "fixture", models: [model], auth: { apiKey: { name: "none", resolve: async () => ({ auth: {} }) } }, images: { fixture: { generateImages: generate } } }));
    const results = await generateImageBatch({ binding: { models, model }, input, signal: signal(), save });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(results[0]).toMatchObject({ status: stopReason === "aborted" ? "cancelled" : "failed", errorCode: stopReason === "stop" ? "IMAGE_INVALID_RESPONSE" : stopReason === "aborted" ? "IMAGE_CANCELLED" : "IMAGE_REQUEST_FAILED" });
  }
});

it("cancels while resolving auth without sending a request", async () => {
  let finish!: () => void;
  const controller = new AbortController();
  const resolveAuth = vi.fn(async () => { await new Promise<void>(resolve => { finish = resolve; }); return { apiKey: "fixture" }; });
  const transport = vi.fn<typeof fetch>();
  const run = generateImageBatch({ endpoint: { ...endpoint, resolveAuth }, input, signal: controller.signal, save, fetchImpl: transport });
  await vi.waitFor(() => expect(resolveAuth).toHaveBeenCalledTimes(1));
  controller.abort(); finish();
  expect((await run)[0].status).toBe("cancelled");
  expect(transport).not.toHaveBeenCalled();
});

it("bounds native data URLs and does not claim zero pricing for custom image models", async () => {
  const operations: ImageOperationMetadata[] = [];
  await generateImageBatch({ endpoint: { ...endpoint, vendorKey: "openrouter" }, input, signal: signal(), save,
    fetchImpl: async () => nativeResponse(), onOperation: operation => operations.push(operation) });
  expect(operations[0].usage).toBeDefined();
  expect(operations[0].usage?.cost).toBeUndefined();
  const results = await generateImageBatch({ endpoint: { ...endpoint, vendorKey: "openrouter" }, input, signal: signal(), save,
    fetchImpl: async () => new Response("", { headers: { "content-length": "999999999" } }) });
  expect(results[0].errorCode).toBe("IMAGE_TOO_LARGE");
});
