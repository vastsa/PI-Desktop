import { parseProxyUrl } from "@pi-desktop/shared";
import { socks5Connect } from "@pi-desktop/agent-runtime/proxy-tunnel";
import { ensureSystemProxyRelay } from "./network-proxy";
import { fetchHttpsMetadata } from "./provider-https-metadata";
import type { ProviderMetadataFetch } from "./provider-metadata-fetch";

/** The existing authenticated relay resolves the active Chromium route per URL,
 * including Direct, System/PAC, custom proxies and bypass rules. */
export const fetchProviderWithoutClientCertificate: ProviderMetadataFetch = async (url, init) => {
  init.signal.throwIfAborted();
  const relay = parseProxyUrl(await ensureSystemProxyRelay());
  init.signal.throwIfAborted();
  if (!relay.ok) throw new Error("invalid provider proxy relay");
  return fetchHttpsMetadata(url, init, (host, port) => socks5Connect(relay.value, host, port));
};
