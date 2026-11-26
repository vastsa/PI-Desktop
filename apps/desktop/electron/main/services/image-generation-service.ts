import { randomUUID } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createImageBinding, generateImageBatch, type ImageOperationMetadata } from "@pi-desktop/agent-runtime";
import type { ImageApi, ImageModel } from "@earendil-works/pi-ai";
import type { VendorOAuth } from "../oauth";
import {
  CODEX_IMAGE_VENDOR_KEY,
  imageGenerationItems,
  imageModelOfferedByProvider,
  parseImageGenerationBinding,
  STARAI_DEFAULT_IMAGE_MODEL,
  STARAI_PROVIDER_ID,
  type AppSettings,
  type GeneratedImageResult,
  type ProviderPublic,
} from "@pi-desktop/shared";
import type { HostProcess } from "../host-process";
import type { LocalToolHandler } from "../agent-sidecar";
import type { StarAiAccount } from "../star-ai-account";
import { imageInputLoader } from "./image-inputs";
import { runStarAiStudioGeneration } from "./star-ai-studio-media";

function failure(errorCode: string, content: string) {
  return {
    ok: false,
    isError: true,
    errorCode,
    content: { kind: "image-generation-error", errorCode, message: content },
  };
}

export function createImageGenerationTool(options: {
  dataDir: string;
  getHost: () => Pick<HostProcess, "call"> | null;
  getStarAi?: () => Pick<StarAiAccount, "isSignedIn" | "studioMedia"> | undefined;
  fetchImpl?: typeof fetch;
  allowFakeIp?: () => boolean;
  resolveAuth?: VendorOAuth["resolveAuth"];
  resolveImageModel?: (provider: ProviderPublic, modelId: string) => Promise<ImageModel<ImageApi> | undefined>;
}): LocalToolHandler {
  return async ({ sessionId, args, signal }) => {
    const requestedItems = imageGenerationItems(args);
    const host = options.getHost();
    if (!host) return failure("HOST_UNAVAILABLE", "Host unavailable.");
    const settings = await host.call<AppSettings>("settings.get");
    const binding = parseImageGenerationBinding(settings.imageGeneration);

    const resolveSessionOutput = async () => {
      const { path } = await host.call<{ path: string }>("session.getScratchPath", { sessionId });
      const root = resolve(options.dataDir, "scratch");
      const within = (base: string, target: string) => {
        const rel = relative(base, target);
        return !!rel && !rel.startsWith("..") && !isAbsolute(rel);
      };
      if (typeof path !== "string" || !within(root, resolve(path))) {
        return { error: failure("INVALID_ARGUMENT", "Invalid image output directory.") };
      }
      await mkdir(path, { recursive: true });
      const realRoot = await realpath(root);
      const realDir = await realpath(path);
      if (!within(realRoot, realDir)) {
        return { error: failure("INVALID_ARGUMENT", "Invalid image output directory.") };
      }
      signal.throwIfAborted();
      const { session } = await host.call<{ session?: { projectPath?: string } }>("session.get", {
        id: sessionId,
        messageLimit: 1,
      });
      if (!session) return { error: failure("SESSION_NOT_FOUND", "The image session no longer exists.") };
      return { realDir, projectPath: session.projectPath };
    };

    if (!binding) {
      const starAi = options.getStarAi?.();
      if (starAi && (await starAi.isSignedIn())) {
        const output = await resolveSessionOutput();
        if ("error" in output && output.error) return output.error;
        const loadImages = imageInputLoader({
          dataDir: options.dataDir,
          scratchPath: output.realDir,
          projectPath: output.projectPath,
        });
        const results: GeneratedImageResult[] = [];
        let usedModel: string = STARAI_DEFAULT_IMAGE_MODEL;
        for (let index = 0; index < requestedItems.length; index++) {
          const item = requestedItems[index];
          if (signal.aborted) {
            results.push({ index, status: "cancelled", errorCode: "IMAGE_CANCELLED" });
            continue;
          }
          try {
            const loaded = item.images?.length ? await loadImages(item.images.slice(0, 1)) : undefined;
            const outcome = await runStarAiStudioGeneration(
              starAi.studioMedia,
              {
                kind: "image",
                model: item.model ?? STARAI_DEFAULT_IMAGE_MODEL,
                prompt: item.prompt,
                aspectRatio: item.aspectRatio,
                resolution: item.resolution,
                images: loaded,
              },
              signal,
            );
            usedModel = outcome.model;
            for (const file of outcome.files) {
              const target = join(output.realDir, `generated-${randomUUID()}.${file.extension}`);
              await writeFile(target, file.bytes, { flag: "wx" });
              results.push({ index: results.length, status: "succeeded", path: target, mimeType: file.mimeType });
            }
          } catch (error) {
            const code =
              signal.aborted
                ? "IMAGE_CANCELLED"
                : error && typeof error === "object" && "errorCode" in error && typeof error.errorCode === "string"
                  ? error.errorCode.replace(/^MEDIA_/, "IMAGE_")
                  : "IMAGE_REQUEST_FAILED";
            results.push({
              index: results.length,
              status: code === "IMAGE_CANCELLED" ? "cancelled" : "failed",
              errorCode: code,
            });
          }
        }
        const ok = results.some((result) => result.status === "succeeded");
        return {
          ok,
          isError: !ok,
          content: {
            kind: "generated-images",
            providerId: STARAI_PROVIDER_ID,
            modelId: usedModel,
            results,
            operations: [],
          },
        };
      }
      return failure(
        "IMAGE_NOT_CONFIGURED",
        // MCP image tools stay separate: they are discovered and called as
        // ordinary MCP tools and never back this built-in tool (#2563).
        "Sign in to your StarAI account (or configure an image generation model in Settings > Models > Image generation model) before generating images. Do not substitute another model. MCP image tools are separate tools and cannot back this one.",
      );
    }
    const { provider } = await host.call<{ provider?: ProviderPublic }>("providers.get", {
      id: binding.providerId,
    });
    if (
      !provider?.enabled ||
      !provider.baseUrl ||
      !imageModelOfferedByProvider(provider, binding.modelId)
    ) {
      return failure(
        "IMAGE_MODEL_UNAVAILABLE",
        "The configured image model is unavailable. Update Settings > Models > Image generation model.",
      );
    }
    const { value } = provider.authKind === "oauth" || provider.authKind === "none"
      ? { value: undefined }
      : await host.call<{ value?: string }>("providers.getSecret", { id: provider.id });
    if (provider.authKind !== "none" && provider.authKind !== "oauth" && !value)
      return failure("IMAGE_AUTH_FAILED", "The image provider needs an API key.");
    const downloadOptions = { allowFakeIp: options.allowFakeIp?.() === true };
    // A signed-in Codex account serves images on the vendor's Codex routes and
    // identifies the calling client with `originator`, the header its chat
    // traffic sends. A configured header still wins.
    const codexImages = provider.authKind === "oauth" &&
      provider.vendorKey === CODEX_IMAGE_VENDOR_KEY;
    const headers = codexImages ? { originator: "pi", ...provider.headers } : provider.headers;
    let imageBinding;
    try {
      imageBinding = createImageBinding({
        nativeModel: await options.resolveImageModel?.(provider, binding.modelId),
        providerId: provider.id, vendorKey: provider.vendorKey, authKind: provider.authKind,
        baseUrl: provider.baseUrl, modelId: binding.modelId, apiKey: value, headers,
        ...(provider.authKind === "oauth" && options.resolveAuth
          ? { resolveAuth: () => options.resolveAuth!(provider.id) } : {}),
      }, downloadOptions);
    } catch (error) {
      if (error && typeof error === "object" && "errorCode" in error && error.errorCode === "IMAGE_AUTH_UNSUPPORTED")
        return failure("IMAGE_AUTH_UNSUPPORTED", "The selected account has no supported image operation.");
      throw error;
    }
    const { path } = await host.call<{ path: string }>("session.getScratchPath", { sessionId });
    const root = resolve(options.dataDir, "scratch");
    const within = (base: string, target: string) => {
      const rel = relative(base, target);
      return !!rel && !rel.startsWith("..") && !isAbsolute(rel);
    };
    if (typeof path !== "string" || !within(root, resolve(path)))
      return failure("INVALID_ARGUMENT", "Invalid image output directory.");
    await mkdir(path, { recursive: true });
    const realRoot = await realpath(root);
    const realDir = await realpath(path);
    if (!within(realRoot, realDir))
      return failure("INVALID_ARGUMENT", "Invalid image output directory.");
    signal.throwIfAborted();
    const { session } = await host.call<{ session?: { projectPath?: string } }>("session.get", {
      id: sessionId,
      messageLimit: 1,
    });
    if (!session) return failure("SESSION_NOT_FOUND", "The image session no longer exists.");
    const operations: ImageOperationMetadata[] = [];
    const results = await generateImageBatch({
      input: args,
      binding: imageBinding,
      onOperation: operation => { operations.push(operation); },
      signal,
      fetchImpl: options.fetchImpl,
      downloadOptions: { allowFakeIp: options.allowFakeIp?.() === true },
      loadImages: imageInputLoader({
        dataDir: options.dataDir,
        scratchPath: realDir,
        projectPath: session?.projectPath,
      }),
      save: async (image) => {
        const target = join(realDir, `generated-${randomUUID()}.${image.extension}`);
        await writeFile(target, image.bytes, { flag: "wx" });
        return target;
      },
    });
    const ok = results.some((result) => result.status === "succeeded");
    return {
      ok,
      isError: !ok,
      content: {
        kind: "generated-images",
        providerId: binding.providerId,
        modelId: binding.modelId,
        results,
        operations: operations.sort((a, b) => a.index - b.index),
      },
    };
  };
}
