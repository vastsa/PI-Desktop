import { describe, expect, it } from "vitest";
import { createFauxCore, fauxAssistantMessage, normalizeContext, type TextContent } from "@earendil-works/pi-ai";
import { completeOneShot } from "./one-shot-complete.js";
import type { RuntimeProviderConfig } from "./provider-binding.js";

const provider: RuntimeProviderConfig = {
  id: "fixture", name: "Fixture", modelId: "fixture-model", apiStyle: "responses",
  baseUrl: "https://example.invalid/v1", apiKey: "", authKind: "none",
  supportsReasoning: false, supportedThinkingLevels: ["off"],
};
const commentary: TextContent = {
  type: "text", text: "I have the result.\n",
  textSignature: JSON.stringify({ v: 1, id: "msg_progress", phase: "commentary" }),
};

function completeWithText(...content: TextContent[]) {
  const faux = createFauxCore({ api: "openai-responses", provider: provider.id });
  faux.setResponses([fauxAssistantMessage(content)]);
  return completeOneShot(provider, { messages: [{ role: "user", content: "What is 6 × 7?", timestamp: 1 }] }, "off", {
    stream: (model, context, options) => faux.streamSimple(model, normalizeContext(context), options),
  });
}

describe("completeOneShot Responses answers", () => {
  it("returns the final answer without its preceding commentary", async () => {
    const result = await completeWithText(commentary, {
      type: "text", text: "42",
      textSignature: JSON.stringify({ v: 1, id: "msg_answer", phase: "final_answer" }),
    });
    expect(result.text).toBe("42");
  });

  it("rejects commentary alone as an empty completion", async () => {
    await expect(completeWithText(commentary)).rejects.toMatchObject({
      errorCode: "EMPTY_COMPLETION", message: "The model returned no text.",
    });
  });
});
