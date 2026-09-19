import type { AssistantImages, ImagesContext, ImageContent } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { extensionModelError } from "./model-complete-contract.js";

export const EXTENSION_IMAGE_TIMEOUT_MS = 300_000;
export const EXTENSION_IMAGE_BYTES = 20 * 1024 * 1024;
export type ExtensionImageOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  n?: number;
  size?: string;
  quality?: "low" | "medium" | "high" | "auto";
  background?: "transparent" | "opaque" | "auto";
  outputFormat?: "png" | "jpeg" | "webp";
  /** Codex uses JSON image_url inputs; multipart supports older compatible gateways. */
  editFormat?: "json" | "multipart";
};
export type ExtensionImageRequest = {
  sessionId: string; extensionId: string; requestId: string;
  providerId: string; modelId: string; context: ImagesContext;
  options: Omit<ExtensionImageOptions, "signal">;
};
export type ExtensionImageRegistry = {
  generateImages(model: { provider: string; id: string }, context: ImagesContext, options?: ExtensionImageOptions): Promise<AssistantImages>;
};
const id = Type.String({ minLength: 1, maxLength: 4096 });
const oneOf = (values: string[]) => Type.Union(values.map((value) => Type.Literal(value)));
const schema = Type.Object({
  sessionId: id, extensionId: id, requestId: id, providerId: id, modelId: id,
  context: Type.Object({ input: Type.Array(Type.Union([
    Type.Object({ type: Type.Literal("text"), text: Type.String({ maxLength: 32768 }) }, { additionalProperties: false }),
    Type.Object({ type: Type.Literal("image"), data: Type.String({ maxLength: Math.ceil(EXTENSION_IMAGE_BYTES / 3) * 4 }),
      mimeType: oneOf(["image/png", "image/jpeg", "image/webp"]) }, { additionalProperties: false }),
  ]), { minItems: 1, maxItems: 17 }) }, { additionalProperties: false }),
  options: Type.Object({
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: EXTENSION_IMAGE_TIMEOUT_MS })),
    n: Type.Optional(Type.Integer({ minimum: 1, maximum: 4 })),
    size: Type.Optional(Type.String({ pattern: "^(auto|[1-9][0-9]{1,3}x[1-9][0-9]{1,3})$" })),
    quality: Type.Optional(oneOf(["low", "medium", "high", "auto"])),
    background: Type.Optional(oneOf(["transparent", "opaque", "auto"])),
    outputFormat: Type.Optional(oneOf(["png", "jpeg", "webp"])),
    editFormat: Type.Optional(oneOf(["json", "multipart"])),
  }, { additionalProperties: false }),
}, { additionalProperties: false });

export function imageMimeType(bytes: Uint8Array): ImageContent["mimeType"] | undefined {
  if (bytes.length >= 8 && Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (bytes.length >= 12 && Buffer.from(bytes.subarray(0, 4)).toString() === "RIFF" && Buffer.from(bytes.subarray(8, 12)).toString() === "WEBP") return "image/webp";
  return undefined;
}

export function parseExtensionImageRequest(value: unknown): ExtensionImageRequest {
  if (!Check(schema, value) || Buffer.byteLength(JSON.stringify(value), "utf8") > 32 * 1024 * 1024) throw extensionModelError("INVALID_ARGUMENT", "Invalid image request");
  const request = value as ExtensionImageRequest;
  let bytes = 0;
  let prompt = "";
  for (const part of request.context.input) {
    if (part.type === "text") { prompt += part.text; continue; }
    const decoded = Buffer.from(part.data, "base64");
    bytes += decoded.byteLength;
    if (decoded.toString("base64") !== part.data || imageMimeType(decoded) !== part.mimeType) {
      throw extensionModelError("INVALID_ARGUMENT", "Invalid image encoding or media type");
    }
  }
  if (!prompt.trim() || prompt.length > 32768 || bytes > EXTENSION_IMAGE_BYTES) {
    throw extensionModelError("INVALID_ARGUMENT", "Image input or prompt exceeds its limit");
  }
  return request;
}
