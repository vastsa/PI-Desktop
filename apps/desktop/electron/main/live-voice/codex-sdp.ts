const MAX_SDP_BYTES = 256 * 1024;

function protocolError(message: string): Error & { errorCode: string } {
  return Object.assign(new Error(message), { errorCode: "LIVE_PROTOCOL_ERROR" });
}

export function normalizeCodexSdp(value: string, maxBytes = MAX_SDP_BYTES): string {
  if (Buffer.byteLength(value, "utf8") > maxBytes || value.includes("\0")) {
    throw protocolError("Live provider SDP is invalid or too large");
  }
  const lines = value.trim().replace(/\r\n?/g, "\n").split("\n");
  while (lines.at(-1) === "") lines.pop();
  if (!lines.length || lines[0] !== "v=0") throw protocolError("Live provider returned an invalid SDP version");
  return `${lines.join("\r\n")}\r\n`;
}

export function extractCodexSdpAnswer(raw: string): string {
  if (Buffer.byteLength(raw, "utf8") > MAX_SDP_BYTES || raw.includes("\0")) {
    throw protocolError("Live provider SDP answer is invalid or too large");
  }
  const trimmed = raw.trim();
  let candidate = trimmed;
  if (!trimmed.startsWith("v=0")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      throw protocolError("Live provider returned an invalid SDP answer");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw protocolError("Live provider returned an invalid SDP answer");
    }
    const record = parsed as Record<string, unknown>;
    if (Object.keys(record).length !== 1 || typeof record.sdp !== "string") {
      throw protocolError("Live provider returned an invalid SDP answer");
    }
    candidate = record.sdp;
  }
  return normalizeCodexSdp(candidate);
}

export async function readResponseTextBounded(response: Response, maxBytes = MAX_SDP_BYTES): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let size = 0;
  let result = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        result += decoder.decode();
        return result;
      }
      size += chunk.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw protocolError("Live provider SDP answer is too large");
      }
      result += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}
