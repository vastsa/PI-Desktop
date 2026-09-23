/**
 * Per-session Runner for trusted extensions (spec 07-plugins/16 §4 to §9).
 *
 * One Runner is bound to one desktop session. It loads the enabled entries
 * (module factories are cached across Runners, so module-level state is
 * shared between sessions like it is in one pi process), hands each factory
 * an `ExtensionAPI` object built over a {@link TrustedExtensionBridge}, and
 * exposes the registrations back to the runtime: tools, commands, and event
 * handlers. Every unsupported member is inert and reports a diagnostic; it
 * never throws into extension code.
 */
import { spawn } from "node:child_process";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
  trustedExtensionAgentProviderId,
  trustedExtensionApiPermission,
  trustedExtensionApiScopePermission,
  trustedExtensionEventPermission,
  isWithdrawnRuntimeEvent,
  PLUGIN_MODEL_COMPLETE_PERMISSION,
  TRUSTED_EXTENSION_RECAP_DEFAULT_LIMIT,
  TRUSTED_EXTENSION_RECAP_MAX_LIMIT,
  type TrustedExtensionAgentModelConfig,
  type TrustedExtensionApiCall,
  type TrustedExtensionContinuation,
  type TrustedExtensionContinuationRequest,
  type TrustedExtensionTurnFacts,
  type TrustedExtensionTurnRecap,
} from "@pi-desktop/shared";
import {
  createVirtualModules,
  knownStubSymbols,
  loadExtensionFactory,
  setStubSymbolReporter,
  type ExtensionFactory,
} from "./loader.js";
import {
  TRUSTED_EXTENSION_HANDLER_TIMEOUT_MS,
  type TrustedExtensionCommand,
  type TrustedExtensionDiagnostic,
  type TrustedExtensionDiagnosticKind,
  type TrustedExtensionLoadReport,
  type TrustedExtensionSpec,
  type TrustedExtensionUiRequest,
  type TrustedExtensionUiResponse,
} from "./types.js";

/**
 * Event names `pi.on` accepts in v1 (spec §6); a name outside this list and
 * outside `NOT_EMITTED_EVENTS` is reported as `unsupported_api`. The six names
 * withdrawn with slot 6 — `before_agent_start`, `context`,
 * `before_provider_request`, `before_provider_headers`, `model_select`,
 * `thinking_level_select` — must stay listed so a registration is accepted
 * instead of rejected; the runner never consults their handlers
 * (`isWithdrawnRuntimeEvent`).
 */
export const TRUSTED_EXTENSION_EVENTS = [
  "session_start",
  "session_shutdown",
  "session_info_changed",
  "project_trust",
  "resources_discover",
  "before_agent_start",
  "context",
  "before_provider_request",
  "before_provider_headers",
  "after_provider_response",
  "agent_start",
  "agent_end",
  "agent_settled",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_call",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "tool_result",
  "turn_closing",
  "model_select",
  "thinking_level_select",
  "session_before_compact",
  "session_compact",
  "session_compact_failed",
  "session_before_fork",
  "session_before_switch",
  "session_lifecycle",
  "input",
] as const;

export type TrustedExtensionEventName = (typeof TRUSTED_EXTENSION_EVENTS)[number];

/**
 * Upstream events the runtime never emits in v1; handlers register silently.
 * `session_before_switch` left this list with slot 11: the desktop emits it
 * from the host side, because the switch happens there. `session_before_tree`
 * stays: the desktop has no tree navigation to announce.
 */
const NOT_EMITTED_EVENTS = new Set([
  "user_bash",
  "session_before_tree",
  "session_tree",
  "ui_prompt_start",
  "ui_prompt_end",
]);

/**
 * Events whose handler result is honored, and therefore time-limited.
 *
 * The session lifecycle notices are in here for the budget rather than for a
 * result: they are informed-only (ADR 0295 rule 11), so the caller ignores
 * what they return, but a handler that stalls is still cut off after the
 * budget instead of holding the notification loop forever.
 */
const RESULT_EVENTS = new Set<string>([
  "resources_discover",
  "before_agent_start",
  "context",
  "before_provider_request",
  "before_provider_headers",
  "message_end",
  "tool_call",
  "tool_result",
  "turn_closing",
  "session_before_compact",
  "session_before_fork",
  "session_before_switch",
  "session_lifecycle",
  "input",
  "project_trust",
]);

/** ExtensionAPI members deferred to v2 or unsupported in v1. */
const INERT_API_MEMBERS = [
  "sendMessage",
  "appendEntry",
  "setLabel",
  "switchSession",
  "registerShortcut",
  "registerMarkdownTransformer",
  "registerMessageRenderer",
  "registerEntryRenderer",
  "getKeybindings",
  "registerLifecycle",
  "getInputPolicy",
  "setInputPolicy",
] as const;

/** UI context members that need a terminal (unsupported) or an editor (v2). */
const INERT_UI_MEMBERS = [
  "setWidget",
  "setFooter",
  "setHeader",
  "setTitle",
  "custom",
  "overlay",
  "onTerminalInput",
  "setWorkingVisible",
  "setWorkingIndicator",
  "setHiddenThinkingLabel",
  "pasteToEditor",
  "editor",
  "setEditorText",
  "getEditorText",
  "addAutocompleteProvider",
] as const;

export type ExtensionExecOptions = {
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
  signal?: AbortSignal;
  maxBuffer?: number;
};

export type ExtensionExecResult = {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
};

/**
 * One row of the tool catalogue an extension reads through `getAllTools()`.
 * `introducedBy: "plugin"` marks a tool another plugin brought in at runtime
 * through a tool result (ADR 0295 slot 5), so the catalogue never presents it
 * as a host tool.
 */
export type ExtensionToolInfo = {
  name: string;
  description: string;
  active: boolean;
  introducedBy?: "plugin";
};

