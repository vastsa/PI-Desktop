import { describe, expect, it } from "vitest";
import { fastModeBillingOn, fastModeSupportedOn } from "./fast-mode.js";

describe("fast mode wire rule", () => {
  it("prices the Codex backend on plan limits and Responses per token", () => {
    expect(fastModeBillingOn("openai_codex_responses")).toBe("subscription");
    expect(fastModeBillingOn("openai-codex-responses")).toBe("subscription");
    expect(fastModeBillingOn("responses")).toBe("usage");
    expect(fastModeBillingOn(" Responses ")).toBe("usage");
    expect(fastModeBillingOn("openai-responses")).toBe("usage");
  });

  it("rejects wires that do not carry service_tier", () => {
    for (const api of ["chat_completions", "openai-completions", "anthropic_messages",
      "azure-openai-responses", "opencode_go", "", undefined, null]) {
      expect(fastModeSupportedOn(api)).toBe(false);
    }
  });
});
