/**
 * Tool calls a codemode script makes while it runs. Each one goes through the
 * same pi-agent-core preparation as a model-issued call (`runToolCall`):
 * argument preparation, schema validation, the session's `beforeToolCall`
 * (ToolSearch activation, mode policy, extension hooks, path instructions),
 * execution against the Host (permission, approval, audit), and
 * `afterToolCall`. Nothing here grants a capability the session lacks.
 */
import {
  runToolCall,
  type AgentToolCall,
  type AgentTool,
  type AgentToolResult,
  type ToolCallHooks,
} from "@earendil-works/pi-agent-core";
import type { AssistantMessage, JsonObject } from "@earendil-works/pi-ai";
import type { AgentEvent } from "@pi-desktop/shared";
import { CODEMODE_LIMITS } from "./limits.js";

export type NestedCallStatus = "running" | "ok" | "error" | "cancelled";

/** One row of the call record a codemode result carries in `details.calls`. */
export type NestedCallRecord = {
  id: string;
  name: string;
  kind: "tool" | "model";
  status: NestedCallStatus;
  durationMs?: number;
  /** Retained arguments, or their size when they exceed the record budget. */
  arguments?: unknown;
  argumentsBytes?: number;
  error?: string;
};

const encoder = new TextEncoder();

/**
 * Tools whose nested calls may overlap. They are read-only and still pass Host
 * file admission. Everything else, including Write/Edit even where the Host
 * could batch them, runs one call at a time.
 */
export const CODEMODE_PARALLEL_TOOL_NAMES: ReadonlySet<string> = new Set(["Read", "Glob", "Grep"]);

