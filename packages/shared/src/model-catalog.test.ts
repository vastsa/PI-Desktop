import { describe, expect, it } from "vitest";
import {
  bindingForCustomModel,
  bindingForCustomModelInfo,
  bindingFromModelInfo,
  bindingSupportsDocuments,
  effectiveContextWindow,
  effectiveMaxTokens,
  bindingSupportsImages,
  resolveBindingLimits,
  formatCompactTokenCount,
  formatTokenCount,
  modelMatchesFilter,
  normalizeApiStyle,
} from "./model-catalog.js";
import type { ModelInfo } from "./types.js";

function visionModel(): ModelInfo {
  return {
    modelId: "vision-model",
    providerId: "provider-1",
    displayName: "Vision Model",
    capabilities: ["text", "vision", "pdf"],
    source: "discovered",
    modalities: { input: ["text", "image", "pdf"], output: ["text"] },
  } as ModelInfo;
}

function textModel(): ModelInfo {
  return {
    modelId: "text-model",
    providerId: "provider-1",
    displayName: "Text Model",
    capabilities: ["text"],
    source: "discovered",
    modalities: { input: ["text"], output: ["text"] },
  } as ModelInfo;
}

describe("effective model context windows", () => {
  it("lets a published long-context window replace a catalog-marked seed", () => {
    expect(effectiveContextWindow(1_050_000, 128_000, "catalog")).toBe(1_050_000);
    expect(effectiveContextWindow(64_000, 128_000, "catalog")).toBe(64_000);
  });

  it("preserves a non-default per-model override", () => {
    expect(effectiveContextWindow(1_050_000, 256_000)).toBe(256_000);
    expect(effectiveContextWindow(1_050_000, undefined)).toBe(1_050_000);
  });
});

describe("effective model output caps", () => {
  it("preserves every unmarked stored cap, including the generic seed", () => {
    expect(effectiveMaxTokens(131_072, 8_192)).toBe(8_192);
    expect(effectiveMaxTokens(64_000, 8_192)).toBe(8_192);
    expect(effectiveMaxTokens(131_072, 32_000)).toBe(32_000);
    expect(effectiveMaxTokens(131_072, undefined)).toBe(131_072);
  });

  it("preserves a non-default cap, a user's number and a catalog snapshot", () => {
    expect(effectiveMaxTokens(131_072, 32_000)).toBe(32_000);
    expect(effectiveMaxTokens(131_072, 8_192, "user")).toBe(8_192);
    expect(effectiveMaxTokens(131_072, 8_192, "catalog")).toBe(131_072);
    expect(effectiveMaxTokens(undefined, undefined)).toBeUndefined();
  });
});

