/**
 * The opt-in `codemode` tool (ADR codemode-sandbox-boundary): the model writes
 * JavaScript that runs in a QuickJS-WASI worker and calls this session's tools
 * and auxiliary models. Only the script's output reaches the model; nested
 * results stay in the transcript as child rows of the codemode call.
 *
 * The sandbox holds no host function or credential. Every nested tool call is
 * dispatched by {@link NestedToolRunner} through the session's normal tool
 * pipeline, and every model call through the session's own bindings.
 */
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { CodemodeTool } from "@earendil-works/pi-codemode";
import { renderToolSample, toCodemodeIdentifier } from "@earendil-works/pi-codemode/declarations";
import { CodemodeSourceError, parseCodemodeSource } from "@earendil-works/pi-codemode/source";
import { Type } from "typebox";
import { CODEMODE_LIMITS, CODEMODE_TOOL_NAME } from "./limits.js";
import { createModelGlobals, type CodemodeModelHost } from "./model-globals.js";
import { NestedCallRecorder, scriptValueOf, type NestedCallRecord, type NestedToolRunner } from "./nested-calls.js";
import { formatNotStarted, formatScriptResult } from "./output.js";
import { runInSandbox, type CodemodeAssets } from "./sandbox.js";

export { CODEMODE_TOOL_NAME } from "./limits.js";

/** Image generation is reachable as `models.generateImages()` when this tool is callable. */
export const CODEMODE_IMAGE_TOOL_NAME = "GenerateImages";

export type CodemodeDetails = {
  calls: NestedCallRecord[];
  complete: boolean;
  status: "running" | "completed" | "failed";
  errorKind?: string;
  truncated?: boolean;
};

export type CodemodeToolOptions = {
  runner: NestedToolRunner;
  /** Tools a script may call right now: the session's active set minus control tools. */
  callableTools(): readonly AgentTool[];
  models?: CodemodeModelHost;
  /** A nested call asked the turn to stop after this tool (mutation recovery). */
  onTerminate?(callerId: string): void;
  /** Test seam for asset locations. */
  assets?: CodemodeAssets;
};

function description(models: boolean): string {
  return [
    "Run JavaScript in an isolated QuickJS sandbox to batch, chain, or filter tool calls locally, so only the final result enters the conversation. `code` is the body of an async function: top-level `await` and `return` work. There is no Node API, filesystem, network, timer, or module access.",
    "- `await tools.<Name>(args)` runs one of the tools currently available to you through the normal permission and approval flow. It resolves to the tool's text result and rejects with an Error on failure. On-demand tools must be activated with ToolSearch before a script can call them. `ALL_TOOLS` lists callable tools; `await searchTools(query)` finds them and `await describeTool(name)` shows a tool's arguments.",
    "- Read, Glob, and Grep calls may overlap (for example with `Promise.all`); every other tool runs one call at a time.",
    "- `text(value)`, `console.log(...)`, `image(dataUrl)`, and `return value` produce output; `exit()` ends the script early. Calls still running when the script ends are cancelled.",
    ...(models ? ["- `await models.list()`, `await models.complete({ prompt, system?, maxOutputTokens? })`, `await models.classify({ state, questions })` and `await models.generateImages(args)` reach this session's auxiliary models when they are configured."] : []),
    `- Optional first line: \`// @options: {"max_output_tokens": ${CODEMODE_LIMITS.defaultMaxOutputTokens}, "timeout_ms": ${CODEMODE_LIMITS.defaultTimeoutMs}}\` (at most ${CODEMODE_LIMITS.maxOutputTokens} tokens and ${CODEMODE_LIMITS.maxTimeoutMs} ms). A script may start at most ${CODEMODE_LIMITS.maxCalls} nested calls.`,
    "- A failed script reports which nested calls already ran. Their side effects are not undone.",
  ].join("\n");
}

function sample(tool: AgentTool): string {
  return renderToolSample({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameters as Record<string, unknown>,
    outputSchema: (tool.outputSchema as Record<string, unknown> | undefined) ?? { type: "string" },
  });
}

function clamp(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.round(value), max);
}

