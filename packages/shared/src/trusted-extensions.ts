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
  /**
   * Permissions the owning plugin holds, exactly as the loader granted them.
   * The runtime slot gate consults this list (ADR 0295 rule 2); absent means
   * none, because a tier permission must never imply a slot permission.
   */
  permissions?: readonly string[];
  /** This plugin's non-secret settings at runtime launch; part of runtime identity. */
  settings?: Readonly<Record<string, unknown>>;
};

export type TrustedExtensionDiagnosticKind =
  | "load_error"
  | "factory_error"
  | "unsupported_api"
  | "stub_symbol"
  | "rejected_registration"
  | "permission_denied"
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
  | { kind: "notify"; message: string; level: "info" | "warning" | "error" }
  | { kind: "confirm"; title: string; message: string }
  | { kind: "select"; title: string; options: string[] }
  | { kind: "input"; title: string; placeholder?: string }
  | { kind: "setStatus"; key: string; text: string | undefined }
  | { kind: "setWorkingMessage"; text: string | undefined };

export type TrustedExtensionUiResponse =
  | { kind: "notify" }
  | { kind: "confirm"; value: boolean }
  | { kind: "select"; value: string | undefined }
  | { kind: "input"; value: string | undefined }
  | { kind: "setStatus" }
  | { kind: "setWorkingMessage" };

/** Envelope for `extensions.ui.request` (sidecar → main). */
export type TrustedExtensionUiRequestEnvelope = {
  sessionId: string;
  extensionId: string;
  extensionLabel: string;
  request: TrustedExtensionUiRequest;
};

