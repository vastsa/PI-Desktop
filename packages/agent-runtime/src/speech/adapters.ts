import { ErrorCodes, type SpeechBinding, type SpeechRole } from "@pi-desktop/shared";
import {
  assertSameOrigin,
  executeSpeechHttp,
  joinProviderUrl,
  type SpeechHttpCall,
  type SpeechHttpContext,
  type SpeechHttpResult,
} from "./http.js";

export type SpeechJob = {
  role: SpeechRole;
  binding: SpeechBinding;
  text?: string;
  language?: string;
  audio?: { filename: string; mimeType: string; bytes: Uint8Array };
};

export type SpeechEndpoint = {
  baseUrl: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
};

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { errorCode: code });
}

function endpointUrl(endpoint: SpeechEndpoint, binding: SpeechBinding, fallback: string): string {
  const url = joinProviderUrl(endpoint.baseUrl, binding.path || fallback);
  assertSameOrigin(endpoint.baseUrl, url);
  return url;
}

export function openaiAudioCall(job: SpeechJob, endpoint: SpeechEndpoint): SpeechHttpCall {
  const { binding, role } = job;
  if (role === "transcribe") {
    return {
      url: endpointUrl(endpoint, binding, "audio/transcriptions"),
      body: {
        type: "multipart",
        fields: {
          model: binding.modelId,
          ...(job.language ? { language: job.language } : {}),
          ...(binding.extra ?? {}),
        },
        fileField: "file",
      },
      parse: "openai-transcription",
    };
  }
  const format = binding.format || "mp3";
  return {
    url: endpointUrl(endpoint, binding, "audio/speech"),
    body: {
      type: "json",
      value: {
        model: binding.modelId,
        input: job.text ?? "",
        voice: job.binding.voice || "alloy",
        response_format: format,
        ...(binding.extra ?? {}),
      },
    },
    parse: "bytes",
  };
}

export function openaiChatAudioCall(job: SpeechJob, endpoint: SpeechEndpoint): SpeechHttpCall {
  if (job.role !== "synthesize") {
    fail(ErrorCodes.SPEECH_PROTOCOL_UNSUPPORTED, "openai_chat_audio does not transcribe");
  }
  const format = job.binding.format || "wav";
  const voice = job.binding.voice || "alloy";
  const style = job.binding.extra?.style;
  return {
    url: endpointUrl(endpoint, job.binding, "chat/completions"),
    body: {
      type: "json",
      value: {
        model: job.binding.modelId,
        messages: [
          ...(style ? [{ role: "user", content: style }] : []),
          { role: "assistant", content: job.text ?? "" },
        ],
        audio: { format, voice },
        ...(job.binding.extra
          ? Object.fromEntries(Object.entries(job.binding.extra).filter(([key]) => key !== "style"))
          : {}),
      },
    },
    parse: "openai-chat-audio",
  };
}

export function builtinSpeechCall(job: SpeechJob, endpoint: SpeechEndpoint): SpeechHttpCall {
  switch (job.binding.protocol) {
    case "openai_audio":
      return openaiAudioCall(job, endpoint);
    case "openai_chat_audio":
      return openaiChatAudioCall(job, endpoint);
    default:
      fail(ErrorCodes.SPEECH_PROTOCOL_UNSUPPORTED, `unknown speech protocol: ${job.binding.protocol}`);
  }
}

export async function runBuiltinSpeech(
  job: SpeechJob,
  endpoint: SpeechEndpoint,
): Promise<SpeechHttpResult> {
  const call = builtinSpeechCall(job, endpoint);
  const context: SpeechHttpContext = {
    apiKey: endpoint.apiKey,
    audio: job.audio,
    fetchImpl: endpoint.fetchImpl,
  };
  return executeSpeechHttp(call, context);
}
