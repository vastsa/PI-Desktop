import { describe, expect, it } from "vitest";
import {
  bindingForCustomModel,
  bindingFromModelInfo,
  bindingSupportsDocuments,
  effectiveContextWindow,
  bindingSupportsImages,
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
  it("lets a published long-context window replace the legacy generic seed", () => {
    expect(effectiveContextWindow(1_050_000, 128_000)).toBe(1_050_000);
    expect(effectiveContextWindow(64_000, 128_000)).toBe(64_000);
  });

  it("preserves a non-default per-model override", () => {
    expect(effectiveContextWindow(1_050_000, 256_000)).toBe(256_000);
    expect(effectiveContextWindow(1_050_000, undefined)).toBe(1_050_000);
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

  it("treats an unknown model as unsupported unless the user answered", () => {
    // A hand-typed model ID has no published record, so nothing can be inferred.
    const custom = bindingForCustomModel("my-local-model");
    expect(custom.supportsImages).toBeNull();
    expect(bindingSupportsImages(custom, null)).toBe(false);
    expect(bindingSupportsImages({ supportsImages: true }, null)).toBe(true);
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
