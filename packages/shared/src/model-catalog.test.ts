import { describe, expect, it } from "vitest";
import {
  bindingForCustomModel,
  bindingFromModelInfo,
  bindingSupportsDocuments,
  bindingSupportsImages,
  modelMatchesFilter,
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
