import { describe, expect, it } from "vitest";
import {
  applyProxyEnvAssignments,
  chromiumProxyConfig,
  DEFAULT_NETWORK_PROXY_BYPASS,
  envProxyBypass,
  normalizeNetworkProxy,
  parseProxyUrl,
  proxyEnvAssignments,
  proxyHasCredentials,
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
  it("drops the retired fake-IP key from a stored proxy", () => {
    // The fake-IP tolerance moved to `networkPolicy.mode`; an older stored value
    // is ignored rather than refused, so an existing profile keeps loading.
    expect(validateNetworkProxy({ mode: "direct", allowFakeIp: true })).toEqual({
      ok: true,
      value: { mode: "direct" },
    });
    expect(validateNetworkProxy({ mode: "system", allowFakeIp: false })).toEqual({
      ok: true,
      value: { mode: "system" },
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

  it("maps curl's socks5h rule onto a Chromium-supported SOCKS5 rule", () => {
    // Chromium has no `socks5h` proxy scheme: session.setProxy accepts the
    // rule and then resolves every URL to no proxy, so requests fail with
    // net::ERR_NO_SUPPORTED_PROXIES instead of using the user's proxy (#419).
    expect(
      chromiumProxyConfig({
        mode: "custom",
        url: "socks5h://user:secret@127.0.0.1:1080",
      }),
    ).toEqual({
      proxyRules: "socks5://127.0.0.1:1080",
      proxyBypassRules: DEFAULT_NETWORK_PROXY_BYPASS,
    });
    expect(
      chromiumProxyConfig({ mode: "custom", url: "socks://127.0.0.1:1080" }),
    ).toEqual({
      proxyRules: "socks://127.0.0.1:1080",
      proxyBypassRules: DEFAULT_NETWORK_PROXY_BYPASS,
    });
  });

  it("strips userinfo from Chromium proxyRules (issue #490)", () => {
    expect(
      chromiumProxyConfig({
        mode: "custom",
        url: "http://user:s3cret@10.0.0.1:8080",
      }),
    ).toEqual({
      proxyRules: "http://10.0.0.1:8080",
      proxyBypassRules: DEFAULT_NETWORK_PROXY_BYPASS,
    });
    const parsed = parseProxyUrl("socks5://user:s3cret@127.0.0.1:1080");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(proxyHasCredentials(parsed.value)).toBe(true);
    expect(proxyEnvAssignments({
      mode: "custom",
      url: "http://user:s3cret@10.0.0.1:8080",
    }).HTTP_PROXY).toBe("http://user:s3cret@10.0.0.1:8080");
  });

  it("omits Chromium <local> from NO_PROXY, keeps the LAN ranges, and does not set HTTP_PROXY for SOCKS", () => {
    // The default bypass is the user's own machine plus the private ranges a
    // user's LAN devices live in: a proxy is for reaching the public internet,
    // and sending a local model server, NAS or MCP endpoint through it is how it
    // stops answering. `<local>` is Chromium's own single-label rule rather than
    // an env-var wildcard, so NO_PROXY drops it and keeps everything else.
    const lanRanges = "10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,169.254.0.0/16";
    const envBypass = `localhost,127.0.0.1,::1,${lanRanges}`;
    // Pinned literally: `crates/host-core/src/network_proxy.rs` carries the same
    // string for the sidecar's own bypass.
    expect(DEFAULT_NETWORK_PROXY_BYPASS).toBe(
      `localhost,127.0.0.1,::1,<local>,${lanRanges}`,
    );
    const socks = proxyEnvAssignments({
      mode: "custom",
      url: "socks5://127.0.0.1:1080",
    });
    expect(socks.ALL_PROXY).toBe("socks5://127.0.0.1:1080");
    expect(socks.HTTP_PROXY).toBeNull();
    expect(socks.NO_PROXY).toBe(envBypass);
    expect(socks.NO_PROXY ?? "").not.toContain("<local>");
    expect(envProxyBypass({ mode: "custom", url: "http://127.0.0.1:7890" })).toBe(envBypass);

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