function textOf(result: AgentToolResult<unknown>): string {
  return (result.content ?? [])
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

/**
 * Bounded record of the calls one script made. The call cap is enforced, not
 * only recorded: a script cannot start more than `maxCalls` nested calls.
 */
export class NestedCallRecorder {
  readonly calls: NestedCallRecord[] = [];
  private argumentBytes = 0;
  private complete = true;
  private startedAt = new Map<NestedCallRecord, number>();

  constructor(private readonly onChange: () => void = () => undefined) {}

  /** Admit and record one call. Throws when the script used up its call budget. */
  start(id: string, name: string, kind: NestedCallRecord["kind"], args: unknown): NestedCallRecord {
    if (this.calls.length >= CODEMODE_LIMITS.maxCalls) {
      throw new Error(`codemode scripts may start at most ${CODEMODE_LIMITS.maxCalls} nested calls.`);
    }
    const record: NestedCallRecord = { id, name, kind, status: "running" };
    let json: string | undefined;
    try {
      json = JSON.stringify(args ?? {});
    } catch {
      json = undefined;
    }
    const bytes = json === undefined ? 0 : encoder.encode(json).length;
    if (json === undefined
      || bytes > CODEMODE_LIMITS.maxArgumentBytesPerCall
      || this.argumentBytes + bytes > CODEMODE_LIMITS.maxArgumentBytesTotal) {
      record.argumentsBytes = bytes;
      this.complete = false;
    } else {
      record.arguments = JSON.parse(json) as unknown;
      this.argumentBytes += bytes;
    }
    this.calls.push(record);
    this.startedAt.set(record, performance.now());
    this.onChange();
    return record;
  }

  finish(record: NestedCallRecord, status: Exclude<NestedCallStatus, "running">, errorText?: string): void {
    record.status = status;
    record.durationMs = Math.round(performance.now() - (this.startedAt.get(record) ?? performance.now()));
    this.startedAt.delete(record);
    if (status !== "ok" && errorText) record.error = errorText.slice(0, CODEMODE_LIMITS.maxErrorChars);
    this.onChange();
  }

  /** Calls the script did not await before it ended were cancelled with it. */
  cancelRunning(): void {
    for (const record of this.calls) {
      if (record.status === "running") this.finish(record, "cancelled");
    }
  }

  snapshot(): { calls: NestedCallRecord[]; complete: boolean } {
    return {
      calls: this.calls.map((call) => ({ ...call })),
      complete: this.complete && this.calls.every((call) => call.status !== "running"),
    };
  }
}

export type NestedToolEvent = Extract<AgentEvent, { type: "tool_start" | "tool_update" | "tool_end" }>;

/** What the session runtime provides to run nested calls. */
export interface NestedToolHost {
  /** Tools a nested call resolves against: the session catalog itself. */
  tools(): readonly AgentTool[];
  /** The session's own hooks, so nested calls pass the same gates. */
  hooks(): ToolCallHooks;
  /** A synthetic one-call assistant message that "issued" this nested call. */
  issuingMessage(toolCall: AgentToolCall): AssistantMessage;
  /**
   * Emit a lifecycle event for the nested call. `nestedParentToolCallId` is
   * the script's call; it never identifies `Task` ownership.
   */
  emit(event: NestedToolEvent, nestedParentToolCallId: string, ts?: number): void;
  /** Track/untrack a running nested call (steering guard, activity). */
  track(toolCallId: string, info: { toolName: string; args: unknown; startedAt: number }): void;
  untrack(toolCallId: string): void;
  /** Release Host batch state that a one-call nested batch may have registered. */
  settleBatch(message: AssistantMessage): void;
}

export type NestedToolOutcome = {
  toolCallId: string;
  result: AgentToolResult<unknown>;
  isError: boolean;
  terminate: boolean;
};

/**
 * Runs nested calls for every script of one session. Tools that are not
 * parallel-safe run one at a time across all scripts, in call order; the
 * read-only file tools may overlap and still pass Host admission.
 */
export class NestedToolRunner {
  private queueTail: Promise<void> = Promise.resolve();
  private nextIds = new Map<string, number>();

  constructor(private readonly host: NestedToolHost) {}

  /** Forget id counters of a finished script. */
  finishScript(callerId: string): void {
    this.nextIds.delete(callerId);
  }

  /** Never rejects for tool failures: those come back as `isError`. */
  async run(
    callerId: string,
    name: string,
    args: unknown,
    recorder: NestedCallRecorder,
    signal: AbortSignal | undefined,
  ): Promise<NestedToolOutcome> {
    const next = (this.nextIds.get(callerId) ?? 0) + 1;
    this.nextIds.set(callerId, next);
    const toolCall: AgentToolCall = {
      type: "toolCall",
      id: `${callerId}/${next}`,
      name,
      // Script arguments arrive after a JSON round trip, so they are JSON values.
      arguments: (args && typeof args === "object" && !Array.isArray(args) ? args : {}) as JsonObject,
    };
    const record = recorder.start(toolCall.id, name, "tool", toolCall.arguments);
    const tools = this.host.tools();
    const tool = tools.find((candidate) => candidate.name === name);
    const exclusive = !CODEMODE_PARALLEL_TOOL_NAMES.has(name) || tool?.executionMode !== "parallel";
    let release: (() => void) | undefined;
    if (exclusive) {
      const previous = this.queueTail;
      this.queueTail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
    }
    const startedAt = Date.now();
    let outcome: NestedToolOutcome;
    try {
      if (signal?.aborted) {
        outcome = {
          toolCallId: toolCall.id,
          result: { content: [{ type: "text", text: "Operation aborted" }], details: {} },
          isError: true,
          terminate: false,
        };
      } else {
        let message: AssistantMessage | undefined;
        let started = false;
        try {
          message = this.host.issuingMessage(toolCall);
          this.host.track(toolCall.id, { toolName: name, args: toolCall.arguments, startedAt });
          this.host.emit({ type: "tool_start", toolCallId: toolCall.id, toolName: name, args: toolCall.arguments }, callerId, startedAt);
          started = true;
          const finalized = await runToolCall(toolCall, {
            ...this.host.hooks(),
            tools,
            assistantMessage: message,
            context: { messages: [], tools: [...tools] },
            ...(signal ? { signal } : {}),
            onUpdate: (partialResult) => {
              this.host.emit({ type: "tool_update", toolCallId: toolCall.id, partialResult }, callerId);
            },
          });
          outcome = {
            toolCallId: toolCall.id,
            result: finalized.result,
            isError: finalized.isError,
            terminate: finalized.result.terminate === true,
          };
        } catch (error) {
          // runToolCall reports tool failures as results; anything thrown here
          // is unexpected. Settle the row instead of leaving it running.
          outcome = {
            toolCallId: toolCall.id,
            result: { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], details: {} },
            isError: true,
            terminate: false,
          };
        } finally {
          this.host.untrack(toolCall.id);
          if (message) this.host.settleBatch(message);
        }
        if (started) {
          this.host.emit({ type: "tool_end", toolCallId: toolCall.id, result: outcome.result, isError: outcome.isError }, callerId);
        }
      }
    } finally {
      release?.();
    }
    recorder.finish(
      record,
      outcome.isError ? (signal?.aborted ? "cancelled" : "error") : "ok",
      outcome.isError ? textOf(outcome.result) : undefined,
    );
    return outcome;
  }
}

/**
 * The value a script receives: `structuredContent` for tools that declare an
 * output schema, else the text content. Every failure rejects with the tool's
 * text, also when it carries structured content.
 */
export function scriptValueOf(tool: AgentTool | undefined, outcome: NestedToolOutcome): unknown {
  if (outcome.isError) {
    throw new Error(textOf(outcome.result) || `Tool "${tool?.name ?? "unknown"}" failed`);
  }
  if (tool?.outputSchema && outcome.result.structuredContent !== undefined) {
    return outcome.result.structuredContent;
  }
  return textOf(outcome.result);
}
