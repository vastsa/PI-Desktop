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
import { managedExec } from "./managed-exec.js";
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
  type TrustedExtensionAgentModelConfig,
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

import { HandlerLifecycle } from "./handler-lifecycle.js";
import { waitForOperation } from "./operation.js";
import {
  isKnownExtensionEvent,
  TRUSTED_EXTENSION_EVENT_CAPABILITIES,
  type TrustedExtensionEventName,
} from "./event-capabilities.js";
export { TRUSTED_EXTENSION_EVENTS, type TrustedExtensionEventName } from "./event-capabilities.js";

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

export type ExtensionToolInfo = { name: string; description: string; active: boolean };

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
  setModel(model: unknown, signal?: AbortSignal): Promise<boolean>;
  getThinkingLevel(): string;
  setThinkingLevel(level: string): void;
  isIdle(): boolean;
  abort(): void;
  hasPendingMessages(): boolean;
  getContextUsage(): { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
  compact(options?: { customInstructions?: string }): void;
  getSystemPrompt(): string;
  getActiveTools(): string[];
  getAllTools(): ExtensionToolInfo[];
  setActiveTools(names: string[]): void;
  getSessionName(): string | undefined;
  setSessionName(name: string, signal?: AbortSignal): void | Promise<void>;
  sendUserMessage(
    content: string | unknown[],
    options?: { deliverAs?: "steer" | "followUp" },
    signal?: AbortSignal,
  ): void | Promise<void>;
  waitForIdle(): Promise<void>;
  newSession(): Promise<{ cancelled: boolean }>;
  fork(entryId: string): Promise<{ cancelled: boolean }>;
  requestUi(
    extension: TrustedExtensionSpec,
    request: TrustedExtensionUiRequest,
    signal?: AbortSignal,
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
  private closing = false;
  private disposal?: Promise<void>;
  private readonly lifecycle = new HandlerLifecycle();
  private readonly processes = new Set<Promise<ExtensionExecResult>>();

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
    const signal = this.lifecycle.signal;
    for (const spec of this.specs) {
      if (this.closing || signal.aborted) break;
      const extension: LoadedExtension = {
        spec,
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
          factory = await this.lifecycle.run(
            () => loadExtensionFactory(spec.entry, virtualModules), signal, TRUSTED_EXTENSION_HANDLER_TIMEOUT_MS,
          );
        } catch (err) {
          if (signal.aborted) break;
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
        const loadedFactory = factory;
        await this.lifecycle.run(
          () => loadedFactory(this.createApi(extension)), signal, TRUSTED_EXTENSION_HANDLER_TIMEOUT_MS,
        );
      } catch (err) {
        if (signal.aborted) break;
        this.report(spec.id, "factory_error", errorMessage(err), undefined, errorStack(err));
        this.reports.set(spec.id, this.errorReport(spec.id));
        continue;
      }
      if (this.closing || signal.aborted) break;
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
    if (this.closing || signal.aborted) return this.getLoadReports();
    this.bridge.publishCommands(this.getCommands());
    this.flushDiagnostics();
    await this.emit("session_start", { type: "session_start", reason: "startup" });
    return this.getLoadReports();
  }

  /** Retire current dispatches; subsequent turns use a fresh generation. */
  cancelPending(): void {
    if (!this.closing) this.lifecycle.cancel();
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.closing = true;
    this.lifecycle.cancel();
    this.disposal = Promise.resolve().then(async () => {
      try {
        await this.dispatch("session_shutdown", { type: "session_shutdown", reason: "quit" });
      } finally {
        this.disposed = true;
        this.lifecycle.cancel();
        await Promise.allSettled([...this.processes]);
        this.bridge.publishCommands([]);
      }
    });
    return this.disposal;
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
          execute: (toolCallId, params, signal, onUpdate) => {
            if (this.closing) throw new DOMException("Extension disposed", "AbortError");
            const parent = signal ? AbortSignal.any([signal, this.lifecycle.signal]) : this.lifecycle.signal;
            return this.lifecycle.run(async () => {
              const operation = this.lifecycle.operationSignal;
              const result = await def.execute(toolCallId, structuredClone(params), operation,
                onUpdate ? (partial) => { if (!operation.aborted) onUpdate(structuredClone(partial)); } : undefined,
                this.createContext(extension));
              return structuredClone(result);
            }, parent);
          },
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
    if (this.closing) return false;
    for (const extension of this.loaded.values()) {
      const command = extension.commands.get(name);
      if (!command) continue;
      const signal = this.lifecycle.signal;
      try {
        await this.lifecycle.run(() => command.handler(args, this.createCommandContext(extension)), signal);
      } catch (err) {
        if (!signal.aborted && !(err instanceof Error && err.name === "AbortError")) {
          this.report(extension.spec.id, "handler_error", errorMessage(err), `command:${name}`, errorStack(err));
        }
      }
      return true;
    }
    return false;
  }

  /**
   * Emit one event to every handler in load order. For result events the
   * results are folded by the caller-supplied reducer; a throwing or stalled
   * handler counts as `undefined` (spec §6).
   */
  async emit<R = unknown>(
    event: TrustedExtensionEventName,
    payload: Record<string, unknown>,
    fold?: (acc: R | undefined, next: R) => R,
  ): Promise<R | undefined> {
    if (this.closing) return undefined;
    return this.dispatch(event, payload, fold);
  }

  private async dispatch<R>(
    event: TrustedExtensionEventName,
    payload: Record<string, unknown>,
    fold?: (acc: R | undefined, next: R) => R,
  ): Promise<R | undefined> {
    const signal = this.lifecycle.signal;
    let acc: R | undefined;
    for (const extension of this.loaded.values()) {
      const handlers = extension.handlers.get(event);
      if (!handlers?.length) continue;
      for (const handler of handlers) {
        if (signal.aborted || this.disposed) return undefined;
        try {
          // Result/mutation events operate on detached data. Only a timely
          // headers mutation is committed; late handlers retain their own copy.
          const isolate = TRUSTED_EXTENSION_EVENT_CAPABILITIES[event] === "result" ||
            TRUSTED_EXTENSION_EVENT_CAPABILITIES[event] === "mutation";
          const input = isolate ? structuredClone(payload) : payload;
          const result = await this.lifecycle.run(
            () => handler(input, this.createContext(extension)), signal, TRUSTED_EXTENSION_HANDLER_TIMEOUT_MS,
          ) as R | undefined;
          if (signal.aborted || this.disposed) return undefined;
          if (event === "before_provider_headers" && payload.headers && typeof payload.headers === "object") {
            for (const key of Object.keys(payload.headers)) Reflect.deleteProperty(payload.headers, key);
            Object.assign(payload.headers, structuredClone(input.headers));
          }
          if (result !== undefined && result !== null) {
            const detached = isolate ? structuredClone(result) : result;
            acc = fold ? fold(acc, detached) : detached;
          }
        } catch (err) {
          if (signal.aborted || this.disposed) return undefined;
          const kind: TrustedExtensionDiagnosticKind = /exceeded \d+ms/.test(errorMessage(err))
            ? "handler_timeout"
            : "handler_error";
          this.report(extension.spec.id, kind, errorMessage(err), event, errorStack(err));
        }
      }
    }
    return acc;
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
    extension: LoadedExtension,
    command: string,
    args: string[],
    options?: ExtensionExecOptions,
  ): Promise<ExtensionExecResult> {
    if (this.disposed) return Promise.reject(new DOMException("Extension disposed", "AbortError"));
    const pending = managedExec(command, args, this.bridge.cwd, this.lifecycle.operationSignal, options);
    this.processes.add(pending);
    void pending.then(() => this.processes.delete(pending), (error: unknown) => {
      this.processes.delete(pending);
      this.report(extension.spec.id, "handler_error", errorMessage(error), "exec");
    });
    return pending;
  }

  private createUi(extension: LoadedExtension): Record<string, unknown> {
    const signal = this.lifecycle.operationSignal;
    const request = (req: TrustedExtensionUiRequest) => {
      signal.throwIfAborted();
      return waitForOperation(this.bridge.requestUi(extension.spec, req, signal), signal).then((response) => {
        if ("cancelled" in response && response.cancelled) {
          this.lifecycle.cancelOperation();
          signal.throwIfAborted();
        }
        return response;
      });
    };
    const ui: Record<string, unknown> = {
      notify: (message: string, level: "info" | "warning" | "error" = "info") => {
        void request({ kind: "notify", message: String(message), level }).catch((error: unknown) => {
          if (!signal.aborted) this.report(extension.spec.id, "handler_error", errorMessage(error), "ui.notify");
        });
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
        void request({ kind: "setStatus", key: String(key), text: text ?? undefined }).catch((error: unknown) => {
          if (!signal.aborted) this.report(extension.spec.id, "handler_error", errorMessage(error), "ui.setStatus");
        });
      },
      setWorkingMessage: (text?: string) => {
        void request({ kind: "setWorkingMessage", text: text ?? undefined }).catch((error: unknown) => {
          if (!signal.aborted) this.report(extension.spec.id, "handler_error", errorMessage(error), "ui.setWorkingMessage");
        });
      },
    };
    for (const member of INERT_UI_MEMBERS) {
      ui[member] = this.inert(extension, `ui.${member}`, () => undefined);
    }
    return ui;
  }

  private createContext(extension: LoadedExtension): Record<string, unknown> {
    const bridge = this.operationBridge(this.lifecycle.operationSignal);
    return {
      signal: this.lifecycle.operationSignal,
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
      abort: () => bridge.abort(),
      hasPendingMessages: () => bridge.hasPendingMessages(),
      shutdown: this.inert(extension, "shutdown"),
      getContextUsage: () => bridge.getContextUsage(),
      compact: (options?: { customInstructions?: string }) => bridge.compact(options),
      getSystemPrompt: () => bridge.getSystemPrompt(),
    };
  }

  private createCommandContext(extension: LoadedExtension): Record<string, unknown> {
    const bridge = this.operationBridge(this.lifecycle.operationSignal);
    return {
      ...this.createContext(extension),
      getSystemPromptOptions: () => ({}),
      waitForIdle: () => bridge.waitForIdle(),
      newSession: () => bridge.newSession(),
      fork: (entryId: string) => bridge.fork(entryId),
      navigateTree: this.inert(extension, "navigateTree", Promise.resolve({ cancelled: true })),
      switchSession: this.inert(extension, "switchSession", Promise.resolve({ cancelled: true })),
      sendUserMessage: (content: string | unknown[], options?: { deliverAs?: "steer" | "followUp" }) =>
        bridge.sendUserMessage(content, options),
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
    const bridge = this.operationBridge();
    const api: Record<string, unknown> = {
      on: (event: string, handler: Handler) => {
        if (typeof handler !== "function") return;
        if (!isKnownExtensionEvent(event)) {
          this.report(extension.spec.id, "unsupported_api", `unknown event "${event}"`, `on:${event}`);
          return;
        }
        if (TRUSTED_EXTENSION_EVENT_CAPABILITIES[event] === "deferred") {
          this.report(extension.spec.id, "unsupported_api", `event "${event}" is not emitted by Desktop`, `on:${event}`);
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
        this.exec(extension, command, Array.isArray(args) ? args.map(String) : [], options),
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
        const signal = this.lifecycle.operationSignal;
        void Promise.resolve(bridge.setSessionName(String(name))).catch((error: unknown) => {
          if (!signal.aborted) this.report(extension.spec.id, "handler_error", errorMessage(error), "setSessionName");
        });
      },
      getSessionName: () => bridge.getSessionName(),
      sendUserMessage: (content: string | unknown[], options?: { deliverAs?: "steer" | "followUp" }) =>
        bridge.sendUserMessage(content, options),
      events: {
        on: () => () => {},
        emit: () => {},
      },
    };
    for (const member of INERT_API_MEMBERS) {
      api[member] = this.inert(extension, member);
    }
    return new Proxy(api, {
      get: (target, key) => {
        const member: unknown = Reflect.get(target, key);
        if (typeof member !== "function") return member;
        return (...args: unknown[]) => {
          this.lifecycle.operationSignal.throwIfAborted();
          if (this.disposed) throw new DOMException("Extension disposed", "AbortError");
          return Reflect.apply(member, target, args);
        };
      },
    });
  }

  /** AsyncLocalStorage preserves the original invocation even in late callbacks. */
  private operationBridge(boundSignal?: AbortSignal): TrustedExtensionBridge {
    return new Proxy(this.bridge, {
      get: (target, key, receiver) => {
        const value: unknown = Reflect.get(target, key, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          const signal = boundSignal ?? this.lifecycle.operationSignal;
          signal.throwIfAborted();
          if (this.disposed) throw new DOMException("Extension disposed", "AbortError");
          const callArgs = key === "sendUserMessage" ? [args[0], args[1], signal]
            : key === "setModel" || key === "setSessionName" ? [args[0], signal] : args;
          const result: unknown = Reflect.apply(value, target, callArgs);
          if (!(result instanceof Promise)) return result;
          const waiting = waitForOperation(result, signal);
          // Some upstream SDK setters are fire-and-forget. Observe rejection
          // without changing the promise seen by an awaiting extension.
          void waiting.catch(() => {
            if (!signal.aborted) console.error(`[extensions] SDK operation failed: ${String(key)}`);
          });
          return waiting;
        };
      },
    });
  }
}
