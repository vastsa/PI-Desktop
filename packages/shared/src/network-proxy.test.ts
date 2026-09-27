import { describe, expect, it } from "vitest";
import {
  applyProxyEnvAssignments,
  chromiumProxyConfig,
  DEFAULT_NETWORK_PROXY_BYPASS,
  envProxyBypass,
  normalizeNetworkProxy,
  parseProxyUrl,
  proxyEnvAssignments,
  redactProxyUrl,
  restoreProxyEnv,
  snapshotProxyEnv,
  stripProxyEnv,
  validateNetworkProxy,
} from "./network-proxy.js";

describe("parseProxyUrl", () => {
  it("accepts http, https, and socks5 URLs", () => {
    expect(parseProxyUrl("http://127.0.0.1:7890")).toMatchObject({
      ok: true,
      value: {
        href: "http://127.0.0.1:7890",
        scheme: "http",
        host: "127.0.0.1",
        port: 7890,
        isSocks: false,
      },
    });
    expect(parseProxyUrl("socks5://127.0.0.1:1080")).toMatchObject({
      ok: true,
      value: { href: "socks5://127.0.0.1:1080", isSocks: true, scheme: "socks5" },
    });
    expect(parseProxyUrl("SOCKS5H://proxy.example:1080")).toMatchObject({
      ok: true,
      value: { href: "socks5h://proxy.example:1080", scheme: "socks5h" },
    });
  });

  it("rejects missing hosts, unknown schemes, and whitespace", () => {
    expect(parseProxyUrl("")).toMatchObject({ ok: false });
    expect(parseProxyUrl("http://")).toMatchObject({ ok: false });
    expect(parseProxyUrl("ftp://127.0.0.1:1080")).toMatchObject({ ok: false });
    expect(parseProxyUrl("socks5://127.0.0.1:1080 extra")).toMatchObject({
      ok: false,
    });
    expect(parseProxyUrl("file:///tmp/proxy")).toMatchObject({ ok: false });
    expect(parseProxyUrl("socks4://127.0.0.1:1080")).toMatchObject({ ok: false });
    expect(parseProxyUrl("socks4a://127.0.0.1:1080")).toMatchObject({ ok: false });
    expect(parseProxyUrl("http://%ZZ@proxy.example:8080")).toEqual({
      ok: false,
      error: "proxy credentials are invalid",
    });
  });

  it("preserves credentials in the canonical href and redacts passwords", () => {
    const parsed = parseProxyUrl("http://user:s3cret@10.0.0.1:8080");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.username).toBe("user");
    expect(parsed.value.password).toBe("s3cret");
    expect(redactProxyUrl(parsed.value.href)).toBe(
      "http://user:***@10.0.0.1:8080",
    );
  });
});

describe("validateNetworkProxy", () => {
  it("defaults unknown values to system and drops custom URL for non-custom modes", () => {
    expect(validateNetworkProxy(undefined)).toEqual({
      ok: true,
      value: { mode: "system" },
    });
    expect(validateNetworkProxy({ mode: "direct", url: "socks5://127.0.0.1:1080" })).toEqual({
      ok: true,
      value: { mode: "direct" },
    });
  });

  it("requires a valid URL in custom mode", () => {
    expect(validateNetworkProxy({ mode: "custom" }).ok).toBe(false);
    expect(
      validateNetworkProxy({ mode: "custom", url: "socks5://127.0.0.1:1080" }),
    ).toEqual({
      ok: true,
      value: { mode: "custom", url: "socks5://127.0.0.1:1080" },
    });
  });
});

describe("chromium and env projections", () => {
  it("maps modes onto Chromium session.setProxy payloads", () => {
    expect(chromiumProxyConfig({ mode: "system" })).toEqual({ mode: "system" });
    expect(chromiumProxyConfig({ mode: "direct" })).toEqual({ mode: "direct" });
    expect(
      chromiumProxyConfig({
        mode: "custom",
        url: "socks5://127.0.0.1:1080",
      }),
    ).toEqual({
      proxyRules: "socks5://127.0.0.1:1080",
      proxyBypassRules: DEFAULT_NETWORK_PROXY_BYPASS,
    });
  });

  it("omits Chromium <local> from NO_PROXY and does not set HTTP_PROXY for SOCKS", () => {
    const socks = proxyEnvAssignments({
      mode: "custom",
      url: "socks5://127.0.0.1:1080",
    });
    expect(socks.ALL_PROXY).toBe("socks5://127.0.0.1:1080");
    expect(socks.HTTP_PROXY).toBeNull();
    expect(socks.NO_PROXY).toBe("localhost,127.0.0.1,::1");
    expect(envProxyBypass({ mode: "custom", url: "http://127.0.0.1:7890" })).toBe(
      "localhost,127.0.0.1,::1",
    );

    const http = proxyEnvAssignments({
      mode: "custom",
      url: "http://127.0.0.1:7890",
    });
    expect(http.HTTP_PROXY).toBe("http://127.0.0.1:7890");
    expect(http.HTTPS_PROXY).toBe("http://127.0.0.1:7890");
  });

  it("clears proxy env keys in direct mode and can restore a snapshot", () => {
    const env: Record<string, string | undefined> = {
      HTTP_PROXY: "http://old:1",
      PATH: "/bin",
    };
    const snapshot = snapshotProxyEnv(env);
    applyProxyEnvAssignments(proxyEnvAssignments({ mode: "direct" }), env);
    expect(env.HTTP_PROXY).toBeUndefined();
    restoreProxyEnv(snapshot, env);
    expect(env.HTTP_PROXY).toBe("http://old:1");
    const stripped = stripProxyEnv({ ...env, ALL_PROXY: "socks5://x:1" });
    expect(stripped.ALL_PROXY).toBeUndefined();
    expect(stripped.PATH).toBe("/bin");
  });
});

describe("normalizeNetworkProxy", () => {
  it("reads a persisted settings object", () => {
    expect(
      normalizeNetworkProxy({
        mode: "custom",
        url: "  socks5://127.0.0.1:1080  ",
        bypass: " localhost ",
      }),
    ).toEqual({
      mode: "custom",
      url: "socks5://127.0.0.1:1080",
      bypass: "localhost",
    });
  });
});
