import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it } from "vitest";
import { generateImageBatch, generateOneImage, type ImageEditInput } from "./index.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9mQAAAAASUVORK5CYII=", "base64");
const input: ImageEditInput = { bytes: png, mimeType: "image/png", extension: "png" };
const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => server.close(() => resolve())))); });

async function fixture() {
  const requests: Array<{ path: string; body: Record<string, unknown> | FormData; type: string }> = [];
  const failures: unknown[] = [];
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks);
      const type = String(req.headers["content-type"]);
      const body = type.startsWith("multipart/form-data")
        ? await new Request("http://localhost", { method: "POST", headers: { "content-type": type }, body: raw }).formData()
        : JSON.parse(raw.toString());
      requests.push({ path: req.url ?? "", body, type });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ b64_json: png.toString("base64") }] }));
    } catch (error) { failures.push(error); res.writeHead(400); res.end(); }
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  return { requests, failures, call: (modelId: string, images: ImageEditInput[] = []) => generateOneImage({ baseUrl, modelId }, "A cup", new AbortController().signal, fetch, images) };
}

it("requests b64_json for DALL-E without sending response_format to GPT Image", async () => {
  const f = await fixture();
  for (const model of ["dall-e-2", "dall-e-3", "gpt-image-1.5", "gpt-image-2.5"]) {
    expect((await f.call(model)).bytes).toEqual(png);
    const request = f.requests.at(-1)!;
    expect(request.path).toBe("/v1/images/generations");
    expect(request.body).toEqual({ model, prompt: "A cup", n: 1, ...(model.startsWith("dall-e-") ? { response_format: "b64_json" } : {}) });
  }
  expect(f.failures).toEqual([]);
});

it("sends real multipart edits with boundary, binary files and model-specific response format", async () => {
  const f = await fixture();
  for (const [model, images] of [["gpt-image-1.5", [input]], ["gpt-image-2.5", [input, input]], ["gpt-image-2.5", [input, input, input, input]], ["dall-e-2", [input]]] as const) {
    expect((await f.call(model, [...images])).bytes).toEqual(png);
    const request = f.requests.at(-1)!;
    expect(request.path).toBe("/v1/images/edits");
    expect(request.type).toMatch(/^multipart\/form-data; boundary=/);
    expect(request.body).toBeInstanceOf(FormData);
    const form = request.body as FormData;
    expect(form.get("model")).toBe(model);
    expect(form.get("prompt")).toBe("A cup");
    expect(form.get("n")).toBe("1");
    expect(form.get("response_format")).toBe(model === "dall-e-2" ? "b64_json" : null);
    const files = form.getAll(images.length === 1 ? "image" : "image[]");
    expect(files).toHaveLength(images.length);
    for (const file of files) {
      expect(file).toBeInstanceOf(Blob);
      expect((file as Blob).type).toBe("image/png");
      expect(Buffer.from(await (file as Blob).arrayBuffer())).toEqual(png);
    }
  }
  expect(f.failures).toEqual([]);
});

it("rejects more than four reference images before reading files or sending HTTP", async () => {
  let reads = 0, requests = 0;
  await expect(generateImageBatch({
    input: { items: [{ prompt: "cup", images: ["1.png", "2.png", "3.png", "4.png", "5.png"] }] },
    endpoint: { baseUrl: "https://example.invalid", modelId: "gpt-image-2.5" },
    signal: new AbortController().signal,
    loadImages: async () => { reads++; return [input]; },
    fetchImpl: async () => { requests++; return new Response(); },
    save: async () => "unused",
  })).rejects.toMatchObject({ errorCode: "INVALID_ARGUMENT" });
  expect({ reads, requests }).toEqual({ reads: 0, requests: 0 });
});

it("does not leak provider error bodies and bounds JSON before decoding", async () => {
  for (const status of [401, 403, 429, 500]) {
    await expect(generateOneImage({ baseUrl: "https://example.invalid", modelId: "gpt-image-2.5" }, "cup", new AbortController().signal,
      async () => new Response("private upstream token", { status }),
    )).rejects.toMatchObject({ errorCode: [401, 403].includes(status) ? "IMAGE_AUTH_FAILED" : `IMAGE_HTTP_${status}` });
  }
  await expect(generateOneImage({ baseUrl: "https://example.invalid", modelId: "gpt-image-2.5" }, "cup", new AbortController().signal,
    async () => new Response("", { headers: { "content-length": "999999999" } }),
  )).rejects.toMatchObject({ errorCode: "IMAGE_TOO_LARGE" });
});
