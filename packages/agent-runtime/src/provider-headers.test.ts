import { describe, expect, it, vi } from "vitest";
import {
  applyProviderHeadersToRequestInit,
  applyStoredProviderHeadersToInit,
  mergeProviderHeaders,
  normalizeProviderHeaders,
  providerHeadersEqual,
  runWithProviderHeaders,
  withProviderHeaders,
  withProviderHeadersFetch,
} from "./provider-headers.js";

describe("normalizeProviderHeaders", () => {
  it("trims, drops empty rows, and treats empty as absent", () => {
    expect(
      normalizeProviderHeaders({ "  X-Custom  ": "  one  ", skip: "   " }),
    ).toEqual({ "X-Custom": "one" });
    expect(normalizeProviderHeaders({})).toBeUndefined();
    expect(normalizeProviderHeaders(undefined)).toBeUndefined();
  });

  it("rejects CR/LF, reserved keys, and bad names", () => {
    expect(
      normalizeProviderHeaders({ "X-Custom": "bad\r\nX-Injected: 1" }),
    ).toBeUndefined();
    expect(normalizeProviderHeaders({ Authorization: "Bearer secret" })).toBeUndefined();
    expect(normalizeProviderHeaders({ Host: "evil.example" })).toBeUndefined();
    expect(normalizeProviderHeaders({ "Content-Type": "text/plain" })).toBeUndefined();
    expect(
      normalizeProviderHeaders({ "x-opencode-session": "hijack" }),
    ).toBeUndefined();
    expect(normalizeProviderHeaders({ "X_Nope": "1" })).toBeUndefined();
  });

  it("folds fullwidth values and drops what still cannot be a ByteString", () => {
    expect(
      normalizeProviderHeaders({
        "X-Title": "PI\u3000Desktop",
        "X-Key": "1234567\uFF10",
        "X-CJK": "星",
        "X-Control": "ab\u0000cd",
      }),
    ).toEqual({
      "X-Title": "PI Desktop",
      "X-Key": "12345670",
    });
  });

  it("collapses duplicate keys case-insensitively, last write winning", () => {
    expect(
      normalizeProviderHeaders({
        "user-agent": "first",
        "User-Agent": "Custom/1",
        Accept: "application/json",
      }),
    ).toEqual({
      "User-Agent": "Custom/1",
      Accept: "application/json",
    });
  });
});

describe("mergeProviderHeaders", () => {
  it("overlays custom headers over stream headers without smashing auth", () => {
    expect(
      mergeProviderHeaders(
        { Authorization: "Bearer sk", Accept: "application/json" },
        { "X-Gateway": "1", Authorization: "Bearer other", Accept: "text/plain" },
      ),
    ).toEqual({
      Authorization: "Bearer sk",
      Accept: "text/plain",
      "X-Gateway": "1",
    });
  });

  it("leaves other headers alone when the override is empty", () => {
    expect(mergeProviderHeaders({ Accept: "application/json" }, {})).toEqual({
      Accept: "application/json",
    });
  });
});

describe("withProviderHeadersFetch", () => {
  it("wins over a Codex-style last Headers.set of User-Agent", async () => {
    const captured: Headers[] = [];
    const base = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured.push(new Headers(init?.headers));
      return new Response("ok");
    });
    const wrapped = withProviderHeadersFetch(base, {
      "User-Agent": "Custom/1",
      "X-Gateway": "keep",
    });
    const headers = new Headers();
    headers.set("X-Extra", "keep");
    headers.set("User-Agent", "pi (darwin 24.0; arm64)");
    await wrapped!("https://provider.example/v1", { headers });
    expect(captured[0].get("User-Agent")).toBe("Custom/1");
    expect(captured[0].get("X-Gateway")).toBe("keep");
    expect(captured[0].get("X-Extra")).toBe("keep");
    expect(headers.get("User-Agent")).toBe("pi (darwin 24.0; arm64)");
  });

  it("does not wrap when the override is empty", () => {
    const base = vi.fn();
    expect(withProviderHeadersFetch(base, {})).toBe(base);
    expect(withProviderHeadersFetch(undefined, undefined)).toBeUndefined();
  });
});

