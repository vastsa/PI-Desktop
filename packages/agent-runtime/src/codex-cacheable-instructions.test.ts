import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  codexCacheableInstructions,
  withCodexCacheableInstructions,
} from "./codex-cacheable-instructions.js";

const codexModel = (id: string, provider = "openai-codex") =>
  ({ id, provider, api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api" }) as Model<any>;

const codexBody = () => ({
  model: "gpt-6.2-sol",
  store: false,
  stream: true,
  instructions: "You are PI, a careful desktop agent.",
  input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
  prompt_cache_key: "session-1",
});

describe("codexCacheableInstructions (#2419)", () => {
  it("moves a gpt-6.2 codex system prompt into input as a leading developer message", () => {
    const rewritten = codexCacheableInstructions(codexBody(), codexModel("gpt-6.2-sol")) as Record<string, unknown>;

    expect(rewritten).toBeDefined();
    expect(rewritten.instructions).toBeUndefined();
    const input = rewritten.input as Array<Record<string, unknown>>;
    expect(input).toHaveLength(2);
    expect(input[0]).toEqual({
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: "You are PI, a careful desktop agent." }],
    });
    expect(input[1]).toEqual(codexBody().input[0]);
    // Everything else the adapter built stays untouched.
    expect(rewritten.prompt_cache_key).toBe("session-1");
    expect(rewritten.model).toBe("gpt-6.2-sol");
  });

  it("leaves gpt-6.1 and earlier codex models on the instructions field", () => {
    expect(codexCacheableInstructions(codexBody(), codexModel("gpt-6.1-sol"))).toBeUndefined();
    expect(codexCacheableInstructions(codexBody(), codexModel("gpt-6-astra"))).toBeUndefined();
    expect(codexCacheableInstructions(codexBody(), codexModel("gpt-5.6-luna"))).toBeUndefined();
  });

  it("leaves non-codex providers alone even on a gpt-6.2 id", () => {
    expect(codexCacheableInstructions(codexBody(), codexModel("gpt-6.2-sol", "openai-responses"))).toBeUndefined();
  });

  it("is a no-op once the prompt already lives in input", () => {
    const first = codexCacheableInstructions(codexBody(), codexModel("gpt-6.2-sol")) as Record<string, unknown>;
    expect(codexCacheableInstructions(first, codexModel("gpt-6.2-sol"))).toBeUndefined();
  });

  it("does nothing when the adapter sent no system prompt", () => {
    const body = codexBody();
    delete (body as Record<string, unknown>).instructions;
    expect(codexCacheableInstructions(body, codexModel("gpt-6.2-sol"))).toBeUndefined();
  });
});

describe("withCodexCacheableInstructions", () => {
  it("rewrites the payload for a gpt-6.2 codex model and runs the caller hook", async () => {
    const callerOrder: string[] = [];
    const options = {
      onPayload: async (payload: unknown) => {
        callerOrder.push("caller");
        return (payload as Record<string, unknown>).marked === true ? payload : undefined;
      },
    };
    const wrapped = withCodexCacheableInstructions(options as never, codexModel("gpt-6.2-sol"));
    const body = { ...codexBody(), marked: true };
    const result = (await wrapped.onPayload?.(body, codexModel("gpt-6.2-sol"))) as Record<string, unknown>;
    expect(callerOrder).toEqual(["caller"]);
    expect(result.instructions).toBeUndefined();
    expect((result.input as Array<unknown>)[0]).toMatchObject({ role: "developer" });
  });

  it("returns the original options untouched for other models", () => {
    const options = {};
    expect(withCodexCacheableInstructions(options as never, codexModel("gpt-6.1-sol"))).toBe(options);
    expect(withCodexCacheableInstructions(options as never, codexModel("gpt-6.2-sol", "openai-responses"))).toBe(options);
  });

  it("still rewrites when the caller hook declines", async () => {
    const wrapped = withCodexCacheableInstructions({} as never, codexModel("gpt-6.2-sol"));
    const result = (await wrapped.onPayload?.(codexBody(), codexModel("gpt-6.2-sol"))) as Record<string, unknown>;
    expect(result.instructions).toBeUndefined();
  });
});
