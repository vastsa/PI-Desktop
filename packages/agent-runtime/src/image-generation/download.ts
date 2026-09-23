import { lookup } from "node:dns/promises";
import {
  classifyIpLiteral,
  isAcceptableUserEndpointAddress,
  isCloudMetadataAddress,
  isProxyFakeIpAddress,
} from "@pi-desktop/shared";
import { Agent, fetch as fetchPinned } from "undici";

export const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
export type ImageDownloadOptions = {
  /** Explicitly permits router/TUN benchmark fake-IP answers. */
  allowFakeIp?: boolean;
  /** Proxy-aware transport used when a fake-IP answer must be resolved by the proxy. */
  fetchImpl?: typeof fetch;
};
export function imageError(code: string): Error & { errorCode: string } {
  return Object.assign(new Error(code), { errorCode: code });
}

export async function boundedBytes(
  response: Pick<Response, "headers" | "body">,
  max: number,
): Promise<Uint8Array> {
  if (Number(response.headers.get("content-length")) > max) {
    await response.body?.cancel();
    throw imageError("IMAGE_TOO_LARGE");
  }
  if (!response.body) throw imageError("IMAGE_EMPTY_RESPONSE");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > max) throw imageError("IMAGE_TOO_LARGE");
      chunks.push(part.value);
    }
    return Buffer.concat(chunks);
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

/**
 * Whether a resolved address may be dialed for a generated image.
 *
 * The URL comes from the image provider's own response, but the provider is an
 * endpoint the user configured, and a self-hosted one (ComfyUI, SD-WebUI) hands
 * back its own LAN address. Judging it by the third-party rule made those setups
 * unusable, so loopback, RFC1918, CGNAT, link-local, ULA and site-local are all
 * reachable here, and the address classes are taken from `@pi-desktop/shared`
 * rather than re-derived so they cannot drift. Cloud metadata stays refused on
 * every input, as do the classes that name no destination at all (unspecified,
 * multicast, reserved, documentation, benchmark — a fake-IP answer is a proxy
 * placeholder, not a host this process dials).
 */
export function publicImageAddress(address: string): boolean {
  if (typeof address !== "string" || !address) return false;
  if (isCloudMetadataAddress(address)) return false;
  return isAcceptableUserEndpointAddress(address, classifyIpLiteral(address), "direct");
}

/**
 * Pin the checked DNS answer to the connection; never forward provider headers.
 *
 * Plain `http` and any port are accepted because the realistic target is a
 * self-hosted generator on the user's own machine or LAN, where TLS and port
 * 443 are the exception. `@pi-desktop/agent-runtime` has no access to the app's
 * network policy (it must not import Electron main-process modules), so a
 * plaintext hop to a private address cannot be gated on the user's choice here;
 * the trade-off is accepted because the endpoint this dials is the one the user
 * configured, and the response is still size-capped and stripped of
 * provider-supplied headers.
 *
 * An explicitly opted-in fake-IP answer is the one exception: it goes through the
 * global fetch instead, which resolves the hostname again at connect time.
 */
export async function downloadGeneratedImage(
  raw: string,
  signal: AbortSignal,
  options: ImageDownloadOptions = {},
): Promise<Uint8Array> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw imageError("IMAGE_INVALID_URL");
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password
  ) {
    throw imageError("IMAGE_INVALID_URL");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const answers = await lookup(hostname, { all: true });
  signal.throwIfAborted();
  const hasUnsafeAddress = answers.some((answer) => !publicImageAddress(answer.address));
  const hasFakeIp = answers.some((answer) => hasFakeIpAddress(answer.address));
  const onlyFakeIp = answers.length > 0 && answers.every((answer) => hasFakeIpAddress(answer.address));
  if (
    !answers.length ||
    (hasUnsafeAddress && !(options.allowFakeIp === true && hasFakeIp && onlyFakeIp))
  )
    throw imageError("IMAGE_UNSAFE_URL");
  if (options.allowFakeIp === true && hasFakeIp) {
    const response = await (options.fetchImpl ?? fetch)(url, {
      signal,
      redirect: "error",
    });
    if (!response.ok) throw imageError("IMAGE_DOWNLOAD_FAILED");
    return await boundedBytes(response, MAX_IMAGE_BYTES);
  }
  const address = answers[0];
  const dispatcher = new Agent({
    connect: {
      lookup: (_name, options, callback) => {
        if (options.all) callback(null, [address]);
        else callback(null, address.address, address.family);
      },
    },
  });
  try {
    const response = await fetchPinned(url, { signal, redirect: "error", dispatcher });
    if (!response.ok) throw imageError("IMAGE_DOWNLOAD_FAILED");
    return await boundedBytes(response as unknown as Response, MAX_IMAGE_BYTES);
  } finally {
    await dispatcher.destroy();
  }
}

function hasFakeIpAddress(address: string): boolean {
  return isProxyFakeIpAddress(classifyIpLiteral(address));
}

export function generatedImageType(bytes: Uint8Array): { mimeType: string; extension: string } {
  const data = Buffer.from(bytes);
  if (data.length > MAX_IMAGE_BYTES) throw imageError("IMAGE_TOO_LARGE");
  if (
    data.length >= 24 &&
    data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    data.toString("ascii", 12, 16) === "IHDR"
  )
    return { mimeType: "image/png", extension: "png" };
  if (
    data.length > 4 &&
    data[0] === 255 &&
    data[1] === 216 &&
    data[2] === 255 &&
    data[data.length - 2] === 255 &&
    data[data.length - 1] === 217
  )
    return { mimeType: "image/jpeg", extension: "jpg" };
  if (
    data.length >= 16 &&
    data.toString("ascii", 0, 4) === "RIFF" &&
    data.toString("ascii", 8, 12) === "WEBP"
  )
    return { mimeType: "image/webp", extension: "webp" };
  throw imageError("IMAGE_INVALID_CONTENT");
}
