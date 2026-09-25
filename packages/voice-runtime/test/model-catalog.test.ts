import { describe, it, expect } from "vitest";
import { getCatalog, findModel, getRecommendedModel } from "../src/model-catalog.js";

describe("getCatalog", () => {
  it("returns a non-empty array", () => {
    const catalog = getCatalog();
    expect(catalog.length).toBeGreaterThan(0);
  });

  it("each model has required fields", () => {
    for (const model of getCatalog()) {
      expect(model.id).toBeTruthy();
      expect(model.name).toBeTruthy();
      expect(model.languages.length).toBeGreaterThan(0);
      expect(model.sizeBytes).toBeGreaterThan(0);
      expect(model.hfRepo).toBeTruthy();
      expect(model.hfFilename).toBeTruthy();
    }
  });
});

describe("findModel", () => {
  it("finds a known model", () => {
    const model = findModel("whisper-large-v3-turbo");
    expect(model).toBeDefined();
    expect(model!.name).toContain("Whisper");
  });

  it("returns undefined for unknown model", () => {
    expect(findModel("nonexistent")).toBeUndefined();
  });
});

describe("getRecommendedModel", () => {
  it("returns a model for common languages", () => {
    const model = getRecommendedModel(["zh", "en"]);
    expect(model).toBeDefined();
    expect(model.recommended).toBe(true);
  });

  it("always returns a model even for exotic languages", () => {
    const model = getRecommendedModel(["xx"]);
    expect(model).toBeDefined();
  });
});
