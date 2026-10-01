import type { AssistantImages, ProviderImages } from "@earendil-works/pi-ai";
import {
  boundedBytes, downloadGeneratedImage, generatedImageType, imageError, MAX_IMAGE_BYTES,
  type ImageDownloadOptions,
} from "./download.js";

/** Private wire API, not a provider identity or a second model catalog. */
export const OPENAI_IMAGES_API = "pi-desktop-openai-images";

export function imageGenerationUrl(baseUrl: string, edit = false): string {
  const url = new URL(baseUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw imageError("IMAGE_INVALID_ENDPOINT");
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = `${path || "/v1"}/images/${edit ? "edits" : "generations"}`;
  return url.href;
}

export function safeImageError(error: unknown): string {
  return error && typeof error === "object" && "errorCode" in error &&
    typeof error.errorCode === "string" && /^IMAGE_[A-Z0-9_]+$/.test(error.errorCode)
    ? error.errorCode : "IMAGE_REQUEST_FAILED";
}

/** Only the generations/edits protocol missing from Pi; auth and dispatch belong to Models. */
export function openAIImagesAdapter(downloadOptions: ImageDownloadOptions = {}): ProviderImages {
  return {
    async generateImages(model, context, options) {
      const result: AssistantImages = {
        api: model.api, provider: model.provider, model: model.id,
        output: [], stopReason: "stop", timestamp: Date.now(),
      };
      try {
        const signal = options?.signal ?? new AbortController().signal;
        signal.throwIfAborted();
        const headers = new Headers(model.headers);
        if (options?.apiKey) headers.set("Authorization", `Bearer ${options.apiKey}`);
        for (const [name, value] of Object.entries(options?.headers ?? {})) {
          if (value === null) headers.delete(name);
          else headers.set(name, value);
        }
        const prompt = context.input.filter(item => item.type === "text").map(item => item.text).join("\n");
        const images = context.input.filter(item => item.type === "image");
        const responseFormat = /^dall-e-[23]$/i.test(model.id) ? "b64_json" : undefined;
        let body: BodyInit;
        if (images.length) {
          const form = new FormData();
          form.set("model", model.id);
          form.set("prompt", prompt);
          form.set("n", "1");
          if (responseFormat) form.set("response_format", responseFormat);
          images.forEach((image, index) => {
            const bytes = decodeImageBase64(image.data);
            const type = generatedImageType(bytes);
            form.append(images.length === 1 ? "image" : "image[]",
              new Blob([new Uint8Array(bytes)], { type: type.mimeType }), `input-${index}.${type.extension}`);
          });
          headers.delete("Content-Type");
          body = form;
        } else {
          headers.set("Content-Type", "application/json");
          body = JSON.stringify({ model: model.id, prompt, n: 1,
            ...(responseFormat ? { response_format: responseFormat } : {}) });
        }
        const response = await (options?.fetch ?? fetch)(imageGenerationUrl(model.baseUrl, images.length > 0), {
          method: "POST", headers, redirect: "error", signal, body,
        });
        await options?.onResponse?.({ status: response.status, headers: Object.fromEntries(response.headers) }, model);
        if (!response.ok) {
          await response.body?.cancel();
          throw imageError(response.status === 401 || response.status === 403 ? "IMAGE_AUTH_FAILED" : `IMAGE_HTTP_${response.status}`);
        }
        // A response may contain several images. Bound the entire JSON as well as every image.
        const raw = await boundedBytes(response, Math.ceil(MAX_IMAGE_BYTES * 4 / 3) * 10 + 65536);
        let payload: unknown;
        try { payload = JSON.parse(Buffer.from(raw).toString("utf8")); }
        catch { throw imageError("IMAGE_INVALID_RESPONSE"); }
        const reported = (payload as { usage?: Record<string, unknown> })?.usage;
        if (reported) {
          const count = (key: string): number => typeof reported[key] === "number" && Number.isFinite(reported[key]) ? Math.max(0, Math.round(reported[key])) : 0;
          const input = count("input_tokens") || count("prompt_tokens");
          const output = count("output_tokens") || count("completion_tokens");
          if (input || output || count("total_tokens")) result.usage = {
            input, output, cacheRead: 0, cacheWrite: 0, totalTokens: count("total_tokens") || input + output,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          };
        }
        const data = (payload as { data?: unknown } | null)?.data;
        if (!Array.isArray(data) || !data.length || data.length > 10) throw imageError("IMAGE_INVALID_RESPONSE");
        for (const item of data) {
          if (!item || typeof item !== "object") throw imageError("IMAGE_INVALID_RESPONSE");
          if (typeof item.revised_prompt === "string") result.output.push({ type: "text", text: item.revised_prompt });
          let bytes: Uint8Array;
          if (typeof item.b64_json === "string") bytes = decodeImageBase64(item.b64_json);
          else if (typeof item.url === "string") bytes = await downloadGeneratedImage(item.url, signal, {
            ...downloadOptions, fetchImpl: downloadOptions.fetchImpl ?? options?.fetch,
          });
          else throw imageError("IMAGE_INVALID_RESPONSE");
          const type = generatedImageType(bytes);
          result.output.push({ type: "image", data: Buffer.from(bytes).toString("base64"), mimeType: type.mimeType });
        }
      } catch (error) {
        result.stopReason = options?.signal?.aborted ? "aborted" : "error";
        result.errorMessage = safeImageError(error);
      }
      return result;
    },
  };
}

export function decodeImageBase64(data: string): Uint8Array {
  if (data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) throw imageError("IMAGE_TOO_LARGE");
  if (!data.length || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data))
    throw imageError("IMAGE_INVALID_RESPONSE");
  return Buffer.from(data, "base64");
}
