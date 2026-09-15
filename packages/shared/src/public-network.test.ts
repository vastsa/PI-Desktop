import { describe, expect, it } from "vitest";
import {
  classifyIpAddress,
  classifyIpLiteral,
  isPublicHttpsUrl,
  isPublicIpLiteral,
  PUBLIC_NETWORK_POLICY_ERROR,
  isPublicHostname,
  isPublicNetworkPolicyFailure,
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
});
