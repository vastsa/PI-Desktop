import { randomUUID } from "node:crypto";
import { mkdir, open, realpath, writeFile } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import {
  parseVideoGenerationInput,
  STARAI_PROVIDER_ID,
} from "@pi-desktop/shared";
import type { HostProcess } from "../host-process";
import type { LocalToolHandler } from "../agent-sidecar";
import type { StarAiAccount } from "../star-ai-account";
import { generatedMediaUrlFromScratchRoot } from "./star-ai-media-url";
import { imageInputLoader } from "./image-inputs";
import { runStarAiStudioGeneration, type StudioMediaFile } from "./star-ai-studio-media";

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const AUDIO_MIME: Record<string, { mimeType: string; extension: string }> = {
  ".mp3": { mimeType: "audio/mpeg", extension: "mp3" },
  ".wav": { mimeType: "audio/wav", extension: "wav" },
  ".m4a": { mimeType: "audio/mp4", extension: "m4a" },
  ".aac": { mimeType: "audio/aac", extension: "aac" },
  ".ogg": { mimeType: "audio/ogg", extension: "ogg" },
  ".flac": { mimeType: "audio/flac", extension: "flac" },
};

function failure(errorCode: string, message: string) {
  return {
    ok: false,
    isError: true,
    errorCode,
    content: { kind: "video-generation-error", errorCode, message },
  };
}

function audioInputLoader(options: { projectPath?: string; scratchPath: string; dataDir: string }) {
  return async (refs: string[]): Promise<StudioMediaFile[]> => {
    const roots = await Promise.all(
      [options.projectPath, options.scratchPath, resolve(options.dataDir, "attachments")]
        .filter((root): root is string => !!root)
        .map((root) => realpath(root).catch(() => null)),
    );
    const results: StudioMediaFile[] = [];
    for (const ref of refs) {
      const candidate = /^attachments[\\/][a-f0-9]{64}$/.test(ref)
        ? resolve(options.dataDir, ref)
        : isAbsolute(ref)
          ? ref
          : options.projectPath
            ? resolve(options.projectPath, ref)
            : resolve(options.scratchPath, ref);
      const path = await realpath(candidate);
      if (
        !roots.some((root) => {
          if (!root) return false;
          const rel = relative(root, path);
          return !!rel && !rel.startsWith("..") && !isAbsolute(rel);
        })
      ) {
        throw Object.assign(new Error("Audio input is outside the session and project roots"), {
          errorCode: "MEDIA_INPUT_OUTSIDE_ROOT",
        });
      }
      const type = AUDIO_MIME[extname(path).toLowerCase()] ?? { mimeType: "audio/mpeg", extension: "mp3" };
      const file = await open(path, "r");
      try {
        const stats = await file.stat();
        if (!stats.isFile() || stats.size <= 0 || stats.size > MAX_AUDIO_BYTES) {
          throw Object.assign(new Error("Audio input exceeds the 25 MB limit"), {
            errorCode: "MEDIA_INPUT_INVALID",
          });
        }
        const bytes = Buffer.alloc(stats.size);
        let offset = 0;
        while (offset < bytes.length) {
          const chunk = await file.read(bytes, offset, bytes.length - offset, null);
          if (!chunk.bytesRead) break;
          offset += chunk.bytesRead;
        }
        results.push({ bytes: bytes.subarray(0, offset), ...type });
      } finally {
        await file.close();
      }
    }
    return results;
  };
}

