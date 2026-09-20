import { describe, expect, it } from "vitest";
import {
  classifyIpAddress,
  classifyIpLiteral,
  classifyProxyRoute,
  isAcceptableResolvedAddress,
  isPublicHttpsUrl,
  isPublicIpLiteral,
  PUBLIC_NETWORK_POLICY_ERROR,
  isPublicHostname,
  isProxyFakeIpAddress,
  isPublicNetworkPolicyFailure,
  publicNetworkRefusalDetail,
  publicNetworkRefusalReason,
} from "./public-network.js";

describe("public network address policy", () => {
  it("classifies special-use IPv4 ranges", () => {
    const cases: Array<[string, ReturnType<typeof classifyIpLiteral>]> = [
      ["0.0.0.0", "unspecified"],
      ["10.1.2.3", "private"],
      ["100.64.0.1", "cgnat"],
      ["100.127.255.254", "cgnat"],
      ["127.0.0.1", "loopback"],
      ["169.254.10.20", "link-local"],
      ["172.16.0.1", "private"],
      ["192.0.0.1", "reserved"],
      ["192.0.2.1", "documentation"],
      ["192.31.196.1", "reserved"],
      ["192.52.193.1", "reserved"],
      ["192.88.99.1", "reserved"],
      ["192.168.1.1", "private"],
      ["192.175.48.1", "reserved"],
      ["198.18.0.1", "benchmark"],
      ["198.19.255.254", "benchmark"],
      ["198.51.100.1", "documentation"],
      ["203.0.113.1", "documentation"],
      ["224.0.0.1", "multicast"],
      ["240.0.0.1", "reserved"],
      ["8.8.8.8", "public"],
    ];
    for (const [ip, kind] of cases) {
      expect(classifyIpAddress(ip), ip).toBe(kind);
      expect(isPublicIpLiteral(ip), ip).toBe(kind === "public");
    }
  });

  it("classifies IPv6 special-use ranges and embedded IPv4", () => {
    const cases: Array<[string, ReturnType<typeof classifyIpLiteral>]> = [
      ["::", "unspecified"],
      ["::1", "loopback"],
      ["::ffff:192.168.1.1", "private"],
      ["::ffff:8.8.8.8", "public"],
      ["::192.0.2.1", "documentation"],
      ["2001:4860::192.168.1.1", "private"],
      ["fc00::1", "ula"],
      ["fd12:3456::1", "ula"],
      ["fe80::1", "link-local"],
      ["fec0::1", "site-local"],
      ["ff02::1", "multicast"],
      ["64:ff9b::192.0.2.1", "reserved"],
      ["100::1", "reserved"],
      ["2001::1", "reserved"],
      ["2001:2::1", "benchmark"],
      ["2001:10::1", "reserved"],
      ["2001:1f::1", "reserved"],
      ["2001:20::1", "reserved"],
      ["2001:2f::1", "reserved"],
      ["2001:db8::1", "documentation"],
      ["2002::1", "reserved"],
      ["3fff::1", "documentation"],
      ["2606:4700::1", "public"],
    ];
    for (const [ip, kind] of cases) expect(classifyIpLiteral(ip), ip).toBe(kind);
    expect(classifyIpLiteral("not-an-ip")).toBe("invalid");
    expect(classifyIpLiteral("2001:db8::1::2")).toBe("invalid");
  });

  it("rejects credentials and non-public hosts in HTTPS URLs", () => {
    expect(isPublicHttpsUrl("https://user:pass@example.com/mcp")).toBe(false);
    expect(isPublicHttpsUrl("https://localhost./mcp")).toBe(false);
    expect(isPublicHttpsUrl("https://127.0.0.1/mcp")).toBe(false);
    expect(isPublicHttpsUrl("https://[::ffff:10.0.0.1]/mcp")).toBe(false);
    expect(isPublicHttpsUrl("https://[2001:db8::1]/mcp")).toBe(false);
    expect(isPublicHttpsUrl("http://example.com/mcp")).toBe(false);
    expect(isPublicHttpsUrl("https://example.com./mcp")).toBe(true);
    expect(isPublicHttpsUrl("https://[2606:4700::1]/mcp")).toBe(true);
    expect(isPublicHostname("localhost.")).toBe(false);
    expect(isPublicHostname("registry.example.")).toBe(true);
    expect(isPublicHostname("0x7f000001")).toBe(false);
  });

  it("recognizes a policy refusal without importing the client", () => {
    // The skill market aggregator classifies failures with this structural
    // check so it can stay free of the client's `node:dns` import (issue #419).
    const refusal = Object.assign(new Error("hostname does not resolve: x"), {
      name: PUBLIC_NETWORK_POLICY_ERROR,
    });
    expect(isPublicNetworkPolicyFailure(refusal)).toBe(true);
    expect(isPublicNetworkPolicyFailure(new Error("responded 502"))).toBe(false);
    expect(isPublicNetworkPolicyFailure(null)).toBe(false);
    expect(isPublicNetworkPolicyFailure("PublicNetworkPolicyError")).toBe(false);
    expect(PUBLIC_NETWORK_POLICY_ERROR).toBe("PublicNetworkPolicyError");
  });

  it("reads a refusal's own reason, and treats an unnamed one as a refusal", () => {
    // Issue #419: "the resolver answered nothing" and "the resolved address is
    // not public" need different fixes, so a refusal has to say which one it is
    // without the reader parsing its message.
    expect(
      publicNetworkRefusalDetail({
        name: PUBLIC_NETWORK_POLICY_ERROR,
        reason: "resolve-failed",
        host: "api.github.com",
      }),
    ).toEqual({ reason: "resolve-failed", host: "api.github.com" });
    // An unrecognized or absent reason is still a refusal — never permission —
    // so a caller that needs the stricter reading gets `undefined`, not a pass.
    expect(publicNetworkRefusalReason({ name: PUBLIC_NETWORK_POLICY_ERROR })).toBeUndefined();
    expect(publicNetworkRefusalReason({ name: PUBLIC_NETWORK_POLICY_ERROR, reason: "made-up" })).toBeUndefined();
    expect(publicNetworkRefusalDetail({ name: PUBLIC_NETWORK_POLICY_ERROR })).toBeUndefined();
    expect(isPublicNetworkPolicyFailure({ name: PUBLIC_NETWORK_POLICY_ERROR })).toBe(true);
    // The class and the address both travel: the address is what the user
    // recognises (`198.18.0.1` is unmistakably a proxy's fake-IP) and the class
    // is what a machine decides on. `isProxyFakeIpAddress` is the one place that
    // turns "benchmark" into "a proxy invented this", and it never turns it into
    // permission — the guard still refuses the address.
    expect(
      publicNetworkRefusalDetail({
        name: PUBLIC_NETWORK_POLICY_ERROR,
        reason: "non-public-address",
        host: "api.github.com",
        address: "198.18.0.4",
        addressKind: "benchmark",
      }),
    ).toEqual({
      reason: "non-public-address",
      host: "api.github.com",
      address: "198.18.0.4",
      addressKind: "benchmark",
    });
    expect(isProxyFakeIpAddress("benchmark")).toBe(true);
    expect(isProxyFakeIpAddress("private")).toBe(false);
    expect(isProxyFakeIpAddress("loopback")).toBe(false);
    expect(isProxyFakeIpAddress(undefined)).toBe(false);
    // An unknown class is dropped rather than passed through.
    expect(
      publicNetworkRefusalDetail({
        name: PUBLIC_NETWORK_POLICY_ERROR,
        reason: "non-public-address",
        addressKind: "made-up",
      }),
    ).toEqual({ reason: "non-public-address" });
    // Only a well-formed IP literal travels: a refusal must never become a
    // channel for arbitrary resolver text.
    expect(
      publicNetworkRefusalDetail({
        name: PUBLIC_NETWORK_POLICY_ERROR,
        reason: "non-public-address",
        address: "not-an-address",
        addressKind: "benchmark",
      }),
    ).toEqual({ reason: "non-public-address", addressKind: "benchmark" });
    expect(publicNetworkRefusalDetail(new Error("responded 502"))).toBeUndefined();
    expect(publicNetworkRefusalDetail(undefined)).toBeUndefined();
  });

  it("reads the route a proxy list proves, and refuses to guess", () => {
    // ADR 0272: the address verdict follows the route the request will take, so
    // the route has to be read strictly. Only a list with a proxy chain and no
    // `DIRECT` entry proves the app's socket can be a proxy: Chromium may fall
    // back to `DIRECT`, so an offered direct connection is `unknown`, never
    // `proxied`.
    const cases: Array<[unknown, ReturnType<typeof classifyProxyRoute>]> = [
      ["DIRECT", "direct"],
      ["direct", "direct"],
      ["PROXY 127.0.0.1:7890", "proxied"],
      ["SOCKS5 127.0.0.1:1080", "proxied"],
      ["SOCKS 127.0.0.1:1080", "proxied"],
      ["HTTPS proxy.example:443", "proxied"],
      ["SOCKS5 a.example:1, PROXY b.example:2", "proxied"],
      ["PROXY 127.0.0.1:7890; PROXY 127.0.0.1:7891", "proxied"],
      ["PROXY 127.0.0.1:7890; DIRECT", "unknown"],
      ["DIRECT; PROXY 127.0.0.1:7890", "unknown"],
      ["", "unknown"],
      ["   ", "unknown"],
      ["MAGIC 127.0.0.1:7890", "unknown"],
      ["PROXY", "unknown"],
      ["PROXY 127.0.0.1:7890; MAGIC x", "unknown"],
      [undefined, "unknown"],
      [null, "unknown"],
      [7890, "unknown"],
    ];
    for (const [proxyList, route] of cases) {
      expect(classifyProxyRoute(proxyList), JSON.stringify(proxyList)).toBe(route);
    }
  });

  it("accepts only the resolver artifact on a proxied route", () => {
    // `benchmark` is a TUN fake-IP answer: an address this app never dials when
    // it is dialing a proxy. Every class that names a real internal target still
    // refuses on both routes, and a direct (or unreadable) route keeps the
    // original rule for all of them.
    expect(isAcceptableResolvedAddress("public", "direct")).toBe(true);
    expect(isAcceptableResolvedAddress("public", "proxied")).toBe(true);
    expect(isAcceptableResolvedAddress("public", "unknown")).toBe(true);
    expect(isAcceptableResolvedAddress("benchmark", "proxied")).toBe(true);
    expect(isAcceptableResolvedAddress("benchmark", "direct")).toBe(false);
    expect(isAcceptableResolvedAddress("benchmark", "unknown")).toBe(false);
    for (const kind of [
      "invalid",
      "unspecified",
      "loopback",
      "private",
      "cgnat",
      "link-local",
      "multicast",
      "reserved",
      "documentation",
      "ula",
      "site-local",
    ] as const) {
      expect(isAcceptableResolvedAddress(kind, "proxied"), kind).toBe(false);
    }
  });

  it("carries the judged route, and drops an unknown one", () => {
    expect(
      publicNetworkRefusalDetail({
        name: PUBLIC_NETWORK_POLICY_ERROR,
        reason: "non-public-address",
        host: "cdn.jsdelivr.net",
        address: "198.18.0.4",
        addressKind: "benchmark",
        route: "direct",
      }),
    ).toEqual({
      reason: "non-public-address",
      host: "cdn.jsdelivr.net",
      address: "198.18.0.4",
      addressKind: "benchmark",
      route: "direct",
    });
    expect(
      publicNetworkRefusalDetail({
        name: PUBLIC_NETWORK_POLICY_ERROR,
        reason: "resolve-failed",
        host: "api.github.com",
        route: "made-up",
      }),
    ).toEqual({ reason: "resolve-failed", host: "api.github.com" });
    expect(
      publicNetworkRefusalDetail({
        name: PUBLIC_NETWORK_POLICY_ERROR,
        reason: "url-syntax",
        route: "proxied",
      }),
    ).toEqual({ reason: "url-syntax", route: "proxied" });
  });
});
