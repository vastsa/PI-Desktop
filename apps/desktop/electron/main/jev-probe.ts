/**
 * TypeSafe reachability check for the Jev classifier key.
 *
 * Jev is configured from settings, where a wrong or expired key would
 * otherwise be discovered by the Agent mid-task. The check is the smallest
 * real System One round trip — one boolean question over a one-field state —
 * against the same address and classifier id the Agent's `JevClassify` tool
 * uses, so "the key works" means TypeSafe answered this key, not that the
 * string looks plausible.
 *
 * Nothing is written here: the caller stores the key only when this answered.
 * The key never reaches a log line or an error message; failure text is
 * redacted before it is returned.
 */
import {
  TYPESAFE_JEV_MODEL_ID,
  TYPESAFE_SYSTEM_ONE_URL,
  type JevKeyCheckResult,
} from "@pi-desktop/shared";

export const JEV_PROBE_TIMEOUT_MS = 20_000;

/** Longest provider message echoed back to the settings dialog. */
const MAX_DETAIL_LENGTH = 300;

export type JevProbeOptions = {
  /** The caller's own cancellation, combined with the timeout. */
  signal?: AbortSignal;
  /** Test seam; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

/**
 * The smallest valid System One request: `bool` is PI-Desktop's public name for
 * the wire-level `noul` question (see pi-ai's System One transport).
 */
function probeRequestBody() {
  return {
    model: TYPESAFE_JEV_MODEL_ID,
    state: { probe: true },
    questions: {
      reachable: {
        type: "noul",
        instructions: "Did this request reach the classifier?",
        criteria: {
          true: "The request reached the classifier.",
          false: "The request did not reach the classifier.",
        },
      },
    },
  };
}

/** A message that never carries the credential it describes. */
function redact(value: string, apiKey: string): string {
  if (!apiKey) return value;
  return value.split(apiKey).join("[redacted]");
}

export async function probeJevApiKey(
  apiKey: string,
  options: JevProbeOptions = {},
): Promise<JevKeyCheckResult> {
  const key = apiKey.trim();
  if (!key) return { ok: false, message: "No TypeSafe API key was provided." };
  const timeoutMs = options.timeoutMs ?? JEV_PROBE_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  try {
    const response = await doFetch(TYPESAFE_SYSTEM_ONE_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(probeRequestBody()),
      signal,
    });
    if (response.ok) return { ok: true, status: response.status };
    const body = await response.text().catch(() => "");
    const detail = redact(body.slice(0, MAX_DETAIL_LENGTH).trim(), key);
    return {
      ok: false,
      status: response.status,
      message: detail
        ? `TypeSafe returned ${response.status}: ${detail}`
        : `TypeSafe returned ${response.status}`,
    };
  } catch (error) {
    if (options.signal?.aborted) {
      return { ok: false, message: "The TypeSafe key check was cancelled." };
    }
    const name = (error as { name?: unknown }).name;
    if (name === "TimeoutError" || name === "AbortError") {
      return {
        ok: false,
        message: `TypeSafe did not answer within ${Math.round(timeoutMs / 1000)}s.`,
      };
    }
    return { ok: false, message: redact(error instanceof Error ? error.message : String(error), key) };
  }
}
