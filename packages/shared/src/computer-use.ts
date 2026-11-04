/**
 * Public, host-authoritative contracts for computer use (ADR 0342).
 *
 * Nothing here carries authority by itself. The grant is minted by host-core
 * from a target the user picked, and every field a caller could forge — the
 * target, the revision, the budget — is re-read from the host before an action
 * runs. These types exist so main, the renderer, and the loop agree on the
 * shape of what the host already decided.
 */

/** Settings-level capture choice. `a11y-only` never takes a pixel. */
export type ComputerCaptureMode = "a11y-only" | "a11y-and-pixels";

/**
 * Per-grant input policy. `confirm-each` raises an approval card for every
 * input step and is the only policy available under permission mode `ask`.
 */
export type ComputerInputPolicy = "confirm-each" | "autonomous-in-scope";

/** One `{ providerId, modelId }` the user picked, as in `imageGeneration`. */
export type ComputerModelBinding = { providerId: string; modelId: string };

export type ComputerUseSettings = {
  enabled: boolean;
  /** Absent means unconfigured; the tool refuses rather than falling back. */
  model?: ComputerModelBinding | null;
  defaultInputPolicy?: ComputerInputPolicy;
  defaultCapture?: ComputerCaptureMode;
  /**
   * User-added application identifiers that may never be targeted. The
   * built-in credential-surface entries live in host-core and are not listed
   * here, because a settings write must not be able to remove them.
   */
  denylist?: string[];
  /** Hard ceiling on input actions per grant; the host clamps its own bound. */
  actionBudget?: number;
  /** Idle milliseconds before a grant closes itself. */
  idleExpiryMs?: number;
};

export const COMPUTER_USE_DEFAULTS = {
  inputPolicy: "confirm-each",
  capture: "a11y-only",
  /** One instruction rarely needs more; a runaway loop should hit this. */
  actionBudget: 40,
  idleExpiryMs: 15 * 60_000,
  /** Clamp for a single `Computer` call, independent of the grant budget. */
  maxStepsPerCall: 12,
} as const satisfies {
  inputPolicy: ComputerInputPolicy;
  capture: ComputerCaptureMode;
  actionBudget: number;
  idleExpiryMs: number;
  maxStepsPerCall: number;
};

export const COMPUTER_ACTION_BUDGET_LIMIT = 200;
/**
 * Ceiling on one `Computer` call. The loop makes a model request per step, so
 * the default RPC timeout would cut a legitimate multi-step task short.
 */
export const COMPUTER_CALL_TIMEOUT_MS = 10 * 60_000;
export const COMPUTER_MAX_STEPS_LIMIT = 40;
/** Bound on the tree a single `inspect` returns, so one call cannot flood. */
export const COMPUTER_MAX_NODES = 400;
/** Bound on one element label, so a hostile window cannot pad the context. */
export const COMPUTER_MAX_LABEL_CHARS = 200;
/** Bound on text the loop may type in one step. */
export const COMPUTER_MAX_TEXT_CHARS = 2_000;

