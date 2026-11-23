import type { PluginNetFetchInput, PluginNetFetchResult } from "@pi-desktop/plugin-sdk";

export const MAX_PLUGIN_BINARY_RESPONSE_BYTES = 16 * 1024 * 1024;

/** A single HTTP exchange. Transports must honor manual redirects and abort. */
export type PluginFetchTransport = (url: string, init: RequestInit) => Promise<Response>;

function failure(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

export function parseFetchRedirect(value: unknown): "follow" | "error" | "manual" {
  if (value === undefined) return "follow";
  if (value === "follow" || value === "error" || value === "manual") return value;
  throw failure("INVALID_ARGUMENT", "redirect must be follow, error, or manual");
}

function parseResponseType(value: unknown): "text" | "base64" {
  if (value === undefined || value === "text") return "text";
  if (value === "base64") return "base64";
  throw failure("INVALID_ARGUMENT", "responseType must be text or base64");
}

function parseResponseLimit(value: unknown, responseType: "text" | "base64"): number {
  if (value === undefined) return MAX_PLUGIN_BINARY_RESPONSE_BYTES;
  if (responseType !== "base64" || typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > MAX_PLUGIN_BINARY_RESPONSE_BYTES) {
    throw failure("INVALID_ARGUMENT", "maxResponseBytes is only supported for bounded base64 responses");
  }
  return value;
}

async function readBinaryBody(response: Response, limit: number): Promise<Buffer> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
    await response.body?.cancel();
    throw failure("RESPONSE_TOO_LARGE", "binary response exceeds the declared size limit");
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = Buffer.from(next.value);
      total += chunk.length;
      if (total > limit) {
        await reader.cancel();
        throw failure("RESPONSE_TOO_LARGE", "binary response exceeds the size limit");
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

/** One deadline and one policy owner for every transport and redirect hop. */
export async function pluginNetFetch(
  input: PluginNetFetchInput,
  assertEgress: (url: string) => void,
  transport: PluginFetchTransport = fetch,
): Promise<{ url: string; result: PluginNetFetchResult }> {
  const redirect = parseFetchRedirect(input.redirect);
  const responseType = parseResponseType(input.responseType);
  const maxResponseBytes = parseResponseLimit(input.maxResponseBytes, responseType);
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
        body: input.body,
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
      if (responseType === "base64") {
        const bytes = await readBinaryBody(res, maxResponseBytes);
        return { url, result: { status: res.status, headers, bodyText: "", bodyBase64: bytes.toString("base64"), contentType: headers["content-type"] ?? "application/octet-stream", byteLength: bytes.length } };
      }
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
