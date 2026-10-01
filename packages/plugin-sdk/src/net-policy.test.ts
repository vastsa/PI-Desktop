import { describe, expect, it } from "vitest";
import {
  isLocalNetDomain,
  isMetadataNetHost,
  isNetHostAllowed,
  isNetSocketUrlAllowedWithGrant,
  isNetUrlAllowed,
  isNetUrlAllowedWithGrant,
  parseNetDomains,
} from "./net-policy.js";

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

describe("isLocalNetDomain", () => {
  it("flags loopback, link-local, and cloud metadata hosts", () => {
    for (const entry of [
      "localhost",
      "*.localhost",
      "app.localhost",
      "127.0.0.1",
      "127.1.2.3",
      "0.0.0.0",
      "169.254.169.254",
      "169.254.0.7",
      "metadata.google.internal",
      "LOCALHOST.",
    ]) {
      expect(isLocalNetDomain(entry), entry).toBe(true);
    }
  });

  it("leaves public hosts alone", () => {
    for (const entry of [
      "api.github.com",
      "*.example.com",
      "10.0.0.1",
      "192.168.1.1",
      "localhost.example.com",
      "metadata.example.com",
    ]) {
      expect(isLocalNetDomain(entry), entry).toBe(false);
    }
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

describe("isMetadataNetHost", () => {
  it("recognizes cloud metadata endpoints", () => {
    for (const host of ["169.254.169.254", "metadata.google.internal", "metadata", "METADATA."]) {
      expect(isMetadataNetHost(host), host).toBe(true);
    }
  });

  it("leaves ordinary and private hosts alone", () => {
    for (const host of ["api.github.com", "192.168.1.10", "10.0.0.1", "localhost"]) {
      expect(isMetadataNetHost(host), host).toBe(false);
    }
  });
});

describe("isNetUrlAllowedWithGrant", () => {
  it("keeps the allowlist decision unchanged without the grant", () => {
    const grant = { domains: ["api.github.com"], anyHost: false };
    expect(isNetUrlAllowedWithGrant("https://api.github.com/x", grant)).toBe(true);
    expect(isNetUrlAllowedWithGrant("https://my-self-hosted.example/x", grant)).toBe(false);
  });

  it("admits any http(s) host once the grant is held", () => {
    const grant = { domains: [], anyHost: true };
    expect(isNetUrlAllowedWithGrant("https://my-self-hosted.example:8443/x", grant)).toBe(true);
    expect(isNetUrlAllowedWithGrant("http://192.168.1.10/api", grant)).toBe(true);
  });

  it("never admits cloud metadata endpoints, grant or not", () => {
    const grant = { domains: [], anyHost: true };
    expect(isNetUrlAllowedWithGrant("http://169.254.169.254/latest/meta-data", grant)).toBe(false);
    expect(isNetUrlAllowedWithGrant("http://metadata.google.internal/", grant)).toBe(false);
  });

  it("still refuses non-http schemes and unparseable input under the grant", () => {
    const grant = { domains: [], anyHost: true };
    expect(isNetUrlAllowedWithGrant("file:///etc/passwd", grant)).toBe(false);
    expect(isNetUrlAllowedWithGrant("ws://my-self-hosted.example", grant)).toBe(false);
    expect(isNetUrlAllowedWithGrant("not a url", grant)).toBe(false);
  });

  it("prefers the allowlist when the host is declared", () => {
    const grant = { domains: ["169.254.169.254"], anyHost: true };
    expect(isNetUrlAllowedWithGrant("http://169.254.169.254/latest/meta-data", grant)).toBe(true);
  });
});

describe("isNetSocketUrlAllowedWithGrant", () => {
  it("admits any ws(s) host under the grant, metadata excepted", () => {
    const grant = { domains: [], anyHost: true };
    expect(isNetSocketUrlAllowedWithGrant("wss://my-self-hosted.example/ws", grant)).toBe(true);
    expect(isNetSocketUrlAllowedWithGrant("http://my-self-hosted.example", grant)).toBe(false);
    expect(isNetSocketUrlAllowedWithGrant("ws://169.254.169.254/", grant)).toBe(false);
  });

  it("changes nothing without the grant", () => {
    const grant = { domains: ["api.github.com"] };
    expect(isNetSocketUrlAllowedWithGrant("wss://api.github.com/ws", grant)).toBe(true);
    expect(isNetSocketUrlAllowedWithGrant("wss://other.example/ws", grant)).toBe(false);
  });
});
