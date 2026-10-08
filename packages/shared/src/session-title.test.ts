import { describe, expect, it } from "vitest";
import {
  SESSION_TITLE_DEFAULT_PROMPT,
  SESSION_TITLE_IDEAL_LENGTH_VARIABLE,
  SESSION_TITLE_PROMPT_MAX_LENGTH,
  isCustomSessionTitlePromptActive,
  isValidSessionTitleIdealLength,
  isValidSessionTitleMaxLength,
  renderSessionTitleSystemPrompt,
  resolveSessionTitleLengths,
  resolveSessionTitlePrompt,
  resolveSessionTitleSystemPrompt,
  sessionTitlePromptUsesIdealLength,
} from "./session-title.js";

/** The constant that shipped with ADR 0186; the default must render to it. */
const LEGACY_SYSTEM_PROMPT =
  "You generate a short, concise, descriptive session title summarizing the conversation based on the user's initial prompt and context.\n" +
  "Rules:\n" +
  "1. Output ONLY the title text. Do NOT wrap in quotes, brackets, or backticks.\n" +
  "2. Do not include markdown formatting, trailing punctuation, or emojis.\n" +
  "3. Keep it under 25 characters (or 4-7 words).\n" +
  "4. Use the primary language of the user's prompt (e.g. Chinese for Chinese requests, English for English requests).\n" +
  "5. Focus on the key topic or action (e.g. \"Debug WebSocket reconnect\", \"重构用户认证模块\").";

describe("session title default prompt", () => {
  it("is the built-in prompt with the hard-coded length replaced by a variable", () => {
    expect(sessionTitlePromptUsesIdealLength(SESSION_TITLE_DEFAULT_PROMPT)).toBe(true);
    expect(renderSessionTitleSystemPrompt(SESSION_TITLE_DEFAULT_PROMPT, 25)).toBe(
      LEGACY_SYSTEM_PROMPT,
    );
  });

  it("renders with no stored settings exactly as before", () => {
    expect(resolveSessionTitleSystemPrompt()).toBe(LEGACY_SYSTEM_PROMPT);
  });

  it("substitutes the configured ideal length", () => {
    const rendered = resolveSessionTitleSystemPrompt({ idealLength: 15 });
    expect(rendered).toContain("3. Keep it under 15 characters (or 4-7 words).");
    expect(rendered).not.toContain(SESSION_TITLE_IDEAL_LENGTH_VARIABLE);
  });
});

describe("custom session title prompt", () => {
  it("applies only while the gate is on and the text is usable", () => {
    expect(resolveSessionTitlePrompt({ customPrompt: true, prompt: "custom" })).toBe("custom");
    expect(resolveSessionTitlePrompt({ customPrompt: false, prompt: "custom" })).toBe(
      SESSION_TITLE_DEFAULT_PROMPT,
    );
    expect(resolveSessionTitlePrompt({ prompt: "custom" })).toBe(SESSION_TITLE_DEFAULT_PROMPT);
    expect(resolveSessionTitlePrompt({ customPrompt: true, prompt: "   " })).toBe(
      SESSION_TITLE_DEFAULT_PROMPT,
    );
    expect(
      resolveSessionTitlePrompt({
        customPrompt: true,
        prompt: "x".repeat(SESSION_TITLE_PROMPT_MAX_LENGTH + 1),
      }),
    ).toBe(SESSION_TITLE_DEFAULT_PROMPT);
    expect(isCustomSessionTitlePromptActive({ customPrompt: true, prompt: "custom" })).toBe(true);
    expect(isCustomSessionTitlePromptActive({ customPrompt: true, prompt: "" })).toBe(false);
  });

  it("substitutes every occurrence and keeps replacement patterns literal", () => {
    expect(
      renderSessionTitleSystemPrompt("a {{idealLength}} b {{idealLength}} $& $1 $'", 12),
    ).toBe("a 12 b 12 $& $1 $'");
  });

  it("leaves a prompt without the variable unchanged", () => {
    const prompt = "Short title only.";
    expect(sessionTitlePromptUsesIdealLength(prompt)).toBe(false);
    expect(resolveSessionTitleSystemPrompt({ customPrompt: true, prompt, idealLength: 10 })).toBe(
      prompt,
    );
  });
});

describe("session title lengths", () => {
  it("uses defaults when absent or out of range", () => {
    expect(resolveSessionTitleLengths()).toEqual({ idealLength: 25, maxLength: 80 });
    expect(resolveSessionTitleLengths({ idealLength: 7, maxLength: 201 })).toEqual({
      idealLength: 25,
      maxLength: 80,
    });
    expect(resolveSessionTitleLengths({ idealLength: 12.5, maxLength: 15 })).toEqual({
      idealLength: 25,
      maxLength: 80,
    });
  });

  it("clamps the ideal length to the truncation length", () => {
    expect(resolveSessionTitleLengths({ idealLength: 40, maxLength: 20 })).toEqual({
      idealLength: 20,
      maxLength: 20,
    });
    expect(resolveSessionTitleLengths({ idealLength: 12, maxLength: 120 })).toEqual({
      idealLength: 12,
      maxLength: 120,
    });
  });

  it("validates storable values", () => {
    expect(isValidSessionTitleIdealLength(8)).toBe(true);
    expect(isValidSessionTitleIdealLength(60)).toBe(true);
    expect(isValidSessionTitleIdealLength(61)).toBe(false);
    expect(isValidSessionTitleIdealLength("25")).toBe(false);
    expect(isValidSessionTitleMaxLength(16)).toBe(true);
    expect(isValidSessionTitleMaxLength(200)).toBe(true);
    expect(isValidSessionTitleMaxLength(15)).toBe(false);
  });
});
