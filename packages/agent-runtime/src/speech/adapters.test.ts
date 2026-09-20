import { describe, expect, it } from "vitest";
import type { SpeechBinding } from "@pi-desktop/shared";
import { openaiAudioCall, openaiChatAudioCall, runBuiltinSpeech } from "./adapters.js";
import { assertSameOrigin } from "./http.js";

const transcribe: SpeechBinding = {
  providerId: "openai",
  modelId: "whisper-1",
  protocol: "openai_audio",
};

const tts: SpeechBinding = {
  providerId: "openai",
  modelId: "tts-1",
  protocol: "openai_audio",
  voice: "alloy",
  format: "mp3",
};

const chatTts: SpeechBinding = {
  providerId: "xiaomi",
  modelId: "mimo-v2.5-tts",
  protocol: "openai_chat_audio",
  voice: "Chloe",
  format: "wav",
  extra: { style: "Bright and bouncy." },
};

describe("builtin speech adapters", () => {
  it("builds OpenAI transcription multipart", () => {
    const call = openaiAudioCall(
      { role: "transcribe", binding: transcribe, language: "en" },
      { baseUrl: "https://api.openai.com/v1" },
    );
    expect(call.url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(call.body).toMatchObject({
      type: "multipart",
      fileField: "file",
      fields: { model: "whisper-1", language: "en" },
    });
  });

  it("builds OpenAI speech JSON", () => {
    const call = openaiAudioCall(
      { role: "synthesize", binding: tts, text: "hello" },
      { baseUrl: "https://api.openai.com/v1" },
    );
    expect(call.url).toBe("https://api.openai.com/v1/audio/speech");
    expect(call.body).toMatchObject({
      type: "json",
      value: { model: "tts-1", input: "hello", voice: "alloy", response_format: "mp3" },
    });
  });

  it("builds MIMO-style chat audio", () => {
    const call = openaiChatAudioCall(
      { role: "synthesize", binding: chatTts, text: "I passed!" },
      { baseUrl: "https://api.xiaomimimo.com/v1" },
    );
    expect(call.url).toBe("https://api.xiaomimimo.com/v1/chat/completions");
    expect(call.body).toMatchObject({
      type: "json",
      value: {
        model: "mimo-v2.5-tts",
        audio: { format: "wav", voice: "Chloe" },
      },
    });
  });

  it("transcribes through a mock OpenAI Audio server", async () => {
    const result = await runBuiltinSpeech(
      {
        role: "transcribe",
        binding: transcribe,
        audio: { filename: "a.wav", mimeType: "audio/wav", bytes: new Uint8Array([1, 2, 3]) },
      },
      {
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-test",
        fetchImpl: async (url, init) => {
          expect(String(url)).toContain("/audio/transcriptions");
          expect((init?.headers as Headers).get("Authorization")).toBe("Bearer sk-test");
          expect(init?.body).toBeInstanceOf(FormData);
          return new Response(JSON.stringify({ text: "hello world" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      },
    );
    expect(result).toEqual({ kind: "text", text: "hello world" });
  });

  it("decodes chat-audio base64", async () => {
    const wav = Buffer.from("RIFF").toString("base64");
    const result = await runBuiltinSpeech(
      { role: "synthesize", binding: chatTts, text: "hi" },
      {
        baseUrl: "https://api.xiaomimimo.com/v1",
        apiKey: "mimo",
        fetchImpl: async () =>
          new Response(
            JSON.stringify({ choices: [{ message: { audio: { data: wav } } }] }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      },
    );
    expect(result.kind).toBe("audio");
    if (result.kind === "audio") {
      expect(Buffer.from(result.bytes).toString()).toBe("RIFF");
    }
  });

  it("rejects an unknown protocol", async () => {
    await expect(
      runBuiltinSpeech(
        {
          role: "synthesize",
          binding: { ...tts, protocol: "elevenlabs" },
          text: "hi",
        },
        { baseUrl: "https://api.openai.com/v1" },
      ),
    ).rejects.toMatchObject({ errorCode: "SPEECH_PROTOCOL_UNSUPPORTED" });
  });
});

describe("assertSameOrigin", () => {
  it("allows the provider origin", () => {
    expect(() =>
      assertSameOrigin("https://api.openai.com/v1", "https://api.openai.com/v1/audio/speech"),
    ).not.toThrow();
  });

  it("rejects a different origin", () => {
    expect(() => assertSameOrigin("https://api.openai.com/v1", "https://evil.test/x")).toThrow(
      /provider origin/,
    );
  });
});

