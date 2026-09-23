/**
 * Subagents: bounded delegate agent loops spawned by the `Task` tool (ADR 0062).
 *
 * A delegate is a second pi `Agent` inside the same sidecar process, with its
 * own system prompt, its own (possibly pinned) provider/model, and only the
 * tools its definition declares. It shares the session's host connection, so
 * every tool call it makes goes through the same host-core permission and
 * containment path as the parent's.
 *
 * Two boundaries define the design:
 * - The parent's model context only ever gains the delegate's final report
 *   (and a one-line heartbeat while it runs). Child messages and tool rows
 *   are emitted for the transcript and persisted for review, but the session
 *   runtime filters them out when it rebuilds model context.
 * - A delegate's lifecycle never reaches Electron main's turn handling. It
 *   runs in the background under the session runtime (ADR 0089 / D328):
 *   `Task` starts it and returns, `TaskWait` may converge early, and when it
 *   finishes the runtime delivers the report to the parent even if the parent
 *   already stopped calling tools. Only user Stop or `TaskStop` aborts it.
 */

import { randomUUID } from "node:crypto";
import {
  Agent,
  convertToLlm,
  type AfterToolCallContext,
  type AfterToolCallResult,
  type AgentEvent,
  type AgentLoopTurnUpdate,
  type AgentMessage,
  type AgentTool,
  type PrepareNextTurnContext,
} from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  addUsage,
  cumulativeDelta,
  isCertificateVerificationError,
  subagentCanMutate,
  subagentToolsLabel,
  type AgentEventEnvelope,
  type MessageUsage,
  type SubagentDefinition,
  type SubagentRunStatus as SharedSubagentRunStatus,
  type SubagentThinkingLevel,
  type UiMessage,
} from "@pi-desktop/shared";
import { classifyAgentError } from "./agent-errors.js";
import { readLocalRequestErrorDetails } from "./local-request-errors.js";
import { withProviderFetchFailure } from "./provider-transport-recovery.js";
import {
  assistantContent,
  nowIso,
  usageFromPi,
} from "./agent-messages.js";
import type { RuntimeProviderConfig } from "./provider-binding.js";
import { clampThinkingLevel } from "./thinking-level.js";
import { subagentModelBinding, type SubagentProviderRetryState } from "./subagent-model-binding.js";
import { contextBudgetFor } from "./context-budget.js";
import {
  delegateRetentionMode,
  delegateSummaryModels,
  prepareDelegateTurnContext,
  subagentContextOverflowError,
  type DelegateTurnUpdate,
} from "./subagent-context.js";
import {
  dedupeToolCallMessages,
  reportDuplicateToolCallDrop,
} from "./tool-call-dedupe.js";
import {
  classifyProviderError,
  delayWithAbort,
  PROVIDER_RATE_LIMIT_MAX_RETRIES,
  PROVIDER_TRANSIENT_MAX_RETRIES,
  isTransientProviderRetryCode,
  providerRateLimitDelayMs,
  providerSetupRetryDelayMs,
} from "./provider-retry.js";

export const SUBAGENT_TOOL_NAME = "Task";
/** Converge on running delegations and read their reports (ADR 0089). */
export const SUBAGENT_WAIT_TOOL_NAME = "TaskWait";
/** Report on the session's delegations without waiting (ADR 0089). */
export const SUBAGENT_LIST_TOOL_NAME = "TaskList";
/** Stop running delegations (ADR 0089). */
export const SUBAGENT_STOP_TOOL_NAME = "TaskStop";

/** The report is the only thing that enters the parent's context; keep it
 * from becoming the context problem delegation was supposed to avoid. */
export const MAX_SUBAGENT_REPORT_CHARS = 12_000;

export type SubagentRunStatus = SharedSubagentRunStatus;

export type SubagentRunResult = {
  agentName: string;
  /** Provider/model used by this run after delegation resolution. */
  modelId: string;
  /** Thinking selection passed to the delegate after inheritance/clamping. */
  thinkingLevel: SubagentThinkingLevel;
  status: SubagentRunStatus;
  /** Text handed back to the parent model. */
  report: string;
  /** Provider requests the delegate spent. */
  turns: number;
  toolCalls: number;
  usage?: MessageUsage;
  modelFailures?: Array<{ model: string; code: string; message: string }>;
  /** In-memory context compactions the run needed (ADR 0299). */
  contextCompactions?: number;
  /** True when the run had to discard working history without a summary. */
  contextDegraded?: boolean;
  error?: { code: string; message: string };
};

