import { usageFromPi } from "../agent-messages.js";
import { nativeCostStatus, requestUsageIdentity } from "../request-usage.js";
import { IMAGE_GENERATION_TIMEOUT_MS, imageGenerationItems, type GeneratedImageResult, type MessageUsage } from "@pi-desktop/shared";
import { boundedBytes, generatedImageType, imageError, MAX_IMAGE_BYTES, type ImageDownloadOptions } from "./download.js";
import { decodeImageBase64, safeImageError } from "./openai-images.js";
import { createImageBinding, type ImageBinding, type ImageEndpoint } from "./binding.js";
export { generatedImageType, MAX_IMAGE_BYTES } from "./download.js";
export { createImageBinding, type ImageBinding, type ImageEndpoint } from "./binding.js";

export type ImageEditInput = { bytes: Uint8Array; mimeType: string; extension: string };
export type ImageOperationMetadata = {
  index: number;
  text: string[];
  responseId?: string;
  usage?: MessageUsage;
};

/** Stop waiting for a credential resolver that cannot accept AbortSignal. Late dispatch is fenced by fetch. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(imageError("IMAGE_CANCELLED"));
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

/** Two workers, stable result ordering, and exactly one Pi call per requested operation. */
export async function generateImageBatch(options: {
  input: unknown;
  endpoint?: ImageEndpoint;
  binding?: ImageBinding;
  signal: AbortSignal;
  save: (image: ImageEditInput, index: number) => Promise<string>;
  fetchImpl?: typeof fetch;
  downloadOptions?: ImageDownloadOptions;
  loadImages?: (paths: string[]) => Promise<ImageEditInput[]>;
  onOperation?: (metadata: ImageOperationMetadata) => void;
}): Promise<GeneratedImageResult[]> {
  const prompts = imageGenerationItems(options.input);
  const binding = options.binding ?? (options.endpoint && createImageBinding(options.endpoint, options.downloadOptions));
  if (!binding) throw imageError("IMAGE_MODEL_UNAVAILABLE");
  const results: GeneratedImageResult[][] = Array.from({ length: prompts.length }, () => []);
  let next = 0;
  let authFailed = false;
  const worker = async () => {
    while (next < prompts.length) {
      const index = next++;
      const output = results[index];
      if (options.signal.aborted || authFailed) {
        output.push({ index, status: "cancelled", errorCode: authFailed ? "IMAGE_AUTH_FAILED" : "IMAGE_CANCELLED" });
        continue;
      }
      const controller = new AbortController();
      const signal = AbortSignal.any([options.signal, controller.signal]);
      const timer = setTimeout(() => controller.abort(), IMAGE_GENERATION_TIMEOUT_MS);
      let transportError: string | undefined;
      try {
        const item = prompts[index];
        if (item.images && !options.loadImages) throw imageError("IMAGE_EDIT_UNAVAILABLE");
        const images = item.images ? await options.loadImages!(item.images) : [];
        signal.throwIfAborted();
        const identity = requestUsageIdentity(binding.model, binding.accountId);
        const result = await untilAborted(binding.models.generateImages(binding.model, {
          input: [{ type: "text", text: item.prompt }, ...images.map(image => ({
            type: "image" as const, data: Buffer.from(image.bytes).toString("base64"), mimeType: image.mimeType,
          }))],
        }, {
          signal, maxRetries: 0, timeoutMs: IMAGE_GENERATION_TIMEOUT_MS,
          // Host request policy, not a competing implementation of the native wire protocol.
          fetch: async (url, init) => {
            try {
              signal.throwIfAborted();
              const response = await (options.fetchImpl ?? fetch)(url, { ...init, signal, redirect: "error" });
              if (!response.ok) {
                transportError = response.status === 401 || response.status === 403 ? "IMAGE_AUTH_FAILED" : `IMAGE_HTTP_${response.status}`;
                await response.body?.cancel();
                throw imageError(transportError);
              }
              const bytes = await boundedBytes(response, Math.ceil(MAX_IMAGE_BYTES * 4 / 3) * 10 + 65536);
              return new Response(new Uint8Array(bytes), { status: response.status, statusText: response.statusText, headers: response.headers });
            } catch (error) {
              transportError ??= safeImageError(error);
              throw error;
            }
          },
          transformHeaders: headers => {
            const merged = new Headers();
            for (const entries of [headers, binding.model.headers ?? {}])
              for (const [name, value] of Object.entries(entries)) {
                if (value === null) merged.delete(name);
                else if (value !== undefined) merged.set(name, value);
              }
            return Object.fromEntries(merged);
          },
        }), signal);
        const usage = usageFromPi(result.usage, { ...identity, costStatus: nativeCostStatus(binding.model.cost) });
        options.onOperation?.({ index, text: result.output.filter(part => part.type === "text").map(part => part.text),
          ...(result.responseId ? { responseId: result.responseId } : {}),
          ...(usage ? { usage } : {}),
        });
        signal.throwIfAborted();
        for (const part of result.output) {
          if (part.type !== "image") continue;
          signal.throwIfAborted();
          try {
            const bytes = decodeImageBase64(part.data);
            const image = { bytes, ...generatedImageType(bytes) };
            const path = await options.save(image, index);
            output.push({ index, status: "succeeded", path, mimeType: image.mimeType });
          } catch (error) {
            output.push({ index, status: "failed", errorCode: safeImageError(error) });
          }
        }
        if (result.stopReason !== "stop")
          throw imageError(result.stopReason === "aborted" ? "IMAGE_CANCELLED" : transportError ??
            (/^IMAGE_[A-Z0-9_]+$/.test(result.errorMessage ?? "") ? result.errorMessage! : "IMAGE_REQUEST_FAILED"));
        if (!output.length) throw imageError("IMAGE_INVALID_RESPONSE");
      } catch (error) {
        const code = options.signal.aborted ? "IMAGE_CANCELLED" : controller.signal.aborted ? "IMAGE_TIMEOUT" : safeImageError(error);
        if (code === "IMAGE_AUTH_FAILED") authFailed = true;
        output.push({ index, status: code === "IMAGE_CANCELLED" ? "cancelled" : "failed", errorCode: code });
      } finally {
        clearTimeout(timer);
      }
    }
  };
  await Promise.all([worker(), worker()]);
  return results.flat().map((result, index) => ({ ...result, index }));
}