describe("withProviderHeaders", () => {
  it("puts custom headers on stream headers and wraps fetch", async () => {
    const base = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("User-Agent")).toBe("Custom/1");
      expect(headers.get("X-Gateway")).toBe("1");
      return new Response("ok");
    });
    const result = withProviderHeaders(
      {
        headers: {
          "x-opencode-session": "s1",
          "User-Agent": "pi-desktop/0.0.0",
        },
        fetch: base,
      },
      { "User-Agent": "Custom/1", "X-Gateway": "1" },
    );
    expect(result.headers).toMatchObject({
      "x-opencode-session": "s1",
      "User-Agent": "Custom/1",
      "X-Gateway": "1",
    });
    await result.fetch!("https://opencode.ai/zen/go/v1", {
      headers: { "User-Agent": "still-sdk" },
    });
    expect(base).toHaveBeenCalledOnce();
  });

  it("keeps the headers but drops the fetch for the Google adapters", () => {
    const base = vi.fn(async () => new Response("ok"));
    const result = withProviderHeaders(
      { headers: { "User-Agent": "pi-desktop/0.0.0" }, fetch: base },
      { "X-Gateway": "1" },
      "google-generative-ai",
    );

    expect(result.headers).toMatchObject({
      "User-Agent": "pi-desktop/0.0.0",
      "X-Gateway": "1",
    });
    expect(result.fetch).toBeUndefined();
    expect(base).not.toHaveBeenCalled();
  });

  it("clears an inherited fetch for a Google adapter with no header override", () => {
    const base = vi.fn(async () => new Response("ok"));

    const result = withProviderHeaders({ fetch: base }, undefined, "google-generative-ai");

    expect(result.fetch).toBeUndefined();
    expect(base).not.toHaveBeenCalled();
  });

  it("returns the caller's options untouched for every other adapter", () => {
    const base = vi.fn(async () => new Response("ok"));
    const options = { fetch: base };

    expect(withProviderHeaders(options, undefined, "openai-completions")).toBe(options);
    expect(withProviderHeaders(options, {}, "anthropic-messages")).toBe(options);
  });
});

describe("runWithProviderHeaders", () => {
  it("does not wrap the callback when the override is empty", () => {
    const fn = vi.fn(() => 7);
    expect(runWithProviderHeaders({}, fn)).toBe(7);
    expect(fn).toHaveBeenCalledOnce();
  });

  it("exposes the scoped headers for a global fetch patch", () => {
    const outside = applyStoredProviderHeadersToInit({
      headers: { "User-Agent": "sdk" },
    });
    expect(new Headers(outside?.headers).get("User-Agent")).toBe("sdk");
    const inside = runWithProviderHeaders({ "User-Agent": "Custom/1" }, () =>
      applyStoredProviderHeadersToInit({ headers: { "User-Agent": "sdk" } }),
    );
    expect(new Headers(inside?.headers).get("User-Agent")).toBe("Custom/1");
  });
});

describe("applyProviderHeadersToRequestInit", () => {
  it("does not mutate the caller's Headers object", () => {
    const headers = new Headers({ "User-Agent": "sdk" });
    const next = applyProviderHeadersToRequestInit(
      { headers },
      { "User-Agent": "Custom/1", "X-Gateway": "1" },
    );
    expect(new Headers(next.headers).get("User-Agent")).toBe("Custom/1");
    expect(new Headers(next.headers).get("X-Gateway")).toBe("1");
    expect(headers.get("User-Agent")).toBe("sdk");
  });
});

describe("providerHeadersEqual", () => {
  it("compares maps case-insensitively", () => {
    expect(
      providerHeadersEqual({ "User-Agent": "A" }, { "user-agent": "A" }),
    ).toBe(true);
    expect(
      providerHeadersEqual({ "User-Agent": "A" }, { "User-Agent": "B" }),
    ).toBe(false);
    expect(providerHeadersEqual(undefined, {})).toBe(true);
  });
});
