import { describe, expect, it, vi } from "vitest";
import { normalizeContext } from "@earendil-works/pi-ai";
import { completeOneShot } from "./one-shot-complete.js";
import { subagentModelBinding } from "./subagent-model-binding.js";
import type { RuntimeProviderConfig } from "./provider-binding.js";

/**
 * The Google adapter refuses any `fetch` that is not `globalThis.fetch`
 * (issue #1072). Every request path must therefore reach it without one, while
 * the request still carries the provider's own headers.
 */
const googleProvider: RuntimeProviderConfig = {
  id: "google",
  name: "Google Gemini",
  vendorKey: "google",
  apiStyle: "google_generative_ai",
  baseUrl: "https://generativelanguage.googleapis.com/v1beta",
  modelId: "gemini-3.8-flash",
  apiKey: "AIza-test",
  authKind: "api_key",
  supportsReasoning: true,
  supportedThinkingLevels: ["off", "high"],
  headers: { "X-Team": "platform" },
};

type Captured = { url: string; headers: Record<string, string> };

function googleStreamResponse(): Response {
  const chunk = (body: unknown) => `data: ${JSON.stringify(body)}\n\n`;
  return new Response(
    chunk({ candidates: [{ content: { role: "model", parts: [{ text: "hello" }] }, index: 0 }] }) +
      chunk({
        candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP", index: 0 }],
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1, totalTokenCount: 4 },
      }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

async function withStubbedGoogle<T>(
  run: (captured: Captured[]) => Promise<T>,
): Promise<T> {
  const captured: Captured[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    captured.push({ url: input instanceof Request ? input.url : String(input), headers });
    return googleStreamResponse();
  });
  try {
    return await run(captured);
  } finally {
    vi.unstubAllGlobals();
  }
}

describe("Google Generative AI requests", () => {
  it("completes a one-shot completion through the native endpoint", async () => {
    const result = await withStubbedGoogle(async (captured) => {
      const oneShot = await completeOneShot(
        googleProvider,
        { systemPrompt: "s", messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
        "off",
      );
      return { oneShot, captured };
    });

    expect(result.oneShot.text).toBe("hello");
    expect(result.captured).toHaveLength(1);
    expect(result.captured[0].url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse",
    );
    expect(result.captured[0].headers["x-team"]).toBe("platform");
  });

  it("streams a subagent turn through the native endpoint", async () => {
    const binding = subagentModelBinding(
      { provider: googleProvider, thinkingLevel: "off", sessionId: "session-1" },
      { claim: () => undefined },
    );

    const text = await withStubbedGoogle(async (captured) => {
      const result = await binding
        .streamFn(
          binding.model,
          normalizeContext({
            messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
          }),
          {},
        )
        .result();
      expect(captured).toHaveLength(1);
      return result.content;
    });

    expect(text).toEqual([{ type: "text", text: "hello" }]);
  });
});
