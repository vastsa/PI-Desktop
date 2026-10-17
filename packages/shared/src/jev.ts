/**
 * Non-secret configuration for the optional Jev System One classifier.
 *
 * The credential remains in Host secure storage. This module owns the endpoint
 * and model identity shared by Settings, Electron main, and agent-runtime so a
 * probe and a real classification can never silently target different places.
 */
import {
  TYPESAFE_JEV_MODEL_ID,
  TYPESAFE_SYSTEM_ONE_BASE_URL,
} from "./secret-refs.js";

export const JEV_SYSTEM_ONE_API_STYLE = "typesafe_system_one" as const;
export const MAX_JEV_BASE_URL_LENGTH = 2_048;
export const MAX_JEV_MODEL_ID_LENGTH = 256;

export type JevClassifierBinding = {
  /** API root. The System One adapter appends `/systemone` exactly once. */
  baseUrl: string;
  /** Exact classifier id sent in the System One request body. */
  modelId: string;
};

/** Ephemeral Main → sidecar configuration; the API key is never persisted here. */
export type JevClassifierRuntimeConfig = JevClassifierBinding & {
  apiKey: string;
};

export const DEFAULT_JEV_CLASSIFIER_BINDING: Readonly<JevClassifierBinding> =
  Object.freeze({
    baseUrl: TYPESAFE_SYSTEM_ONE_BASE_URL,
    modelId: TYPESAFE_JEV_MODEL_ID,
  });

export type JevClassifierBindingResolution =
  | { status: "default"; binding: JevClassifierBinding }
  | { status: "configured"; binding: JevClassifierBinding }
  | { status: "invalid"; error: string };

function normalizedHttpUrl(value: string): URL | undefined {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_JEV_BASE_URL_LENGTH) return undefined;
  if (/^https?:/iu.test(trimmed) && !/^https?:\/\//iu.test(trimmed)) {
    return undefined;
  }
  const withScheme = /^[a-z][a-z\d+.-]*:\/\//iu.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  try {
    const parsed = new URL(withScheme);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
    if (!parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * Canonical API root accepted from the settings field.
 *
 * A pasted operation URL is convenient and unambiguous, so a final
 * `/systemone` segment is removed. Other path segments are preserved exactly;
 * only redundant trailing slashes are dropped.
 */
export function normalizeJevBaseUrl(value: string): string | undefined {
  const parsed = normalizedHttpUrl(value);
  if (!parsed) return undefined;
  let pathname = parsed.pathname.replace(/\/+$/u, "");
  if (/\/systemone$/iu.test(pathname)) {
    pathname = pathname.slice(0, -"/systemone".length).replace(/\/+$/u, "");
  }
  parsed.pathname = pathname || "/";
  const normalized = parsed.toString().replace(/\/$/u, "");
  return normalized || `${parsed.protocol}//${parsed.host}`;
}

/** Exact classifier id after safe input normalization. */
export function normalizeJevModelId(value: string): string | undefined {
  const modelId = value.trim();
  if (
    !modelId ||
    modelId.length > MAX_JEV_MODEL_ID_LENGTH ||
    /[\s\u0000-\u001f\u007f]/u.test(modelId)
  ) {
    return undefined;
  }
  return modelId;
}

/** Validate and normalize an explicit persisted/user-entered binding. */
export function normalizeJevClassifierBinding(
  value: unknown,
): JevClassifierBinding | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 2 ||
    !("baseUrl" in record) ||
    !("modelId" in record)
  ) {
    return undefined;
  }
  if (typeof record.baseUrl !== "string" || typeof record.modelId !== "string") {
    return undefined;
  }
  const baseUrl = normalizeJevBaseUrl(record.baseUrl);
  const modelId = normalizeJevModelId(record.modelId);
  return baseUrl && modelId ? { baseUrl, modelId } : undefined;
}

/**
 * Resolve persisted settings without hiding corruption.
 *
 * Only an absent field means the legacy official TypeSafe default. Once a field
 * exists, invalid data is an error and must not fall back to another endpoint.
 */
export function resolveJevClassifierBinding(
  value: unknown,
): JevClassifierBindingResolution {
  if (value === undefined) {
    return {
      status: "default",
      binding: { ...DEFAULT_JEV_CLASSIFIER_BINDING },
    };
  }
  const binding = normalizeJevClassifierBinding(value);
  return binding
    ? { status: "configured", binding }
    : { status: "invalid", error: "Jev classifier binding is invalid" };
}

/** Absolute operation URL used by both the probe and pi-ai transport. */
export function jevSystemOneUrl(binding: JevClassifierBinding): string {
  return new URL("systemone", `${binding.baseUrl.replace(/\/+$/u, "")}/`).toString();
}

export function isDefaultJevClassifierBinding(binding: JevClassifierBinding): boolean {
  return (
    binding.baseUrl === DEFAULT_JEV_CLASSIFIER_BINDING.baseUrl &&
    binding.modelId === DEFAULT_JEV_CLASSIFIER_BINDING.modelId
  );
}
