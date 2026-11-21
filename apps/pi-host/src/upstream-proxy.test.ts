import { describe, expect, it } from "vitest";

import { resolveUpstreamProxy, UpstreamProxyError } from "./upstream-proxy.js";

describe("resolveUpstreamProxy", () => {
  const httpsTarget = new URL("https://github.com/octo/repo.git");
  const httpTarget = new URL("http://example.com/octo/repo.git");

  it("returns null when no proxy variables are set or values are blank", () => {
    expect(resolveUpstreamProxy(httpsTarget, {})).toBeNull();
    expect(resolveUpstreamProxy(httpsTarget, { HTTPS_PROXY: "", https_proxy: "   ", ALL_PROXY: "\t" })).toBeNull();
    expect(resolveUpstreamProxy(httpTarget, { HTTP_PROXY: "  " })).toBeNull();
    expect(resolveUpstreamProxy(new URL("ssh://github.com/octo/repo.git"), { ALL_PROXY: "http://proxy.local:8080" })).toBeNull();
  });

  it("applies https_proxy > HTTPS_PROXY > all_proxy > ALL_PROXY precedence for https targets", () => {
    expect(
      resolveUpstreamProxy(httpsTarget, {
        http_proxy: "http://wrong-http:8080",
        HTTP_PROXY: "http://wrong-HTTP:8080",
        ALL_PROXY: "http://all-upper:8080",
      })?.href,
    ).toBe("http://all-upper:8080/");

    expect(
      resolveUpstreamProxy(httpsTarget, {
        all_proxy: "http://all-lower:8080",
        ALL_PROXY: "http://all-upper:8080",
      })?.href,
    ).toBe("http://all-lower:8080/");

    expect(
      resolveUpstreamProxy(httpsTarget, {
        HTTPS_PROXY: "http://https-upper:8080",
        all_proxy: "http://all-lower:8080",
      })?.href,
    ).toBe("http://https-upper:8080/");

    expect(
      resolveUpstreamProxy(httpsTarget, {
        https_proxy: "https://https-lower:8443",
        HTTPS_PROXY: "http://https-upper:8080",
        all_proxy: "http://all-lower:8080",
      })?.href,
    ).toBe("https://https-lower:8443/");

    // Blank lowercase falls through to uppercase.
    expect(
      resolveUpstreamProxy(httpsTarget, {
        https_proxy: "   ",
        HTTPS_PROXY: "http://https-upper:8080",
      })?.href,
    ).toBe("http://https-upper:8080/");
  });

  it("applies http_proxy > HTTP_PROXY > all_proxy > ALL_PROXY precedence for http targets", () => {
    expect(
      resolveUpstreamProxy(httpTarget, {
        https_proxy: "http://wrong-https:8080",
        HTTPS_PROXY: "http://wrong-HTTPS:8080",
        ALL_PROXY: "http://all-upper:8080",
      })?.href,
    ).toBe("http://all-upper:8080/");

    expect(
      resolveUpstreamProxy(httpTarget, {
        HTTP_PROXY: "http://http-upper:8080",
        all_proxy: "http://all-lower:8080",
      })?.href,
    ).toBe("http://http-upper:8080/");

    expect(
      resolveUpstreamProxy(httpTarget, {
        http_proxy: "http://http-lower:8080",
        HTTP_PROXY: "http://http-upper:8080",
      })?.href,
    ).toBe("http://http-lower:8080/");
  });

  it("supports NO_PROXY wildcard, exact host, leading dot, and suffix matching without partial-suffix false positives", () => {
    const env = (noProxy: string) => ({ HTTPS_PROXY: "http://proxy.local:8080", NO_PROXY: noProxy });

    // Wildcard bypasses everything.
    expect(resolveUpstreamProxy(httpsTarget, env("*"))).toBeNull();
    expect(resolveUpstreamProxy(httpsTarget, env(" foo.local , * , bar.local "))).toBeNull();

    // Exact hostname (case-insensitive, FQDN trailing dot).
    expect(resolveUpstreamProxy(httpsTarget, env("GITHUB.COM"))).toBeNull();
    expect(resolveUpstreamProxy(new URL("https://github.com./octo/repo"), env("github.com"))).toBeNull();
    expect(resolveUpstreamProxy(httpsTarget, env("github.com."))).toBeNull();

    // Leading-dot entry matches subdomains and bare domain, not partial suffixes.
    expect(resolveUpstreamProxy(new URL("https://sub.example.com/"), env(".example.com"))).toBeNull();
    expect(resolveUpstreamProxy(new URL("https://a.b.example.com/"), env(".example.com"))).toBeNull();
    expect(resolveUpstreamProxy(new URL("https://example.com/"), env(".example.com"))).toBeNull();
    expect(resolveUpstreamProxy(new URL("https://notexample.com/"), env(".example.com"))?.href).toBe("http://proxy.local:8080/");
    expect(resolveUpstreamProxy(new URL("https://example.com.evil.com/"), env(".example.com"))?.href).toBe("http://proxy.local:8080/");

    // Suffix entry without leading dot matches domain and subdomains, not partial suffixes.
    expect(resolveUpstreamProxy(new URL("https://example.com/"), env("example.com"))).toBeNull();
    expect(resolveUpstreamProxy(new URL("https://api.example.com/"), env("example.com"))).toBeNull();
    expect(resolveUpstreamProxy(new URL("https://notexample.com/"), env("example.com"))?.href).toBe("http://proxy.local:8080/");
    expect(resolveUpstreamProxy(new URL("https://example.com.evil.com/"), env("example.com"))?.href).toBe("http://proxy.local:8080/");

    // Lowercase no_proxy takes precedence over NO_PROXY.
    expect(
      resolveUpstreamProxy(new URL("https://github.com/"), {
        HTTPS_PROXY: "http://proxy.local:8080",
        no_proxy: "internal.local",
        NO_PROXY: "github.com",
      })?.href,
    ).toBe("http://proxy.local:8080/");
    expect(
      resolveUpstreamProxy(new URL("https://internal.local/"), {
        HTTPS_PROXY: "http://proxy.local:8080",
        no_proxy: "internal.local",
        NO_PROXY: "github.com",
      }),
    ).toBeNull();
  });

  it("supports NO_PROXY port constraints and bracketed IPv6 entries", () => {
    const base = { HTTPS_PROXY: "http://proxy.local:8080", HTTP_PROXY: "http://proxy.local:8080" };

    // Explicit port and default scheme ports (443 / 80).
    expect(resolveUpstreamProxy(new URL("https://example.com:8443/"), { ...base, NO_PROXY: "example.com:8443" })).toBeNull();
    expect(resolveUpstreamProxy(new URL("https://sub.example.com:8443/"), { ...base, NO_PROXY: ".example.com:8443" })).toBeNull();
    expect(resolveUpstreamProxy(new URL("https://example.com/"), { ...base, NO_PROXY: "example.com:8443" })?.href).toBe("http://proxy.local:8080/");
    expect(resolveUpstreamProxy(new URL("https://example.com/"), { ...base, NO_PROXY: "example.com:443" })).toBeNull();
    expect(resolveUpstreamProxy(new URL("http://example.com/"), { ...base, NO_PROXY: "example.com:443" })?.href).toBe("http://proxy.local:8080/");
    expect(resolveUpstreamProxy(new URL("http://example.com/"), { ...base, NO_PROXY: "example.com:80" })).toBeNull();

    // Bracketed IPv6 with and without port, plus canonicalization and unbracketed form.
    expect(resolveUpstreamProxy(new URL("http://[::1]:8080/"), { ...base, NO_PROXY: "[::1]" })).toBeNull();
    expect(resolveUpstreamProxy(new URL("http://[::1]:8080/"), { ...base, NO_PROXY: "[::1]:8080" })).toBeNull();
    expect(resolveUpstreamProxy(new URL("http://[::1]:9090/"), { ...base, NO_PROXY: "[::1]:8080" })?.href).toBe("http://proxy.local:8080/");
    expect(resolveUpstreamProxy(new URL("https://[2001:db8::1]/"), { ...base, NO_PROXY: "[2001:0db8::1]" })).toBeNull();
    expect(resolveUpstreamProxy(new URL("http://[::1]:8080/"), { ...base, NO_PROXY: "::1" })).toBeNull();

    // IPv4 matches exact host only, not suffix.
    expect(resolveUpstreamProxy(new URL("http://127.0.0.1:8080/"), { ...base, NO_PROXY: "127.0.0.1" })).toBeNull();
    expect(resolveUpstreamProxy(new URL("http://127.0.0.1:8080/"), { ...base, NO_PROXY: "127.0.0.1:9090" })?.href).toBe("http://proxy.local:8080/");

    // Malformed entries in NO_PROXY are skipped safely.
    expect(resolveUpstreamProxy(new URL("https://github.com/"), { ...base, NO_PROXY: "[::1, ., :8080, example.com:notaport, github.com" })).toBeNull();
  });

  it("throws descriptive non-secret errors on invalid or unsupported proxy URLs", () => {
    const cases: Array<{ value: string; code: UpstreamProxyError["code"]; secret: string[] }> = [
      {
        value: "socks5://proxy-user:proxy-secret-pass@proxy.local:1080",
        code: "ERR_UNSUPPORTED_PROXY_PROTOCOL",
        secret: ["proxy-user", "proxy-secret-pass"],
      },
      {
        value: "proxy-user:proxy-secret-pass@proxy.local:8080",
        code: "ERR_INVALID_PROXY_URL",
        secret: ["proxy-user", "proxy-secret-pass"],
      },
      {
        value: "http://proxy-user:proxy-secret-pass@bad host:8080",
        code: "ERR_INVALID_PROXY_URL",
        secret: ["proxy-user", "proxy-secret-pass"],
      },
      {
        value: "http://:8080",
        code: "ERR_INVALID_PROXY_URL",
        secret: [],
      },
      {
        value: "http://proxy-user%ZZ:proxy-secret-pass@proxy.local:8080",
        code: "ERR_INVALID_PROXY_URL",
        secret: ["proxy-user", "proxy-secret-pass"],
      },
    ];

    for (const testCase of cases) {
      let caught: unknown;
      try {
        resolveUpstreamProxy(httpsTarget, { HTTPS_PROXY: testCase.value });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(UpstreamProxyError);
      const err = caught as UpstreamProxyError;
      expect(err.code).toBe(testCase.code);
      for (const secret of testCase.secret) {
        expect(err.message).not.toContain(secret);
      }
    }
  });
});