export function createCodemodeTool(options: CodemodeToolOptions): AgentTool<ReturnType<typeof codemodeSchema>, CodemodeDetails> {
  return {
    name: CODEMODE_TOOL_NAME,
    label: "Codemode",
    description: description(options.models !== undefined),
    parameters: codemodeSchema(),
    executionMode: "sequential",
    execute: async (toolCallId, params, signal, onUpdate) => {
      const startedAt = performance.now();
      const elapsed = () => performance.now() - startedAt;
      const fail = (reason: string): AgentToolResult<CodemodeDetails> => ({
        content: formatNotStarted(reason, elapsed()),
        details: { calls: [], complete: true, status: "failed" },
        isError: true,
      });
      const raw = (params as { code?: unknown }).code;
      if (typeof raw !== "string") return fail("`code` must be a JavaScript string.");
      if (raw.length > CODEMODE_LIMITS.maxCodeChars) {
        return fail(`The script is ${raw.length} characters; the limit is ${CODEMODE_LIMITS.maxCodeChars}.`);
      }
      let parsed: ReturnType<typeof parseCodemodeSource>;
      try {
        parsed = parseCodemodeSource(raw);
      } catch (error) {
        if (error instanceof CodemodeSourceError) return fail(error.message);
        throw error;
      }
      const timeoutMs = clamp(parsed.options.timeoutMs, CODEMODE_LIMITS.defaultTimeoutMs, CODEMODE_LIMITS.maxTimeoutMs);
      const maxOutputTokens = clamp(parsed.options.maxOutputTokens, CODEMODE_LIMITS.defaultMaxOutputTokens, CODEMODE_LIMITS.maxOutputTokens);

      const publish = () => {
        const snapshot = recorder.snapshot();
        onUpdate?.({ content: [], details: { ...snapshot, status: "running" } });
      };
      const recorder = new NestedCallRecorder(publish);
      let terminate = false;
      const callable = options.callableTools().filter((tool) => tool.name !== CODEMODE_TOOL_NAME);
      const byName = new Map(callable.map((tool) => [tool.name, tool]));
      const runNested = async (name: string, args: unknown, callSignal: AbortSignal): Promise<unknown> => {
        const tool = byName.get(name);
        if (terminate) throw new Error("A previous call ended this turn; no further calls run.");
        const outcome = await options.runner.run(toolCallId, name, args, recorder, callSignal);
        if (outcome.terminate) {
          terminate = true;
          options.onTerminate?.(toolCallId);
        }
        return scriptValueOf(tool, outcome);
      };
      const tools: CodemodeTool[] = callable.map((tool) => ({
        name: tool.name,
        description: sample(tool),
        execute: (args, context) => runNested(tool.name, args, context.signal),
      }));
      const describe: CodemodeTool = {
        name: "describeTool",
        description: "Arguments and result type of a callable tool.",
        execute: (name) => {
          if (typeof name !== "string") throw new Error("describeTool() expects a tool name.");
          const tool = callable.find((candidate) => candidate.name === name || toCodemodeIdentifier(candidate.name) === name);
          return tool ? sample(tool) : undefined;
        },
      };
      const search: CodemodeTool = {
        name: "searchTools",
        description: "Callable tools whose name or description contains every query word.",
        execute: (query) => {
          if (typeof query !== "string") throw new Error("searchTools() expects a query string.");
          const words = query.toLowerCase().split(/\s+/).filter(Boolean);
          return callable
            .filter((tool) => {
              const haystack = `${tool.name}\n${tool.description}`.toLowerCase();
              return words.every((word) => haystack.includes(word));
            })
            .slice(0, 24)
            .map((tool) => ({ name: toCodemodeIdentifier(tool.name), description: tool.description.split("\n")[0] }));
        },
      };
      const globals = [
        describe,
        search,
        ...createModelGlobals({
          callerId: toolCallId,
          host: options.models,
          recorder,
          ...(byName.has(CODEMODE_IMAGE_TOOL_NAME)
            ? { generateImages: (args: unknown, callSignal: AbortSignal) => runNested(CODEMODE_IMAGE_TOOL_NAME, args, callSignal) }
            : {}),
        }),
      ];
      publish();
      try {
        let run: Awaited<ReturnType<typeof runInSandbox>>;
        try {
          run = await runInSandbox({
            code: parsed.code,
            tools,
            globals,
            timeoutMs,
            ...(signal ? { signal } : {}),
            ...(options.assets ? { assets: options.assets } : {}),
          });
        } catch (error) {
          // Loading the module, worker or WASM failed: no script code ran.
          return fail(`The codemode sandbox could not start: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (!run.started) {
          return fail(run.reason === "aborted"
            ? "Script aborted before a sandbox worker was free."
            : `No codemode worker became free within ${Math.round(Math.min(timeoutMs, CODEMODE_LIMITS.workerWaitMs) / 1000)} seconds. Retry after other scripts finish.`);
        }
        recorder.cancelRunning();
        const { result } = run;
        const formatted = formatScriptResult(result, recorder.calls, maxOutputTokens, elapsed());
        const snapshot = recorder.snapshot();
        return {
          content: formatted.content,
          details: {
            ...snapshot,
            status: result.ok ? "completed" : "failed",
            ...(result.ok ? {} : { errorKind: result.error.kind }),
            ...(formatted.truncated ? { truncated: true } : {}),
          },
          ...(result.ok ? {} : { isError: true }),
          ...(terminate ? { terminate: true } : {}),
        };
      } finally {
        options.runner.finishScript(toolCallId);
      }
    },
  };
}

export function codemodeSchema() {
  return Type.Object(
    {
      code: Type.String({ description: "Raw JavaScript source: the body of an async function." }),
    },
    { additionalProperties: false },
  );
}