export type SubagentToolOutcome = {
  isError?: boolean;
  terminate?: boolean;
};

export type SubagentRunOptions = {
  definition: SubagentDefinition;
  sessionId: string;
  /** Parent durable turn; child rows are attributed to the same turn. */
  turnId?: string;
  /** `Task` call that owns this delegate. */
  parentToolCallId: string;
  /** The delegated instruction, written by the parent model. */
  task: string;
  /** Provider resolved by Electron main (the definition's pin, or the
   * session's provider when the definition pins nothing). */
  provider: RuntimeProviderConfig;
  /** Inherited session policy for retrying transient provider failures. */
  infiniteProviderRetry?: boolean;
  thinkingLevel: SubagentThinkingLevel;
  /** User-owned definition pins only, in configured order. Missing bindings fail visibly. */
  fallbackModels?: Array<{ key: string; provider?: RuntimeProviderConfig }>;
  /** Original parent thinking selection, before primary-model clamping. */
  inheritedThinkingLevel?: SubagentThinkingLevel;
  onModelChange?: (provider: RuntimeProviderConfig, thinkingLevel: SubagentThinkingLevel) => void;
  /** Fully composed child system prompt (see `composeSubagentSystemPrompt`). */
  systemPrompt: string;
  /** Host-backed tools, built by the session runtime so a delegate's calls
   * take the exact same path as the parent's. */
  tools: AgentTool[];
  onEvent: (envelope: AgentEventEnvelope) => void;
  /**
   * Result of the parent's own `afterToolCall` bookkeeping for one call, so a
   * host failure reaches the delegate's tool-error channel the same way it
   * reaches the parent's.
   */
  resolveToolOutcome?: (
    context: AfterToolCallContext,
  ) => SubagentToolOutcome | undefined;
  signal?: AbortSignal;
  /**
   * Prior chain messages that seed this run (ADR 0279). Omitted for a cold
   * start. The original `task` is still passed to `prompt()` as the new user
   * turn; these messages are everything that came before it.
   */
  initialMessages?: AgentMessage[];
};

/**
 * Compose the delegate's system prompt.
 *
 * The session runtime owns the shared parts (shell dialect, scratch
 * directory, project instruction chain) because it is the only place that
 * knows them; this function only decides the framing and the ordering, with
 * the definition body ahead of the workspace guidance so a project's own
 * instructions still have the last word.
 */
export function composeSubagentSystemPrompt(options: {
  definition: SubagentDefinition;
  /** Guidance blocks inherited from the session (shell, scratch, rules). */
  guidance?: string[];
  /** Spawn-time tool names after inherit resolution. */
  toolNames?: readonly string[];
}): string {
  const { definition } = options;
  const resolved = options.toolNames;
  const toolList =
    resolved && resolved.length > 0
      ? resolved.join(", ")
      : subagentToolsLabel(definition);
  const framing = [
    `You are the \"${definition.name}\" subagent inside PI-Desktop, working on one task delegated by the main agent.`,
    `You cannot see the user, ask questions, or delegate further. Finish the task with the tools you have: ${toolList}.`,
    subagentCanMutate(definition, resolved)
      ? "You may change files, but only the ones the task is about; leave everything else untouched."
      : "You have no tools that change files or run commands, so never report an edit you could not have made.",
    "Your final message is the report the main agent receives when you finish. Make it self-contained: what you did, what you found with exact paths and line numbers, and anything you could not finish.",
    "Keep the report tight. Report findings, not narration, and never pad it with a summary of your own process.",
    "If you discover in the first few turns that you lack a tool essential to the task (e.g. no Bash when shell commands are needed), stop immediately with a one-sentence report naming the missing capability. Do not attempt workarounds or pad the report with unrelated reading.",
  ].join("\n");
  return [framing, definition.prompt, ...(options.guidance ?? [])]
    .filter((block) => block.trim().length > 0)
    .join("\n\n");
}

function boundedReport(value: string): string {
  const text = value.trim();
  if (text.length <= MAX_SUBAGENT_REPORT_CHARS) return text;
  const marker = "\n\n[subagent report truncated]\n\n";
  const available = MAX_SUBAGENT_REPORT_CHARS - marker.length;
  const head = Math.ceil(available / 2);
  const tail = Math.floor(available / 2);
  return `${text.slice(0, head)}${marker}${text.slice(-tail)}`;
}

