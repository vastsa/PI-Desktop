import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Models,
} from "@earendil-works/pi-ai";
import type { AgentEventEnvelope, SubagentDefinition } from "@pi-desktop/shared";
import { DesktopAgentRuntime, type RuntimeProviderConfig } from "./runtime.js";

// Keep both parent and delegate pi loops real; replace only provider transport.
const transport = vi.hoisted(() => vi.fn<Models["streamSimple"]>());
vi.mock("./provider-binding.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./provider-binding.js")>();
  return {
    ...actual,
    createProviderModels: (...args: Parameters<typeof actual.createProviderModels>) => {
      const models = actual.createProviderModels(...args);
      models.streamSimple = transport;
      return models;
    },
  };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const provider: RuntimeProviderConfig = {
  id: "fixture", name: "Fixture", apiKey: "", authKind: "none",
  baseUrl: "http://127.0.0.1:1/v1", modelId: "fixture", supportsReasoning: false,
  supportedThinkingLevels: ["off"],
};
const definition = (name: string, permission?: SubagentDefinition["permission"]): SubagentDefinition => ({
  name, permission, description: "Focused delegate", tools: ["Read", "Write"],
  prompt: "Perform the task and report.", source: "builtin",
});
function message(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
  return {
    role: "assistant", api: "openai-completions", provider: "fixture", model: "fixture",
    timestamp: Date.now(), stopReason, content,
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}
function response(content: AssistantMessage["content"], stopReason: "stop" | "toolUse" = "stop") {
  const stream = createAssistantMessageEventStream();
  const result = message(content, stopReason);
  queueMicrotask(() => {
    stream.push({ type: "start", partial: result });
    stream.push({ type: "done", reason: stopReason, message: result });
    stream.end(result);
  });
  return stream;
}
const finalResponse = () => response([{ type: "text", text: "Finished the requested work." }]);
const runtimes: DesktopAgentRuntime[] = [];
function fixture(call = vi.fn(async (_method: string, _params?: any): Promise<any> => ({ ok: true, content: {} }))) {
  const events: AgentEventEnvelope[] = [];
  const runtime = new DesktopAgentRuntime({
    host: { call, onNotification: () => () => {} } as never,
    sessionId: "delegate-boundaries", mode: "agent", thinkingLevel: "off", provider,
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    subagents: [definition("inherited")],
    onEvent: (event) => events.push(event),
  });
  runtimes.push(runtime);
  return { runtime, internal: runtime as any };
}
beforeEach(() => { transport.mockReset().mockImplementation(finalResponse); });
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose();
});

// Event-loop deadline, not the resolver's outcome, is the cancellation oracle.
async function promptly<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("operation did not retire before authorization")), 1000);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

describe("Parent Stop waits for every delegate", () => {
  it.each(["waiting-model", "waiting-subagents"] as const)(
    "aborts every child and waits for their retirement while the parent is %s",
    async (phase) => {
      const streams = new Map<string, { signal?: AbortSignal; finish: () => void }>();
      const { runtime, internal } = fixture();
      let parentRequests = 0;
      transport.mockImplementation((_model, context, options) => {
        const isParent = context.messages.some((message) => message.role === "user" && JSON.stringify(message.content).includes("Start both workers."));
        if (isParent) {
          if (++parentRequests === 1) return response(["A", "B"].map((id) => ({
            type: "toolCall" as const, id: `task-${id}`, name: "Task",
            arguments: { agent: "inherited", task: `Worker ${id}` },
          })), "toolUse");
          if (phase === "waiting-subagents") return finalResponse();
        }
        const stream = createAssistantMessageEventStream();
        const key = isParent
          ? "parent" : JSON.stringify(context.messages.at(-1)?.content);
        const finish = () => {
          const aborted = message([], "aborted");
          stream.push({ type: "error", reason: "aborted", error: aborted });
          stream.end(aborted);
        };
        streams.set(key, { signal: options?.signal, finish });
        return stream;
      });
      const running = runtime.prompt("Start both workers.");
      let stopping: Promise<void> | undefined;
      try {
        await vi.waitFor(() => {
          expect(parentRequests).toBe(2);
          expect(streams.size).toBe(phase === "waiting-model" ? 3 : 2);
        });
        let acknowledged = false;
        const cancellation = runtime.abort();
        expect(runtime.abort()).toBe(cancellation);
        stopping = cancellation.then(() => { acknowledged = true; });
        expect([...streams.values()].every((stream) => stream.signal?.aborted)).toBe(true);
        streams.get("parent")?.finish();
        const children = [...streams.entries()].filter(([key]) => key !== "parent").map(([, stream]) => stream);
        children[0].finish();
        await vi.waitFor(() => expect(internal.runningDelegations()).toHaveLength(1));
        expect(runtime.getStatus().isRunning).toBe(true);
        expect(acknowledged).toBe(false);
        await expect(runtime.prompt("Too soon.")).rejects.toMatchObject({ errorCode: "AGENT_BUSY" });
        children[1].finish();
        await promptly(Promise.all([running, stopping]));
        expect(runtime.getStatus().isRunning).toBe(false);
        expect(internal.runningDelegations()).toHaveLength(0);
        expect(parentRequests).toBe(2);
        transport.mockImplementation(finalResponse);
        await promptly(runtime.prompt("Safe follow-up."));
      } finally {
        for (const stream of streams.values()) stream.finish();
        await promptly(Promise.allSettled([running, stopping ?? runtime.abort()]));
      }
    },
  );
});