describe("binding context-window provenance", () => {
  it("marks the catalog snapshot a fresh binding is seeded with", () => {
    const binding = bindingFromModelInfo({
      ...textModel(),
      limit: { context: 1_048_576, output: 64_000 },
    });
    expect(binding.contextWindow).toBe(1_048_576);
    expect(binding.contextWindowSource).toBe("catalog");
    expect(binding.maxTokensSource).toBe("catalog");
  });

  it("follows a catalog correction for a catalog-sourced window", () => {
    // The bug this guards: a binding saved before models.dev corrected the
    // model kept the old snapshot forever, so the only fix was deleting and
    // re-adding the model.
    expect(effectiveContextWindow(1_050_000, 1_048_576, "catalog")).toBe(1_050_000);
    expect(effectiveContextWindow(1_050_000, 64_000, "catalog")).toBe(1_050_000);
  });

  it("keeps a hand-edited window even when it equals the generic seed", () => {
    // 128k is a real user answer, not the "inherit the catalog" sentinel, once
    // the binding records where the value came from.
    expect(effectiveContextWindow(1_050_000, 128_000, "user")).toBe(128_000);
    expect(effectiveContextWindow(1_050_000, 256_000, "user")).toBe(256_000);
    // An unpublished model leaves the stored value as the only answer.
    expect(effectiveContextWindow(undefined, 256_000, "user")).toBe(256_000);
    expect(effectiveContextWindow(undefined, 128_000, "catalog")).toBe(128_000);
  });

  it("preserves legacy stored windows when provenance is absent", () => {
    // An old 128k value cannot reveal whether it was a generic seed or the
    // user's explicit choice, so an upgrade must not replace it speculatively.
    expect(effectiveContextWindow(1_050_000, 128_000, undefined)).toBe(128_000);
    expect(effectiveContextWindow(1_050_000, 1_048_576, undefined)).toBe(1_048_576);
    expect(effectiveContextWindow(1_050_000, 256_000, null)).toBe(256_000);
    expect(effectiveContextWindow(undefined, 128_000, undefined)).toBe(128_000);
  });

  it("keeps the provenance marker across a JSON round trip", () => {
    const stored = JSON.parse(JSON.stringify(bindingFromModelInfo(textModel())));
    expect(stored.contextWindowSource).toBe("catalog");
    // An edit path stamps the user as the author.
    const edited = { ...stored, contextWindow: 256_000, contextWindowSource: "user" };
    expect(effectiveContextWindow(1_050_000, edited.contextWindow, edited.contextWindowSource)).toBe(
      256_000,
    );
  });

  it("keeps a catalog snapshot when the lookup falls back to the generic shape", () => {
    // The bug this guards: a gateway row whose catalog lookup started missing
    // (for example an id several publishers list) resolved to the generic
    // 128k shape, which then replaced the saved 1M catalog snapshot and made
    // automatic compaction start at ~86k tokens.
    const binding = { contextWindow: 1_000_000, contextWindowSource: "catalog" as const };
    const generic = { source: "generic", contextWindow: 128_000 };
    const resolved = resolveBindingLimits(generic, binding);
    expect(resolved.catalogConfig.contextWindow).toBe(1_000_000);
    expect(resolved.binding.contextWindow).toBe(1_000_000);
    expect(resolved.binding.contextWindowSource).toBe("catalog");
  });

  it("still follows a published record for a catalog-sourced window", () => {
    const binding = { contextWindow: 1_000_000, contextWindowSource: "catalog" as const };
    const published = { source: "models.dev", contextWindow: 1_048_576 };
    const resolved = resolveBindingLimits(published, binding);
    expect(resolved.catalogConfig.contextWindow).toBe(1_048_576);
    expect(resolved.binding.contextWindow).toBe(1_048_576);
  });

  it("resolves the output cap a row was seeded with before its record existed", () => {
    // The row was added with the generic 8.2k cap while nothing published the
    // id. Once models.dev describes it, the published cap takes over, so the
    // saved row stops reporting an 8.2k output for a 131k model.
    const binding = {
      contextWindow: 128_000,
      maxTokens: 8_192,
      contextWindowSource: "catalog" as const,
      maxTokensSource: "catalog" as const,
    };
    const published = { source: "models.dev", contextWindow: 1_048_576, maxTokens: 131_072 };
    const resolved = resolveBindingLimits(published, binding);
    expect(resolved.binding.contextWindow).toBe(1_048_576);
    expect(resolved.binding.maxTokens).toBe(131_072);
    expect(resolved.catalogConfig.maxTokens).toBe(131_072);
  });

  it("preserves both limits on an unmarked legacy binding", () => {
    const published = { source: "models.dev", contextWindow: 1_048_576, maxTokens: 131_072 };
    const legacy = resolveBindingLimits(published, {
      contextWindow: 128_000,
      maxTokens: 8_192,
    });
    expect(legacy.binding.contextWindow).toBe(128_000);
    expect(legacy.binding.contextWindowSource).toBe("user");
    expect(legacy.binding.maxTokens).toBe(8_192);
    expect(legacy.binding.maxTokensSource).toBe("user");
  });

  it("keeps output ownership independent when only the context window follows the catalog", () => {
    const published = { source: "models.dev", contextWindow: 1_048_576, maxTokens: 131_072 };
    const legacyOutput = resolveBindingLimits(published, {
      contextWindow: 128_000,
      contextWindowSource: "catalog" as const,
      maxTokens: 8_192,
    });
    expect(legacyOutput.binding.contextWindow).toBe(1_048_576);
    expect(legacyOutput.binding.contextWindowSource).toBe("catalog");
    expect(legacyOutput.binding.maxTokens).toBe(8_192);
    expect(legacyOutput.binding.maxTokensSource).toBe("user");
  });

  it("keeps the output cap independently when the context window follows the catalog", () => {
    const published = { source: "models.dev", contextWindow: 1_048_576, maxTokens: 131_072 };
    const explicit = resolveBindingLimits(published, {
      contextWindow: 128_000,
      contextWindowSource: "catalog" as const,
      maxTokens: 8_192,
      maxTokensSource: "user" as const,
    });
    expect(explicit.binding.contextWindow).toBe(1_048_576);
    expect(explicit.binding.maxTokens).toBe(8_192);
    expect(explicit.binding.maxTokensSource).toBe("user");

    // Legacy rows have no output-cap marker. A non-generic stored value was
    // authoritative before provenance existed and must remain so.
    const legacy = resolveBindingLimits(published, {
      contextWindow: 1_048_576,
      contextWindowSource: "catalog" as const,
      maxTokens: 4_096,
    });
    expect(legacy.binding.maxTokens).toBe(4_096);
  });
});

describe("provider API style compatibility", () => {
  it("falls back to Chat Completions for missing or unknown persisted styles", () => {
    expect(normalizeApiStyle(undefined)).toBe("chat_completions");
    expect(normalizeApiStyle("auto")).toBe("chat_completions");
    expect(normalizeApiStyle("legacy_style")).toBe("chat_completions");
  });

  it("preserves every current API style", () => {
    expect(normalizeApiStyle("responses")).toBe("responses");
    expect(normalizeApiStyle("anthropic_messages")).toBe("anthropic_messages");
    expect(normalizeApiStyle("opencode_go")).toBe("opencode_go");
  });
});

describe("published attachment capabilities", () => {
  it("reads image and pdf input from the published modalities", () => {
    expect(modelMatchesFilter(visionModel(), "vision")).toBe(true);
    expect(modelMatchesFilter(visionModel(), "pdf")).toBe(true);
    expect(modelMatchesFilter(textModel(), "vision")).toBe(false);
    expect(modelMatchesFilter(textModel(), "pdf")).toBe(false);
  });
});