/** Modal prompt shown to the user (main → renderer). */
export type TrustedExtensionUiPrompt = {
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

/**
 * Runtime slot behind each wired extension event (ADR 0295 rule 2).
 *
 * A tier permission says where plugin code runs (`agent.extension`); a slot
 * permission says what that code may do to a running turn. This map is the
 * contract between the two: the runner resolves it before a handler runs, and
 * an event that is absent here has no slot and stays unrestricted —
 * `session_start` and `session_shutdown` are the runner's own boundaries and
 * `session_info_changed` is a rename notice, so none of them changes a turn.
 *
 * Every name this map holds is registered with its slot, so the runner enforces
 * all of them for every plugin, the high-trust tier included (see
 * {@link REGISTERED_SLOT_PERMISSIONS}).
 */
export const TRUSTED_EXTENSION_EVENT_PERMISSIONS = {
  // Slot 7: consulted before a turn closes.
  turn_closing: "runtime.turn.closing",
  // Slot 4: block a call with a reason, replace a tool's result.
  tool_call: "runtime.tool.gate",
  tool_result: "runtime.tool.gate",
  // Slot 6 (`runtime.request.before`) is withdrawn: before_agent_start /
  // context / before_provider_* / model_select / thinking_level_select are
  // no longer plugin-facing rewrite points. Unmapped events stay unconsulted.
  // Slot 2: live observation of the running turn.
  agent_start: "runtime.turn.watch",
  agent_end: "runtime.turn.watch",
  agent_settled: "runtime.turn.watch",
  turn_start: "runtime.turn.watch",
  turn_end: "runtime.turn.watch",
  message_start: "runtime.turn.watch",
  message_update: "runtime.turn.watch",
  message_end: "runtime.turn.watch",
  tool_execution_start: "runtime.turn.watch",
  tool_execution_update: "runtime.turn.watch",
  tool_execution_end: "runtime.turn.watch",
  after_provider_response: "runtime.turn.watch",
  // Slot 11: create / switch / delete / fork, and compaction.
  project_trust: "runtime.session.lifecycle",
  resources_discover: "runtime.session.lifecycle",
  session_before_compact: "runtime.session.lifecycle",
  session_compact: "runtime.session.lifecycle",
  session_compact_failed: "runtime.session.lifecycle",
  session_before_fork: "runtime.session.lifecycle",
  session_before_switch: "runtime.session.lifecycle",
  session_lifecycle: "runtime.session.lifecycle",
  // Slot 1: after send, before the message is queued.
  input: "runtime.send.before",
} as const satisfies Record<string, string>;

/**
 * The `input` event for a prompt that is about to reach the model (ADR 0295
 * slot 1).
 *
 * The runtime emits it once per prompt, after the desktop has accepted and
 * persisted the user's message and before that message enters the agent, so a
 * handler reads exactly what is about to be queued — attachments included —
 * while the user's own text stays untouched in the transcript.
 */
export type TrustedExtensionInputPayload = {
  type: "input";
  sessionId: string;
  turnId: string;
  /** The text being queued, before and after any handler rewrites it. */
  text: string;
  /** Image attachments carried inline for this turn. */
  images: ReadonlyArray<{ name: string; mimeType?: string; data: string }>;
  /** Every attachment of the message, images included, by reference. */
  attachments: ReadonlyArray<{
    name: string;
    ref: string;
    kind: "image" | "file";
    mimeType?: string;
    size?: number;
  }>;
  /** Where the message came from: a desktop send is `rpc`. */
  source: "rpc" | "extension";
};

/**
 * What an `input` handler may answer (ADR 0295 slot 1). The three actions are
 * the kernel's own: `continue` passes the message through unchanged, and is
 * the answer a handler that returns nothing gives.
 *
 * `transform` replaces the text the model receives. Transforms chain in load
 * order — a later handler sees the text an earlier one produced — and the
 * user's row keeps the text the user typed, with the rewrite recorded at diff
 * level (rule 5).
 *
 * `handled` keeps the message away from the model entirely; the desktop's
 * variant of that action carries a `reason`, because the user has to be able
 * to read why their message went nowhere.
 */
export type TrustedExtensionInputResult = {
  action: "continue" | "transform" | "handled";
  /** Replacement text; only meaningful with `action: "transform"`. */
  text?: string;
  /** User-readable explanation; only meaningful with `action: "handled"`. */
  reason?: string;
};

/**
 * One diff-level audit record of a rewrite a slot performed (ADR 0295 rule 5),
 * as the runtime hands it to the embedding host.
 *
 * The host owns persistence: `plugin_rewrites` already stores this shape
 * (`outgoing_message` with character edits) and `plugin.rewrites.list` reads
 * it back. The diff itself is computed by the host, so `before` / `after` are
 * the full texts rather than a second implementation of the same algorithm.
 *
 * Two producers exist, one per rewrite slot, and they do not carry the same
 * rows: slot 1 (send-before) rewrites one message the user can be shown, so
 * its record names that message; slot 6 (before-request) rewrites what the
 * model receives — the message list, or the request's model and thinking
 * level — and has no single transcript row to attach to. `before`/`after` stay
 * the full texts in both cases, so the owner of `plugin_rewrites` still
 * computes the diff.
 */
export type TrustedExtensionRewriteRecord =
  | TrustedExtensionSendRewriteRecord
  | TrustedExtensionRequestRewriteRecord;

/** Slot 1: the outgoing message, on the row the user sees. */
export type TrustedExtensionSendRewriteRecord = {
  sessionId: string;
  /** The durable turn the rewrite belongs to, when it is known. */
  turnId?: string;
  /** `id` of the owning plugin's extension entry. */
  pluginId: string;
  /** Short label of the owning plugin, for the row and the audit view. */
  pluginLabel: string;
  /** The one kind this slot produces (ADR 0295 table, slot 1). */
  kind: "outgoing_message";
  /** Transcript row the rewrite changed what the model saw for. */
  targetMessageId: string;
  /** The text as the user sent it. */
  before: string;
  /** The text the model received instead. */
  after: string;
};

/**
 * Slot 6: a rewrite of what the request carries, recorded at diff level.
 *
 * `message_list` is the context transform: `before`/`after` are the message
 * list the request would have carried and the list it carried instead, in the
 * host's own message shape, serialized. `request_payload` is the model and
 * thinking-level route: `before`/`after` are the request's `model` and
 * `thinkingLevel` fields serialized, so the walk the host already describes
 * for that kind finds exactly what the plugin changed.
 *
 * Host-side reader note: `plugin.rewrites.record` accepts `outgoing_message`
 * today and host-core already names the wider vocabulary. A slot-6 rewrite
 * therefore records its diff through the same sink and the runtime reports a
 * sink that cannot take it (`publishRewrite`), rather than applying the
 * rewrite with no record attempted at all.
 */
export type TrustedExtensionRequestRewriteRecord = {
  sessionId: string;
  /** The durable turn the rewrite belongs to, when it is known. */
  turnId?: string;
  pluginId: string;
  pluginLabel: string;
  /** `message_list` for the context transform; `request_payload` for the route. */
  kind: "message_list" | "request_payload";
  /** The text before the rewrite: the message list, or the model/level fields. */
  before: string;
  /** The text the request carried instead. */
  after: string;
};

/** Event name the desktop host uses for session create / delete (slot 11). */
export const TRUSTED_EXTENSION_SESSION_LIFECYCLE_EVENT = "session_lifecycle";

/**
 * A session lifecycle notice the kernel has no hook for (ADR 0295 slot 11,
 * rule 11). The host emits it at the moment the desktop creates or deletes a
 * session; a plugin is told and can veto nothing.
 *
 * `change: "created"` reaches the plugins of the sessions that are loaded when
 * the new session appears (the created session has no runtime yet, so its own
 * plugin learns about it through its `session_start`). `change: "deleted"`
 * reaches the plugin of the session being deleted, if that session is loaded.
 */
export type TrustedExtensionSessionLifecyclePayload = {
  type: "session_lifecycle";
  change: "created" | "deleted";
  /** Session the notice is about. */
  sessionId: string;
};

/**
 * A session lifecycle moment the embedding host observed, as it reports it to
 * the session's runtime (ADR 0295 slot 11, rule 11).
 *
 * The desktop owns these moments, so it names them here rather than pretending
 * the kernel produced them: `created` and `deleted` have no kernel hook at all,
 * and the runtime maps `switch` / `fork` onto the kernel's
 * `session_before_switch` / `session_before_fork` because the moments match.
 */
export type TrustedExtensionSessionLifecycleNotice =
  | { change: "created" | "deleted"; sessionId: string }
  | {
      change: "switch";
      sessionId: string;
      reason: "new" | "resume";
      targetSessionId?: string;
    }
  | { change: "fork"; sessionId: string; entryId?: string; position: "before" | "at" };

/**
 * The kernel's `session_before_switch`, emitted by the desktop host when the
 * user leaves a session for a new one or for another session (ADR 0295 slot
 * 11). Informed-only in PI-Desktop: the kernel lets a handler cancel the
 * switch, rule 11 does not.
 */
export type TrustedExtensionSessionBeforeSwitchPayload = {
  type: "session_before_switch";
  reason: "new" | "resume";
  /** Session being left. */
  sessionId: string;
  /** Session being opened, when there is one; a new session has none yet. */
  targetSessionId?: string;
};

/**
 * The kernel's `session_before_fork`, emitted by the desktop host before the
 * session is forked (ADR 0295 slot 11). Informed-only, like the switch above.
 */
export type TrustedExtensionSessionBeforeForkPayload = {
  type: "session_before_fork";
  sessionId: string;
  /** Transcript boundary the fork is taken from, when the caller named one. */
  entryId?: string;
  position: "before" | "at";
};

/** The conversation a compaction is about to replace (ADR 0295 rule 7). */
export type TrustedExtensionCompactionSegment = {
  /** The messages that will be summarized away, oldest first. */
  messages: ReadonlyArray<unknown>;
  messageCount: number;
  /** Context size the checkpoint replaces. */
  tokensBefore: number;
  /** What the checkpoint keeps verbatim, newest last. */
  retained: ReadonlyArray<unknown>;
};

/** The events this map knows about: every wired event that has a slot behind it. */
export type TrustedExtensionSlotEvent = keyof typeof TRUSTED_EXTENSION_EVENT_PERMISSIONS;

/**
 * The slot permission a handler for `event` must hold; `undefined` means the
 * event has no slot and stays unrestricted (ADR 0295 rule 2).
 */
export function trustedExtensionEventPermission(event: string): string | undefined {
  return Object.hasOwn(TRUSTED_EXTENSION_EVENT_PERMISSIONS, event)
    ? TRUSTED_EXTENSION_EVENT_PERMISSIONS[event as TrustedExtensionSlotEvent]
    : undefined;
}

/**
 * Events withdrawn with slot 6 (`runtime.request.before`). The runner must not
 * consult handlers for these even if an extension registers them: silent
 * rewrites of what the model reads are not offered. Missing from the permission
 * map alone would leave them ungated, so the runner refuses on this set.
 */
export const WITHDRAWN_RUNTIME_EVENTS = [
  "before_agent_start",
  "context",
  "before_provider_request",
  "before_provider_headers",
  "model_select",
  "thinking_level_select",
] as const;

export type WithdrawnRuntimeEvent = (typeof WITHDRAWN_RUNTIME_EVENTS)[number];

export function isWithdrawnRuntimeEvent(event: string): event is WithdrawnRuntimeEvent {
  return (WITHDRAWN_RUNTIME_EVENTS as readonly string[]).includes(event);
}

/** Plugin-side completion on user-configured models (`pi.ai.complete`). */
export const PLUGIN_MODEL_COMPLETE_PERMISSION = "agent.model.complete";


/**
 * The one slot permission behind a plugin tool's extended result fields (ADR
 * 0295 slot 5): introducing a tool, reporting spend, and requesting early
 * termination. `TRUSTED_EXTENSION_API_PERMISSIONS.toolResult` is the same name
 * seen from an agent extension; the constant exists so Electron main, which
 * holds no extension context, refuses with exactly the same permission.
 */
export const PLUGIN_TOOL_EXTEND_PERMISSION = "runtime.tool.extend";

/**
 * Runtime slot behind each extension call that is not an event (ADR 0295
 * rule 2).
 *
 * {@link TRUSTED_EXTENSION_EVENT_PERMISSIONS} answers "may this handler run";
 * this answers the same question for the things an extension asks for itself
 * and that no event describes. An API call carries no event name, so its slot
 * cannot be inferred from the payload: it is named here, resolved by the
 * runner before the call runs, and reported as `permission_denied` when the
 * plugin does not hold the permission — the same gate an event gets.
 *
 * `requestTurnAbort` is slot 3: stop the current turn (the plugin's own
 * long-running work receives the cancellation signal separately).
 * `toolResult` is slot 5: introduce a tool, report spend, or request early
 * termination through a tool's result.
 * `turnFacts` is slot 9: read the host's own structured numbers for one turn.
 * `recap` is slot 8: read what a turn contained. Its whole-session form also
 * needs {@link TRUSTED_EXTENSION_SESSION_READ_PERMISSION} (rule 7), which is a
 * property of the requested scope rather than of the call — see
 * {@link trustedExtensionApiScopePermission}.
 * `continueTurn` is slot 10: start another turn after one ends. It is the only
 * extension-facing way to queue that turn; there is no second call name, so a
 * queued continuation always carries plugin provenance (ADR 0293).
 * `aiComplete` is plugin-level AI on user-configured models
 * (`agent.model.complete`): not a turn slot, never a renderer action.
 */
export const TRUSTED_EXTENSION_API_PERMISSIONS = {
  requestTurnAbort: "runtime.turn.abort",
  toolResult: PLUGIN_TOOL_EXTEND_PERMISSION,
  turnFacts: "runtime.turn.facts",
  recap: "runtime.turn.recap",
  continueTurn: "runtime.turn.continue",
  aiComplete: PLUGIN_MODEL_COMPLETE_PERMISSION,
} as const satisfies Record<string, string>;

/**
 * Reading a session's own content is a permission of its own (ADR 0295 rule
 * 7): slot 8's whole-session read needs this on top of `runtime.turn.recap`,
 * while reading a single turn needs only the slot's own name. Reads are
 * deliberately **not** recorded one by one; the install review and the plugin
 * row are the consent surface.
 */
export const TRUSTED_EXTENSION_SESSION_READ_PERMISSION = "runtime.session.read";

/**
 * The permission a call of `apiCall` needs *in addition to* its own slot when
 * it is made with `scope`, or `undefined` when the scope adds no requirement.
 *
 * The requested scope, not the member, decides whether a second right is
 * needed, so the requirement is named here instead of folding two permissions
 * into one call: `recap({ scope: "session" })` reads a whole session and
 * therefore also needs `runtime.session.read` (rule 7), and `scope: "turn"`
 * does not.
 */
export function trustedExtensionApiScopePermission(
  apiCall: string,
  scope: string,
): string | undefined {
  return apiCall === "recap" && scope === "session"
    ? TRUSTED_EXTENSION_SESSION_READ_PERMISSION
    : undefined;
}

/** Newest transcript rows one `recap` read returns when no `limit` is given. */
export const TRUSTED_EXTENSION_RECAP_DEFAULT_LIMIT = 200;

/** Upper bound on `recap`'s transcript window, so one call cannot pull an unbounded history. */
export const TRUSTED_EXTENSION_RECAP_MAX_LIMIT = 500;

/** The non-event calls this map knows about. */
export type TrustedExtensionApiCall = keyof typeof TRUSTED_EXTENSION_API_PERMISSIONS;

/**
 * The slot permission a call of `apiCall` needs; `undefined` means the call is
 * not part of the extension API surface the map covers.
 */
export function trustedExtensionApiPermission(apiCall: string): string | undefined {
  return Object.hasOwn(TRUSTED_EXTENSION_API_PERMISSIONS, apiCall)
    ? TRUSTED_EXTENSION_API_PERMISSIONS[apiCall as TrustedExtensionApiCall]
    : undefined;
}
/**
 * Slot permissions the permission registry holds (spec 13 §2).
 *
 * {@link TRUSTED_EXTENSION_EVENT_PERMISSIONS} is the whole contract; this is
 * the subset a plugin can actually be granted, and the subset the gate refuses
 * on. It is the ADR 0295 slot set with no gaps: every mapped name is registered
 * together with the slot it gates, so a mapped name never falls back to "no
 * gate" behavior. A name that is mapped and missing here would silently leave
 * its event unrestricted, which is the drift
 * `apps/desktop/test/runtime-slot-permissions.test.mjs` exists to catch: it
 * fails when this list and `PLUGIN_PERMISSIONS` disagree. Slot 6
 * (`runtime.request.before`) is withdrawn and is deliberately absent. The
 * twelfth ADR 0295 slot, `runtime.approval.before`, is not built and is
 * deliberately absent.
 */
export const REGISTERED_SLOT_PERMISSIONS = [
  "runtime.send.before",
  "runtime.session.lifecycle",
  "runtime.session.read",
  "runtime.tool.extend",
  "runtime.tool.gate",
  "runtime.turn.abort",
  "runtime.turn.closing",
  "runtime.turn.continue",
  "runtime.turn.facts",
  "runtime.turn.recap",
  "runtime.turn.watch",
] as const;

/**
 * True when `permission` is a slot permission the registry holds. The runner
 * enforces every mapped slot name directly (ADR 0295 rule 2) and no longer
 * consults this; the guard test and the docs use it to say which names the
 * registry actually holds.
 */
export function isRegisteredSlotPermission(permission: string): boolean {
  return (REGISTERED_SLOT_PERMISSIONS as readonly string[]).includes(permission);
}

/** Modal prompt timeout (spec §9). */
export const TRUSTED_EXTENSION_PROMPT_TIMEOUT_MS = 5 * 60_000;

/** The pinned kernel version every pi package in the sidecar must share (spec §13). */
export const TRUSTED_EXTENSION_KERNEL_VERSION = "0.85.1";

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

/** One turn's model tokens (host-core `TurnTokens`). */
export type TrustedExtensionTurnTokens = {
  input: number;
  output: number;
  /** `input + output`; the provider's own `totalTokens` stays inside `usage`. */
  total: number;
};

/** One tool's share of a turn's executed calls (host-core `ToolCallSummary`). */
export type TrustedExtensionToolCallSummary = {
  /** The tool name the host's audit record carries; `""` when it carried none. */
  toolName: string;
  calls: number;
  ok: number;
  failed: number;
  /** Distinct error codes of the failed calls, sorted; empty when none failed. */
  errorCodes: string[];
};

/** A turn's executed tool calls, counted from the host's audit records. */
export type TrustedExtensionToolCallFacts = {
  total: number;
  ok: number;
  failed: number;
  /** One entry per tool, ordered by tool name. */
  byTool: TrustedExtensionToolCallSummary[];
};

/**
 * One file a turn touched (host-core `Artifact`, ADR 0295 rule 8).
 *
 * A touch is the unit, so a file changed in three turns appears once per turn.
 * `op` is `create | write | edit | download | delete` and is exposed verbatim,
 * so a row written by a build with a wider vocabulary is not dropped here.
 */
export type TrustedExtensionTurnFile = {
  sessionId: string;
  sessionTitle: string | null;
  path: string;
  op: string;
  /** The turn that touched the file; `null` when the host recorded it outside a turn. */
  turnId: string | null;
  /** Time of this touch, not of the file's first appearance. */
  updatedAt: string;
};

/**
 * One turn's facts: the host's own answer for `turn.facts` (ADR 0295 rule 8,
 * slot 9 `runtime.turn.facts`), passed to a plugin unchanged.
 *
 * Every number comes from a host table and "this turn" means exactly one
 * thing — the rows carrying that turn's id — so nothing here is reconstructed
 * from what a plugin observed, and no conversation text is included. A turn
 * the host never recorded is not answered with zeroes: the call fails instead.
 */
export type TrustedExtensionTurnFacts = {
  sessionId: string;
  turnId: string;
  /** `running | completed | aborted | error`; an unknown status is exposed verbatim. */
  status: string;
  providerId: string | null;
  modelId: string | null;
  /** The turn's own terminal error, not a tool's. */
  errorCode: string | null;
  startedAt: string;
  /** `null` while the turn is still running. */
  endedAt: string | null;
  /** `endedAt - startedAt` in milliseconds; `null` while running. */
  durationMs: number | null;
  tokens: TrustedExtensionTurnTokens;
  /** The provider usage record exactly as the host stored it, or `null`. */
  usage: unknown;
  /**
   * The turn's plugin-tool spend: the `pluginToolUsage` member of the recorded
   * usage, exposed on its own because it is spend a plugin reported and never
   * part of the model's tokens (ADR 0295 slot 5).
   */
  pluginToolUsage: unknown;
  toolCalls: TrustedExtensionToolCallFacts;
  /** The files the turn touched, oldest touch first. */
  files: TrustedExtensionTurnFile[];
  /** The file list hit the requested limit; `false` means it is the complete history. */
  filesTruncated: boolean;
};

/**
 * What a slot-8 recap read answered.
 *
 * `scope: "turn"` returns the turn's facts — the only per-turn answer the host
 * has today. Conversation *text* for a single turn has no host read path yet:
 * the host exposes one turn's numbers (`turn.facts`, with `artifacts` carrying
 * `turn_id`) but no per-turn message read, so `messages` is `null` and
 * `messagesUnavailable` says why instead of the turn looking empty.
 *
 * `scope: "session"` returns the newest transcript rows and needs
 * `runtime.session.read` as well as the slot's own permission (rule 7).
 */
export type TrustedExtensionTurnRecap =
  | {
      scope: "turn";
      sessionId: string;
      turnId: string;
      facts: TrustedExtensionTurnFacts;
      /** Always `null`: no host read returns one turn's conversation text. */
      messages: null;
      messagesUnavailable: "no-host-turn-read";
    }
  | {
      scope: "session";
      sessionId: string;
      /** Newest rows last, as host-core returns them. */
      messages: ReadonlyArray<unknown>;
      /** Physical transcript bounds, when a host supplies paged reads. */
      title?: string;
      messageStart?: number;
      messageEnd?: number;
      /** Older rows exist outside the returned window. */
      truncated: boolean;
    };

/**
 * The request a slot-10 continuation carries to the host (ADR 0295 rule 9).
 *
 * `pluginId` and `pluginLabel` travel with the message so the host can
 * attribute the continuation to the plugin that asked for it (ADR 0293). They
 * are part of the request rather than inferred later from the session.
 */
export type TrustedExtensionContinuationRequest = {
  /** Text of the turn the host starts after the current one ends. */
  message: string;
  pluginId: string;
  pluginLabel: string;
};

/**
 * What a continuation did: the host queued a real, durable turn for it.
 *
 * `queuedTurnId` is the queued turn's own id. The agent turn that actually runs
 * from it is created by the host at the next turn boundary and carries its own
 * durable turn id, so this id is not a `turn.facts` key.
 *
 * ADR 0295 rule 9 asks for the continuation to be persisted as a visible row
 * naming the plugin, and for it to be unbounded. There is no quota here, and
 * the row is attributed: host-core stores the plugin id and the display label
 * on the queue row and on the transcript row it becomes (schema v22,
 * `plugin_provenance.rs`), so the queued turn is both visible and named.
 */
export type TrustedExtensionContinuation = {
  queuedTurnId: string;
};
