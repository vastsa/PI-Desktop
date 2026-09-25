import { describe, expect, it } from "vitest";
import {
  ENDPOINT_EVIDENCE_CONFIDENCE,
  MAX_DISCOVERY_CANDIDATES,
  buildDiscoveryCandidates,
  canonicalEndpointUrl,
  discoveryProbeUrl,
  discoveryStyleForApiStyle,
  inferEndpointProfile,
  matchEndpointOperation,
  parseEndpointInput,
} from "./provider-endpoint.js";

const operationInputs: ReadonlyArray<[string, string]> = [
  ["api.foo.com", "https://api.foo.com"],
  ["https://api.foo.com", "https://api.foo.com"],
  ["https://api.foo.com/", "https://api.foo.com"],
  ["https://api.foo.com/v1", "https://api.foo.com/v1"],
  ["https://api.foo.com/v1/models", "https://api.foo.com/v1"],
  ["https://api.foo.com/v1/chat/completions", "https://api.foo.com/v1"],
  ["https://api.foo.com/v1/responses", "https://api.foo.com/v1"],
  ["https://api.foo.com/v1/messages", "https://api.foo.com/v1"],
];

describe("endpoint input parsing", () => {
  it("completes a bare host with https instead of guessing another origin", () => {
    const parsed = parseEndpointInput("api.foo.com");
    expect(parsed?.normalizedInput).toBe("https://api.foo.com");
    expect(parsed?.origin).toBe("https://api.foo.com");
    expect(parsed?.pathname).toBe("");
  });

  it("accepts a base URL, an operation URL and a discovery URL", () => {
    for (const [input, baseUrl] of operationInputs) {
      // No style is selected yet, so a pasted operation is the user saying
      // which route they copied: it is resolved and stripped in one step.
      const profile = inferEndpointProfile({ baseUrl: input });
      expect(profile?.effectiveBaseUrl, input).toBe(baseUrl);
    }
  });

  it("never accepts a URL that could carry a secret of its own", () => {
    for (const value of [
      "",
      "   ",
      "not a url",
      "file:///v1/messages",
      "https://user:secret@api.foo.com/v1",
      "https://api.foo.com/v1?key=secret",
      "https://api.foo.com/v1#fragment",
    ]) {
      expect(parseEndpointInput(value), value).toBeUndefined();
      expect(inferEndpointProfile({ baseUrl: value }), value).toBeUndefined();
    }
  });
});

describe("operation suffixes", () => {
  it("names the wire style a pasted operation implies", () => {
    expect(matchEndpointOperation("/v1/chat/completions")).toMatchObject({
      suffix: "/chat/completions",
      apiStyle: "chat_completions",
      basePath: "/v1",
    });
    expect(matchEndpointOperation("/v1/responses")).toMatchObject({ apiStyle: "responses", basePath: "/v1" });
    expect(matchEndpointOperation("/v1/messages")).toMatchObject({
      apiStyle: "anthropic_messages",
      basePath: "/v1",
    });
    // A discovery URL names no wire style by itself.
    expect(matchEndpointOperation("/v1/models")).toMatchObject({ suffix: "/models", basePath: "/v1" });
    expect(matchEndpointOperation("/v1/models")?.apiStyle).toBeUndefined();
    expect(matchEndpointOperation("/v1/completions")).toBeUndefined();
  });

  it("keeps an operation that contradicts the selected format until the user resolves it", () => {
    const mismatched = inferEndpointProfile({
      baseUrl: "https://api.foo.com/v1/responses",
      apiStyle: "chat_completions",
      explicitApiStyle: true,
    });
    expect(mismatched?.effectiveBaseUrl).toBe("https://api.foo.com/v1/responses");
    expect(mismatched?.apiStyle).toBe("chat_completions");

    // The same operation matches the OpenCode Go / Codex families, which
    // address Chat Completions and Responses respectively.
    for (const apiStyle of ["opencode_go", "chat_completions"] as const) {
      expect(
        inferEndpointProfile({
          baseUrl: "https://api.foo.com/v1/chat/completions",
          apiStyle,
          explicitApiStyle: true,
        })?.effectiveBaseUrl,
        apiStyle,
      ).toBe("https://api.foo.com/v1");
    }
    expect(
      inferEndpointProfile({
        baseUrl: "https://api.foo.com/v1/responses",
        apiStyle: "openai_codex_responses",
        explicitApiStyle: true,
      })?.effectiveBaseUrl,
    ).toBe("https://api.foo.com/v1");
  });
});

