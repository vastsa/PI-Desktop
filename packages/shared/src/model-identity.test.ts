import { describe, expect, it } from "vitest";
import { catalogModelIdsMatch, modelIdsMatch, stripReleaseSuffix } from "./types/models.js";

describe("release-stamp aliases", () => {
  it("drops a release date from a dated snapshot id", () => {
    expect(stripReleaseSuffix("mify/mimo-v2.5-pro-0731")).toBe("mify/mimo-v2.5-pro");
    expect(stripReleaseSuffix("foo-v2-20250731")).toBe("foo-v2");
    expect(stripReleaseSuffix("foo-v2-2025-07-31")).toBe("foo-v2");
    expect(stripReleaseSuffix("foo-v2-2025_07_31")).toBe("foo-v2");
    expect(stripReleaseSuffix("foo-v2-2025.07.31")).toBe("foo-v2");
    expect(stripReleaseSuffix("gpt-4o-2024-08-06")).toBe("gpt-4o");
    expect(stripReleaseSuffix("claude-3-5-sonnet-20241022")).toBe("claude-3-5-sonnet");
  });

  it("keeps a four-digit tail that is not a calendar month and day", () => {
    for (const value of ["foo-v2-1399", "foo-v2-9999", "foo-v2-0232", "foo-v2-0000", "qwen3-235b-a22b-2507"]) {
      expect(stripReleaseSuffix(value), value).toBe(value);
    }
  });

  it("leaves an id without a release stamp alone", () => {
    for (const value of ["llama-3.1-8b-instant", "gpt-4o", "deepseek-chat", "mify/mimo-v2.5-pro"]) {
      expect(stripReleaseSuffix(value), value).toBe(value);
    }
  });

  it("does not treat a dated snapshot leaf as the undated model leaf", () => {
    // Catalog matching is exact last-segment only; release stamps stay part of the leaf.
    expect(catalogModelIdsMatch("mimo-v2.5-pro", "mify/mimo-v2.5-pro-0731")).toBe(false);
    expect(catalogModelIdsMatch("foo-v2", "foo-v2-20250731")).toBe(false);
    expect(catalogModelIdsMatch("foo-v2", "foo-v2-2025-07-31")).toBe(false);
    expect(catalogModelIdsMatch("foo-v2", "foo-v2-2025_07_31")).toBe(false);
    expect(catalogModelIdsMatch("foo-v2", "foo-v2-2025.07.31")).toBe(false);
    expect(catalogModelIdsMatch("foo-v2", "foo-v2-1399")).toBe(false);
    expect(catalogModelIdsMatch("foo-v2", "foo-v2-9999")).toBe(false);
    expect(catalogModelIdsMatch("foo-v2", "foo-v2-0232")).toBe(false);
    // Same leaf still matches across a route prefix.
    expect(catalogModelIdsMatch("mimo-v2.5-pro-0731", "mify/mimo-v2.5-pro-0731")).toBe(true);
  });

  it("keeps a dated record from borrowing another publisher's family", () => {
    expect(catalogModelIdsMatch("provider-a/foo-v2", "provider-b/foo-v2-0731")).toBe(false);
  });
});

describe("metadata aliases never redefine the wire id", () => {
  it("does not resolve a routed dated snapshot to an undated leaf", () => {
    expect(catalogModelIdsMatch("mify/mimo-v2.5-pro", "mify/mimo-v2.5-pro-0731")).toBe(false);
  });

  it("leaves configured-model identity on the complete wire id", () => {
    // A binding id is what a request is addressed with, so the alias rules that
    // catalog metadata may use must not apply to it.
    expect(modelIdsMatch("mify/mimo-v2.5-pro-0731", "mify/mimo-v2.5-pro-0731")).toBe(true);
    expect(modelIdsMatch("mify/mimo-v2.5-pro", "mify/mimo-v2.5-pro-0731")).toBe(false);
    expect(modelIdsMatch("foo-v2", "foo-v2-20250731")).toBe(false);
  });

  it("matches independently routed ids that share an exact last segment", () => {
    // Disambiguation (0/1/≥2, official, shared caps) is the caller's job.
    expect(catalogModelIdsMatch("provider-a/foo", "gateway/foo")).toBe(true);
    expect(catalogModelIdsMatch("provider-a/foo", "provider-b/foo")).toBe(true);
    expect(catalogModelIdsMatch("provider-a/foo", "gateway/bar")).toBe(false);
  });
});
