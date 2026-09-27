import { describe, expect, it } from "vitest";
import { isNetHostAllowed, isNetUrlAllowed, parseNetDomains } from "./net-policy.js";

describe("parseNetDomains", () => {
  it("treats an absent list as no egress rather than an error", () => {
    expect(parseNetDomains(undefined)).toEqual({ ok: true, domains: [] });
    expect(parseNetDomains([])).toEqual({ ok: true, domains: [] });
  });

  it("normalizes case and drops duplicates", () => {
    expect(parseNetDomains(["API.GitHub.com", "api.github.com"])).toEqual({
      ok: true,
      domains: ["api.github.com"],
    });
  });

  it("accepts a subdomain wildcard", () => {
    expect(parseNetDomains(["*.example.com"]).domains).toEqual(["*.example.com"]);
  });

  it("rejects a bare wildcard so nobody declares their way to every host", () => {
    const result = parseNetDomains(["*"]);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/must not contain/);
  });

  it("rejects anything that is not a bare hostname", () => {
    for (const entry of [
      "https://api.github.com",
      "api.github.com/v3",
      "api.github.com:443",
      "api..github.com",
      "-github.com",
      "",
    ]) {
      expect(parseNetDomains([entry]).ok, entry).toBe(false);
    }
  });

  it("rejects non-array and non-string input", () => {
    expect(parseNetDomains("api.github.com").ok).toBe(false);
    expect(parseNetDomains([1]).ok).toBe(false);
  });
});

describe("isNetHostAllowed", () => {
  it("matches an exact host only", () => {
    expect(isNetHostAllowed("api.github.com", ["api.github.com"])).toBe(true);
    expect(isNetHostAllowed("evil.com", ["api.github.com"])).toBe(false);
  });

  it("matches the apex and its subdomains for a wildcard", () => {
    const domains = ["*.example.com"];
    expect(isNetHostAllowed("example.com", domains)).toBe(true);
    expect(isNetHostAllowed("a.b.example.com", domains)).toBe(true);
  });

  it("does not let a suffix collision through", () => {
    // The classic bug: endsWith("example.com") also matches notexample.com.
    expect(isNetHostAllowed("notexample.com", ["*.example.com"])).toBe(false);
    expect(isNetHostAllowed("example.com.evil.net", ["*.example.com"])).toBe(false);
  });

  it("allows nothing when the list is empty", () => {
    expect(isNetHostAllowed("api.github.com", [])).toBe(false);
  });
});

describe("isNetUrlAllowed", () => {
  it("allows an http(s) url whose host is declared", () => {
    expect(isNetUrlAllowed("https://api.github.com/user", ["api.github.com"])).toBe(true);
    expect(isNetUrlAllowed("http://api.github.com/user", ["api.github.com"])).toBe(true);
  });

  it("ignores userinfo and port when matching the host", () => {
    expect(isNetUrlAllowed("https://evil.com@api.github.com/", ["api.github.com"])).toBe(
      true,
    );
    expect(isNetUrlAllowed("https://api.github.com:8443/", ["api.github.com"])).toBe(true);
    // ...and the reverse must not sneak past: the real host is evil.com.
    expect(isNetUrlAllowed("https://api.github.com@evil.com/", ["api.github.com"])).toBe(
      false,
    );
  });

  it("refuses non-http schemes and unparseable input", () => {
    expect(isNetUrlAllowed("ws://api.github.com", ["api.github.com"])).toBe(false);
    expect(isNetUrlAllowed("file:///etc/passwd", ["api.github.com"])).toBe(false);
    expect(isNetUrlAllowed("not a url", ["api.github.com"])).toBe(false);
  });
});