describe("effective binding attachment capabilities", () => {
  it("follows the published capability while no override is stored", () => {
    const binding = bindingFromModelInfo(visionModel());
    expect(binding.supportsImages).toBeNull();
    expect(bindingSupportsImages(binding, visionModel())).toBe(true);
    expect(bindingSupportsDocuments(binding, visionModel())).toBe(true);
  });

  it("lets an explicit override win in both directions", () => {
    expect(bindingSupportsImages({ supportsImages: false }, visionModel())).toBe(false);
    expect(bindingSupportsImages({ supportsImages: true }, textModel())).toBe(true);
    expect(bindingSupportsDocuments({ supportsDocuments: true }, textModel())).toBe(true);
    expect(bindingSupportsDocuments({ supportsDocuments: false }, visionModel())).toBe(
      false,
    );
  });

  it("keeps a capability the user explicitly selected when the catalog changes", () => {
    const selected = { supportsImages: true };
    // This was the published value when the user selected it; a later catalog
    // correction must not reinterpret that explicit choice as "follow".
    expect(bindingSupportsImages(selected, visionModel())).toBe(true);
    expect(bindingSupportsImages(selected, textModel())).toBe(true);
  });

  it("treats an unknown model as unsupported unless the user answered", () => {
    // A hand-typed model ID has no published record, so nothing can be inferred.
    const custom = bindingForCustomModel("my-local-model");
    expect(custom.supportsImages).toBeNull();
    expect(bindingSupportsImages(custom, null)).toBe(false);
    expect(bindingSupportsImages({ supportsImages: true }, null)).toBe(true);
  });

describe("a hand-typed id the catalog publishes", () => {
  it("adopts the published limits and thinking levels", () => {
    // The user typed a custom id; models.dev knows it, so the row is seeded
    // like a picked model instead of the generic 128k / 8k seed.
    const published: ModelInfo = {
      ...textModel(),
      reasoning: true,
      supportedThinkingLevels: ["low", "high"],
      limit: { context: 1_048_576, output: 64_000 },
    };
    const binding = bindingForCustomModelInfo("My-Proxy/Model", published);
    expect(binding.contextWindow).toBe(1_048_576);
    expect(binding.contextWindowSource).toBe("catalog");
    expect(binding.maxTokens).toBe(64_000);
    expect(binding.thinkingLevels).toEqual(["low", "high"]);
  });

  it("keeps the id the user typed, not the catalog spelling", () => {
    const binding = bindingForCustomModelInfo("My-Proxy/Model", textModel());
    expect(binding.id).toBe("My-Proxy/Model");
    expect(bindingForCustomModelInfo("  spaced-id  ", textModel()).id).toBe("spaced-id");
  });
});
});

describe("compact token counts", () => {
  it("keeps neighbouring published windows distinguishable", () => {
    // models.dev publishes all three of these along the 1M line. One rounded
    // decimal collapsed them into `1M` / `1.1M` / `1.1M`.
    const rendered = [
      formatTokenCount(1_000_000),
      formatTokenCount(1_050_000),
      formatTokenCount(1_100_000),
    ];
    expect(rendered).toEqual(["1M", "1.05M", "1.1M"]);
    expect(new Set(rendered).size).toBe(3);
  });

  it("never reports a window above the published value's own precision", () => {
    // `1.1M` overstated 1,050,000 by 50k tokens, which is what made unrelated
    // models look like they shared one limit.
    expect(formatTokenCount(1_050_000)).not.toBe("1.1M");
    expect(formatTokenCount(1_048_576)).toBe("1.05M");
    expect(formatTokenCount(1_064_000)).toBe("1.06M");
    expect(formatTokenCount(1_131_072)).toBe("1.13M");
  });

  it("keeps the K and M scales exact at their boundaries", () => {
    expect(formatTokenCount(999)).toBe("999");
    expect(formatTokenCount(1_000)).toBe("1K");
    expect(formatTokenCount(1_500)).toBe("1.5K");
    expect(formatTokenCount(200_000)).toBe("200K");
    expect(formatTokenCount(262_144)).toBe("262.1K");
    expect(formatTokenCount(10_000_000)).toBe("10M");
  });

  it("promotes a K mantissa instead of rendering `1000K`", () => {
    expect(formatTokenCount(999_949)).toBe("999.9K");
    expect(formatTokenCount(999_999)).toBe("1M");
    expect(formatTokenCount(1_000_000)).toBe("1M");
  });

  it("reads an unpublished limit as absent, but a real count as a number", () => {
    expect(formatTokenCount(undefined)).toBe("—");
    expect(formatTokenCount(0)).toBe("—");
    // Usage counters report a real zero, so they must not borrow the dash.
    expect(formatCompactTokenCount(0)).toBe("0");
    expect(formatCompactTokenCount(12)).toBe("12");
    expect(formatCompactTokenCount(1_500)).toBe("1.5K");
  });
});
