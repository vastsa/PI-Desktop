import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import {
  ErrorCodes,
  MAX_SPEECH_TTS_DATA_URL_BYTES,
  assertSpeechInputSize,
  builtinSpeechProtocols,
  type AppSettings,
  type SpeechBinding,
  type SpeechProtocolInfo,
  type SpeechRole,
  type SpeechStatus,
  type SpeechSynthesizeResult,
  type SpeechTranscribeResult,
} from "@pi-desktop/shared";
import {
  assertSameOrigin,
  executeSpeechHttp,
  runBuiltinSpeech,
  type SpeechEndpoint,
  type SpeechHttpCall,
  type SpeechHttpResult,
  type SpeechJob,
} from "@pi-desktop/agent-runtime";
import type { HostProcess } from "../host-process";
import type { Logger } from "../logger";
import type { PluginRuntime } from "../plugin-runtime";

const AUDIO_EXT_MIME: Record<string, string> = {
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
  ".webm": "audio/webm",
};

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { errorCode: code });
}

function mimeFor(path: string, fallback?: string): string {
  return fallback || AUDIO_EXT_MIME[extname(path).toLowerCase()] || "application/octet-stream";
}

function extensionFor(mimeType: string, format?: string): string {
  if (format && /^\w+$/.test(format)) return format;
  if (mimeType.includes("wav")) return "wav";
  if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return "mp3";
  if (mimeType.includes("ogg")) return "ogg";
  return "wav";
}

export type SpeechService = {
  status(): Promise<SpeechStatus>;
  transcribe(input: {
    sessionId?: string | null;
    path: string;
    mimeType?: string;
    language?: string;
  }): Promise<SpeechTranscribeResult>;
  synthesize(input: {
    sessionId?: string | null;
    text: string;
    voice?: string;
    format?: string;
  }): Promise<SpeechSynthesizeResult>;
};

