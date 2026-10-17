import { describe, expect, it } from "vitest";
import {
  DEFAULT_JEV_CLASSIFIER_BINDING,
  isDefaultJevClassifierBinding,
  jevSystemOneUrl,
  normalizeJevBaseUrl,
  normalizeJevClassifierBinding,
  normalizeJevModelId,
  resolveJevClassifierBinding,
} from "./jev.js";

describe("Jev classifier binding", () => {
  it("keeps the official TypeSafe binding as the legacy default", () => {
    const resolved = resolveJevClassifierBinding(undefined);
    expect(resolved).toEqual({
      status: "default",
      binding: {
        baseUrl: "https://api.typesafe.ai/v1",
        modelId: "jev-latest",
      },
    });
    if (resolved.status !== "invalid") {
      expect(isDefaultJevClassifierBinding(resolved.binding)).toBe(true);
      expect(jevSystemOneUrl(resolved.binding)).toBe(
        "https://api.typesafe.ai/v1/systemone",
      );
    }
  });

  it("accepts an API root or full System One operation without doubling the path", () => {
    expect(normalizeJevBaseUrl("https://openrouter.ai/api/v1/")).toBe(
      "https://openrouter.ai/api/v1",
    );
    expect(
      normalizeJevBaseUrl("https://example.test/v1/systemone/"),
    ).toBe("https://example.test/v1");
    expect(normalizeJevBaseUrl("localhost:8787/v1/systemone")).toBe(
      "https://localhost:8787/v1",
    );
    expect(
      jevSystemOneUrl({
        baseUrl: "https://openrouter.ai/api/v1",
        modelId: "~typesafe/jev-latest",
      }),
    ).toBe("https://openrouter.ai/api/v1/systemone");
  });

  it("rejects non-HTTP addresses and URLs that carry credentials or extra data", () => {
    for (const value of [
      "",
      "file:///tmp/systemone",
      "https://user:secret@example.test/v1",
      "https://example.test/v1?token=secret",
      "https://example.test/v1#fragment",
    ]) {
      expect(normalizeJevBaseUrl(value), value).toBeUndefined();
    }
  });

  it("preserves exact safe classifier ids and rejects blank or unsafe ids", () => {
    expect(normalizeJevModelId("  ~typesafe/jev-latest  ")).toBe(
      "~typesafe/jev-latest",
    );
    for (const value of ["", "   ", "two ids", "bad\nmodel"]) {
      expect(normalizeJevModelId(value), value).toBeUndefined();
    }
  });

  it("normalizes explicit bindings and never turns corrupt explicit data into the default", () => {
    expect(
      normalizeJevClassifierBinding({
        baseUrl: "https://openrouter.ai/api/v1/systemone",
        modelId: " ~typesafe/jev-latest ",
      }),
    ).toEqual({
      baseUrl: "https://openrouter.ai/api/v1",
      modelId: "~typesafe/jev-latest",
    });
    expect(resolveJevClassifierBinding(null)).toEqual({
      status: "invalid",
      error: "Jev classifier binding is invalid",
    });
    expect(resolveJevClassifierBinding({ baseUrl: "bad", modelId: "" })).toEqual({
      status: "invalid",
      error: "Jev classifier binding is invalid",
    });
    expect(
      resolveJevClassifierBinding({
        baseUrl: "https://openrouter.test/api/v1",
        modelId: "~typesafe/jev-latest",
        unexpected: true,
      }),
    ).toEqual({
      status: "invalid",
      error: "Jev classifier binding is invalid",
    });
    expect(DEFAULT_JEV_CLASSIFIER_BINDING).toEqual({
      baseUrl: "https://api.typesafe.ai/v1",
      modelId: "jev-latest",
    });
  });
});
