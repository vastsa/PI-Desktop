import { describe, expect, it, vi } from "vitest";
import { generateImageBatch, generateOneImage, imageGenerationUrl } from "./index.js";
import { publicImageAddress, generatedImageType, boundedBytes } from "./download.js";
import { imageGenerationPrompts, parseImageGenerationBinding } from "@pi-desktop/shared";

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9mQAAAAASUVORK5CYII=";
const endpoint = { baseUrl: "https://example.com", modelId: "image-model", apiKey: "test-only" };
const response = () => Response.json({ data: [{ b64_json: png }] });
const save = async (_image: unknown, index: number) => `/scratch/image-${index}.png`;

describe("image generation", () => {
  it("normalizes root/versioned base URLs without doubling the version", () => {
    expect(imageGenerationUrl(endpoint.baseUrl)).toBe("https://example.com/v1/images/generations");
    expect(imageGenerationUrl("https://example.com/gateway/v1/")).toBe(
      "https://example.com/gateway/v1/images/generations",
    );
    expect(() => imageGenerationUrl("https://user:pass@example.com")).toThrow();
  });
  it("validates binding and both batch forms without truncation", () => {
    expect(parseImageGenerationBinding(null)).toBeNull();
    expect(
      imageGenerationPrompts({
        items: [
          { prompt: "a", images: [] },
          { prompt: "b", images: null },
        ],
      }),
    ).toEqual(["a", "b"]);
    expect(() => parseImageGenerationBinding({ modelId: "m" })).toThrow();
    expect(imageGenerationPrompts({ items: [{ prompt: "a", count: 2 }, { prompt: "b" }] })).toEqual(
      ["a", "a", "b"],
    );
    for (const count of [0, 1.5, 11, "2"])
      expect(() => imageGenerationPrompts({ items: [{ prompt: "a", count }] })).toThrow();
    expect(() =>
      imageGenerationPrompts({
        items: [
          { prompt: "a", count: 6 },
          { prompt: "b", count: 5 },
        ],
      }),
    ).toThrow();
  });
  it("uses the configured model, key and headers without chat protocol fields", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response());
    const image = await generateOneImage(
      { ...endpoint, headers: { "X-Test": "custom" } },
      "draw",
      new AbortController().signal,
      fetchImpl,
    );
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://example.com/v1/images/generations");
    expect(JSON.parse(String(init?.body))).toEqual({ model: "image-model", prompt: "draw", n: 1 });
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-only");
    expect(new Headers(init?.headers).get("X-Test")).toBe("custom");
    expect(init?.redirect).toBe("error");
    expect(image.mimeType).toBe("image/png");
  });
  it("limits concurrency to two and preserves input order through partial failure", async () => {
    const releases: Array<() => void> = [];
    let inFlight = 0;
    let peak = 0;
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      const call = calls++;
      peak = Math.max(peak, ++inFlight);
      await new Promise<void>((resolve) => releases.push(resolve));
      inFlight--;
      return call === 1 ? new Response("failure", { status: 500 }) : response();
    };
    const batch = generateImageBatch({
      input: { items: [{ prompt: "a", count: 3 }] },
      endpoint,
      signal: new AbortController().signal,
      save,
      fetchImpl,
    });
    await vi.waitFor(() => expect(releases.length).toBe(2));
    releases[1]();
    await vi.waitFor(() => expect(releases.length).toBe(3));
    releases[2]();
    releases[0]();
    expect((await batch).map((result) => result.status)).toEqual([
      "succeeded",
      "failed",
      "succeeded",
    ]);
    expect(peak).toBe(2);
    expect(calls).toBe(3);
  });
  it("cancels in-flight requests and never starts queued images", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
      async (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    );
    const batch = generateImageBatch({
      input: { items: [{ prompt: "a", count: 5 }] },
      endpoint,
      signal: controller.signal,
      save,
      fetchImpl,
    });
    controller.abort();
    expect((await batch).every((item) => item.status === "cancelled")).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it("stops queued work on authentication failure and does not disclose provider bodies", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("secret provider payload", { status: 401 }));
    const result = await generateImageBatch({
      input: { items: [{ prompt: "a", count: 5 }] },
      endpoint,
      signal: new AbortController().signal,
      save,
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(result[4].status).toBe("cancelled");
  });
  it("times out each image without retry", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
        async (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("timeout")), {
              once: true,
            });
          }),
      );
      const batch = generateImageBatch({
        input: { items: [{ prompt: "a" }] },
        endpoint,
        signal: new AbortController().signal,
        save,
        fetchImpl,
      });
      await vi.advanceTimersByTimeAsync(180_000);
      expect((await batch)[0].errorCode).toBe("IMAGE_TIMEOUT");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
  it("rejects unsafe image addresses, forged images and oversized bodies", async () => {
    for (const address of [
      "127.0.0.1",
      "10.0.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "192.168.0.1",
      "::1",
      "::ffff:127.0.0.1",
      "fc00::1",
      "2002:7f00:1::",
    ])
      expect(publicImageAddress(address)).toBe(false);
    expect(publicImageAddress("8.8.8.8")).toBe(true);
    expect(() => generatedImageType(Buffer.from("<svg>"))).toThrow("IMAGE_INVALID_CONTENT");
    await expect(boundedBytes(new Response("oversized"), 2)).rejects.toThrow("IMAGE_TOO_LARGE");
  });
});