export function createVideoGenerationTool(options: {
  dataDir: string;
  getHost: () => Pick<HostProcess, "call"> | null;
  getStarAi: () => Pick<StarAiAccount, "isSignedIn" | "studioMedia"> | undefined;
}): LocalToolHandler {
  return async ({ sessionId, args, signal }) => {
    const input = parseVideoGenerationInput(args);
    if (
      (input.model === "minimax_h3_768p" || input.model === "minimax_h3_480p") &&
      (!input.images || input.images.length === 0)
    ) {
      return failure(
        "INVALID_ARGUMENT",
        `${input.model} requires 1–9 reference images. Call GenerateImages first to create a keyframe image and pass its local path in \`images\`, or pass \`model: "grok-imagine-video-1.5（按次）"\` for text-only video generation.`,
      );
    }
    if (input.model === "gk-video-3.5-lk" && (!input.images || input.images.length !== 1)) {
      return failure(
        "INVALID_ARGUMENT",
        'gk-video-3.5-lk requires exactly 1 first-frame reference image in `images`.',
      );
    }
    const host = options.getHost();
    if (!host) return failure("HOST_UNAVAILABLE", "Host unavailable.");
    const starAi = options.getStarAi();
    if (!starAi || !(await starAi.isSignedIn())) {
      return failure(
        "STARAI_LOGIN_REQUIRED",
        "Sign in to your StarAI account in Settings > Models before generating videos.",
      );
    }

    const { path } = await host.call<{ path: string }>("session.getScratchPath", { sessionId });
    const root = resolve(options.dataDir, "scratch");
    const within = (base: string, target: string) => {
      const rel = relative(base, target);
      return !!rel && !rel.startsWith("..") && !isAbsolute(rel);
    };
    if (typeof path !== "string" || !within(root, resolve(path))) {
      return failure("INVALID_ARGUMENT", "Invalid video output directory.");
    }
    await mkdir(path, { recursive: true });
    const realRoot = await realpath(root);
    const realDir = await realpath(path);
    if (!within(realRoot, realDir)) {
      return failure("INVALID_ARGUMENT", "Invalid video output directory.");
    }
    signal.throwIfAborted();
    const { session } = await host.call<{ session?: { projectPath?: string } }>("session.get", {
      id: sessionId,
      messageLimit: 1,
    });
    if (!session) return failure("SESSION_NOT_FOUND", "The video session no longer exists.");

    try {
      const loadImages = imageInputLoader({
        dataDir: options.dataDir,
        scratchPath: realDir,
        projectPath: session.projectPath,
      });
      const loadAudio = audioInputLoader({
        dataDir: options.dataDir,
        scratchPath: realDir,
        projectPath: session.projectPath,
      });
      const images = input.images?.length ? await loadImages(input.images) : undefined;
      const audio = input.audio?.length ? await loadAudio(input.audio) : undefined;
      signal.throwIfAborted();

      const outcome = await runStarAiStudioGeneration(
        starAi.studioMedia,
        {
          kind: "video",
          model: input.model,
          prompt: input.prompt,
          aspectRatio: input.aspectRatio,
          resolution: input.resolution,
          seconds: input.seconds,
          images,
          audio,
        },
        signal,
      );
      const first = outcome.files[0];
      if (!first) return failure("MEDIA_INVALID_RESPONSE", "StarAI returned no video file.");
      const target = join(realDir, `generated-video-${randomUUID()}.${first.extension}`);
      await writeFile(target, first.bytes, { flag: "wx" });
      const mediaUrl = generatedMediaUrlFromScratchRoot(realRoot, target) ?? undefined;
      return {
        ok: true,
        isError: false,
        content: {
          kind: "generated-video",
          providerId: STARAI_PROVIDER_ID,
          modelId: outcome.model,
          result: {
            status: "succeeded",
            path: target,
            ...(mediaUrl ? { mediaUrl } : {}),
            mimeType: first.mimeType,
            model: outcome.model,
            generationId: outcome.id,
            ...(outcome.billedAmount !== undefined ? { billedAmount: outcome.billedAmount } : {}),
          },
        },
      };
    } catch (error) {
      const code =
        error && typeof error === "object" && "errorCode" in error && typeof error.errorCode === "string"
          ? error.errorCode
          : "MEDIA_GENERATION_FAILED";
      const message =
        error instanceof Error && error.message
          ? error.message
          : "Video generation failed.";
      return failure(code, message);
    }
  };
}