export type TrustedExtensionAgentDefinition = {
  id: string;
  name?: string;
  models: TrustedExtensionAgentModelConfig[];
  stream?: (
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;
  complete?: (
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ) => Promise<AssistantMessage>;
};

export type RegisteredTrustedExtensionAgent = {
  key: string;
  extensionId: string;
  extensionLabel: string;
  id: string;
  name: string;
  providerId: string;
  models: Model<Api>[];
  stream: (
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ) => AssistantMessageEventStream;
};

/** What the desktop runtime provides to extensions. All methods may be sync or async. */
export interface TrustedExtensionBridge {
  sessionId: string;
  cwd: string;
  getModel(): unknown;
  setModel(model: unknown): Promise<boolean>;
  getThinkingLevel(): string;
  setThinkingLevel(level: string): void;
  isIdle(): boolean;
  /**
   * The running turn's cancellation token, or `undefined` when no turn is
   * running. Plugin work observes the abort through this (ADR 0295 slot 3);
   * `abort()` is the same turn being stopped.
   */
  getAbortSignal(): AbortSignal | undefined;
  abort(): void;
  hasPendingMessages(): boolean;
  getContextUsage(): { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
  compact(options?: { customInstructions?: string }): void;
  getSystemPrompt(): string;
  getActiveTools(): string[];
  getAllTools(): ExtensionToolInfo[];
  setActiveTools(names: string[]): void;
  getSessionName(): string | undefined;
  setSessionName(name: string): void | Promise<void>;
  waitForIdle(): Promise<void>;
  newSession(): Promise<{ cancelled: boolean }>;
  fork(entryId: string): Promise<{ cancelled: boolean }>;
  /**
   * Slot 9: the host's own facts for one turn (`turn.facts`, ADR 0295 rule 8).
   * `turnId` absent means the turn running now. `undefined` means the host
   * holds no such turn — a turn it never recorded is never answered with
   * zeroes, and the caller reports the failure rather than inventing one.
   */
  turnFacts(input: {
    turnId?: string;
    limit?: number;
  }): Promise<TrustedExtensionTurnFacts | undefined>;
  /**
   * Slot 8: a session's newest transcript rows, windowed and attributed by the
   * host (`session.get`), never by this process. `limit` is a positive window
   * size; `truncated` says older rows exist outside it.
   */
  recapSession(input: { limit: number; sessionId?: string; before?: number }): Promise<{
    messages: ReadonlyArray<unknown>;
    truncated: boolean;
    title?: string;
    messageStart?: number;
    messageEnd?: number;
  }>;
  /**
   * Slot 10: queue a real, durable turn for this plugin's continuation (ADR
   * 0295 rule 9). `undefined` means the host refused or could not queue it.
   * The request carries the plugin's identity, because only the caller knows
   * which plugin asked for the continuation (ADR 0293).
   */
  continueTurn(
    input: TrustedExtensionContinuationRequest,
  ): Promise<TrustedExtensionContinuation | undefined>;
  /**
   * Plugin-level AI on user-configured models (`agent.model.complete`).
   * Credentials stay in the host; `system` is not merged with the session prompt.
   */
  aiComplete(input: {
    messages: Array<{ role: string; content: string }>;
    system?: string;
    modelKey?: string;
    purpose?: string;
    maxTokens?: number;
  }): Promise<
    | { ok: true; text: string; modelKey: string; usage?: unknown }
    | { ok: false; code: string; detail?: string }
  >;
  requestUi(
    extension: TrustedExtensionSpec,
    request: TrustedExtensionUiRequest,
  ): Promise<TrustedExtensionUiResponse>;
  publishCommands(commands: TrustedExtensionCommand[]): void;
  publishDiagnostics(diagnostics: TrustedExtensionDiagnostic[]): void;
  /** Optional read-only registry passed straight through to extensions. */
  modelRegistry?: unknown;
}

type ToolDefinitionLike = {
  name: string;
  label?: string;
  description: string;
  parameters: unknown;
  executionMode?: "sequential" | "parallel";
  prepareArguments?: (args: unknown) => unknown;
  execute: (
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: ((partial: AgentToolResult<unknown>) => void) | undefined,
    ctx: unknown,
  ) => Promise<AgentToolResult<unknown>>;
};

type RegisteredCommandLike = {
  description?: string;
  handler: (args: string, ctx: unknown) => Promise<void> | void;
  getArgumentCompletions?: (prefix: string) => unknown;
};

type Handler = (event: unknown, ctx: unknown) => unknown;

type LoadedExtension = {
  spec: TrustedExtensionSpec;
  /** Permissions the owning plugin holds, from {@link TrustedExtensionSpec.permissions}. */
  permissions: ReadonlySet<string>;
  tools: Map<string, ToolDefinitionLike>;
  commands: Map<string, RegisteredCommandLike>;
  agents: Map<string, RegisteredTrustedExtensionAgent>;
  handlers: Map<string, Handler[]>;
  flags: Map<string, { type: "boolean" | "string"; default?: boolean | string }>;
};
function extensionErrorResult(model: Model<Api>, error: unknown): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: error instanceof Error ? error.message : String(error),
    timestamp: Date.now(),
  };
}

function modelFromAgentConfig(
  providerId: string,
  config: TrustedExtensionAgentModelConfig,
): Model<Api> {
  const id = String(config.id ?? "").trim();
  if (!id || id.length > 256) throw new Error("agent model id must be 1-256 characters");
  const contextWindow = Number.isSafeInteger(config.contextWindow) && (config.contextWindow ?? 0) > 0
    ? config.contextWindow!
    : 128_000;
  const maxTokens = Number.isSafeInteger(config.maxTokens) && (config.maxTokens ?? 0) > 0
    ? config.maxTokens!
    : 8_192;
  const input = (config.input ?? ["text"]).filter((value): value is "text" | "image" =>
    value === "text" || value === "image",
  );
  return {
    id,
    name: String(config.name ?? id).trim() || id,
    api: (config.api ?? "openai-completions") as Api,
    provider: providerId,
    baseUrl: "",
    reasoning: config.reasoning === true,
    input: input.length > 0 ? input : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
  } as Model<Api>;
}

function streamForAgent(
  definition: TrustedExtensionAgentDefinition,
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const output = createAssistantMessageEventStream();
  void (async () => {
    try {
      if (definition.stream) {
        const source = await definition.stream(model, context, options);
        for await (const event of source) output.push(event);
        output.end(await source.result());
        return;
      }
      if (!definition.complete) throw new Error("agent must provide stream() or complete()");
      output.end(await definition.complete(model, context, options));
    } catch (error) {
      output.end(extensionErrorResult(model, error));
    }
  })();
  return output;
}


