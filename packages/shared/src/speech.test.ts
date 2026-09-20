import { describe, expect, it } from "vitest";
import {
  builtinSpeechProtocols,
  parseSpeechBinding,
  validateSpeechSettings,
} from "./speech.js";

describe("validateSpeechSettings", () => {
  it("accepts absent speech", () => {
    expect(validateSpeechSettings(undefined)).toBeUndefined();
    expect(validateSpeechSettings(null)).toBeUndefined();
    expect(validateSpeechSettings({})).toBeUndefined();
  });

  it("parses a transcribe binding", () => {
    const speech = validateSpeechSettings({
      transcribe: {
        providerId: "openai",
        modelId: "whisper-1",
        protocol: "openai_audio",
      },
    });
    expect(speech?.transcribe).toEqual({
      providerId: "openai",
      modelId: "whisper-1",
      protocol: "openai_audio",
    });
  });

  it("rejects a closed protocol enum and accepts plugin ids", () => {
    const speech = validateSpeechSettings({
      synthesize: {
        providerId: "eleven",
        modelId: "eleven_multilingual_v2",
        protocol: "elevenlabs",
        voice: "Rachel",
      },
    });
    expect(speech?.synthesize?.protocol).toBe("elevenlabs");
  });

  it("rejects an invalid protocol id", () => {
    expect(() =>
      parseSpeechBinding(
        { providerId: "p", modelId: "m", protocol: "OpenAI Audio" },
        "transcribe",
      ),
    ).toThrow(/protocol is invalid/);
  });
});

describe("builtinSpeechProtocols", () => {
  it("lists open request-shape adapters", () => {
    expect(builtinSpeechProtocols().map((item) => item.id)).toEqual([
      "openai_audio",
      "openai_chat_audio",
    ]);
  });
});