describe("api style inference order", () => {
  it("never lets a known host or published metadata override the user's own choice", () => {
    const profile = inferEndpointProfile({
      baseUrl: "https://api.anthropic.com",
      apiStyle: "chat_completions",
      explicitApiStyle: true,
      providerKey: "anthropic",
      providerApiStyle: "anthropic_messages",
    });
    expect(profile?.apiStyle).toBe("chat_completions");
    expect(profile?.evidence.at(-1)).toMatchObject({
      type: "explicit",
      confidence: ENDPOINT_EVIDENCE_CONFIDENCE.explicit,
    });
  });

  it("lets a pasted operation outrank a known host and published metadata", () => {
    const profile = inferEndpointProfile({
      baseUrl: "https://api.deepseek.com/v1/messages",
      apiStyle: "chat_completions",
      providerApiStyle: "responses",
    });
    expect(profile?.apiStyle).toBe("anthropic_messages");
    expect(profile?.effectiveBaseUrl).toBe("https://api.deepseek.com/v1");
  });

  it("resolves an unknown host from the pasted operation, then from published metadata", () => {
    expect(inferEndpointProfile({ baseUrl: "https://api.foo.com/v1/responses" })?.apiStyle).toBe("responses");
    expect(
      inferEndpointProfile({ baseUrl: "https://api.foo.com", providerApiStyle: "responses" })?.apiStyle,
    ).toBe("responses");
  });

  it("never reads a model id: only the endpoint decides the protocol", () => {
    const gateway = inferEndpointProfile({ baseUrl: "https://gateway.example/v1" });
    expect(gateway?.apiStyle).toBe("chat_completions");
    expect(gateway?.evidence.some((entry) => entry.type === "catalog_model")).toBe(false);
    // The rank exists so a metadata hint can never outrank an endpoint fact.
    expect(ENDPOINT_EVIDENCE_CONFIDENCE.catalog_model).toBeLessThan(
      ENDPOINT_EVIDENCE_CONFIDENCE.discovery,
    );
  });

  it("falls back to Chat Completions and says so", () => {
    const profile = inferEndpointProfile({ baseUrl: "api.foo.com" });
    expect(profile?.apiStyle).toBe("chat_completions");
    expect(profile?.discoveryStyle).toBe("openai_models");
    expect(profile?.evidence[0]).toMatchObject({ type: "fallback", confidence: 0 });
  });

  it("maps wire styles onto the discovery style the transport actually uses", () => {
    expect(discoveryStyleForApiStyle("anthropic_messages")).toBe("anthropic_models");
    expect(discoveryStyleForApiStyle("google_generative_ai")).toBe("google_models");
    expect(discoveryStyleForApiStyle("pi_messages")).toBe("openai_models");
    expect(discoveryStyleForApiStyle("opencode_go")).toBe("openai_models");
    expect(discoveryStyleForApiStyle("openai_codex_responses")).toBe("openai_models");
    expect(discoveryStyleForApiStyle("chat_completions")).toBe("openai_models");
  });
});