export function validateComputerUseSettings(value: unknown): ComputerUseSettings {
  const invalid = (): never => {
    throw Object.assign(new Error("computerUse settings are invalid"), {
      errorCode: "INVALID_PARAMS",
    });
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const input = value as Record<string, unknown>;
  const allowed = [
    "enabled",
    "model",
    "defaultInputPolicy",
    "defaultCapture",
    "denylist",
    "actionBudget",
    "idleExpiryMs",
  ];
  if (Object.keys(input).some((key) => !allowed.includes(key))) return invalid();
  if (typeof input.enabled !== "boolean") return invalid();

  const cleanId = (item: unknown, maxLength = 256): string => {
    if (typeof item !== "string" || !item.trim() || item.trim() !== item || item.length > maxLength) {
      return invalid();
    }
    return item;
  };

  const result: ComputerUseSettings = { enabled: input.enabled };

  if (input.model !== undefined && input.model !== null) {
    if (!input.model || typeof input.model !== "object" || Array.isArray(input.model)) return invalid();
    const model = input.model as Record<string, unknown>;
    if (Object.keys(model).some((key) => !["providerId", "modelId"].includes(key))) return invalid();
    result.model = { providerId: cleanId(model.providerId), modelId: cleanId(model.modelId) };
  } else if (input.model === null) {
    result.model = null;
  }

  if (input.defaultInputPolicy !== undefined) {
    if (input.defaultInputPolicy !== "confirm-each" && input.defaultInputPolicy !== "autonomous-in-scope") {
      return invalid();
    }
    result.defaultInputPolicy = input.defaultInputPolicy;
  }
  if (input.defaultCapture !== undefined) {
    if (input.defaultCapture !== "a11y-only" && input.defaultCapture !== "a11y-and-pixels") return invalid();
    result.defaultCapture = input.defaultCapture;
  }
  if (input.denylist !== undefined) {
    if (!Array.isArray(input.denylist) || input.denylist.length > 200) return invalid();
    result.denylist = input.denylist.map((entry) => cleanId(entry));
  }
  if (input.actionBudget !== undefined) {
    if (
      typeof input.actionBudget !== "number"
      || !Number.isInteger(input.actionBudget)
      || input.actionBudget < 1
      || input.actionBudget > COMPUTER_ACTION_BUDGET_LIMIT
    ) {
      return invalid();
    }
    result.actionBudget = input.actionBudget;
  }
  if (input.idleExpiryMs !== undefined) {
    if (
      typeof input.idleExpiryMs !== "number"
      || !Number.isInteger(input.idleExpiryMs)
      || input.idleExpiryMs < 30_000
      || input.idleExpiryMs > 60 * 60_000
    ) {
      return invalid();
    }
    result.idleExpiryMs = input.idleExpiryMs;
  }
  return result;
}

/** Why a listed target cannot be picked. Listed, never silently dropped. */
export type ComputerTargetRefusal = "self" | "denylisted" | "elevated" | "no-accessibility";

export type ComputerTarget = {
  targetId: string;
  appName: string;
  title: string;
  /** Bundle id, process name, or WM class — whatever the platform can prove. */
  appKey: string;
  bounds: ComputerRect;
  refusedReason?: ComputerTargetRefusal;
};

export type ComputerRect = { x: number; y: number; width: number; height: number };

/**
 * How much of the real UI the platform backend can see. A backend that can
 * only enumerate top-level windows reports `partial` so an empty result is not
 * mistaken for an empty window.
 */
export type ComputerFidelity = "full" | "partial" | "none";

export type ComputerPermissionState = "granted" | "denied" | "not-requested" | "unsupported";

export type ComputerCapabilities = {
  platform: "darwin" | "win32" | "linux" | "other";
  backend: "macos-ax" | "windows-uia" | "linux-atspi" | "unsupported";
  fidelity: ComputerFidelity;
  /** Native inspection/synthesis permission (macOS Accessibility, AT-SPI bus). */
  accessibility: ComputerPermissionState;
  /** Desktop app's own TCC grant, for display only; never authorizes native input. */
  applicationAccessibility?: ComputerPermissionState;
  /** Window capture permission, as far as the host can tell before trying. */
  capture: ComputerPermissionState;
  /** `wayland` refuses input by contract; `x11` is best effort. */
  sessionType?: "x11" | "wayland" | "unknown";
  /** Present when the backend exists but cannot act — e.g. Wayland input. */
  inputUnsupportedReason?: string;
};

/** Only the macOS backend currently implements an explicit OS trust request. */
export function needsAccessibilityRequest(capabilities: ComputerCapabilities): boolean {
  const permission = capabilities.applicationAccessibility ?? capabilities.accessibility;
  return capabilities.platform === "darwin"
    && capabilities.backend === "macos-ax"
    && (permission === "not-requested" || permission === "denied");
}

export type ComputerGrantView = {
  grantId: string;
  /** Bumped whenever the measured target geometry or identity changes. */
  revision: number;
  targetId: string;
  targetLabel: string;
  appKey: string;
  bounds: ComputerRect;
  inputPolicy: ComputerInputPolicy;
  capture: ComputerCaptureMode;
  /** Input actions left before the grant closes itself. */
  remainingBudget: number;
  /** Session that owns the grant; a second session is refused, not queued. */
  sessionId: string;
  createdAt: string;
  expiresAt: string;
  state: "active" | "revoked" | "expired";
};

export type ComputerNode = {
  uid: string;
  role: string;
  /** Accessible name, truncated. Absent when the platform exposes none. */
  label?: string;
  /** Whether a value exists — never the value itself (ADR 0342 §3). */
  hasValue: boolean;
  enabled: boolean;
  focused: boolean;
  bounds?: ComputerRect;
  /** Index of the parent in the same array; absent for the scope root. */
  parent?: number;
  /** Platform actions this element offers, already filtered to ours. */
  actions: ComputerActionKind[];
};

export type ComputerInspection = {
  grantId: string;
  revision: number;
  bounds: ComputerRect;
  fidelity: ComputerFidelity;
  nodes: ComputerNode[];
  /** True when the tree hit `COMPUTER_MAX_NODES` and was cut. */
  truncated: boolean;
  /** Set when the platform reports a secure input state right now. */
  secureInput: boolean;
};

export type ComputerActionKind =
  | "click"
  | "double_click"
  | "right_click"
  | "set_value"
  | "press_keys"
  | "scroll"
  | "select";

/**
 * The geometry a capture was taken against. A coordinate action carries it so
 * the host can refuse when its own re-measurement disagrees, instead of
 * clicking whatever now occupies those pixels.
 */
export type ComputerBasis = { revision: number; bounds: ComputerRect };

export type ComputerAction = {
  kind: ComputerActionKind;
  /** Element identity from the current inspection. Preferred over `point`. */
  uid?: string;
  /** Scope-relative coordinate; requires `basis` and is clamped to bounds. */
  point?: { x: number; y: number };
  basis?: ComputerBasis;
  text?: string;
  /** Normalized chord list, e.g. `["cmd+a", "delete"]`. */
  keys?: string[];
  scroll?: { dx: number; dy: number };
  option?: string;
};

export type ComputerActResult = {
  grantId: string;
  revision: number;
  remainingBudget: number;
  /** What the backend actually dispatched, for the audit trail and the log. */
  dispatched: "accessibility-action" | "window-event";
};

/** One step the loop completed, as reported back to the user-facing summary. */
export type ComputerStepRecord = {
  index: number;
  action: ComputerActionKind | "observe" | "done" | "ask";
  /** Element label or coordinate description; never a typed value. */
  target?: string;
  ok: boolean;
  errorCode?: string;
};

export type ComputerRunOutcome =
  | "done"
  | "step-limit"
  | "budget-exhausted"
  | "revoked"
  | "expired"
  | "needs-user"
  | "failed";

export type ComputerRunResult = {
  outcome: ComputerRunOutcome;
  /** Assembled from the steps that ran, not copied from model prose. */
  summary: string;
  steps: ComputerStepRecord[];
  /** Present when `outcome` is `needs-user`: what the model wants to ask. */
  question?: string;
  errorCode?: string;
};

/**
 * Draw commands for the cursor overlay. The overlay is a click-through window
 * that visualizes where the agent is acting; it carries no authority, so these
 * payloads are screen coordinates and a label, never an element reference.
 */
export type ComputerCursorEvent =
  | { kind: "show"; grantId: string; bounds: ComputerRect }
  | { kind: "move"; grantId: string; x: number; y: number; label?: string }
  | { kind: "press"; grantId: string; x: number; y: number; action: ComputerActionKind }
  | { kind: "type"; grantId: string; x: number; y: number; chars: number }
  | { kind: "hide"; grantId: string };

/** Agent-facing `Computer` tool arguments. No target, no uid, no coordinate. */
export type ComputerToolArgs = {
  instruction: string;
  maxSteps?: number;
  /** Describe the scope without acting. Needs no input-policy approval. */
  observeOnly?: boolean;
};

export function validateComputerToolArgs(value: unknown): ComputerToolArgs {
  const invalid = (message: string): never => {
    throw Object.assign(new Error(message), { errorCode: "INVALID_PARAMS" });
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalid("Computer expects an object with an instruction");
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !["instruction", "maxSteps", "observeOnly"].includes(key))) {
    return invalid("Computer received an unknown argument");
  }
  const instruction = typeof input.instruction === "string" ? input.instruction.trim() : "";
  if (!instruction || instruction.length > 4_000) {
    return invalid("Computer expects a non-empty instruction under 4000 characters");
  }
  const args: ComputerToolArgs = { instruction };
  if (input.maxSteps !== undefined) {
    if (
      typeof input.maxSteps !== "number"
      || !Number.isInteger(input.maxSteps)
      || input.maxSteps < 1
      || input.maxSteps > COMPUTER_MAX_STEPS_LIMIT
    ) {
      return invalid(`Computer maxSteps must be an integer between 1 and ${COMPUTER_MAX_STEPS_LIMIT}`);
    }
    args.maxSteps = input.maxSteps;
  }
  if (input.observeOnly !== undefined) {
    if (typeof input.observeOnly !== "boolean") return invalid("Computer observeOnly must be a boolean");
    args.observeOnly = input.observeOnly;
  }
  return args;
}
