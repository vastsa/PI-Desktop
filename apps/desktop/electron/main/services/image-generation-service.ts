import { randomUUID } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createImageBinding, generateImageBatch, type ImageOperationMetadata } from "@pi-desktop/agent-runtime";
import type { ImageApi, ImageModel, ProviderImages } from "@earendil-works/pi-ai";
import type { VendorOAuth } from "../oauth";
import {
  CODEX_IMAGE_VENDOR_KEY,
  imageGenerationPrompts,
  imageModelOfferedByProvider,
  parseImageGenerationBinding,
  type AppSettings,
  type ProviderPublic,
} from "@pi-desktop/shared";
import type { HostProcess } from "../host-process";
import type { LocalToolHandler } from "../agent-sidecar";
import { imageInputLoader } from "./image-inputs";

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
  fetchImpl?: typeof fetch;
  allowFakeIp?: () => boolean;
  resolveAuth?: VendorOAuth["resolveAuth"];
  resolveImageModel?: (provider: ProviderPublic, modelId: string) => Promise<ImageModel<ImageApi> | undefined>;
  resolveProviderImages?: (provider: ProviderPublic, modelId: string) => ProviderImages | undefined;
}): LocalToolHandler {
  return async ({ sessionId, args, signal }) => {
    imageGenerationPrompts(args);
    const host = options.getHost();
    if (!host) return failure("HOST_UNAVAILABLE", "Host unavailable.");
    const settings = await host.call<AppSettings>("settings.get");
    const binding = parseImageGenerationBinding(settings.imageGeneration);
    if (!binding)
      return failure(
        "IMAGE_NOT_CONFIGURED",
        "Configure an image generation model in Settings > Models > Image generation model before generating images. Do not substitute another model.",
      );
    const { provider } = await host.call<{ provider?: ProviderPublic }>("providers.get", {
      id: binding.providerId,
    });
    const customImages = provider?.enabled ? options.resolveProviderImages?.(provider, binding.modelId) : undefined;
    if (
      !provider?.enabled ||
      (!provider.baseUrl && !customImages) ||
      !imageModelOfferedByProvider(provider, binding.modelId)
    ) {
      return failure(
        "IMAGE_MODEL_UNAVAILABLE",
        "The configured image model is unavailable. Update Settings > Models > Image generation model.",
      );
    }
    const { value } = customImages || provider.authKind === "oauth" || provider.authKind === "none"
      ? { value: undefined }
      : await host.call<{ value?: string }>("providers.getSecret", { id: provider.id });
    if (!customImages && provider.authKind !== "none" && provider.authKind !== "oauth" && !value)
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
        nativeModel: customImages ? undefined : await options.resolveImageModel?.(provider, binding.modelId),
        customImages,
        providerId: provider.id, vendorKey: provider.vendorKey, authKind: customImages ? "none" : provider.authKind,
        baseUrl: provider.baseUrl ?? "https://plugin.invalid", modelId: binding.modelId, apiKey: value, headers,
        ...(!customImages && provider.authKind === "oauth" && options.resolveAuth
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
