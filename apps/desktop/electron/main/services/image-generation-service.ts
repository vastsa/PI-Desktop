import { randomUUID } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { generateImageBatch } from "@pi-desktop/agent-runtime";
import {
  imageGenerationPrompts,
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
    if (
      !provider?.enabled ||
      !provider.baseUrl ||
      !provider.models.some((model) => model.id === binding.modelId)
    ) {
      return failure(
        "IMAGE_MODEL_UNAVAILABLE",
        "The configured image model is unavailable. Update Settings > Models > Image generation model.",
      );
    }
    if (provider.authKind === "oauth")
      return failure(
        "IMAGE_AUTH_UNSUPPORTED",
        "Image generation requires an API-key or no-auth service.",
      );
    const { value } = await host.call<{ value?: string }>("providers.getSecret", {
      id: provider.id,
    });
    if (provider.authKind !== "none" && !value)
      return failure("IMAGE_AUTH_FAILED", "The image provider needs an API key.");
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
    const results = await generateImageBatch({
      input: args,
      endpoint: {
        baseUrl: provider.baseUrl,
        modelId: binding.modelId,
        apiKey: value,
        headers: provider.headers,
      },
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
      },
    };
  };
}
