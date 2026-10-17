/** Metadata probes are replayable; agent turns and plugin requests are not. */
export type ProviderMetadataRequest = {
  method?: "GET" | "OPTIONS";
  headers?: Record<string, string>;
  signal: AbortSignal;
  redirect: "manual";
};

export type ProviderMetadataFetch = (
  url: string,
  init: ProviderMetadataRequest,
) => Promise<Response>;

export function createProviderMetadataFetch(
  primary: ProviderMetadataFetch,
  withoutClientCertificate: ProviderMetadataFetch,
): ProviderMetadataFetch {
  return async (url, init) => {
    try {
      return await primary(url, init);
    } catch (error) {
      // Electron 43 drops the certificate responder before sending HTTP.
      // Never retry unrelated TLS failures, HTTP errors or cancelled work.
      if (
        !(error instanceof Error) ||
        error.message !== "net::ERR_SSL_CLIENT_AUTH_CERT_NEEDED" ||
        new URL(url).protocol !== "https:" ||
        (init.method !== undefined && init.method !== "GET" && init.method !== "OPTIONS")
      ) throw error;
      init.signal.throwIfAborted();
      return withoutClientCertificate(url, init);
    }
  };
}

export const fetchProviderMetadata = createProviderMetadataFetch(
  (url, init) => fetch(url, init),
  async (url, init) => {
    const { fetchProviderWithoutClientCertificate } = await import("./provider-certificate-retry");
    init.signal.throwIfAborted();
    return fetchProviderWithoutClientCertificate(url, init);
  },
);
