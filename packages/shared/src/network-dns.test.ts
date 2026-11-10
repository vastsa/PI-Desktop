import { describe, expect, it } from "vitest";
import {
  DEFAULT_DOH_SERVER_URL,
  chromiumDnsConfig,
  normalizeNetworkDns,
  validateNetworkDns,
} from "./network-dns.js";

describe("desktop secure DNS settings", () => {
  it("leaves existing installations on system defaults", () => {
    expect(normalizeNetworkDns(undefined)).toEqual({ mode: "system" });
    expect(normalizeNetworkDns(null)).toEqual({ mode: "system" });
    expect(chromiumDnsConfig({ mode: "system" }, "win32")).toEqual({
      enableBuiltInResolver: false,
      secureDnsMode: "automatic",
      secureDnsServers: [],
    });
    expect(chromiumDnsConfig({ mode: "system" }, "darwin").enableBuiltInResolver).toBe(true);
  });

  it("uses an HTTPS IP-literal default and requires explicit plaintext fallback", () => {
    expect(DEFAULT_DOH_SERVER_URL).toBe("https://1.1.1.1/dns-query");
    expect(normalizeNetworkDns({ mode: "doh" })).toEqual({
      mode: "doh", serverUrl: DEFAULT_DOH_SERVER_URL, allowSystemFallback: false,
    });
    expect(chromiumDnsConfig({ mode: "doh" }, "linux")).toEqual({
      enableBuiltInResolver: true,
      secureDnsMode: "secure",
      secureDnsServers: [DEFAULT_DOH_SERVER_URL],
    });
    expect(chromiumDnsConfig({ mode: "doh", allowSystemFallback: true }, "linux").secureDnsMode).toBe("automatic");
  });

  it("retains a custom endpoint and fallback choice while disabled", () => {
    const saved = { mode: "system", serverUrl: " https://resolver.example/dns-query ", allowSystemFallback: true };
    expect(validateNetworkDns(saved)).toEqual({
      ok: true, value: { ...saved, serverUrl: "https://resolver.example/dns-query" },
    });
    expect(chromiumDnsConfig(normalizeNetworkDns(saved), "win32").secureDnsServers).toEqual([]);
  });

  it.each([
    true, [], "doh", { mode: "unknown" }, { mode: 1 },
    { mode: "doh", serverUrl: "http://resolver.example/dns-query" },
    { mode: "doh", serverUrl: "https://user:secret@resolver.example/dns-query" },
    { mode: "doh", serverUrl: "https://resolver.example/dns-query#fragment" },
    { mode: "doh", serverUrl: "https://resolver.example/dns query" },
    { mode: "doh", serverUrl: "https://resolver.example/{?dns}" },
    { mode: "doh", serverUrl: "https://resolver.example/" + "a".repeat(2048) },
    { mode: "doh", serverUrl: 123 },
    { mode: "doh", allowSystemFallback: "yes" },
  ])("rejects invalid writes and safely reads invalid saved data: %j", (value) => {
    expect(validateNetworkDns(value).ok).toBe(false);
    expect(normalizeNetworkDns(value)).toEqual({ mode: "system" });
  });

  it("accepts explicit private HTTPS resolvers without relaxing TLS", () => {
    expect(validateNetworkDns({ mode: "doh", serverUrl: "https://192.168.1.2/dns-query" }).ok).toBe(true);
  });
});
