/** Shared contracts for StarAI default media generation (images & videos). */

export const STARAI_DEFAULT_IMAGE_MODEL = "gpt-image-2.6-sunburst" as const;
export const STARAI_DEFAULT_VIDEO_MODEL = "minimax_h3_768p" as const;

export const STARAI_STUDIO_IMAGE_MODELS = [
  "gpt-image-2.6-sunburst",
  "gpt-image-2.6-flare",
  "gpt-image-2.5-sunburst",
  "gpt-image-2.5-flare",
  "gpt-image-2.5",
  "gpt-image-2",
  "gemini-3-pro-image-preview",
  "gemini-3.1-flash-image-preview",
] as const;

export const STARAI_STUDIO_VIDEO_MODELS = [
  "minimax_h3_768p",
  "minimax_h3_480p",
  "gk-video-3.5-lk",
  "grok-imagine-video-1.5（按次）",
] as const;

export const STARAI_STUDIO_ASPECT_RATIOS = [
  "1:1",
  "5:4",
  "4:3",
  "3:2",
  "16:9",
  "21:9",
  "4:5",
  "3:4",
  "2:3",
  "9:16",
] as const;

export const VIDEO_GENERATION_TIMEOUT_MS = 600_000;
export const GENERATED_MEDIA_SCHEME = "pi-media" as const;
export const GENERATED_MEDIA_MAX_BYTES = 200 * 1024 * 1024;

export type VideoGenerationInput = {
  prompt: string;
  model: string;
  images?: string[];
  audio?: string[];
  aspectRatio?: string;
  resolution?: string;
  seconds?: number;
};

export type GeneratedVideoResult = {
  status: "succeeded" | "failed" | "cancelled";
  path?: string;
  mediaUrl?: string;
  mimeType?: string;
  model?: string;
  generationId?: string;
  billedAmount?: number;
  errorCode?: string;
  error?: string;
};

function invalid(message: string): never {
  throw Object.assign(new Error(message), { errorCode: "INVALID_ARGUMENT" });
}

export function parseVideoGenerationInput(value: unknown): VideoGenerationInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid("video generation arguments must be an object");
  }
  const record = value as Record<string, unknown>;
  const prompt = typeof record.prompt === "string" ? record.prompt.trim() : "";
  if (!prompt || prompt.length > 20_000) {
    invalid("prompt must contain 1–20000 characters");
  }
  const rawModel = record.model == null ? STARAI_DEFAULT_VIDEO_MODEL : record.model;
  if (typeof rawModel !== "string" || !rawModel.trim() || rawModel.trim().length > 128) {
    invalid("model must be a non-empty string");
  }
  const model = rawModel.trim();
  const parsePaths = (raw: unknown, field: string, max: number): string[] | undefined => {
    if (raw == null) return undefined;
    if (
      !Array.isArray(raw) ||
      raw.length > max ||
      raw.some((entry) => typeof entry !== "string" || !entry.trim() || entry.length > 4096)
    ) {
      invalid(`${field} must contain at most ${max} local file paths`);
    }
    const paths = (raw as string[]).map((entry) => entry.trim());
    return paths.length ? paths : undefined;
  };
  const images = parsePaths(record.images, "images", 9);
  const audio = parsePaths(record.audio, "audio", 3);
  const aspectRatio =
    typeof record.aspectRatio === "string" && record.aspectRatio.trim()
      ? record.aspectRatio.trim()
      : undefined;
  if (aspectRatio && aspectRatio.length > 16) invalid("aspectRatio is invalid");
  const resolution =
    typeof record.resolution === "string" && record.resolution.trim()
      ? record.resolution.trim()
      : undefined;
  if (resolution && resolution.length > 16) invalid("resolution is invalid");
  let seconds: number | undefined;
  if (record.seconds != null) {
    if (
      typeof record.seconds !== "number" ||
      !Number.isInteger(record.seconds) ||
      record.seconds < 1 ||
      record.seconds > 15
    ) {
      invalid("seconds must be an integer from 1 to 15");
    }
    seconds = record.seconds;
  }
  return {
    prompt,
    model,
    ...(images ? { images } : {}),
    ...(audio ? { audio } : {}),
    ...(aspectRatio ? { aspectRatio } : {}),
    ...(resolution ? { resolution } : {}),
    ...(seconds !== undefined ? { seconds } : {}),
  };
}
