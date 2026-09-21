import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent, fetch as fetchPinned } from "undici";

export const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
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

/** Deny non-public destinations, including mapped IPv6 and cloud metadata. */
export function publicImageAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (isIP(address) === 6) {
    const lower = address.toLowerCase();
    return (
      /^[23][0-9a-f]{3}:/.test(lower) && !lower.startsWith("2001:") && !lower.startsWith("2002:")
    );
  }
  return false;
}

/** Pin the checked DNS answer to the connection; never forward provider headers. */
export async function downloadGeneratedImage(
  raw: string,
  signal: AbortSignal,
): Promise<Uint8Array> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw imageError("IMAGE_INVALID_URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443")
  ) {
    throw imageError("IMAGE_INVALID_URL");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const answers = await lookup(hostname, { all: true });
  signal.throwIfAborted();
  if (!answers.length || answers.some((answer) => !publicImageAddress(answer.address)))
    throw imageError("IMAGE_UNSAFE_URL");
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