export function createSpeechService(options: {
  dataDir: string;
  getHost: () => HostProcess | null;
  plugins: PluginRuntime;
  logger: Pick<Logger, "app">;
}): SpeechService {
  const { dataDir, getHost, plugins, logger } = options;

  const hostOrThrow = () => {
    const host = getHost();
    if (!host) fail(ErrorCodes.HOST_UNAVAILABLE, "host unavailable");
    return host;
  };

  const loadSettings = async () => hostOrThrow().call<AppSettings>("settings.get");

  const protocolCatalog = (): SpeechProtocolInfo[] => [
    ...builtinSpeechProtocols(),
    ...plugins.listSpeechAdapters(),
  ];

  const assertProtocol = (binding: SpeechBinding, role: SpeechRole) => {
    const protocol = protocolCatalog().find((item) => item.id === binding.protocol);
    if (!protocol || !protocol.roles.includes(role)) {
      fail(ErrorCodes.SPEECH_PROTOCOL_UNSUPPORTED, `speech protocol does not support ${role}`);
    }
  };

  const bindingFor = async (role: SpeechRole): Promise<SpeechBinding> => {
    const speech = (await loadSettings()).speech;
    const binding = speech?.[role];
    if (!binding) fail(ErrorCodes.SPEECH_NOT_CONFIGURED, `${role} is not configured`);
    assertProtocol(binding, role);
    return binding;
  };

  const resolveEndpoint = async (binding: SpeechBinding): Promise<SpeechEndpoint & { providerId: string }> => {
    const host = hostOrThrow();
    const result = await host.call<{ provider?: { id: string; baseUrl?: string; enabled?: boolean } }>(
      "providers.get",
      { id: binding.providerId },
    );
    const provider = result.provider;
    if (!provider || provider.enabled === false) fail(ErrorCodes.NOT_FOUND, "speech provider is missing");
    const secret = await host.call<{ value?: string }>("providers.getSecret", { id: provider.id });
    return {
      providerId: provider.id,
      baseUrl: (provider.baseUrl || "").replace(/\/+$/, ""),
      apiKey: secret.value,
    };
  };

  const scratchDir = async (sessionId?: string | null) => {
    if (!sessionId?.trim()) fail(ErrorCodes.INVALID_ARGUMENT, "sessionId is required");
    const host = hostOrThrow();
    const result = await host.call<{ path: string }>("session.getScratchPath", {
      sessionId: sessionId.trim(),
    });
    const scratchPath = resolve(String(result?.path ?? ""));
    const scratchRoot = resolve(join(dataDir, "scratch"));
    const rel = relative(scratchRoot, scratchPath);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
      fail(ErrorCodes.INVALID_ARGUMENT, "invalid session id");
    }
    await mkdir(scratchPath, { recursive: true });
    return scratchPath;
  };

  const readAudio = async (path: string, scratchPath: string, mimeType?: string) => {
    const full = resolve(path);
    const rel = relative(scratchPath, full);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
      fail(ErrorCodes.INVALID_ARGUMENT, "speech input must be a session file");
    }
    const info = await stat(full).catch(() => null);
    if (!info || !info.isFile()) fail(ErrorCodes.NOT_FOUND, "speech input file is missing");
    assertSpeechInputSize(info.size);
    return {
      filename: basename(full),
      mimeType: mimeFor(full, mimeType),
      bytes: new Uint8Array(await readFile(full)),
    };
  };

  const runJob = async (job: SpeechJob, endpoint: SpeechEndpoint): Promise<SpeechHttpResult> => {
    const plugin = plugins.getSpeechAdapter(job.binding.protocol);
    if (plugin) {
      if (!plugin.roles.includes(job.role)) {
        fail(ErrorCodes.SPEECH_PROTOCOL_UNSUPPORTED, `speech protocol does not support ${job.role}`);
      }
      const reply = await plugins.runSpeechAdapter(job, {
        modelId: job.binding.modelId,
        voice: job.binding.voice,
        format: job.binding.format,
        extra: job.binding.extra,
        text: job.text,
        language: job.role === "transcribe" ? (job as { language?: string }).language : undefined,
        audio: job.audio
          ? {
              mimeType: job.audio.mimeType,
              data: Buffer.from(job.audio.bytes).toString("base64"),
            }
          : undefined,
      });
      if (reply.kind === "text") return { kind: "text", text: reply.text ?? "" };
      if (reply.kind === "audio") {
        return {
          kind: "audio",
          mimeType: reply.mimeType || "application/octet-stream",
          bytes: Buffer.from(reply.data ?? "", "base64"),
        };
      }
      const call = reply.call as SpeechHttpCall | undefined;
      if (!call?.url) fail(ErrorCodes.INVALID_ARGUMENT, "speech adapter http call is invalid");
      if (!endpoint.baseUrl) fail(ErrorCodes.INVALID_ARGUMENT, "speech provider has no base URL");
      assertSameOrigin(endpoint.baseUrl, call.url);
      return executeSpeechHttp(call, {
        apiKey: endpoint.apiKey,
        audio: job.audio,
      });
    }
    if (!endpoint.baseUrl) fail(ErrorCodes.INVALID_ARGUMENT, "speech provider has no base URL");
    return runBuiltinSpeech(job, endpoint);
  };

  return {
    async status() {
      const settings = await loadSettings().catch(() => null);
      const protocols = protocolCatalog();
      const roleStatus = (role: SpeechRole) => {
        const binding = settings?.speech?.[role];
        if (!binding) return { configured: false, available: false };
        const protocol = protocols.find((item) => item.id === binding.protocol);
        return {
          configured: true,
          available: Boolean(protocol && protocol.roles.includes(role)),
          providerId: binding.providerId,
          modelId: binding.modelId,
          protocol: binding.protocol,
        };
      };
      return {
        transcribe: roleStatus("transcribe"),
        synthesize: roleStatus("synthesize"),
        protocols,
      };
    },

    async transcribe(input) {
      const binding = await bindingFor("transcribe");
      const endpoint = await resolveEndpoint(binding);
      const dir = await scratchDir(input.sessionId);
      const audio = await readAudio(String(input.path ?? ""), dir, input.mimeType);
      const result = await runJob(
        {
          role: "transcribe",
          binding,
          language: input.language,
          audio,
        },
        endpoint,
      );
      if (result.kind !== "text") fail(ErrorCodes.PROVIDER_ERROR, "speech adapter did not return text");
      logger.app("provider", "info", "speech transcribed", {
        data: { protocol: binding.protocol, providerId: binding.providerId },
      });
      return { text: result.text };
    },

    async synthesize(input) {
      const text = String(input.text ?? "").trim();
      if (!text) fail(ErrorCodes.INVALID_ARGUMENT, "speech text is required");
      const binding = await bindingFor("synthesize");
      const endpoint = await resolveEndpoint(binding);
      const result = await runJob(
        {
          role: "synthesize",
          binding: {
            ...binding,
            ...(input.voice ? { voice: input.voice } : {}),
            ...(input.format ? { format: input.format } : {}),
          },
          text,
        },
        endpoint,
      );
      if (result.kind !== "audio") fail(ErrorCodes.PROVIDER_ERROR, "speech adapter did not return audio");
      const dir = await scratchDir(input.sessionId);
      const ext = extensionFor(result.mimeType, input.format || binding.format);
      const path = join(dir, `speech-${randomUUID()}.${ext}`);
      await writeFile(path, result.bytes);
      const payload: SpeechSynthesizeResult = { path, mimeType: result.mimeType };
      if (result.bytes.byteLength <= MAX_SPEECH_TTS_DATA_URL_BYTES) {
        payload.dataUrl = `data:${result.mimeType};base64,${Buffer.from(result.bytes).toString("base64")}`;
      }
      logger.app("provider", "info", "speech synthesized", {
        data: { protocol: binding.protocol, providerId: binding.providerId },
      });
      return payload;
    },
  };
}