const factoryCache = new Map<string, ExtensionFactory>();

/** Drop cached module factories; the next Runner reloads from disk (spec §4.3). */
export function clearTrustedExtensionCache(): void {
  factoryCache.clear();
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function errorStack(err: unknown): string | undefined {
  return err instanceof Error ? err.stack : undefined;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`handler exceeded ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Transcript window one `recap` read asks the host for.
 *
 * An absent or unusable value falls back to the shared default; a real number
 * is clamped, so a plugin cannot ask one call to pull an unbounded history
 * into its process. The host still decides what the window means and reports
 * truncation itself.
 */
function recapLimit(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return TRUSTED_EXTENSION_RECAP_DEFAULT_LIMIT;
  }
  return Math.min(
    Math.max(1, Math.floor(value)),
    TRUSTED_EXTENSION_RECAP_MAX_LIMIT,
  );
}

export type TrustedExtensionRunnerOptions = {
  specs: TrustedExtensionSpec[];
  bridge: TrustedExtensionBridge;
  /** Names an extension tool may not take (core, plugin, MCP tools). */
  reservedToolNames?: () => Iterable<string>;
};

export class TrustedExtensionRunner {
  private readonly bridge: TrustedExtensionBridge;
  private readonly specs: TrustedExtensionSpec[];
  private readonly reservedToolNames: () => Iterable<string>;
  private readonly loaded = new Map<string, LoadedExtension>();
  private readonly diagnostics = new Map<string, TrustedExtensionDiagnostic>();
  private readonly reports = new Map<string, TrustedExtensionLoadReport>();
  private publishScheduled = false;
  private disposed = false;

  constructor(options: TrustedExtensionRunnerOptions) {
    this.bridge = options.bridge;
    this.specs = options.specs;
    this.reservedToolNames = options.reservedToolNames ?? (() => []);
  }

  get extensionIds(): string[] {
    return this.specs.map((spec) => spec.id);
  }

  /** Load every entry. A failing entry is reported and skipped (spec §4.4). */
  async load(): Promise<TrustedExtensionLoadReport[]> {
    for (const spec of this.specs) {
      const extension: LoadedExtension = {
        spec,
        permissions: new Set(spec.permissions ?? []),
        tools: new Map(),
        commands: new Map(),
        agents: new Map(),
        handlers: new Map(),
        flags: new Map(),
      };
      const reportedStubs = new Set<string>();
      const reportStub = (symbol: string) => {
        if (reportedStubs.has(symbol)) return;
        reportedStubs.add(symbol);
        this.report(spec.id, "stub_symbol", `pi-tui symbol "${symbol}" is a no-op in PI-Desktop`, symbol);
      };
      setStubSymbolReporter(spec.id, reportStub);
      const virtualModules = createVirtualModules({ extensionId: spec.id });
      let factory = factoryCache.get(spec.id);
      // A cached module keeps the pi-tui symbols it imported the first time;
      // report them here so this session's diagnostics say so too.
      if (factory) for (const symbol of knownStubSymbols(spec.id)) reportStub(symbol);
      if (!factory) {
        try {
          factory = await loadExtensionFactory(spec.entry, virtualModules);
        } catch (err) {
          this.report(spec.id, "load_error", errorMessage(err), undefined, errorStack(err));
          this.reports.set(spec.id, this.errorReport(spec.id));
          continue;
        }
        if (!factory) {
          this.report(spec.id, "load_error", "module has no default export function");
          this.reports.set(spec.id, this.errorReport(spec.id));
          continue;
        }
        factoryCache.set(spec.id, factory);
      }
      try {
        await factory(this.createApi(extension));
      } catch (err) {
        this.report(spec.id, "factory_error", errorMessage(err), undefined, errorStack(err));
        this.reports.set(spec.id, this.errorReport(spec.id));
        continue;
      }
      this.loaded.set(spec.id, extension);
      this.reports.set(spec.id, {
        extensionId: spec.id,
        state: "loaded",
        toolNames: [...extension.tools.keys()],
        commandNames: [...extension.commands.keys()],
        agentNames: [...extension.agents.keys()],
        eventNames: [...extension.handlers.keys()],
      });
    }
    this.bridge.publishCommands(this.getCommands());
    this.flushDiagnostics();
    await this.emit("session_start", { type: "session_start", reason: "startup" });
    return this.getLoadReports();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    await this.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
    this.disposed = true;
    this.bridge.publishCommands([]);
  }

  getLoadReports(): TrustedExtensionLoadReport[] {
    return [...this.reports.values()];
  }

  getAgents(): RegisteredTrustedExtensionAgent[] {
    return [...this.loaded.values()].flatMap((extension) => [...extension.agents.values()]);
  }

  getAgentModels(): Model<Api>[] {
    return this.getAgents().flatMap((agent) => agent.models);
  }

  findAgentModel(model: unknown): RegisteredTrustedExtensionAgent | undefined {
    if (!model || typeof model !== "object") return undefined;
    const candidate = model as { provider?: unknown; id?: unknown };
    if (typeof candidate.provider !== "string" || typeof candidate.id !== "string") return undefined;
    return this.getAgents().find(
      (agent) => agent.providerId === candidate.provider && agent.models.some((item) => item.id === candidate.id),
    );
  }

  findAgent(agentKey: string, modelId?: string): { agent: RegisteredTrustedExtensionAgent; model: Model<Api> } | undefined {
    const agent = this.getAgents().find((item) => item.key === agentKey);
    const model = agent?.models.find((item) => !modelId || item.id === modelId);
    return agent && model ? { agent, model } : undefined;
  }
  getDiagnostics(): TrustedExtensionDiagnostic[] {
    return [...this.diagnostics.values()];
  }

  hasHandlers(event: string): boolean {
    // Slot 6 is withdrawn: the runtime must never treat these as live hooks.
    if (isWithdrawnRuntimeEvent(event)) return false;
    for (const extension of this.loaded.values()) {
      if ((extension.handlers.get(event)?.length ?? 0) > 0) return true;
    }
    return false;
  }

  /** Tools as pi-agent-core sees them (spec §7). */
  getAgentTools(): AgentTool[] {
    const tools: AgentTool[] = [];
    for (const extension of this.loaded.values()) {
      for (const def of extension.tools.values()) {
        tools.push({
          name: def.name,
          label: def.label ?? def.name,
          description: def.description,
          parameters: def.parameters as AgentTool["parameters"],
          executionMode: def.executionMode ?? "sequential",
          ...(def.prepareArguments ? { prepareArguments: def.prepareArguments } : {}),
          execute: (toolCallId, params, signal, onUpdate) =>
            def.execute(toolCallId, params, signal, onUpdate, this.createContext(extension)),
        } as AgentTool);
      }
    }
    return tools;
  }

  getCommands(): TrustedExtensionCommand[] {
    const out: TrustedExtensionCommand[] = [];
    for (const extension of this.loaded.values()) {
      for (const [name, command] of extension.commands) {
        out.push({
          extensionId: extension.spec.id,
          extensionLabel: extension.spec.label,
          name,
          ...(command.description ? { description: command.description } : {}),
        });
      }
    }
    return out;
  }

  /** Run `/<name> <args>` in this session (spec §8). Returns false when unknown. */
  async runCommand(name: string, args: string): Promise<boolean> {
    for (const extension of this.loaded.values()) {
      const command = extension.commands.get(name);
      if (!command) continue;
      try {
        await command.handler(args, this.createCommandContext(extension));
      } catch (err) {
        this.report(extension.spec.id, "handler_error", errorMessage(err), `command:${name}`, errorStack(err));
      }
      return true;
    }
    return false;
  }

  /**
   * Emit one event to every handler in load order, after the runtime slot gate
   * (ADR 0295 rule 2). For result events the results are folded by the
   * caller-supplied reducer; a throwing or stalled handler counts as
   * `undefined` (spec §6). The reducer also receives the id and the label of
   * the extension that produced `next`, so a hook that changes control flow can
   * name its source — the id for a record, the label for anything the user
   * reads — without a second lookup.
   */
  async emit<R = unknown>(
    event: TrustedExtensionEventName,
    payload: Record<string, unknown>,
    fold?: (
      acc: R | undefined,
      next: R,
      extensionId: string,
      extensionLabel: string,
    ) => R,
  ): Promise<R | undefined> {
    if (this.disposed) return undefined;
    if (this.disposed) return undefined;
    if (isWithdrawnRuntimeEvent(event)) {
      for (const extension of this.loaded.values()) {
        if ((extension.handlers.get(event)?.length ?? 0) > 0) {
          this.report(
            extension.spec.id,
            "rejected_registration",
            `handler for "${event}" skipped: slot 6 (runtime.request.before) is not offered`,
            event,
          );
        }
      }
      return undefined;
    }
    let acc: R | undefined;
    const timed = RESULT_EVENTS.has(event);
    for (const extension of this.loaded.values()) {
      const handlers = extension.handlers.get(event);
      if (!handlers?.length) continue;
      const refused = this.refusedSlot(extension, event);
      if (refused) {
        // A skip is never silent: the plugin author and the user both need to
        // know why the hook did nothing (ADR 0295 rule 2).
        this.report(
          extension.spec.id,
          "permission_denied",
          `handler for "${event}" skipped: the plugin does not hold ${refused}`,
          event,
        );
        continue;
      }
      const ctx = this.createContext(extension);
      for (const handler of handlers) {
        try {
          const run = Promise.resolve(handler(payload, ctx));
          const result = (await (timed
            ? withTimeout(run, TRUSTED_EXTENSION_HANDLER_TIMEOUT_MS)
            : run)) as R | undefined;
          if (result !== undefined && result !== null) {
            acc = fold ? fold(acc, result, extension.spec.id, extension.spec.label) : result;
          }
        } catch (err) {
          const kind: TrustedExtensionDiagnosticKind = /exceeded \d+ms/.test(errorMessage(err))
            ? "handler_timeout"
            : "handler_error";
          this.report(extension.spec.id, kind, errorMessage(err), event, errorStack(err));
        }
      }
    }
    return acc;
  }

  /**
   * The slot permission that refuses `event` for this extension, or `undefined`
   * when its handlers may run (ADR 0295 rule 2).
   */
  private refusedSlot(extension: LoadedExtension, event: string): string | undefined {
    return this.refusedPermission(extension, trustedExtensionEventPermission(event));
  }

  /**
   * The slot permission that refuses the non-event call `apiCall` for this
   * extension, or `undefined` when the call may run (ADR 0295 rule 2). An API
   * call has no event name, so its slot comes from the named contract in
   * `@pi-desktop/shared` rather than from the payload.
   */
  private refusedApi(
    extension: LoadedExtension,
    apiCall: TrustedExtensionApiCall,
  ): string | undefined {
    return this.refusedPermission(extension, trustedExtensionApiPermission(apiCall));
  }

  /**
   * Report and refuse `apiCall` for `extension` when the plugin does not hold
   * its slot permission; `true` means the call may proceed. Every refusal is
   * reported, never swallowed: the author and the user both need to know why
   * the call did nothing (ADR 0295 rule 2).
   */
  private refuseApi(
    extension: LoadedExtension,
    apiCall: TrustedExtensionApiCall,
    member: string,
  ): boolean {
    const refused = this.refusedApi(extension, apiCall);
    if (!refused) return false;
    this.report(
      extension.spec.id,
      "permission_denied",
      `${member} was refused: the plugin does not hold ${refused}`,
      member,
    );
    return true;
  }

  /**
   * Report and refuse `apiCall` in `scope` for `extension` when the scope
   * needs a permission the plugin does not hold; `true` means the call may
   * proceed. Only one scope needs a second right, and it is a property of the
   * scope rather than of the call: a whole-session recap reads conversation
   * content, so it needs `runtime.session.read` on top of the slot's own name
   * (ADR 0295 rule 7). The refusal is reported like every other one.
   */
  private refuseApiScope(
    extension: LoadedExtension,
    apiCall: TrustedExtensionApiCall,
    scope: string,
    member: string,
  ): boolean {
    const refused = this.refusedPermission(
      extension,
      trustedExtensionApiScopePermission(apiCall, scope),
    );
    if (!refused) return false;
    this.report(
      extension.spec.id,
      "permission_denied",
      `${member} was refused: the plugin does not hold ${refused}`,
      member,
    );
    return true;
  }

  /**
   * Report a host read or write that failed for `apiCall`'s member and answer
   * `undefined` to the plugin.
   *
   * A call that could not be answered is visible, never a silent no-op: the
   * plugin row shows the host's own message. `handler_error` is the
   * diagnostic kind for it because the failure is the plugin's request, not
   * its load.
   */
  private reportCallFailure(extension: LoadedExtension, member: string, error: unknown): void {
    this.report(extension.spec.id, "handler_error", errorMessage(error), member);
  }

  /**
   * Slot 9: hand one turn's host facts to the plugin exactly as the host
   * answered them.
   *
   * `undefined` is the answer for every failure, and each one is reported: the
   * plugin does not hold `runtime.turn.facts`, or the host has no such turn (a
   * turn it never recorded is an error, not zeroes), or the read itself
   * failed. Nothing here is counted, derived or cached from what the plugin
   * observed — the plugin's own event stream is best-effort and is not the
   * host's numbers.
   */
  private async extensionTurnFacts(
    extension: LoadedExtension,
    input?: { turnId?: string; limit?: number },
  ): Promise<TrustedExtensionTurnFacts | undefined> {
    if (this.refuseApi(extension, "turnFacts", "turnFacts")) return undefined;
    const turnId = typeof input?.turnId === "string" ? input.turnId.trim() : "";
    try {
      return await this.bridge.turnFacts({
        ...(turnId ? { turnId } : {}),
        ...(typeof input?.limit === "number" ? { limit: input.limit } : {}),
      });
    } catch (error) {
      this.reportCallFailure(extension, "turnFacts", error);
      return undefined;
    }
  }

  /**
   * Slot 8: read what a turn contained.
   *
   * One turn answers with the host's facts for it — the numbers are the host's
   * (`turn.facts`), and the conversation text of that one turn is named as
   * unavailable rather than returned empty, because the host exposes no
   * per-turn message read yet. A whole session answers with the newest
   * transcript rows windowed by the host (`session.get`), which is conversation
   * content and therefore needs `runtime.session.read` on top of the slot's own
   * `runtime.turn.recap` (rule 7). Reads are not recorded one by one.
   */
  private async extensionRecap(
    extension: LoadedExtension,
    input?: { scope?: "turn" | "session"; turnId?: string; limit?: number; sessionId?: string; before?: number },
  ): Promise<TrustedExtensionTurnRecap | undefined> {
    const scope = input?.scope === "session" ? "session" : "turn";
    if (this.refuseApi(extension, "recap", "recap")) return undefined;
    if (this.refuseApiScope(extension, "recap", scope, `recap:${scope}`)) return undefined;
    const limit = recapLimit(input?.limit);
    try {
      if (scope === "session") {
        const target = input?.sessionId;
        if (target !== undefined && (typeof target !== "string" || !target.trim() || target.length > 256)) {
          throw new Error("Session recap needs a valid session identity");
        }
        if (input?.before !== undefined && (!Number.isSafeInteger(input.before) || input.before < 0)) {
          throw new Error("Session recap needs a non-negative physical cursor");
        }
        const read = await this.bridge.recapSession({
          limit,
          ...(target === undefined ? {} : { sessionId: target.trim() }),
          ...(input?.before === undefined ? {} : { before: input.before }),
        });
        return {
          scope: "session" as const,
          sessionId: target?.trim() ?? this.bridge.sessionId,
          messages: read.messages,
          truncated: read.truncated,
          ...(read.title === undefined ? {} : { title: read.title }),
          ...(read.messageStart === undefined ? {} : { messageStart: read.messageStart }),
          ...(read.messageEnd === undefined ? {} : { messageEnd: read.messageEnd }),
        };
      }
      const turnId = typeof input?.turnId === "string" ? input.turnId.trim() : "";
      const facts = await this.bridge.turnFacts({
        ...(turnId ? { turnId } : {}),
        limit,
      });
      if (!facts) return undefined;
      return {
        scope: "turn" as const,
        sessionId: facts.sessionId,
        turnId: facts.turnId,
        facts,
        messages: null,
        messagesUnavailable: "no-host-turn-read" as const,
      };
    } catch (error) {
      this.reportCallFailure(extension, `recap:${scope}`, error);
      return undefined;
    }
  }

  /**
   * Slot 10: start another turn after this one ends.
   *
   * The host owns the queue, so the continuation is a real, durable turn that
   * survives a restart and is drained at the next turn boundary — the same
   * mechanism a user message uses. There is no numeric quota (ADR 0295 rule
   * 9): what replaces it is the visible row ADR 0293 asks for, which is why the
   * request carries the plugin's id and label. The queued row is real and
   * visible today, and both it and the durable message row it becomes store
   * that provenance (schema v22, host-core `plugin_provenance.rs`), so the row
   * names the plugin that asked for it.
   */
  private async extensionContinueTurn(
    extension: LoadedExtension,
    input: string | { message?: string },
  ): Promise<TrustedExtensionContinuation | undefined> {
    if (this.refuseApi(extension, "continueTurn", "continueTurn")) return undefined;
    const message = typeof input === "string" ? input : input?.message;
    if (typeof message !== "string" || !message.trim()) {
      this.reportCallFailure(
        extension,
        "continueTurn",
        new Error("continueTurn needs a message to continue with"),
      );
      return undefined;
    }
    try {
      return await this.bridge.continueTurn({
        message,
        pluginId: extension.spec.id,
        pluginLabel: extension.spec.label,
      });
    } catch (error) {
      this.reportCallFailure(extension, "continueTurn", error);
      return undefined;
    }
  }

  /**
   * Plugin-level completion on user-configured models. Permission
   * `agent.model.complete` (or legacy `agent.complete` at the host). Not a
   * renderer path: business AI belongs in the extension/plugin process.
   */
  private async extensionAiComplete(
    extension: LoadedExtension,
    input: unknown,
  ): Promise<unknown> {
    const perms = extension.spec.permissions ?? [];
    const allowed =
      perms.includes(PLUGIN_MODEL_COMPLETE_PERMISSION) || perms.includes("agent.complete");
    if (!allowed) {
      this.report(
        extension.spec.id,
        "permission_denied",
        `ai.complete was refused: the plugin does not hold ${PLUGIN_MODEL_COMPLETE_PERMISSION}`,
        "ai.complete",
      );
      return { ok: false, code: "PERMISSION_DENIED" };
    }
    const record = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    if (!Array.isArray(record.messages) || record.messages.length === 0) {
      this.reportCallFailure(extension, "ai.complete", new Error("ai.complete needs messages"));
      return { ok: false, code: "INVALID_INPUT" };
    }
    try {
      return await this.bridge.aiComplete({
        ...record,
        pluginId: extension.spec.id,
        permissions: extension.spec.permissions ?? [],
      } as never);
    } catch (error) {
      this.reportCallFailure(extension, "ai.complete", error);
      return { ok: false, code: "PROVIDER_ERROR", detail: errorMessage(error) };
    }
  }

  /**
   * The slot permission that refuses this extension, or `undefined` when it
   * holds the permission and may proceed (ADR 0295 rule 2).
   *
   * Every mapped slot name is registered, so there is no exception: the gate
   * applies to every plugin, and the high-trust tier is no different —
   * `agent.extension` says where the code runs and never implies a slot grant.
   * A handler the plugin may not run is skipped and reported, never silently
   * allowed (see `emit`, `refuseApi`, and `toolResultExtensionAllowed`).
   */
  private refusedPermission(
    extension: LoadedExtension,
    permission: string | undefined,
  ): string | undefined {
    if (!permission) return undefined;
    return extension.permissions.has(permission) ? undefined : permission;
  }

  /**
   * Slot-5 gate for one tool result (ADR 0295 rule 2): may the extension that
   * registered `toolName` introduce tools, report spend, and request early
   * termination with its result? A refusal is reported as `permission_denied`
   * on the plugin row. `undefined` means the tool belongs to no extension, so
   * the caller's own rules decide; only the runner knows the slot behind a tool
   * an extension registered.
   */
  toolResultExtensionAllowed(toolName: string): boolean | undefined {
    const owner = [...this.loaded.values()].find((extension) =>
      extension.tools.has(toolName),
    );
    if (!owner) return undefined;
    return !this.refuseApi(owner, "toolResult", `toolResult:${toolName}`);
  }

  /**
   * Report an answer a slot accepted but the host will not honour (ADR 0295
   * rules 2 and 5).
   *
   * The plugin holds the grant, so this is not a permission refusal: its hook
   * ran and answered, and the answer itself cannot be applied — a model this
   * run cannot request, or a message list that is not a message list. The host
   * says so on the plugin row instead of quietly passing the answer through,
   * which is the same rule that makes a skipped handler a diagnostic.
   */
  rejectSlotAnswer(extensionId: string, member: string, message: string): void {
    this.report(extensionId, "handler_error", message, member);
  }

  private errorReport(extensionId: string): TrustedExtensionLoadReport {
    return { extensionId, state: "error", toolNames: [], commandNames: [], agentNames: [], eventNames: [] };
  }

  private report(
    extensionId: string,
    kind: TrustedExtensionDiagnosticKind,
    message: string,
    member?: string,
    stack?: string,
  ): void {
    const key = `${extensionId} ${kind} ${member ?? ""}`;
    const existing = this.diagnostics.get(key);
    if (existing) {
      existing.count += 1;
      existing.message = message;
    } else {
      this.diagnostics.set(key, {
        extensionId,
        kind,
        message,
        ...(member ? { member } : {}),
        count: 1,
        ...(stack ? { stack } : {}),
      });
    }
    this.scheduleDiagnostics();
  }

  private scheduleDiagnostics(): void {
    if (this.publishScheduled) return;
    this.publishScheduled = true;
    queueMicrotask(() => this.flushDiagnostics());
  }

  private flushDiagnostics(): void {
    this.publishScheduled = false;
    this.bridge.publishDiagnostics(this.getDiagnostics());
  }

  private inert(extension: LoadedExtension, member: string, returns?: unknown) {
    return (..._args: unknown[]) => {
      this.report(
        extension.spec.id,
        "unsupported_api",
        `${member} is not available in PI-Desktop`,
        member,
      );
      return returns;
    };
  }

  private exec(
    command: string,
    args: string[],
    options?: ExtensionExecOptions,
  ): Promise<ExtensionExecResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: options?.cwd ?? this.bridge.cwd,
        env: options?.env ? { ...process.env, ...options.env } : process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const maxBuffer = options?.maxBuffer ?? 10 * 1024 * 1024;
      let stdout = "";
      let stderr = "";
      let killed = false;
      const kill = () => {
        killed = true;
        child.kill("SIGTERM");
      };
      const timer = options?.timeout ? setTimeout(kill, options.timeout) : undefined;
      options?.signal?.addEventListener("abort", kill, { once: true });
      child.stdout?.on("data", (chunk: Buffer) => {
        if (stdout.length < maxBuffer) stdout += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderr.length < maxBuffer) stderr += chunk.toString("utf8");
      });
      child.on("error", (err) => {
        if (timer) clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code) => {
        if (timer) clearTimeout(timer);
        resolve({ stdout, stderr, code: code ?? (killed ? 143 : 0), killed });
      });
    });
  }

  private createUi(extension: LoadedExtension): Record<string, unknown> {
    const request = (req: TrustedExtensionUiRequest) =>
      this.bridge.requestUi(extension.spec, req);
    const ui: Record<string, unknown> = {
      notify: (message: string, level: "info" | "warning" | "error" = "info") => {
        void request({ kind: "notify", message: String(message), level });
      },
      confirm: async (title: string, message: string) => {
        const res = await request({ kind: "confirm", title: String(title), message: String(message ?? "") });
        return res.kind === "confirm" ? res.value : false;
      },
      select: async (title: string, options: string[]) => {
        const res = await request({
          kind: "select",
          title: String(title),
          options: Array.isArray(options) ? options.map(String) : [],
        });
        return res.kind === "select" ? res.value : undefined;
      },
      input: async (title: string, placeholder?: string) => {
        const res = await request({
          kind: "input",
          title: String(title),
          ...(placeholder ? { placeholder: String(placeholder) } : {}),
        });
        return res.kind === "input" ? res.value : undefined;
      },
      setStatus: (key: string, text: string | undefined) => {
        void request({ kind: "setStatus", key: String(key), text: text ?? undefined });
      },
      setWorkingMessage: (text?: string) => {
        void request({ kind: "setWorkingMessage", text: text ?? undefined });
      },
    };
    for (const member of INERT_UI_MEMBERS) {
      ui[member] = this.inert(extension, `ui.${member}`, () => undefined);
    }
    return ui;
  }

  private createContext(extension: LoadedExtension): Record<string, unknown> {
    const bridge = this.bridge;
    return {
      ui: this.createUi(extension),
      hasUI: true,
      cwd: bridge.cwd,
      sessionManager: {
        getEntries: () => [],
        getBranch: () => [],
        getLeafId: () => null,
        getSessionFile: () => undefined,
        getSessionId: () => bridge.sessionId,
        getCwd: () => bridge.cwd,
      },
      modelRegistry: bridge.modelRegistry ?? {},
      get model() {
        return bridge.getModel();
      },
      isIdle: () => bridge.isIdle(),
      // The live cancellation token of the running turn (ADR 0295 slot 3): a
      // long-running plugin keeps the signal and stops when the turn aborts.
      signal: bridge.getAbortSignal(),
      abort: () => bridge.abort(),
      hasPendingMessages: () => bridge.hasPendingMessages(),
      shutdown: this.inert(extension, "shutdown"),
      getContextUsage: () => bridge.getContextUsage(),
      compact: (options?: { customInstructions?: string }) => bridge.compact(options),
      getSystemPrompt: () => bridge.getSystemPrompt(),
    };
  }

  private createCommandContext(extension: LoadedExtension): Record<string, unknown> {
    const bridge = this.bridge;
    return {
      ...this.createContext(extension),
      getSystemPromptOptions: () => ({}),
      waitForIdle: () => bridge.waitForIdle(),
      newSession: () => bridge.newSession(),
      fork: (entryId: string) => bridge.fork(entryId),
      navigateTree: this.inert(extension, "navigateTree", Promise.resolve({ cancelled: true })),
      switchSession: this.inert(extension, "switchSession", Promise.resolve({ cancelled: true })),
    };
  }

  private registerAgentDefinition(extension: LoadedExtension, input: unknown): void {
    if (!input || typeof input !== "object") {
      this.report(extension.spec.id, "rejected_registration", "agent definition must be an object", "registerAgent");
      return;
    }
    const definition = input as Partial<TrustedExtensionAgentDefinition>;
    const id = typeof definition.id === "string" ? definition.id.trim() : "";
    const models = Array.isArray(definition.models) ? definition.models : [];
    if (!id || models.length === 0 || (!definition.stream && !definition.complete)) {
      this.report(
        extension.spec.id,
        "rejected_registration",
        "agent needs id, models, and stream() or complete()",
        id || "registerAgent",
      );
      return;
    }
    const key = `${extension.spec.id}:${id}`;
    if (
      [...this.loaded.values()].some((item) => item.agents.has(id) || [...item.agents.values()].some((agent) => agent.key === key)) ||
      extension.agents.has(id)
    ) {
      this.report(extension.spec.id, "rejected_registration", `agent "${id}" is already registered`, id);
      return;
    }
    try {
      const providerId = trustedExtensionAgentProviderId(key);
      const normalizedModels = models.map((model) => modelFromAgentConfig(providerId, model));
      const ids = new Set<string>();
      for (const model of normalizedModels) {
        if (ids.has(model.id)) throw new Error(`duplicate agent model id "${model.id}"`);
        ids.add(model.id);
      }
      extension.agents.set(id, {
        key,
        extensionId: extension.spec.id,
        extensionLabel: extension.spec.label,
        id,
        name: typeof definition.name === "string" && definition.name.trim() ? definition.name.trim() : id,
        providerId,
        models: normalizedModels,
        stream: (model, context, options) => streamForAgent(definition as TrustedExtensionAgentDefinition, model, context, options),
      });
    } catch (error) {
      this.report(extension.spec.id, "rejected_registration", errorMessage(error), id);
    }
  }

  private unregisterAgentDefinition(extension: LoadedExtension, id: string): void {
    extension.agents.delete(String(id).trim());
  }

  private createApi(extension: LoadedExtension): Record<string, unknown> {
    const bridge = this.bridge;
    const api: Record<string, unknown> = {
      on: (event: string, handler: Handler) => {
        if (typeof handler !== "function") return;
        if (
          !NOT_EMITTED_EVENTS.has(event) &&
          !(TRUSTED_EXTENSION_EVENTS as readonly string[]).includes(event)
        ) {
          this.report(extension.spec.id, "unsupported_api", `unknown event "${event}"`, `on:${event}`);
          return;
        }
        const list = extension.handlers.get(event) ?? [];
        list.push(handler);
        extension.handlers.set(event, list);
      },
      registerTool: (tool: ToolDefinitionLike) => {
        const name = typeof tool?.name === "string" ? tool.name : "";
        if (!name || typeof tool.execute !== "function") {
          this.report(extension.spec.id, "rejected_registration", "tool needs a name and execute()", name || "tool");
          return;
        }
        const reserved = new Set(this.reservedToolNames());
        const takenByExtension = [...this.loaded.values()].some(
          (other) => other !== extension && other.tools.has(name),
        );
        if (reserved.has(name) || takenByExtension || extension.tools.has(name)) {
          this.report(extension.spec.id, "rejected_registration", `tool name "${name}" is already taken`, name);
          return;
        }
        extension.tools.set(name, tool);
      },
      registerCommand: (name: string, options: RegisteredCommandLike) => {
        if (typeof name !== "string" || !name.trim() || typeof options?.handler !== "function") {
          this.report(extension.spec.id, "rejected_registration", "command needs a name and handler()", name);
          return;
        }
        const clean = name.trim().replace(/^\//, "");
        const taken = [...this.loaded.values()].some((other) => other.commands.has(clean));
        if (taken || extension.commands.has(clean)) {
          this.report(extension.spec.id, "rejected_registration", `command "${clean}" is already registered`, clean);
          return;
        }
        extension.commands.set(clean, options);
      },
      registerAgent: (definition: TrustedExtensionAgentDefinition) => {
        this.registerAgentDefinition(extension, definition);
      },
      unregisterAgent: (id: string) => {
        this.unregisterAgentDefinition(extension, id);
      },
      // The upstream compatibility alias: `registerProvider` accepts the same
      // plugin-owned shape as `registerAgent`, in both the upstream call form
      // (`(id, config)`) and the object form. A `complete` implementation is
      // as valid as a streaming one, so it is carried through rather than
      // dropped.
      registerProvider: (...args: unknown[]) => {
        const first = args[0];
        const second = args[1];
        const isFunction = (value: unknown): boolean => typeof value === "function";
        const pickStream = (source: Record<string, unknown>) =>
          isFunction(source.streamSimple) || isFunction(source.stream)
            ? ((source.streamSimple ?? source.stream) as TrustedExtensionAgentDefinition["stream"])
            : undefined;
        const pickComplete = (source: Record<string, unknown>) =>
          isFunction(source.complete)
            ? (source.complete as TrustedExtensionAgentDefinition["complete"])
            : undefined;
        if (typeof first === "string" && second && typeof second === "object") {
          const config = second as Record<string, unknown>;
          this.registerAgentDefinition(extension, {
            id: first,
            name: typeof config.name === "string" ? config.name : first,
            models: Array.isArray(config.models)
              ? (config.models as TrustedExtensionAgentModelConfig[])
              : [],
            stream: pickStream(config),
            complete: pickComplete(config),
          });
          return;
        }
        if (first && typeof first === "object") {
          const provider = first as Record<string, unknown>;
          const getModels = provider.getModels;
          const models = isFunction(getModels)
            ? (getModels as () => unknown).call(first)
            : provider.models;
          this.registerAgentDefinition(extension, {
            id: typeof provider.id === "string" ? provider.id : "provider",
            name: typeof provider.name === "string" ? provider.name : undefined,
            models: Array.isArray(models)
              ? (models as TrustedExtensionAgentModelConfig[])
              : [],
            stream: pickStream(provider),
            complete: pickComplete(provider),
          });
          return;
        }
        this.report(
          extension.spec.id,
          "rejected_registration",
          "provider needs a name and a model stream",
          "registerProvider",
        );
      },
      unregisterProvider: (id: string) => {
        this.unregisterAgentDefinition(extension, id);
      },
      registerFlag: (name: string, options: { type?: "boolean" | "string"; default?: boolean | string }) => {
        extension.flags.set(String(name), {
          type: options?.type === "string" ? "string" : "boolean",
          ...(options?.default !== undefined ? { default: options.default } : {}),
        });
      },
      getFlag: (name: string) => extension.flags.get(String(name))?.default,
      exec: (command: string, args: string[], options?: ExtensionExecOptions) =>
        this.exec(command, Array.isArray(args) ? args.map(String) : [], options),
      getActiveTools: () => bridge.getActiveTools(),
      getAllTools: () => bridge.getAllTools(),
      setActiveTools: (names: string[]) => bridge.setActiveTools(Array.isArray(names) ? names.map(String) : []),
      getCommands: () =>
        this.getCommands().map((command) => ({
          name: command.name,
          description: command.description,
          source: "extension",
          location: command.extensionId,
        })),
      setModel: (model: unknown) => bridge.setModel(model),
      getThinkingLevel: () => bridge.getThinkingLevel(),
      setThinkingLevel: (level: string) => bridge.setThinkingLevel(String(level)),
      setSessionName: (name: string) => {
        void bridge.setSessionName(String(name));
      },
      getSessionName: () => bridge.getSessionName(),
      /**
       * Slot 3: ask the host to stop the current turn (ADR 0295 rule 2). The
       * plugin's own long-running work learns about it through
       * `ctx.signal` / the tool execution context's `signal`. Returns whether
       * the request was accepted: a plugin that does not hold
       * `runtime.turn.abort` is refused with a `permission_denied` diagnostic
       * and gets `false`, never a throw and never a silent no-op.
       */
      requestTurnAbort: (): boolean => {
        if (this.refuseApi(extension, "requestTurnAbort", "requestTurnAbort")) return false;
        bridge.abort();
        return true;
      },
      /**
       * Slot 9: the host's own facts for one turn (`runtime.turn.facts`). The
       * answer is the host's `turn.facts` payload, passed through unchanged —
       * nothing is re-derived from the events this plugin saw. `turnId` absent
       * means the turn running now. A plugin without the grant — or a turn the
       * host never recorded — gets `undefined` plus a diagnostic, never a
       * throw and never a silent empty answer.
       */
      turnFacts: (input?: { turnId?: string; limit?: number }) =>
        this.extensionTurnFacts(extension, input),
      /**
       * Slot 8: read what a turn contained (`runtime.turn.recap`). The default
       * scope is one turn; `scope: "session"` reads the whole session and
       * needs `runtime.session.read` as well (ADR 0295 rule 7). Reads are not
       * logged one by one.
       */
      getPluginSettings: () => structuredClone(extension.spec.settings ?? {}),
      recap: (input?: { scope?: "turn" | "session"; turnId?: string; limit?: number; sessionId?: string; before?: number }) =>
        this.extensionRecap(extension, input),
      /**
       * Slot 10: start another turn after this one ends
       * (`runtime.turn.continue`). The host owns the queue, so the
       * continuation is a real durable turn and there is no numeric quota
       * (ADR 0295 rule 9). Without the grant the plugin gets `undefined` and a
       * `permission_denied` diagnostic.
       */
      continueTurn: (input: string | { message?: string }) =>
        this.extensionContinueTurn(extension, input),
      ai: {
        complete: (input: unknown) => this.extensionAiComplete(extension, input),
        completeStream: async (input: unknown, onDelta?: (text: string) => void) => {
          const result = (await this.extensionAiComplete(extension, input)) as {
            ok?: boolean;
            text?: string;
          };
          if (typeof onDelta === "function" && result?.ok && typeof result.text === "string") {
            onDelta(result.text);
          }
          return result;
        },
      },
      events: {
        on: () => () => {},
        emit: () => {},
      },
    };
    for (const member of INERT_API_MEMBERS) {
      api[member] = this.inert(extension, member);
    }
    return api;
  }
}
