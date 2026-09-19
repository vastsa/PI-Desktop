import { createServer } from "node:http";
import { afterEach, expect, it } from "vitest";
import { generateHostImages } from "./generate-images.js";
import { parseExtensionImageRequest } from "./image-contract.js";
import type { RuntimeProviderConfig } from "../provider-binding.js";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a+V8AAAAASUVORK5CYII=";
const input = [{ type: "text" as const, text: "A blue square" }];
const image = { type: "image" as const, data: png, mimeType: "image/png" };
const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
async function fixture(reply: unknown = { data: [{ b64_json: png }], usage: { input_tokens: 2, output_tokens: 3 } }) {
  const requests: Array<{ path?: string; body: string; headers: import("node:http").IncomingHttpHeaders }> = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk.toString();
    requests.push({ path: req.url, body, headers: req.headers });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(reply));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture address");
  const provider: RuntimeProviderConfig = { id: "fixture", name: "Fixture", modelId: "image-fixture",
    baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "fixture-only-secret",
    authKind: "api_key", supportsReasoning: false, supportedThinkingLevels: ["off"] };
  return { provider, requests };
}

it("generates and edits through pi collections with host-owned auth and inline outputs", async () => {
  const { provider, requests } = await fixture();
  const generated = await generateHostImages(provider, { input }, { n: 1, size: "1024x1024", quality: "low" });
  expect(generated.stopReason).toBe("stop");
  expect(generated.output).toEqual([image]);
  expect(generated.usage?.totalTokens).toBe(5);
  expect(requests[0].path).toBe("/v1/images/generations");
  expect(requests[0].headers.authorization).toBe("Bearer fixture-only-secret");
  expect(JSON.parse(requests[0].body)).toMatchObject({ model: "image-fixture", prompt: "A blue square", n: 1, quality: "low" });
  const edited = await generateHostImages(provider, { input: [...input, image] });
  expect(edited.output).toEqual([image]);
  expect(requests[1].path).toBe("/v1/images/edits");
  expect(JSON.parse(requests[1].body).images).toEqual([{ image_url: `data:image/png;base64,${png}` }]);
  expect(JSON.stringify([generated, edited])).not.toContain("fixture-only-secret");
});

it("supports explicitly selected multipart edit without overriding its boundary", async () => {
  const { provider, requests } = await fixture();
  const result = await generateHostImages({ ...provider, headers: { "Content-Type": "application/json", "X-Test": "fixture" } },
    { input: [...input, image] }, { editFormat: "multipart" });
  expect(result.stopReason).toBe("stop");
  expect(requests[0].headers["content-type"]).toMatch(/^multipart\/form-data; boundary=/);
  expect(requests[0].body).toContain('name="image[]"');
  expect(requests[0].headers["x-test"]).toBe("fixture");
});

it("uses pi's existing OpenRouter adapter rather than the new Images endpoint", async () => {
  const { provider, requests } = await fixture({ id: "fixture-image", choices: [{ message: {
    content: "Generated", images: [{ image_url: { url: `data:image/png;base64,${png}` } }],
  } }] });
  const result = await generateHostImages({ ...provider, vendorKey: "openrouter" }, { input });
  expect(result.stopReason).toBe("stop");
  expect(result.output).toContainEqual(image);
  expect(requests[0].path).toBe("/v1/chat/completions");
});

it("does not fetch arbitrary output URLs or accept disguised non-images", async () => {
  for (const reply of [{ data: [{ url: "https://private.invalid/file" }] },
    { data: [{ b64_json: Buffer.from("<script>private</script>").toString("base64") }] }]) {
    const { provider, requests } = await fixture(reply);
    const result = await generateHostImages(provider, { input });
    expect(result.stopReason).toBe("error");
    expect(result.output).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("private");
    expect(requests).toHaveLength(1);
  }
});

it("validates image inputs and rejects endpoint/header overrides before sending", () => {
  const request = { sessionId: "s", extensionId: "ext", requestId: "r", providerId: "p", modelId: "image-fixture", context: { input: [...input, image] }, options: {} };
  expect(parseExtensionImageRequest(request)).toEqual(request);
  expect(() => parseExtensionImageRequest({ ...request, context: { input: [image] } })).toThrow();
  expect(() => parseExtensionImageRequest({ ...request, options: { headers: { Authorization: "private" } } })).toThrow();
  expect(() => parseExtensionImageRequest({ ...request, context: { input: [...input, { ...image, mimeType: "image/jpeg" }] } })).toThrow();
});

it("cancels an in-flight HTTP image request without retrying", async () => {
  let started: () => void = () => {};
  const ready = new Promise<void>((resolve) => { started = resolve; });
  let count = 0;
  const server = createServer(async (req) => { for await (const _chunk of req) { /* consume body */ } count++; started(); });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture address");
  const controller = new AbortController();
  const pending = generateHostImages({ id: "p", name: "P", modelId: "image-fixture", baseUrl: `http://127.0.0.1:${address.port}/v1`,
    apiKey: "fixture", supportsReasoning: false, supportedThinkingLevels: ["off"] }, { input }, { signal: controller.signal });
  await ready;
  controller.abort();
  expect((await pending).stopReason).toBe("aborted");
  expect(count).toBe(1);
});
