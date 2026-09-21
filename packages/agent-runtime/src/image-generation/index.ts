import {
  IMAGE_GENERATION_TIMEOUT_MS,
  imageGenerationItems,
  type GeneratedImageResult,
} from "@pi-desktop/shared";
import {
  boundedBytes,
  downloadGeneratedImage,
  generatedImageType,
  imageError,
  MAX_IMAGE_BYTES,
} from "./download.js";
export { generatedImageType, MAX_IMAGE_BYTES } from "./download.js";

export type ImageEndpoint = {
  baseUrl: string;
  modelId: string;
  apiKey?: string;
  headers?: Record<string, string>;
};

export function imageGenerationUrl(baseUrl: string, edit = false): string {
  const url = new URL(baseUrl);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw imageError("IMAGE_INVALID_ENDPOINT");
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = `${path || "/v1"}/images/${edit ? "edits" : "generations"}`;
  return url.href;
}

export type ImageEditInput = { bytes: Uint8Array; mimeType: string; extension: string };

export async function generateOneImage(
  endpoint: ImageEndpoint,
  prompt: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
  images: ImageEditInput[] = [],
) {
  const headers = new Headers(endpoint.headers);
  headers.set("Content-Type", "application/json");
  if (endpoint.apiKey) headers.set("Authorization", `Bearer ${endpoint.apiKey}`);
  const responseFormat = /^dall-e-[23]$/i.test(endpoint.modelId) ? "b64_json" : undefined;
  let body: BodyInit = JSON.stringify({
    model: endpoint.modelId, prompt, n: 1,
    ...(responseFormat ? { response_format: responseFormat } : {}),
  });
  if (images.length) {
    const form = new FormData();
    form.set("model", endpoint.modelId);
    form.set("prompt", prompt);
    form.set("n", "1");
    if (responseFormat) form.set("response_format", responseFormat);
    images.forEach((image, index) =>
      form.append(
        images.length === 1 ? "image" : "image[]",
        new Blob([new Uint8Array(image.bytes)], { type: image.mimeType }),
        `input-${index}.${image.extension}`,
      ),
    );
    headers.delete("Content-Type");
    body = form;
  }
  const response = await fetchImpl(imageGenerationUrl(endpoint.baseUrl, images.length > 0), {
    method: "POST",
    headers,
    redirect: "error",
    signal,
    body,
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw imageError(
      response.status === 401 || response.status === 403
        ? "IMAGE_AUTH_FAILED"
        : `IMAGE_HTTP_${response.status}`,
    );
  }
  const raw = await boundedBytes(response, Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 65536);
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(raw).toString("utf8"));
  } catch {
    throw imageError("IMAGE_INVALID_RESPONSE");
  }
  const data = (payload as { data?: unknown })?.data;
  if (!Array.isArray(data) || data.length !== 1 || !data[0] || typeof data[0] !== "object")
    throw imageError("IMAGE_INVALID_RESPONSE");
  const item = data[0] as Record<string, unknown>;
  let bytes: Uint8Array;
  if (
    typeof item.b64_json === "string" &&
    item.b64_json.length &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(item.b64_json)
  ) {
    bytes = Buffer.from(item.b64_json, "base64");
  } else if (typeof item.url === "string") {
    bytes = await downloadGeneratedImage(item.url, signal);
  } else throw imageError("IMAGE_INVALID_RESPONSE");
  return { bytes, ...generatedImageType(bytes) };
}

/** Two workers, stable result ordering, no automatic retry of billable requests. */
export async function generateImageBatch(options: {
  input: unknown;
  endpoint: ImageEndpoint;
  signal: AbortSignal;
  save: (image: Awaited<ReturnType<typeof generateOneImage>>, index: number) => Promise<string>;
  fetchImpl?: typeof fetch;
  loadImages?: (paths: string[]) => Promise<ImageEditInput[]>;
}): Promise<GeneratedImageResult[]> {
  const prompts = imageGenerationItems(options.input);
  const results: GeneratedImageResult[] = new Array(prompts.length);
  let next = 0;
  let authFailed = false;
  const worker = async () => {
    while (next < prompts.length) {
      const index = next++;
      if (options.signal.aborted || authFailed) {
        results[index] = {
          index,
          status: "cancelled",
          errorCode: authFailed ? "IMAGE_AUTH_FAILED" : "IMAGE_CANCELLED",
        };
        continue;
      }
      const controller = new AbortController();
      const signal = AbortSignal.any([options.signal, controller.signal]);
      const timer = setTimeout(() => controller.abort(), IMAGE_GENERATION_TIMEOUT_MS);
      try {
        const item = prompts[index];
        if (item.images && !options.loadImages) throw imageError("IMAGE_EDIT_UNAVAILABLE");
        const images = item.images ? await options.loadImages!(item.images) : [];
        signal.throwIfAborted();
        const image = await generateOneImage(
          options.endpoint,
          item.prompt,
          signal,
          options.fetchImpl,
          images,
        );
        const path = await options.save(image, index);
        results[index] = { index, status: "succeeded", path, mimeType: image.mimeType };
      } catch (error) {
        const code = options.signal.aborted
          ? "IMAGE_CANCELLED"
          : controller.signal.aborted
            ? "IMAGE_TIMEOUT"
            : error &&
                typeof error === "object" &&
                "errorCode" in error &&
                typeof error.errorCode === "string"
              ? error.errorCode
              : "IMAGE_REQUEST_FAILED";
        if (code === "IMAGE_AUTH_FAILED") authFailed = true;
        results[index] = {
          index,
          status: options.signal.aborted ? "cancelled" : "failed",
          errorCode: code,
        };
      } finally {
        clearTimeout(timer);
      }
    }
  };
  await Promise.all([worker(), worker()]);
  return results;
}
