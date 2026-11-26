import { randomUUID } from "node:crypto";
import {
  GENERATED_MEDIA_MAX_BYTES,
  IMAGE_GENERATION_TIMEOUT_MS,
  STARAI_DEFAULT_IMAGE_MODEL,
  STARAI_DEFAULT_VIDEO_MODEL,
  VIDEO_GENERATION_TIMEOUT_MS,
} from "@pi-desktop/shared";
import { generatedImageType, MAX_IMAGE_BYTES } from "@pi-desktop/agent-runtime";

export type StarAiStudioTransport = {
  submit: (form: FormData, signal: AbortSignal) => Promise<Response>;
  get: (id: string, signal: AbortSignal) => Promise<Response>;
  download: (path: string, signal: AbortSignal) => Promise<Response>;
};

export type StudioMediaFile = {
  bytes: Uint8Array;
  mimeType: string;
  extension: string;
};

export type StudioGenerationRequest = {
  kind: "image" | "video";
  model?: string;
  prompt: string;
  aspectRatio?: string;
  resolution?: string;
  seconds?: number;
  images?: StudioMediaFile[];
  audio?: StudioMediaFile[];
};

export type StudioGenerationOutcome = {
  id: string;
  model: string;
  billedAmount?: number;
  files: StudioMediaFile[];
};

type StudioDto = {
  id?: unknown;
  status?: unknown;
  result_urls?: unknown;
  error?: unknown;
  billed_amount?: unknown;
};

const POLL_INTERVAL_MS = 2_500;

function studioError(errorCode: string, message: string) {
  return Object.assign(new Error(message), { errorCode });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(studioError("MEDIA_CANCELLED", "Generation was cancelled."));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(studioError("MEDIA_CANCELLED", "Generation was cancelled."));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function readBounded(response: Response, maxBytes: number): Promise<Uint8Array> {
  const length = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(length) && length > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw studioError("MEDIA_TOO_LARGE", "Generated media exceeds the size limit.");
  }
  if (!response.body) throw studioError("MEDIA_INVALID_RESPONSE", "Empty media response.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw studioError("MEDIA_TOO_LARGE", "Generated media exceeds the size limit.");
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

function detectVideoFile(bytes: Uint8Array, contentType: string): StudioMediaFile {
  const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (mime === "video/webm" || (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3)) {
    return { bytes, mimeType: "video/webm", extension: "webm" };
  }
  if (mime === "video/quicktime") {
    return { bytes, mimeType: "video/quicktime", extension: "mov" };
  }
  return { bytes, mimeType: "video/mp4", extension: "mp4" };
}

async function parseStudioEnvelope(response: Response): Promise<StudioDto> {
  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    const raw = JSON.parse(text);
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      parsed = raw as Record<string, unknown>;
    }
  } catch {
    if (!response.ok) {
      throw studioError(
        response.status === 401 || response.status === 403 ? "MEDIA_AUTH_FAILED" : `MEDIA_HTTP_${response.status}`,
        `StarAI media request failed (HTTP ${response.status}).`,
      );
    }
    throw studioError("MEDIA_INVALID_RESPONSE", "StarAI returned an invalid JSON response.");
  }
  if (!response.ok || parsed.success !== true) {
    const message =
      typeof parsed.message === "string" && parsed.message.trim()
        ? parsed.message.trim()
        : `StarAI media request failed (HTTP ${response.status}).`;
    const code =
      response.status === 401 || response.status === 403
        ? "MEDIA_AUTH_FAILED"
        : response.status === 400
          ? "INVALID_ARGUMENT"
          : `MEDIA_HTTP_${response.status || 502}`;
    throw studioError(code, message);
  }
  const data = parsed.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw studioError("MEDIA_INVALID_RESPONSE", "StarAI returned an empty generation record.");
  }
  return data as StudioDto;
}

