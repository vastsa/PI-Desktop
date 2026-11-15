import { Buffer } from "node:buffer";
import type { PluginNetCapabilities, PluginNetFetchInput, PluginNetFetchResult } from "@pi-desktop/plugin-sdk";

const MAX_PLUGIN_BINARY_BODY_BYTES = 16 * 1024 * 1024;
const MAX_BINARY_BASE64_LENGTH = Math.ceil(MAX_PLUGIN_BINARY_BODY_BYTES / 3) * 4;

/** Preserve untrusted body fields until the shared transport validates them. */
export type PluginNetFetchRequest = Omit<PluginNetFetchInput, "body" | "bodyBase64" | "redirect"> & {
  body?: unknown;
  bodyBase64?: unknown;
  redirect?: unknown;
};

export function pluginNetCapabilities(): PluginNetCapabilities {
  return {
    fetchRedirectModes: ["follow", "error", "manual"],
    binaryRequestBody: true,
    maxBinaryBodyBytes: MAX_PLUGIN_BINARY_BODY_BYTES,
  };
}

/** A single HTTP exchange. Transports must honor manual redirects and abort. */
export type PluginFetchTransport = (url: string, init: RequestInit) => Promise<Response>;

export function parseFetchRedirect(value: unknown): "follow" | "error" | "manual" {
  if (value === undefined) return "follow";
  if (value === "follow" || value === "error" || value === "manual") return value;
  throw failure("INVALID_ARGUMENT", "redirect must be follow, error, or manual");
}

function failure(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function parseFetchBody(input: PluginNetFetchRequest): string | Buffer<ArrayBuffer> | undefined {
  const { body, bodyBase64 } = input;
  if (bodyBase64 === undefined) {
    if (body !== undefined && typeof body !== "string") {
      throw failure("INVALID_ARGUMENT", "body must be a string");
    }
    return body;
  }
  if (body !== undefined) {
    throw failure("INVALID_ARGUMENT", "body and bodyBase64 are mutually exclusive");
  }
  if (typeof bodyBase64 !== "string" || bodyBase64.length % 4 !== 0) {
    throw failure("INVALID_ARGUMENT", "bodyBase64 must be canonical Base64");
  }
  // Bound both representations before allocating the decoded buffer.
  const padding = bodyBase64.endsWith("==") ? 2 : bodyBase64.endsWith("=") ? 1 : 0;
  const decodedLength = bodyBase64.length / 4 * 3 - padding;
  if (bodyBase64.length > MAX_BINARY_BASE64_LENGTH || decodedLength > MAX_PLUGIN_BINARY_BODY_BYTES) {
    throw failure("INVALID_ARGUMENT", "bodyBase64 exceeds the 16 MiB decoded limit");
  }
  const decoded = Buffer.from(bodyBase64, "base64");
  // Buffer tolerates whitespace, URL-safe symbols and nonzero padding bits.
  // A round trip enforces the standard alphabet, padding and canonical bits.
  if (decoded.toString("base64") !== bodyBase64) {
    throw failure("INVALID_ARGUMENT", "bodyBase64 must be canonical Base64");
  }
  return decoded;
}

/** One deadline and one policy owner for every transport and redirect hop. */
export async function pluginNetFetch(
  input: PluginNetFetchRequest,
  assertEgress: (url: string) => void,
  transport: PluginFetchTransport = fetch,
): Promise<{ url: string; result: PluginNetFetchResult }> {
  const redirect = parseFetchRedirect(input.redirect);
  const body = parseFetchBody(input);
  if (!/^https?:\/\//i.test(input.url)) {
    throw failure("INVALID_ARGUMENT", "only http(s) URLs allowed");
  }
  assertEgress(input.url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 15000);
  try {
    let url = input.url;
    for (let hop = 0; ; hop += 1) {
      const res = await transport(url, {
        method: input.method ?? "GET",
        headers: input.headers,
        body,
        redirect: "manual",
        signal: controller.signal,
      });
      const isRedirect = res.status >= 300 && res.status <= 399;
      const location = res.headers.get("location");
      if (isRedirect && redirect === "error") {
        await res.body?.cancel();
        throw failure("REDIRECT_DISALLOWED", "net.fetch redirect policy refused a 3xx response");
      }
      if (isRedirect && redirect === "follow" && location) {
        await res.body?.cancel();
        if (hop >= 5) throw failure("UNAVAILABLE", "too many redirects");
        url = new URL(location, url).toString();
        assertEgress(url);
        continue;
      }
      const headers: Record<string, string> = {};
      res.headers.forEach((value, key) => { headers[key] = value; });
      const bodyText = await res.text();
      return { url, result: { status: res.status, headers, bodyText } };
    }
  } catch (error) {
    if (controller.signal.aborted) throw failure("TIMEOUT", "net.fetch timed out");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