describe("discovery candidates", () => {
  it("tries the typed path and then /v1 for an unknown OpenAI-compatible endpoint", () => {
    const profile = inferEndpointProfile({ baseUrl: "https://api.foo.com" });
    expect(profile?.candidates.map((candidate) => candidate.baseUrl)).toEqual([
      "https://api.foo.com",
      "https://api.foo.com/v1",
    ]);
    expect(profile?.candidates.every((candidate) => candidate.discoveryStyle === "openai_models")).toBe(true);
  });

  it("does not extend a base that already addresses /v1 or an operation", () => {
    expect(
      inferEndpointProfile({ baseUrl: "https://api.foo.com/v1" })?.candidates.map((c) => c.baseUrl),
    ).toEqual(["https://api.foo.com/v1"]);
    expect(
      buildDiscoveryCandidates(
        inferEndpointProfile({
          baseUrl: "https://api.foo.com/v1/responses",
          apiStyle: "chat_completions",
          explicitApiStyle: true,
        })!,
      ).map((c) => c.baseUrl),
    ).toEqual(["https://api.foo.com/v1/responses"]);
  });

  it("never guesses a provider-specific path for an unknown host", () => {
    const candidates = inferEndpointProfile({ baseUrl: "https://relay.example" })?.candidates ?? [];
    const urls = candidates.map((candidate) => candidate.baseUrl);
    expect(urls.length).toBe(2);
    for (const forbidden of ["/v1beta", "/compatible-mode/v1", "/zen/go/v1", "/api/paas/v4"]) {
      expect(urls.some((url) => url.includes(forbidden)), forbidden).toBe(false);
    }
  });

  it("keeps every candidate on the origin the user typed", () => {
    for (const baseUrl of [
      "https://api.foo.com",
      "https://api.anthropic.com",
      "https://open.bigmodel.cn",
      "https://generativelanguage.googleapis.com",
      "https://api.z.ai/api/paas/v4",
      "http://192.168.1.9:11434/v1",
    ]) {
      const profile = inferEndpointProfile({ baseUrl, apiStyle: "chat_completions", explicitApiStyle: true });
      expect(profile, baseUrl).toBeDefined();
      for (const candidate of profile!.candidates) {
        expect(new URL(candidate.baseUrl).origin, `${baseUrl} -> ${candidate.baseUrl}`).toBe(profile!.origin);
      }
    }
  });

  it("offers a registry endpoint's own style even when the row speaks another one", () => {
    const profile = inferEndpointProfile({
      baseUrl: "https://api.anthropic.com",
      apiStyle: "chat_completions",
      explicitApiStyle: true,
    });
    expect(profile?.discoveryStyle).toBe("openai_models");
    expect(profile?.candidates.map((candidate) => discoveryProbeUrl(candidate.baseUrl, candidate.discoveryStyle)))
      .toEqual(["https://api.anthropic.com/models", "https://api.anthropic.com/v1/models"]);
  });

  it("uses the registry path and style for a known host typed without its path", () => {
    const profile = inferEndpointProfile({ baseUrl: "https://api.z.ai" });
    expect(profile?.apiStyle).toBe("chat_completions");
    expect(profile?.candidates.map((c) => c.baseUrl)).toContain("https://api.z.ai/api/paas/v4");
    const google = inferEndpointProfile({ baseUrl: "https://generativelanguage.googleapis.com" });
    expect(google?.candidates).toContainEqual(
      expect.objectContaining({ baseUrl: "https://generativelanguage.googleapis.com/v1beta", discoveryStyle: "google_models" }),
    );
  });

  it("never swaps a path the user typed for a registry sibling", () => {
    /*
      Zhipu serves three API styles on three paths of one host. A typed
      `/api/v1` that publishes nothing must not be silently replaced by the
      `/api/paas/v4` sibling: that moves the row to another service while
      keeping its format.
    */
    const typed = inferEndpointProfile({
      baseUrl: "https://open.bigmodel.cn/api/v1",
      apiStyle: "responses",
      explicitApiStyle: true,
    });
    expect(typed?.candidates.map((candidate) => candidate.baseUrl)).toEqual([
      "https://open.bigmodel.cn/api/v1",
    ]);
    expect(
      inferEndpointProfile({ baseUrl: "https://api.z.ai/api/paas/v4" })?.candidates.map(
        (candidate) => candidate.baseUrl,
      ),
    ).toEqual(["https://api.z.ai/api/paas/v4"]);
    // Naming the host alone still gets the registry's own paths.
    expect(
      inferEndpointProfile({ baseUrl: "https://open.bigmodel.cn" })?.candidates.map(
        (candidate) => candidate.baseUrl,
      ),
    ).toContain("https://open.bigmodel.cn/api/paas/v4");
  });

  it("dedupes candidates that would address the same URL", () => {
    const profile = inferEndpointProfile({
      baseUrl: "https://api.anthropic.com",
      apiStyle: "anthropic_messages",
      explicitApiStyle: true,
    });
    const probeUrls = profile!.candidates.map((candidate) =>
      discoveryProbeUrl(candidate.baseUrl, candidate.discoveryStyle),
    );
    expect(new Set(probeUrls).size).toBe(probeUrls.length);
  });

  it("bounds the candidate list", () => {
    for (const baseUrl of ["https://open.bigmodel.cn", "https://api.z.ai", "https://api.foo.com"]) {
      expect(
        inferEndpointProfile({ baseUrl })!.candidates.length,
        baseUrl,
      ).toBeLessThanOrEqual(MAX_DISCOVERY_CANDIDATES);
    }
  });
});

describe("discovery probe urls", () => {
  it("addresses the model list the transport adapter uses", () => {
    expect(discoveryProbeUrl("https://api.foo.com", "openai_models")).toBe("https://api.foo.com/models");
    expect(discoveryProbeUrl("https://api.anthropic.com", "anthropic_models")).toBe(
      "https://api.anthropic.com/v1/models",
    );
    expect(discoveryProbeUrl("https://api.anthropic.com/v1", "anthropic_models")).toBe(
      "https://api.anthropic.com/v1/models",
    );
    expect(discoveryProbeUrl("https://generativelanguage.googleapis.com/v1beta", "google_models")).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models",
    );
  });
});

describe("endpoint presets stay the registry's source of truth", () => {
  it("matches a published endpoint exactly", () => {
    expect(canonicalEndpointUrl("https://api.openai.com/v1/")).toBe("https://api.openai.com/v1");
    const profile = inferEndpointProfile({ baseUrl: "https://api.openai.com/v1" });
    expect(profile?.evidence.some((entry) => entry.type === "known_endpoint")).toBe(true);
  });

  it("resolves every named preset endpoint to its own style", () => {
    const expected: ReadonlyArray<[string, string]> = [
      ["https://api.openai.com/v1", "responses"],
      ["https://api.anthropic.com", "anthropic_messages"],
      ["https://generativelanguage.googleapis.com/v1beta", "google_generative_ai"],
      ["https://openrouter.ai/api/v1", "chat_completions"],
      ["https://api.deepseek.com", "chat_completions"],
      ["https://dashscope.aliyuncs.com/compatible-mode/v1", "chat_completions"],
      ["https://opencode.ai/zen/go/v1", "opencode_go"],
      ["https://api.minimaxi.com/anthropic/v1", "anthropic_messages"],
    ];
    for (const [baseUrl, apiStyle] of expected) {
      const profile = inferEndpointProfile({ baseUrl });
      expect(profile?.apiStyle, baseUrl).toBe(apiStyle);
      expect(profile?.effectiveBaseUrl, baseUrl).toBe(baseUrl);
      expect(profile?.evidence.some((entry) => entry.type === "known_endpoint"), baseUrl).toBe(true);
    }
  });
});
