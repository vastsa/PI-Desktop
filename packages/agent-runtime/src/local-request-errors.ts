/**
 * Structural compatibility with pi-ai's local request errors and wire metadata.
 *
 * Provenance is exactly `code` plus a known `phase`: pi-ai's own reader accepts
 * nothing else, and the `message` it reports comes from its fixed table rather
 * than from the payload. The same rule holds here — a local failure's own text
 * can carry prompt, path or credential material, so it is never copied out.
 */
export type LocalRequestPhase =
  | "context-validation"
  | "context-estimation"
  | "request-preparation";

export type LocalRequestErrorDetails = {
  code: "LOCAL_REQUEST_ERROR";
  phase: LocalRequestPhase;
  message: string;
  causeName?: string;
};

const LOCAL_MESSAGES: Record<LocalRequestPhase, string> = {
  "context-validation": "Local request context validation failed.",
  "context-estimation": "Local request context estimation failed.",
  "request-preparation": "Local request preparation failed.",
};

// Error names are mutable free text too. Only known diagnostic names may cross
// the UI boundary; custom names and all messages/stacks stay on the local cause.
const SAFE_CAUSE_NAMES = new Set([
  "Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError",
  "URIError", "EvalError", "AggregateError", "AbortError", "LocalRequestError",
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? value as Record<string, unknown>
    : undefined;
}

function isLocalRequestPhase(value: unknown): value is LocalRequestPhase {
  return (
    value === "context-validation" ||
    value === "context-estimation" ||
    value === "request-preparation"
  );
}

/**
 * pi-ai's own acceptance rule, no wider: `code` plus a known `phase`. `message`
 * is deliberately not part of it (upstream synthesizes that field too), so
 * phase-only details are still explicit provenance instead of something to be
 * second-guessed. Everything else in the payload is ignored, not interpreted.
 */
function readDetails(value: unknown): LocalRequestErrorDetails | undefined {
  const detail = record(value);
  if (
    detail?.code !== "LOCAL_REQUEST_ERROR" ||
    !isLocalRequestPhase(detail.phase)
  ) return undefined;
  // Upstream carries the wrapped failure as `cause` (an Error) on the raw
  // marker and as the flat `causeName` once normalized; both name one original.
  const causeName = detail.causeName ?? record(detail.cause)?.name;
  return {
    code: "LOCAL_REQUEST_ERROR",
    phase: detail.phase,
    message: LOCAL_MESSAGES[detail.phase],
    ...(typeof causeName === "string" && SAFE_CAUSE_NAMES.has(causeName)
      ? { causeName } : {}),
  };
}

/**
 * Never infer local origin from error wording, constructor names or TypeError.
 * Accept only pi-ai's explicit code/phase marker, either on the original error
 * or on the AssistantMessage.errorDetails the adapters attach. The cause
 * traversal is bounded and cycle-safe so a wrapped marker is still found without
 * ever interpreting an arbitrary provider response body.
 */
export function readLocalRequestErrorDetails(error: unknown): LocalRequestErrorDetails | undefined {
  let current = record(error);
  const seen = new Set<object>();
  for (let depth = 0; current && depth < 6 && !seen.has(current); depth += 1) {
    seen.add(current);
    const details = readDetails(current.errorDetails) ?? readDetails(current);
    if (details) return details;
    current = record(current.cause);
  }
  return undefined;
}