export async function runStarAiStudioGeneration(
  transport: StarAiStudioTransport,
  request: StudioGenerationRequest,
  signal: AbortSignal,
): Promise<StudioGenerationOutcome> {
  const model =
    request.model?.trim() ||
    (request.kind === "image" ? STARAI_DEFAULT_IMAGE_MODEL : STARAI_DEFAULT_VIDEO_MODEL);
  const timeoutMs =
    request.kind === "image" ? IMAGE_GENERATION_TIMEOUT_MS : VIDEO_GENERATION_TIMEOUT_MS;
  const timeoutController = new AbortController();
  const combined = AbortSignal.any([signal, timeoutController.signal]);
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs);

  try {
    const form = new FormData();
    form.set("client_request_id", `starai_${randomUUID().replace(/-/g, "")}`);
    form.set("kind", request.kind);
    form.set("model", model);
    form.set("prompt", request.prompt.trim());
    if (request.resolution) form.set("resolution", request.resolution);
    if (request.aspectRatio) form.set("aspect_ratio", request.aspectRatio);
    if (request.kind === "video" && request.seconds !== undefined) {
      form.set("seconds", String(request.seconds));
    }
    request.images?.forEach((image, index) => {
      form.append(
        "image[]",
        new Blob([new Uint8Array(image.bytes)], { type: image.mimeType }),
        `input-${index}.${image.extension}`,
      );
    });
    request.audio?.forEach((track, index) => {
      form.append(
        "audio[]",
        new Blob([new Uint8Array(track.bytes)], { type: track.mimeType }),
        `audio-${index}.${track.extension}`,
      );
    });

    const submitted = await transport.submit(form, combined);
    let dto = await parseStudioEnvelope(submitted);
    const id = typeof dto.id === "string" && dto.id.trim() ? dto.id.trim() : "";
    if (!id) throw studioError("MEDIA_INVALID_RESPONSE", "StarAI generation id is missing.");

    while (true) {
      const status = typeof dto.status === "string" ? dto.status.toLowerCase() : "";
      if (status === "completed" || status === "succeeded") break;
      if (status === "failed" || status === "cancelled" || status === "canceled") {
        const message =
          typeof dto.error === "string" && dto.error.trim()
            ? dto.error.trim()
            : `StarAI ${request.kind} generation ${status}.`;
        throw studioError(status === "failed" ? "MEDIA_GENERATION_FAILED" : "MEDIA_CANCELLED", message);
      }
      await sleep(POLL_INTERVAL_MS, combined);
      const polled = await transport.get(id, combined);
      dto = await parseStudioEnvelope(polled);
    }

    const urls = Array.isArray(dto.result_urls)
      ? dto.result_urls.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
      : [];
    if (!urls.length) {
      throw studioError("MEDIA_INVALID_RESPONSE", "StarAI generation finished without output files.");
    }

    const maxBytes = request.kind === "image" ? MAX_IMAGE_BYTES : GENERATED_MEDIA_MAX_BYTES;
    const files: StudioMediaFile[] = [];
    for (const url of urls) {
      combined.throwIfAborted();
      const asset = await transport.download(url, combined);
      if (!asset.ok) {
        await asset.body?.cancel().catch(() => {});
        throw studioError(`MEDIA_HTTP_${asset.status}`, `Unable to download StarAI result (HTTP ${asset.status}).`);
      }
      const bytes = await readBounded(asset, maxBytes);
      if (request.kind === "image") {
        files.push({ bytes, ...generatedImageType(bytes) });
      } else {
        files.push(detectVideoFile(bytes, asset.headers.get("content-type") ?? "video/mp4"));
      }
    }

    return {
      id,
      model,
      ...(typeof dto.billed_amount === "number" && Number.isFinite(dto.billed_amount)
        ? { billedAmount: dto.billed_amount }
        : {}),
      files,
    };
  } catch (error) {
    if (signal.aborted) throw studioError("MEDIA_CANCELLED", "Generation was cancelled.");
    if (timeoutController.signal.aborted) throw studioError("MEDIA_TIMEOUT", "StarAI media generation timed out.");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