export { addUsage };

/** One delegate execution. A resumed run is still a new instance; it is
 * seeded with the prior chain's messages rather than kept warm in memory. */
export class SubagentRun {
  private readonly agent: Agent;
  private readonly opts: SubagentRunOptions;
  private currentAssistant?: UiMessage;
  private lastReportText = "";
  private turns = 0;
  private toolCalls = 0;
  private usage?: MessageUsage;
  private streamError?: { code: string; message: string };
  /** Set when a settled message reads as a cancel — `stopReason: "aborted"`, or
   * a local marker whose preserved cause name is `AbortError`. pi-ai can wrap
   * an abort that fired before the parent signal flipped, so this is the only
   * trace of the Stop and the run has to report `aborted` from it. */
  private turnAborted = false;
  private contextCompactions = 0;
  private contextDegraded = false;
  /** Set when the turn-boundary guard throws because even the degraded
   * context does not fit; the synthetic stream error keeps this code. */
  private pendingContextOverflow?: { code: "SUBAGENT_CONTEXT_OVERFLOW"; message: string };
  private pendingProviderRetry?: ReturnType<typeof classifyAgentError>;
  private providerRetryInProgress = false;
  private providerTransientRetryAttempt = 0;
  private providerRateLimitRetryAttempt = 0;
  private provider: RuntimeProviderConfig;
  private thinkingLevel: SubagentThinkingLevel;
  private fallbackIndex = 0;
  private readonly attemptedModels = new Set<string>();
  private readonly modelFailures: NonNullable<SubagentRunResult["modelFailures"]> = [];
  private readonly retryState: SubagentProviderRetryState = {
    claim: (error, phase) => this.claimProviderRetry(error, phase),
  };
  private readonly runAbortController = new AbortController();

  constructor(opts: SubagentRunOptions) {
    this.opts = opts;
    this.provider = opts.provider;
    this.thinkingLevel = opts.thinkingLevel;
    this.attemptedModels.add(`${opts.provider.id}/${opts.provider.modelId}`);
    const binding = this.modelBinding();
    this.agent = new Agent({
      streamFn: binding.streamFn,
      getApiKey: binding.getApiKey,
      convertToLlm: (messages) =>
        convertToLlm(this.dedupeToolCalls(messages)),
      // The same turn-boundary context protection the session has (ADR 0299):
      // re-estimate at each boundary, compact before the next request, degrade
      // before failing. The budget derives from this run's resolved model.
      prepareNextTurnWithContext: (context, signal) =>
        this.prepareNextTurn(context, signal),
      afterToolCall: async (context) => this.afterToolCall(context),
      initialState: {
        systemPrompt: opts.systemPrompt,
        model: binding.model,
        tools: opts.tools,
        thinkingLevel: binding.agentThinkingLevel,
        messages: opts.initialMessages ? [...opts.initialMessages] : [],
      },
      toolExecution: "sequential",
    });
    this.agent.subscribe((event) => this.handleEvent(event));
  }

