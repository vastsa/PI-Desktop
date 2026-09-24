/**
 * Trusted extensions (D387, ADR 0214, spec 07-plugins/16-trusted-extensions.md).
 *
 * Plain data shared by the renderer, Electron main, and the Agent sidecar.
 */

/** `plugin` is the only source in v1.1: modules come from `contributes.agentExtensions`. */
export type TrustedExtensionSource = "user" | "project" | "manual" | "plugin";

/** One loadable entry, keyed by the realpath of its entry file. */
export type TrustedExtensionSpec = {
  /** Realpath of the entry file. Stable identity for enablement and diagnostics. */
  id: string;
  /** Absolute entry file path as the loader should import it. */
  entry: string;
  /** Short label: package name, directory name, or file stem. */
  label: string;
  source: TrustedExtensionSource;
  /** Directory the entry was discovered from (the extensions root). */
  root: string;
};

export type TrustedExtensionDiagnosticKind =
  | "load_error"
  | "factory_error"
  | "unsupported_api"
  | "stub_symbol"
  | "rejected_registration"
  | "handler_error"
  | "handler_timeout";

export type TrustedExtensionDiagnostic = {
  extensionId: string;
  kind: TrustedExtensionDiagnosticKind;
  message: string;
  /** API member, event name, tool name, or command name the diagnostic is about. */
  member?: string;
  /** How many times the same (extension, kind, member) triple fired. */
  count: number;
  /** Stack of the first occurrence, when the source threw. */
  stack?: string;
};

export type TrustedExtensionCommand = {
  extensionId: string;
  extensionLabel: string;
  name: string;
  description?: string;
};

export type TrustedExtensionLoadState = "loaded" | "error";

export type TrustedExtensionLoadReport = {
  extensionId: string;
  state: TrustedExtensionLoadState;
  toolNames: string[];
  commandNames: string[];
  agentNames: string[];
  eventNames: string[];
};

/** Interactive and status calls the sidecar sends to the desktop (spec §9). */
export type TrustedExtensionUiRequest =
  | { kind: "cancel"; requestId: string }
  | { kind: "notify"; message: string; level: "info" | "warning" | "error" }
  | { kind: "confirm"; title: string; message: string }
  | { kind: "select"; title: string; options: string[] }
  | { kind: "input"; title: string; placeholder?: string }
  | { kind: "setStatus"; key: string; text: string | undefined }
  | { kind: "setWorkingMessage"; text: string | undefined };

export type TrustedExtensionUiResponse =
  | { kind: "cancel" }
  | { kind: "notify" }
  | { kind: "confirm"; value: boolean; cancelled?: boolean }
  | { kind: "select"; value: string | undefined; cancelled?: boolean }
  | { kind: "input"; value: string | undefined; cancelled?: boolean }
  | { kind: "setStatus" }
  | { kind: "setWorkingMessage" };

/** Envelope for `extensions.ui.request` (sidecar → main). */
export type TrustedExtensionUiRequestEnvelope = {
  requestId?: string;
  sessionId: string;
  extensionId: string;
  extensionLabel: string;
  request: TrustedExtensionUiRequest;
};

/** Modal prompt shown to the user (main → renderer). */
export type TrustedExtensionUiPrompt = {
  /** Main retires this exact prompt after cancellation or timeout. */
  cancelled?: boolean;
  promptId: string;
  sessionId: string;
  extensionId: string;
  extensionLabel: string;
  request: Extract<TrustedExtensionUiRequest, { kind: "confirm" | "select" | "input" }>;
};

/** Renderer answer to a prompt (`extensions/ui/respond`). */
export type TrustedExtensionUiPromptResponse = {
  promptId: string;
  /** Omitted or `undefined` means the user dismissed the prompt. */
  value?: string | boolean;
};

/** Status text an extension set for a session (`ui.setStatus` / `ui.setWorkingMessage`). */
export type TrustedExtensionStatusEvent = {
  sessionId: string;
  extensionId: string;
  /** `working` is the working message; other keys are `setStatus` keys. */
  key: string;
  text: string | undefined;
};

/** Enablement scope as stored by the desktop (spec §3.2). */
export type TrustedExtensionScope = "user" | "manual" | { project: string };

/** `enabled` means switched on but not loaded by any session in this app run yet. */
export type TrustedExtensionEntryState = "disabled" | "enabled" | "loaded" | "error" | "missing";

/** One row of the Settings → Extensions list. */
export type TrustedExtensionEntry = {
  id: string;
  entry: string;
  label: string;
  source: TrustedExtensionSource;
  root: string;
  enabled: boolean;
  scope: TrustedExtensionScope;
  /** True when the entry file no longer exists on disk. */
  missing: boolean;
  /** Last known load state from any session, or `disabled`. */
  state: TrustedExtensionEntryState;
  /** Names registered in the most recent successful load. */
  toolNames: string[];
  commandNames: string[];
  /** Diagnostics from the most recent session that loaded this entry. */
  diagnostics: TrustedExtensionDiagnostic[];
};

export type TrustedExtensionsListResult = {
  entries: TrustedExtensionEntry[];
  /** Directories the desktop scanned, for the trust notice and empty state. */
  roots: { user: string; project?: string; manual: string[] };
};

/** Handler timeout for result-bearing events (spec §6). */
export const TRUSTED_EXTENSION_HANDLER_TIMEOUT_MS = 30_000;

/** Modal prompt timeout (spec §9). */
export const TRUSTED_EXTENSION_PROMPT_TIMEOUT_MS = 5 * 60_000;

/** The pinned kernel version every pi package in the sidecar must share (spec §13). */
export const TRUSTED_EXTENSION_KERNEL_VERSION = "0.87.1";

/** Palette command id prefix for extension commands. */
export const TRUSTED_EXTENSION_COMMAND_ID_PREFIX = "extension:";

export function trustedExtensionCommandId(name: string): string {
  return `${TRUSTED_EXTENSION_COMMAND_ID_PREFIX}${name}`;
}

export function trustedExtensionCommandName(commandId: string): string | undefined {
  return commandId.startsWith(TRUSTED_EXTENSION_COMMAND_ID_PREFIX)
    ? commandId.slice(TRUSTED_EXTENSION_COMMAND_ID_PREFIX.length)
    : undefined;
}
/** Public model metadata a trusted extension may register for its own agent. */
export type TrustedExtensionAgentModelConfig = {
  id: string;
  name?: string;
  api?: string;
  reasoning?: boolean;
  thinkingLevels?: Array<"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max">;
  input?: Array<"text" | "image">;
  contextWindow?: number;
  maxTokens?: number;
};

/** Stable provider id used when a session is bound to a plugin-owned agent. */
export const TRUSTED_EXTENSION_AGENT_PROVIDER_PREFIX = "extension-agent:";

export function trustedExtensionAgentProviderId(agentKey: string): string {
  return `${TRUSTED_EXTENSION_AGENT_PROVIDER_PREFIX}${encodeURIComponent(agentKey)}`;
}

export function trustedExtensionAgentKeyFromProviderId(providerId: string): string | undefined {
  if (!providerId.startsWith(TRUSTED_EXTENSION_AGENT_PROVIDER_PREFIX)) return undefined;
  try {
    return decodeURIComponent(providerId.slice(TRUSTED_EXTENSION_AGENT_PROVIDER_PREFIX.length));
  } catch {
    return undefined;
  }
}
