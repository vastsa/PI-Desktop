import { ErrorCodes } from "@pi-desktop/shared";

export type SpeechHttpBody =
  | { type: "json"; value: unknown }
  | { type: "multipart"; fields?: Record<string, string>; fileField?: string }
  | { type: "raw"; mimeType: string; bytes: Uint8Array };

export type SpeechHttpParse =
  | "bytes"
  | "json-text"
  | "json-path"
  | "openai-transcription"
  | "openai-chat-audio";

export type SpeechHttpCall = {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: SpeechHttpBody;
  parse: SpeechHttpParse;
  jsonPath?: string;
};

export type SpeechHttpContext = {
  apiKey?: string;
  audio?: { filename: string; mimeType: string; bytes: Uint8Array };
  fetchImpl?: typeof fetch;
};

export type SpeechHttpResult =
  | { kind: "text"; text: string }
  | { kind: "audio"; mimeType: string; bytes: Uint8Array };

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { errorCode: code });
}

export function joinProviderUrl(baseUrl: string, path = ""): string {
  if (/^https?:\/\//i.test(path)) return path;
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(path.replace(/^\//, ""), base).href;
}

export function assertSameOrigin(baseUrl: string, url: string): void {
  let expected: URL;
  let actual: URL;
  try {
    expected = new URL(baseUrl);
    actual = new URL(url);
  } catch {
    fail(ErrorCodes.INVALID_ARGUMENT, "speech request URL is invalid");
  }
  if (expected.protocol !== actual.protocol || expected.host !== actual.host) {
    fail(ErrorCodes.INVALID_ARGUMENT, "speech request URL must stay on the provider origin");
  }
}

function headerMap(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

function readPath(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const part of path.split(".").filter(Boolean)) {
    if (!current || typeof current !== "object" || Array.isArray(current) && !/^\d+$/.test(part)) {
      if (Array.isArray(current) && /^\d+$/.test(part)) {
        current = current[Number(part)];
        continue;
      }
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function decodeBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64"));
}

function asBodyBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

async function parseBody(
  response: Response,
  call: SpeechHttpCall,
): Promise<SpeechHttpResult> {
  const mimeType = headerMap(response.headers)["content-type"]?.split(";")[0]?.trim() || "application/octet-stream";
  if (call.parse === "bytes") {
    return { kind: "audio", mimeType, bytes: new Uint8Array(await response.arrayBuffer()) };
  }
  const json = (await response.json()) as unknown;
  if (call.parse === "json-text" || call.parse === "openai-transcription") {
    const text =
      typeof (json as { text?: unknown })?.text === "string"
        ? (json as { text: string }).text
        : typeof (json as { transcript?: unknown })?.transcript === "string"
          ? (json as { transcript: string }).transcript
          : undefined;
    if (!text?.trim()) fail(ErrorCodes.PROVIDER_ERROR, "speech response had no text");
    return { kind: "text", text: text.trim() };
  }
  if (call.parse === "json-path") {
    const path = call.jsonPath?.trim();
    if (!path) fail(ErrorCodes.INVALID_ARGUMENT, "speech jsonPath is required");
    const found = readPath(json, path);
    if (typeof found !== "string" || !found.trim()) {
      fail(ErrorCodes.PROVIDER_ERROR, "speech response path was empty");
    }
    return { kind: "text", text: found.trim() };
  }
  const data = readPath(json, call.jsonPath?.trim() || "choices.0.message.audio.data");
  if (typeof data !== "string" || !data.trim()) {
    fail(ErrorCodes.PROVIDER_ERROR, "speech response had no audio");
  }
  return { kind: "audio", mimeType: "audio/wav", bytes: decodeBase64(data.trim()) };
}

export async function executeSpeechHttp(
  call: SpeechHttpCall,
  context: SpeechHttpContext = {},
): Promise<SpeechHttpResult> {
  const headers = new Headers();
  for (const [key, value] of Object.entries(call.headers ?? {})) {
    if (key.toLowerCase() === "authorization") continue;
    headers.set(key, value);
  }
  if (context.apiKey) headers.set("Authorization", `Bearer ${context.apiKey}`);

  let body: BodyInit | undefined;
  const spec = call.body;
  if (spec?.type === "json") {
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
    body = JSON.stringify(spec.value ?? {});
  } else if (spec?.type === "raw") {
    if (!headers.has("content-type")) headers.set("content-type", spec.mimeType);
    body = asBodyBytes(spec.bytes);
  } else if (spec?.type === "multipart") {
    const form = new FormData();
    for (const [key, value] of Object.entries(spec.fields ?? {})) form.append(key, value);
    if (spec.fileField) {
      const audio = context.audio;
      if (!audio) fail(ErrorCodes.INVALID_ARGUMENT, "speech audio file is required");
      form.append(
        spec.fileField,
        new Blob([asBodyBytes(audio.bytes)], { type: audio.mimeType || "application/octet-stream" }),

        audio.filename || "audio.wav",
      );
    }
    body = form;
  }

  const fetchImpl = context.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(call.url, {
      method: call.method ?? "POST",
      headers,
      body,
    });
  } catch (error) {
    fail(ErrorCodes.NETWORK_ERROR, error instanceof Error ? error.message : "speech request failed");
  }
  if (response.status === 401 || response.status === 403) {
    fail(ErrorCodes.PROVIDER_UNAUTHORIZED, `speech provider returned ${response.status}`);
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 300);
    fail(ErrorCodes.PROVIDER_ERROR, detail || `speech provider returned ${response.status}`);
  }
  return parseBody(response, call);
}