  async run(): Promise<SubagentRunResult> {
    const { signal } = this.opts;
    if (signal?.aborted) {
      return this.result("aborted", "The delegated task was aborted before it started.");
    }
    const onAbort = () => {
      this.runAbortController.abort();
      this.agent.abort();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    let caughtError: ReturnType<typeof classifyAgentError> | undefined;
    try {
      const initialTaskMessage: AgentMessage = {
        role: "user",
        content: this.opts.task,
        timestamp: Date.now(),
      };
      const agentState = this.agent.state;
      const preflightModel = agentState?.model ?? this.modelBinding().model;
      const preflightMessages = (agentState?.messages ?? []).filter(
        (message) => message.role !== "system",
      );
      const preflightSystemPrompt =
        agentState?.systemPrompt ?? this.opts.systemPrompt;
      const preflightTools = agentState?.tools ?? this.opts.tools;
      const initialContext = await prepareDelegateTurnContext({
        messages: preflightMessages,
        additionalMessages: [initialTaskMessage],
        model: preflightModel,
        taskBrief: this.opts.task,
        retentionMode: "active_turn",
        summaryModels: () =>
          delegateSummaryModels(
            this.provider,
            preflightModel,
            this.opts.sessionId,
          ),
        systemPrompt: preflightSystemPrompt,
        tools: preflightTools,
        retainTaskBriefOnDegradation: false,
        thinkingLevel: agentState?.thinkingLevel ?? this.thinkingLevel,
        signal: this.runSignal(),
      });
      if (this.runSignal().aborted) {
        return this.result("aborted", "The delegated task was aborted.");
      }
      if (initialContext.kind === "overflow") {
        return this.result(
          "failed",
          "",
          subagentContextOverflowError(this.provider.modelId),
        );
      }
      if (initialContext.kind !== "unchanged") {
        this.installContextOutcome(initialContext);
      }
      await this.agent.prompt(this.opts.task);
      await this.agent.waitForIdle();
      while (!signal?.aborted) {
        if (this.pendingProviderRetry) {
          await this.retryPendingProviderFailure();
        } else if (this.streamError && this.useNextModel()) {
          await this.agent.continue();
          await this.agent.waitForIdle();
        } else {
          break;
        }
      }
    } catch (error) {
      caughtError = classifyAgentError(error);
    } finally {
      signal?.removeEventListener("abort", onAbort);
      this.finalizeCurrentAssistant();
    }

    if (signal?.aborted) {
      return this.result("aborted", "The delegated task was aborted.");
    }

    // A cancel the settled message itself reported outranks any failure text:
    // pi-ai can wrap an AbortError that fired before the parent signal flipped,
    // and the marker's preserved cause name is the only trace of the Stop. The
    // session runtime reads that same marker as an aborted turn.
    if (this.turnAborted) {
      return this.result("aborted", "The delegated task was aborted.");
    }
    if (caughtError) {
      if (caughtError.code === "TURN_ABORTED") {
        return this.result("aborted", "The delegated task was aborted.");
      }
      return this.result("failed", "", this.terminalError(caughtError));
    }
    if (this.streamError) {
      return this.result("failed", "", this.terminalError(this.streamError));
    }
    if (!this.lastReportText.trim()) {
      return this.result("failed", "", {
        code: "SUBAGENT_NO_REPORT",
        message: "The subagent finished without writing a report.",
      });
    }
    return this.result("completed", this.lastReportText);
  }

  private modelBinding() {
    return this.bindingFor(this.provider, this.thinkingLevel);
  }
  private dedupeToolCalls(messages: AgentMessage[]): AgentMessage[] {
    const drop = dedupeToolCallMessages(messages);
    reportDuplicateToolCallDrop(this.opts.sessionId, drop);
    return drop.messages;
  }

  private bindingFor(
    provider: RuntimeProviderConfig,
    thinkingLevel: SubagentThinkingLevel,
  ) {
    return subagentModelBinding({
      provider,
      thinkingLevel,
      sessionId: this.opts.sessionId,
      maxTokens: this.opts.definition.maxTokens,
    }, this.retryState);
  }

  private installContextOutcome(
    outcome: Extract<DelegateTurnUpdate, { kind: "compacted" | "degraded" }>,
  ): void {
    const systemMessage = this.agent.state.messages.find(
      (message) => message.role === "system",
    );
    this.agent.state.messages = [
      ...(systemMessage ? [systemMessage] : []),
      ...outcome.messages.filter((message) => message.role !== "system"),
    ];
    if (outcome.kind === "compacted") {
      this.contextCompactions += 1;
      const summaryUsage = usageFromPi(outcome.summaryUsage);
      this.usage = addUsage(this.usage, summaryUsage);
    } else {
      this.contextDegraded = true;
    }
  }

  /**
   * Shape the delegate's next in-run turn, mirroring the session's
   * `prepareNextTurn` (ADR 0299, decisions 2-4). A compaction rewrites only
   * this agent's in-memory messages; nothing is persisted anywhere.
   */
  private async prepareNextTurn(
    turn: PrepareNextTurnContext,
    signal?: AbortSignal,
  ): Promise<AgentLoopTurnUpdate | undefined> {
    const outcome = await prepareDelegateTurnContext({
      messages: this.agent.state.messages,
      systemPrompt: this.agent.state.systemPrompt,
      tools: this.agent.state.tools,
      model: this.agent.state.model,
      taskBrief: this.opts.task,
      retentionMode: delegateRetentionMode(turn),
      summaryModels: () =>
        delegateSummaryModels(
          this.provider,
          this.agent.state.model,
          this.opts.sessionId,
        ),
      thinkingLevel: this.agent.state.thinkingLevel,
      signal: signal ?? this.runSignal(),
    });
    if (outcome.kind === "unchanged") return undefined;
    if (outcome.kind === "overflow") {
      // The Agent wrapper converts this throw into the normal error/agent_end
      // sequence; `message_end` picks the pending overflow up so the run
      // surfaces SUBAGENT_CONTEXT_OVERFLOW instead of a classified provider
      // error, and `useNextModel` still gets its fallback pass first.
      this.pendingContextOverflow = subagentContextOverflowError(
        this.provider.modelId,
      );
      throw new Error(this.pendingContextOverflow.message);
    }
    this.installContextOutcome(outcome);
    return {
      context: {
        // The loop owns its context array: pi appends every streamed assistant
        // message and every tool result to the array it was handed, while its
        // own `message_end` listener appends the same message to
        // `state.messages`. Handing over the live array stores each message of
        // the run's later iterations twice, which doubles the estimate at the
        // next boundary and leaves `useNextModel` a trailing assistant row it
        // cannot resume from (D620).
        messages: [...this.agent.state.messages],
        tools: this.agent.state.tools,
      },
    };
  }

  /** Continue the same agent at the failed request; never replay completed tools. */
  private useNextModel(): boolean {
    // An aborted turn never continues, whether the signal flipped yet or the
    // cancel was only visible on the settled message.
    if (this.runSignal().aborted || this.turnAborted || !this.streamError || this.streamError.code === "TURN_ABORTED") return false;
    if (!this.opts.fallbackModels?.length) return false;
    const failed = this.agent.state.messages.at(-1);
    // Only a provider's terminal assistant error permits fallback. Host/tool
    // failures, cancellation, and unexpected internal exceptions do not.
    if (failed?.role !== "assistant" || failed.stopReason !== "error") return false;
    if (readLocalRequestErrorDetails(failed)) return false;
    this.recordModelFailure(`${this.provider.id}/${this.provider.modelId}`, this.streamError);
    // What an alternative would actually carry: the current context minus the
    // failed assistant row (ADR 0299 decision 6 re-evaluates it against each
    // alternative's own window before switching).
    const carried = this.agent.state.messages.slice(0, -1);
    while (this.fallbackIndex < this.opts.fallbackModels.length) {
      const next = this.opts.fallbackModels[this.fallbackIndex++];
      if (!next.provider) {
        this.recordModelFailure(next.key, {
          code: "MODEL_NOT_CONFIGURED",
          message: "The configured fallback model could not be resolved.",
        });
        continue;
      }
      const identity = `${next.provider.id}/${next.provider.modelId}`;
      if (this.attemptedModels.has(identity)) continue;
      this.attemptedModels.add(identity);
      const requested = this.opts.definition.thinkingLevel ?? this.opts.inheritedThinkingLevel ?? this.opts.thinkingLevel;
      const thinking = requested === "omit" ? "omit" : clampThinkingLevel(next.provider, requested);
      const binding = this.bindingFor(next.provider, thinking);
      // An alternative whose window cannot hold the carried context would fail
      // identically to the model it replaces; skip it with the reason recorded
      // instead of burning the slot on the same overflow.
      const budget = contextBudgetFor(binding.model, carried);
      if (budget.tokens >= budget.hardLimit) {
        this.recordModelFailure(identity, {
          code: "SUBAGENT_CONTEXT_OVERFLOW",
          message: `The carried context (~${budget.tokens} tokens) does not fit this model's safe budget (${budget.hardLimit} tokens).`,
        });
        continue;
      }
      this.provider = next.provider;
      this.thinkingLevel = thinking;
      this.agent.state.model = binding.model;
      this.agent.state.thinkingLevel = binding.agentThinkingLevel;
      this.agent.streamFunction = binding.streamFn;
      this.agent.getApiKey = binding.getApiKey;
      this.agent.state.messages = carried;
      this.streamError = undefined;
      this.providerTransientRetryAttempt = 0;
      this.providerRateLimitRetryAttempt = 0;
      this.lastReportText = "";
      this.opts.onModelChange?.(this.provider, this.thinkingLevel);
      return !this.runSignal().aborted;
    }
    return false;
  }

  private recordModelFailure(model: string, error: { code: string; message: string }): void {
    this.modelFailures.push({ model, ...error });
    this.emit({
      type: "message_end",
      message: {
        ...this.newAssistantRow(),
        content: `Model ${model} failed (${error.code}): ${error.message}`,
        status: "error",
        isError: true,
      },
    });
  }

  private claimProviderRetry(
    error: ReturnType<typeof classifyAgentError>,
    phase: "request" | "stream",
  ): number | undefined {
    if (!error.retriable) return undefined;
    const infinite = this.opts.infiniteProviderRetry === true;
    if (error.code === "PROVIDER_RATE_LIMITED") {
      if (!infinite && this.providerRateLimitRetryAttempt >= PROVIDER_RATE_LIMIT_MAX_RETRIES) {
        return undefined;
      }
      return ++this.providerRateLimitRetryAttempt;
    }
    // Setup and stream failures share one bounded budget, exactly as the main
    // session does, so a delegate is not abandoned on a single gateway 502.
    void phase;
    if (!isTransientProviderRetryCode(error.code)) return undefined;
    if (!infinite && this.providerTransientRetryAttempt >= PROVIDER_TRANSIENT_MAX_RETRIES) {
      return undefined;
    }
    return ++this.providerTransientRetryAttempt;
  }

  private async retryPendingProviderFailure(): Promise<void> {
    const retryError = this.pendingProviderRetry;
    if (!retryError) return;
    this.pendingProviderRetry = undefined;
    const messages = [...this.agent.state.messages];
    if (messages.at(-1)?.role !== "assistant") {
      throw new Error("Cannot retry a subagent provider stream without its failed assistant message");
    }
    // A failed provider stream can leave more than one assistant row after a
    // tool round. Remove the entire failed suffix before continuing.
    while (messages.at(-1)?.role === "assistant") messages.pop();
    this.agent.state.messages = messages;
    this.providerRetryInProgress = true;
    try {
      const delayMs =
        retryError.code === "PROVIDER_RATE_LIMITED"
          ? providerRateLimitDelayMs(
              this.providerRateLimitRetryAttempt,
              this.retryState.headers,
            )
          : providerSetupRetryDelayMs(
              this.providerTransientRetryAttempt,
              undefined,
              this.retryState.headers,
            );
      await delayWithAbort(delayMs, this.runSignal());
      if (this.opts.signal?.aborted) return;
      await this.agent.continue();
      await this.agent.waitForIdle();
    } finally {
      this.providerRetryInProgress = false;
    }
  }

  /**
   * The failure the parent receives once no fallback can proceed. A provider
   * overflow is remapped to the actionable delegate code (ADR 0299, decision
   * 5) — but only here, after `useNextModel` had its chance, so a larger
   * fallback window still rescues the run.
   */
  private terminalError(error: { code: string; message: string }): { code: string; message: string } {
    if (error.code === "CONTEXT_TOO_LARGE" || error.code === "SUBAGENT_CONTEXT_OVERFLOW") {
      return subagentContextOverflowError(this.provider.modelId);
    }
    return error;
  }

  private result(
    status: SubagentRunStatus,
    report: string,
    error?: { code: string; message: string },
  ): SubagentRunResult {
    const name = this.opts.definition.name;
    const body = report.trim();
    const text =
      status === "completed"
        ? body
        : status === "aborted"
          ? `The ${name} subagent was aborted after ${this.turns} turn(s).`
          : [
              `The ${name} subagent failed after ${this.turns} turn(s): ${error?.message ?? "unknown error"}.`,
              ...(body ? ["Its last output was:", body] : []),
            ].join("\n\n");
    // A degraded run must say so, or the parent would read a partial answer
    // as a complete one (ADR 0299, decision 4).
    const degradationNote = this.contextDegraded
      ? "Note: this subagent's context exceeded its model's window and older working history was discarded without a summary, so this report may be incomplete."
      : undefined;
    return {
      agentName: name,
      modelId: this.provider.modelId,
      thinkingLevel: this.thinkingLevel,
      status,
      report: boundedReport([
        ...this.modelFailures.map((failure) => `Model ${failure.model} failed (${failure.code}): ${failure.message}`),
        ...(degradationNote ? [degradationNote] : []),
        text,
      ].join("\n\n")),
      turns: this.turns,
      toolCalls: this.toolCalls,
      ...(this.usage ? { usage: this.usage } : {}),
      ...(this.modelFailures.length ? { modelFailures: [...this.modelFailures] } : {}),
      ...(this.contextCompactions > 0 ? { contextCompactions: this.contextCompactions } : {}),
      ...(this.contextDegraded ? { contextDegraded: true } : {}),
      ...(error ? { error } : {}),
    };
  }

  /** Parent bookkeeping: host failures and a mutation-failure terminate. */
  private async afterToolCall(
    context: AfterToolCallContext,
  ): Promise<AfterToolCallResult | undefined> {
    const parent = this.opts.resolveToolOutcome?.(context);
    const terminate = parent?.terminate === true;
    if (!parent?.isError && !terminate) return undefined;
    return {
      ...(parent?.isError ? { isError: true } : {}),
      ...(terminate ? { terminate: true } : {}),
    };
  }

  private emit(event: AgentEventEnvelope["event"]): void {
    this.opts.onEvent({
      sessionId: this.opts.sessionId,
      turnId: this.opts.turnId,
      ts: Date.now(),
      event,
      parentToolCallId: this.opts.parentToolCallId,
      agentName: this.opts.definition.name,
    });
  }

  /**
   * Idle and duration watchdogs are withdrawn (D328). Stopping a delegate is
   * the parent agent's `TaskStop` or the user's Stop, not a timer, so the
   * only abort sources are the parent's signal and this run's own controller.
   */
  private runSignal(): AbortSignal {
    return AbortSignal.any(
      this.opts.signal
        ? [this.opts.signal, this.runAbortController.signal]
        : [this.runAbortController.signal],
    );
  }

  private newAssistantRow(): UiMessage {
    return {
      id: randomUUID(),
      role: "assistant",
      content: "",
      createdAt: nowIso(),
      status: "streaming",
      modelId: this.provider.modelId,
      providerId: this.provider.id,
      parentToolCallId: this.opts.parentToolCallId,
      agentName: this.opts.definition.name,
    };
  }

  /**
   * Translate delegate events into transcript events.
   *
   * Only message and tool events are forwarded. `agent_end`, `turn_end` and
   * error events stay inside: Electron main ends the durable turn on those,
   * and a delegate finishing must never end the parent's turn.
   */
  private handleEvent(event: AgentEvent): void {
    switch (event.type) {
      case "turn_start":
        this.turns += 1;
        break;
      case "message_start": {
        if (event.message.role !== "assistant") break;
        const content = assistantContent((event.message as AssistantMessage).content);
        const retryingAssistant = this.providerRetryInProgress
          ? this.currentAssistant
          : undefined;
        this.currentAssistant = {
          ...(retryingAssistant ?? this.newAssistantRow()),
          content: content.text,
          ...(content.hasThinking && content.thinking
            ? { thinking: content.thinking }
            : {}),
          status: "streaming",
        };
        if (retryingAssistant) {
          this.providerRetryInProgress = false;
          this.emit({ type: "message_update", message: this.currentAssistant });
        } else {
          this.emit({ type: "message_start", message: this.currentAssistant });
        }
        break;
      }
      case "message_update": {
        if (!this.currentAssistant || event.message.role !== "assistant") break;
        const content = assistantContent((event.message as AssistantMessage).content);
        const previousText = this.currentAssistant.content;
        const previousThinking = this.currentAssistant.thinking ?? "";
        const nextText = content.hasText ? content.text : previousText;
        const nextThinking = content.hasThinking
          ? content.thinking
          : previousThinking;
        const textDelta = content.hasText
          ? cumulativeDelta(previousText, content.text)
          : { delta: "", reset: false };
        const thinkingDelta = content.hasThinking
          ? cumulativeDelta(previousThinking, content.thinking)
          : { delta: "", reset: false };
        this.currentAssistant = {
          ...this.currentAssistant,
          content: nextText,
          ...(nextThinking ? { thinking: nextThinking } : {}),
          status: "streaming",
        };
        if (
          textDelta.delta ||
          thinkingDelta.delta ||
          textDelta.reset ||
          thinkingDelta.reset
        ) {
          this.emit({
            type: "message_update",
            message: this.currentAssistant,
            ...(textDelta.delta ? { deltaText: textDelta.delta } : {}),
            ...(thinkingDelta.delta ? { deltaThinking: thinkingDelta.delta } : {}),
            ...(textDelta.reset ? { resetText: true } : {}),
            ...(thinkingDelta.reset ? { resetThinking: true } : {}),
          });
        }
        break;
      }
      case "message_end": {
        if (event.message.role !== "assistant") break;
        const message = event.message as AssistantMessage;
        const content = assistantContent(message.content);
        const stopReason = message.stopReason as string | undefined;
        // Read the cancel off the settled message, the same way the session
        // runtime does: pi-ai wraps an AbortError that fired before the signal
        // flipped in a local marker whose preserved cause name is the only
        // trace of the Stop. An abort is not a failure, so it neither retries
        // nor produces an error row; other local errors stay terminal below.
        const localError = readLocalRequestErrorDetails(message);
        const aborted =
          stopReason === "aborted" || localError?.causeName === "AbortError";
        if (aborted) this.turnAborted = true;
        const failed = !aborted && stopReason === "error";
        let classifiedError: ReturnType<typeof classifyAgentError> | undefined;
        let retryAttempt: number | undefined;
        if (failed) {
          const overflow = this.pendingContextOverflow;
          this.pendingContextOverflow = undefined;
          if (overflow) {
            // The boundary guard threw after degradation still did not fit.
            // The synthetic failure message carries the thrown text; keep the
            // actionable code instead of classifying it as a provider error.
            this.streamError = overflow;
          } else {
            classifiedError = withProviderFetchFailure(
              classifyProviderError(message, this.retryState.status),
              this.retryState.failure,
            );
            retryAttempt = classifiedError.details?.origin === "local"
              ? undefined : this.claimProviderRetry(classifiedError, "stream");
            if (retryAttempt !== undefined) {
              this.pendingProviderRetry = classifiedError;
            } else {
              this.streamError = classifiedError.details?.origin === "local"
                ? classifiedError
                : { code: classifiedError.code, message: classifiedError.message };
            }
          }
        }
        if (!failed && !aborted) {
          this.providerTransientRetryAttempt = 0;
          this.providerRateLimitRetryAttempt = 0;
        }
        const messageUsage = usageFromPi(message.usage);
        this.usage = addUsage(this.usage, messageUsage);
        // The report is the last assistant text; a call-only turn has none and
        // must not clear the text an earlier turn already produced.
        if (content.hasText && content.text.trim() && !failed) {
          this.lastReportText = content.text;
        }
        if (retryAttempt !== undefined) {
          this.currentAssistant = {
            ...(this.currentAssistant ?? this.newAssistantRow()),
            content: content.hasText
              ? content.text
              : (this.currentAssistant?.content ?? ""),
            ...(content.hasThinking && content.thinking
              ? { thinking: content.thinking }
              : {}),
            status: "streaming",
            ...(messageUsage ? { usage: messageUsage } : {}),
          };
          this.emit({ type: "message_update", message: this.currentAssistant });
          break;
        }
        const row: UiMessage = {
          ...(this.currentAssistant ?? this.newAssistantRow()),
          content: content.hasText
            ? content.text
            : (this.currentAssistant?.content ?? ""),
          ...(content.hasThinking && content.thinking
            ? { thinking: content.thinking }
            : {}),
          status: failed ? "error" : aborted ? "aborted" : "complete",
          ...(messageUsage ? { usage: messageUsage } : {}),
          ...(failed ? { isError: true } : {}),
          ...(classifiedError?.details?.origin === "local" ||
              isCertificateVerificationError(classifiedError?.details?.networkCode)
            ? { error: classifiedError } : {}),
        };
        this.currentAssistant = undefined;
        this.emit({ type: "message_end", message: row });
        break;
      }
      case "tool_execution_start":
        this.toolCalls += 1;
        this.emit({
          type: "tool_start",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
        });
        break;
      case "tool_execution_update":
        this.emit({
          type: "tool_update",
          toolCallId: event.toolCallId,
          partialResult: event.partialResult,
        });
        break;
      case "tool_execution_end":
        this.emit({
          type: "tool_end",
          toolCallId: event.toolCallId,
          result: event.result,
          isError: event.isError,
        });
        break;
      default:
        break;
    }
  }

  /** Close a bubble left streaming when the run died without a message_end. */
  private finalizeCurrentAssistant(): void {
    if (!this.currentAssistant) return;
    if (this.currentAssistant.content.trim()) {
      this.lastReportText = this.currentAssistant.content;
    }
    const row: UiMessage = { ...this.currentAssistant, status: "aborted" };
    this.currentAssistant = undefined;
    this.emit({ type: "message_end", message: row });
  }
}
