/** Validation and catalog helpers for host speech bindings. */
import {
  BUILTIN_SPEECH_PROTOCOLS,
  MAX_SPEECH_INPUT_BYTES,
  SPEECH_PROTOCOL_PATTERN,
  SPEECH_ROLES,
  type SpeechBinding,
  type SpeechProtocolInfo,
  type SpeechRole,
  type SpeechSettings,
} from "./types/speech.js";

export {
  BUILTIN_SPEECH_PROTOCOL_IDS,
  BUILTIN_SPEECH_PROTOCOLS,
  MAX_SPEECH_INPUT_BYTES,
  MAX_SPEECH_TTS_DATA_URL_BYTES,
  SPEECH_PROTOCOL_PATTERN,
  SPEECH_ROLES,
} from "./types/speech.js";
export type {
  BuiltinSpeechProtocolId,
  SpeechBinding,
  SpeechProtocolInfo,
  SpeechRole,
  SpeechRoleStatus,
  SpeechSettings,
  SpeechStatus,
  SpeechSynthesizeRequest,
  SpeechSynthesizeResult,
  SpeechTranscribeRequest,
  SpeechTranscribeResult,
} from "./types/speech.js";

const MAX_PROVIDER_ID = 128;
const MAX_MODEL_ID = 256;
const MAX_VOICE = 64;
const MAX_FORMAT = 32;
const MAX_PATH = 256;
const MAX_EXTRA_KEYS = 16;
const MAX_EXTRA_VALUE = 256;

function invalid(message: string): never {
  throw Object.assign(new Error(message), { errorCode: "INVALID_ARGUMENT" });
}

function asTrimmed(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) invalid(`${field} is required`);
  const trimmed = value.trim();
  if (trimmed.length > max) invalid(`${field} is too long`);
  return trimmed;
}

function asOptionalString(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") invalid(`${field} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > max) invalid(`${field} is too long`);
  return trimmed;
}

export function isSpeechProtocolId(value: string): boolean {
  return SPEECH_PROTOCOL_PATTERN.test(value);
}

export function builtinSpeechProtocols(): SpeechProtocolInfo[] {
  return Object.values(BUILTIN_SPEECH_PROTOCOLS).map((entry) => ({
    id: entry.id,
    label: entry.label,
    roles: [...entry.roles],
    source: "builtin",
  }));
}

export function parseSpeechBinding(value: unknown, role: SpeechRole): SpeechBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid(`speech.${role} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const protocol = asTrimmed(record.protocol, `speech.${role}.protocol`, 64);
  if (!isSpeechProtocolId(protocol)) invalid(`speech.${role}.protocol is invalid`);
  const extraRaw = record.extra;
  let extra: Record<string, string> | undefined;
  if (extraRaw !== undefined && extraRaw !== null) {
    if (!extraRaw || typeof extraRaw !== "object" || Array.isArray(extraRaw)) {
      invalid(`speech.${role}.extra must be an object`);
    }
    const entries = Object.entries(extraRaw as Record<string, unknown>);
    if (entries.length > MAX_EXTRA_KEYS) invalid(`speech.${role}.extra has too many keys`);
    extra = {};
    for (const [key, item] of entries) {
      if (!isSpeechProtocolId(key) && !/^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/.test(key)) {
        invalid(`speech.${role}.extra key is invalid`);
      }
      extra[key] = asTrimmed(item, `speech.${role}.extra.${key}`, MAX_EXTRA_VALUE);
    }
  }
  const voice = asOptionalString(record.voice, `speech.${role}.voice`, MAX_VOICE);
  const format = asOptionalString(record.format, `speech.${role}.format`, MAX_FORMAT);
  const path = asOptionalString(record.path, `speech.${role}.path`, MAX_PATH);
  return {
    providerId: asTrimmed(record.providerId, `speech.${role}.providerId`, MAX_PROVIDER_ID),
    modelId: asTrimmed(record.modelId, `speech.${role}.modelId`, MAX_MODEL_ID),
    protocol,
    ...(voice ? { voice } : {}),
    ...(format ? { format } : {}),
    ...(path ? { path } : {}),
    ...(extra ? { extra } : {}),
  };
}

/** Reject malformed `settings.speech`. Absent/empty is a valid unconfigured state. */
export function validateSpeechSettings(value: unknown): SpeechSettings | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) invalid("speech must be an object");
  const record = value as Record<string, unknown>;
  const next: SpeechSettings = {};
  for (const role of SPEECH_ROLES) {
    if (!Object.prototype.hasOwnProperty.call(record, role)) continue;
    const raw = record[role];
    if (raw === undefined || raw === null) continue;
    next[role] = parseSpeechBinding(raw, role);
  }
  return Object.keys(next).length ? next : undefined;
}

export function assertSpeechInputSize(bytes: number): void {
  if (!Number.isFinite(bytes) || bytes < 0) invalid("speech input size is invalid");
  if (bytes > MAX_SPEECH_INPUT_BYTES) {
    throw Object.assign(new Error("speech input is too large"), {
      errorCode: "SPEECH_INPUT_TOO_LARGE",
    });
  }
}
