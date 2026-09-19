import type { AssistantImages, ImagesModel, ImagesApi, ImagesContext, ImagesOptions } from "@earendil-works/pi-ai";
import { EXTENSION_IMAGE_BYTES, imageMimeType, type ExtensionImageOptions } from "./image-contract.js";

const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

function endpoint(baseUrl: string, edit: boolean): string {
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Unsupported image endpoint protocol");
  let path = url.pathname.replace(/\/+$/, "").replace(/\/(responses|chat\/completions|images\/(generations|edits))$/, "");
  if (!path) path = "/v1";
  url.pathname = `${path}/images/${edit ? "edits" : "generations"}`;
  return url.toString();
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Image provider returned HTTP ${response.status}`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Image provider returned an empty response");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > MAX_RESPONSE_BYTES) throw new Error("Image response exceeds its limit");
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel();
  }
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** Missing pi adapter: use the same standalone Images endpoints as Codex. */
export function openAIImagesAdapter(options: Omit<ExtensionImageOptions, "signal">) {
  return {
    async generateImages(model: ImagesModel<ImagesApi>, context: ImagesContext, requestOptions?: ImagesOptions): Promise<AssistantImages> {
      const result: AssistantImages = { api: model.api, provider: model.provider, model: model.id,
        output: [], stopReason: "stop", timestamp: Date.now() };
      try {
        const images = context.input.filter((part) => part.type === "image");
        const prompt = context.input.filter((part) => part.type === "text").map((part) => part.text).join("\n");
        const fields = { model: model.id, prompt,
          ...(options.n !== undefined ? { n: options.n } : {}),
          ...(options.size ? { size: options.size } : {}),
          ...(options.quality ? { quality: options.quality } : {}),
          ...(options.background ? { background: options.background } : {}),
          ...(options.outputFormat ? { output_format: options.outputFormat } : {}),
        };
        const headers = new Headers();
        if (requestOptions?.apiKey) headers.set("Authorization", `Bearer ${requestOptions.apiKey}`);
        for (const [key, value] of Object.entries(requestOptions?.headers ?? {})) {
          if (typeof value === "string") headers.set(key, value);
        }
        let body: string | FormData;
        if (images.length && options.editFormat === "multipart") {
          const form = new FormData();
          for (const [key, value] of Object.entries(fields)) form.set(key, String(value));
          for (const [index, image] of images.entries()) {
            form.append("image[]", new Blob([Buffer.from(image.data, "base64")], { type: image.mimeType }),
              `input-${index}.${image.mimeType.split("/")[1]}`);
          }
          headers.delete("content-type");
          body = form;
        } else {
          headers.set("content-type", "application/json");
          body = JSON.stringify({ ...fields, ...(images.length ? {
            images: images.map((image) => ({ image_url: `data:${image.mimeType};base64,${image.data}` })),
          } : {}) });
        }
        // Image generation is not retried automatically: ambiguous failures can
        // otherwise create duplicate images and duplicate charges.
        const response = await (requestOptions?.fetch ?? fetch)(endpoint(model.baseUrl, images.length > 0), {
          method: "POST", headers, body, signal: requestOptions?.signal, redirect: "error",
        });
        const payload = await boundedJson(response);
        if (!record(payload) || !Array.isArray(payload.data) || !payload.data.length || payload.data.length > 4) {
          throw new Error("Image provider returned no images");
        }
        let totalBytes = 0;
        for (const item of payload.data) {
          if (!record(item) || typeof item.b64_json !== "string") throw new Error("Image provider must return inline base64 images");
          const bytes = Buffer.from(item.b64_json, "base64");
          totalBytes += bytes.length;
          const mimeType = imageMimeType(bytes);
          if (!mimeType || bytes.toString("base64") !== item.b64_json || totalBytes > EXTENSION_IMAGE_BYTES) {
            throw new Error("Image provider returned invalid or oversized image data");
          }
          if (typeof item.revised_prompt === "string") result.output.push({ type: "text", text: item.revised_prompt });
          result.output.push({ type: "image", mimeType, data: item.b64_json });
        }
        const requestId = response.headers.get("x-request-id");
        if (requestId) result.responseId = requestId;
        if (record(payload.usage)) {
          const input = payload.usage.input_tokens;
          const output = payload.usage.output_tokens;
          if (typeof input === "number" && typeof output === "number" && Number.isFinite(input) && Number.isFinite(output) && input >= 0 && output >= 0) {
            result.usage = { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
          }
        }
        return result;
      } catch (error) {
        result.output = [];
        result.stopReason = requestOptions?.signal?.aborted ? "aborted" : "error";
        // Our fixed messages contain no response body, URL or credential.
        result.errorMessage = error instanceof Error && /^(Image provider|Image response|Unsupported image)/.test(error.message)
          ? error.message : "Image request failed";
        return result;
      }
    },
  };
}
