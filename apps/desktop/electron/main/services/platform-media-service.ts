import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { assertAIPlatformProvider, PLATFORM_IMAGE_MODELS, type AppSettings, type ProviderPublic } from "@pi-desktop/shared";
import type { HostProcess } from "../host-process";
import type { LocalToolHandler, LocalToolResult } from "../agent-sidecar";
import { mediaError, parsePlatformMediaInput, prepareMediaReferences } from "./platform-media-input";
import { runPlatformMediaCli, type MediaCliRequest, type PythonLauncher } from "./platform-media-process";
import { copyImageReceipt, mediaRecovery, readOwnedMediaReceipt } from "./platform-media-receipts";

export { parsePlatformMediaInput } from "./platform-media-input";

export function createPlatformMediaTool(options: {
  dataDir: string;
  getHost: () => Pick<HostProcess, "call"> | null;
  scriptsDir?: string;
  /** Host test seams; neither is a model-controlled tool field. */
  python?: PythonLauncher;
  timeoutMs?: number;
}): LocalToolHandler {
  return async ({ sessionId, toolCallId, args, signal }): Promise<LocalToolResult> => {
    let apiKey = "";
    let directory: string | undefined;
    let providerId: string | undefined;
    let operation: string | undefined;
    // Apply to success results too: an upstream can echo a credential inside
    // an error or other field. Never forward raw environment/process objects.
    const redact = (value: unknown): unknown => {
      return JSON.parse(JSON.stringify(value, (key, item: unknown) => {
        if (/^(authorization|api[_-]?key|secret|cookie)$/i.test(key)) return "[REDACTED]";
        if (typeof item !== "string") return item;
        let safe = item;
        let encoded = apiKey;
        for (let depth = 0; encoded && depth < 3; depth++) {
          safe = safe.split(encoded).join("[REDACTED]");
          encoded = JSON.stringify(encoded).slice(1, -1);
        }
        return safe.replace(/sk-[A-Za-z0-9_-]{12,}/g, "[REDACTED]");
      }));
    };
    try {
      const input = parsePlatformMediaInput(args);
      operation = input.operation;
      signal.throwIfAborted();
      const host = options.getHost();
      if (!host) throw mediaError("HOST_UNAVAILABLE", "Host unavailable.");
      const { session } = await host.call<{ session?: { providerId?: string; projectPath?: string } }>("session.get", { id: sessionId });
      if (!session) throw mediaError("SESSION_NOT_FOUND", "The media session no longer exists.");
      providerId = session.providerId;
      if (!providerId) {
        const settings = await host.call<{ defaultProviderId?: string }>("settings.get");
        providerId = settings.defaultProviderId;
      }
      if (!providerId) throw mediaError("PLATFORM_PROVIDER_REQUIRED", "Select a configured AI Aggregation Platform service for this session in Settings > Models.");
      const { provider } = await host.call<{ provider?: ProviderPublic }>("providers.get", { id: providerId });
      if (!provider?.enabled || provider.id !== providerId) throw mediaError("PLATFORM_PROVIDER_REQUIRED", "The selected platform service is unavailable.");
      assertAIPlatformProvider(provider);
      const { value } = await host.call<{ value?: string }>("providers.getSecret", { id: providerId });
      if (!value?.trim()) throw mediaError("PLATFORM_AUTH_REQUIRED", "Configure this platform service's API key in Settings > Models. Register and recharge at https://ai.yykkj.com, then create an API token there.");
      apiKey = value;

      const { path } = await host.call<{ path: string }>("session.getScratchPath", { sessionId });
      const root = resolve(options.dataDir, "scratch");
      if (!/^[A-Za-z0-9_-]{1,160}$/.test(sessionId) || typeof path !== "string" || resolve(path) !== join(root, sessionId))
        throw mediaError("INVALID_ARGUMENT", "Invalid session scratch directory.");
      await mkdir(path, { recursive: true, mode: 0o700 });
      const scratchPath = await realpath(path);
      const realRoot = await realpath(root);
      if (realRoot !== join(await realpath(options.dataDir), "scratch") || scratchPath !== join(realRoot, sessionId))
        throw mediaError("INVALID_ARGUMENT", "Session scratch escapes its session root.");
      const mediaRoot = join(scratchPath, "platform-media");
      await mkdir(mediaRoot, { recursive: true, mode: 0o700 });
      if (await realpath(mediaRoot) !== mediaRoot) throw mediaError("INVALID_ARGUMENT", "Media directory must not be a symlink.");
      const callKey = createHash("sha256").update(toolCallId).digest("hex");
      const invocationDirectory = join(mediaRoot, callKey);
      try { await mkdir(invocationDirectory, { mode: 0o700 }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (await realpath(invocationDirectory) !== invocationDirectory) throw mediaError("INVALID_ARGUMENT", "Invalid existing media invocation.");
        directory = invocationDirectory;
        throw mediaError("MEDIA_ALREADY_STARTED", "This tool call already has an invocation. Recover its receipts instead of submitting again.");
      }
      directory = invocationDirectory;
      await writeFile(join(directory, "invocation.json"), JSON.stringify({ providerId, operation, sessionId }), { flag: "wx", mode: 0o600 });
      signal.throwIfAborted();
      const references = await prepareMediaReferences(input, { projectPath: session.projectPath, scratchPath, dataDir: options.dataDir, directory, signal });
      let taskId = input.taskId;
      let receiptKind: unknown;
      if (input.receipt) {
        const owned = await readOwnedMediaReceipt(input.receipt, scratchPath, providerId);
        receiptKind = owned.journal.kind;
        if (receiptKind === "video") {
          const id = owned.journal.task_id;
          if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(id) || (taskId && taskId !== id))
            throw mediaError("INVALID_RECEIPT", "The receipt has no usable task ID or does not match taskId. Check the platform record; do not resubmit automatically.");
          taskId = id;
        } else if (taskId || input.operation.startsWith("video-")) {
          throw mediaError("INVALID_RECEIPT", "This operation requires a video receipt.");
        }
      }
      const request: MediaCliRequest = { script: "video", args: [], prompt: input.prompt };
      if (input.operation === "image") {
        request.script = "image";
        request.args = ["generate", "--out", join(directory, "image.png"), "--n", String(input.count ?? 1)];
        const settings = await host.call<AppSettings>("settings.get");
        const selectedImage = settings.imageGeneration?.providerId === providerId
          ? settings.imageGeneration.modelId : undefined;
        request.args.push(`--model=${input.model ?? selectedImage ?? PLATFORM_IMAGE_MODELS[0]}`);
        if (input.ratio) request.args.push(`--ratio=${input.ratio}`);
        for (const ref of references.images ?? []) request.args.push(`--ref=${ref}`);
      } else if (input.operation === "image-download" || (input.operation === "billing" && receiptKind !== "video" && input.receipt)) {
        if (!input.receipt || receiptKind === "video") throw mediaError("INVALID_RECEIPT", "An image receipt is required.");
        const receipt = await copyImageReceipt({ receipt: input.receipt, scratchPath, providerId, directory });
        request.script = "image";
        request.args = [input.operation === "billing" ? "billing" : "download", receipt];
      } else if (input.operation === "video-create") {
        request.args = ["create", "--out", join(directory, "video.mp4"), "--seconds", String(input.seconds ?? 4), "--resolution", input.resolution ?? "768P", "--ratio", input.ratio ?? "16:9"];
        for (const [field, flag] of [["images", "--image"], ["videos", "--video"], ["audios", "--audio"]] as const)
          for (const ref of references[field] ?? []) request.args.push(`${flag}=${ref}`);
      } else {
        if (!taskId) throw mediaError("INVALID_ARGUMENT", "A taskId or video receipt is required.");
        request.args = [input.operation === "video-status" ? "status" : input.operation === "billing" ? "billing" : "download", taskId];
        if (input.operation === "video-download") request.args.push("--out", join(directory, "video.mp4"));
      }
      const moduleDir = typeof __dirname === "string" ? __dirname : import.meta.dirname;
      const script = options.scriptsDir ? join(options.scriptsDir, "desktop.py") : [
        ...(process.resourcesPath ? [join(process.resourcesPath, "skills/ai-aggregation-platform/scripts/desktop.py")] : []),
        join(moduleDir, "../../resources/skills/ai-aggregation-platform/scripts/desktop.py"),
        join(moduleDir, "../../../resources/skills/ai-aggregation-platform/scripts/desktop.py"),
      ].find((candidate) => existsSync(candidate));
      if (!script || !existsSync(script)) throw mediaError("MEDIA_SCRIPTS_MISSING", "The bundled media scripts are missing. Reinstall or rebuild PI-Desktop.");
      signal.throwIfAborted();
      const result = await runPlatformMediaCli({ script, request, cwd: directory, apiKey, signal, timeoutMs: options.timeoutMs, python: options.python });
      let parsed: Record<string, unknown> | undefined;
      if (result.stdout.trim()) {
        try {
          const value: unknown = JSON.parse(result.stdout);
          if (value && typeof value === "object" && !Array.isArray(value)) parsed = value as Record<string, unknown>;
        } catch { /* A killed process may have written only part of its JSON. */ }
      }
      // Video status exposes a full raw response in the CLI. The native result
      // needs only its normalized state, progress, request and task identity.
      if (parsed) delete parsed.response;
      const ok = result.exitCode === 0 && !result.interrupted && !!parsed && !parsed.error;
      const errorCode = ok ? undefined : result.interrupted ?? "MEDIA_CLI_FAILED";
      const recovery = !ok || input.operation === "image" || input.operation === "video-create" || input.operation.endsWith("download") ? await mediaRecovery(directory) : undefined;
      return { ok, isError: !ok, ...(errorCode ? { errorCode } : {}), content: redact({
        kind: "platform-media", operation, providerId, result: parsed,
        ...(recovery ? { recovery } : {}),
        ...(!ok ? { errorCode, message: result.interrupted ? `Media operation ${result.interrupted.toLowerCase()}.` : result.stderr.trim() || "Media CLI did not return a successful result." } : {}),
      }) };
    } catch (error) {
      const code = signal.aborted ? "CANCELLED" : (error as { errorCode?: string }).errorCode ?? "MEDIA_FAILED";
      let recovery: Record<string, unknown> | undefined;
      if (directory && existsSync(directory) && await realpath(directory).catch(() => null) === directory) {
        try { recovery = await mediaRecovery(directory); }
        catch { recovery = { invocation: join(directory, "invocation.json"), noAutomaticResubmit: true }; }
      }
      return { ok: false, isError: true, errorCode: code, content: redact({
        kind: "platform-media", operation, providerId, errorCode: code,
        message: signal.aborted ? "Media operation cancelled. Recover any existing receipts before trying generation again." : error instanceof Error ? error.message : "Media operation failed.",
        ...(recovery ? { recovery } : {}),
      }) };
    }
  };
}
