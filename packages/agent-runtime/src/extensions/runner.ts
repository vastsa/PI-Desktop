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

/** Events the desktop runtime emits in v1 (spec §6). */
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
  "model_select",
  "thinking_level_select",
  "session_before_compact",
  "session_compact",
  "session_compact_failed",
  "session_before_fork",
  "input",
] as const;

export type TrustedExtensionEventName = (typeof TRUSTED_EXTENSION_EVENTS)[number];

/** Upstream events the runtime never emits in v1; handlers register silently. */
const NOT_EMITTED_EVENTS = new Set([
  "user_bash",
  "session_before_switch",
  "session_before_tree",
  "session_tree",
  "ui_prompt_start",
  "ui_prompt_end",
]);

/** Events whose handler result is honored, and therefore time-limited. */
const RESULT_EVENTS = new Set<string>([
  "resources_discover",
  "before_agent_start",
  "context",
  "before_provider_request",
  "before_provider_headers",
  "message_end",
  "tool_call",
  "tool_result",
  "session_before_compact",
  "session_before_fork",
  "input",
  "project_trust",
]);

/** ExtensionAPI members deferred to v2 or unsupported in v1 (spec §5). */
const INERT_API_MEMBERS = [
  "sendMessage",
  "appendEntry",
  "setLabel",
  "switchSession",
  "registerShortcut",
  "registerMarkdownTransformer",
  "registerMessageRenderer",
  "registerEntryRenderer",
  "registerProvider",
  "registerAgent",
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

/** What the desktop runtime provides to extensions. All methods may be sync or async. */
export interface TrustedExtensionBridge {
  sessionId: string;
  cwd: string;
  getModel(): unknown;
  setModel(model: unknown): Promise<boolean>;
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
  setSessionName(name: string): void | Promise<void>;
  sendUserMessage(
    content: string | unknown[],
    options?: { deliverAs?: "steer" | "followUp" },
  ): void | Promise<void>;
  waitForIdle(): Promise<void>;
  newSession(): Promise<{ cancelled: boolean }>;
  fork(entryId: string): Promise<{ cancelled: boolean }>;
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
  tools: Map<string, ToolDefinitionLike>;
  commands: Map<string, RegisteredCommandLike>;
  handlers: Map<string, Handler[]>;
  flags: Map<string, { type: "boolean" | "string"; default?: boolean | string }>;
};

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
        tools: new Map(),
        commands: new Map(),
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
   * Emit one event to every handler in load order. For result events the
   * results are folded by the caller-supplied reducer; a throwing or stalled
   * handler counts as `undefined` (spec §6).
   */
  async emit<R = unknown>(
    event: TrustedExtensionEventName,
    payload: Record<string, unknown>,
    fold?: (acc: R | undefined, next: R) => R,
  ): Promise<R | undefined> {
    if (this.disposed) return undefined;
    let acc: R | undefined;
    const timed = RESULT_EVENTS.has(event);
    for (const extension of this.loaded.values()) {
      const handlers = extension.handlers.get(event);
      if (!handlers?.length) continue;
      const ctx = this.createContext(extension);
      for (const handler of handlers) {
        try {
          const run = Promise.resolve(handler(payload, ctx));
          const result = (await (timed
            ? withTimeout(run, TRUSTED_EXTENSION_HANDLER_TIMEOUT_MS)
            : run)) as R | undefined;
          if (result !== undefined && result !== null) {
            acc = fold ? fold(acc, result) : result;
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

  private errorReport(extensionId: string): TrustedExtensionLoadReport {
    return { extensionId, state: "error", toolNames: [], commandNames: [], eventNames: [] };
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
      sendUserMessage: (content: string | unknown[], options?: { deliverAs?: "steer" | "followUp" }) =>
        bridge.sendUserMessage(content, options),
    };
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
    return api;
  }
}
