import { afterEach, describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import type { AgentEventEnvelope } from "@pi-desktop/shared";
import { DesktopAgentRuntime } from "./runtime.js";
import { SubagentRun } from "./subagent.js";
import type { RuntimeProviderConfig } from "./provider-binding.js";

const provider: RuntimeProviderConfig = {
  id: "fixture",
  name: "Fixture",
  modelId: "fixture-model",
  baseUrl: "http://provider.invalid/v1",
  apiKey: "fixture-only",
  apiStyle: "chat_completions",
  supportsReasoning: false,
  supportedThinkingLevels: ["off"],
};

type Failure = "network" | "rate-limit" | "stream";
type Step = Failure | "tool" | "success" | "stall";

/** Real provider adapter and agent loop; replace only fetch and the host edge. */
function fixture(steps: Step[], retryAfterMs = 1) {
  let requests = 0;
  let reads = 0;
  let abortedRequests = 0;
  const startedAborted: boolean[] = [];
  const events: AgentEventEnvelope[] = [];
  const fetch = vi.fn(async (_input: unknown, init?: RequestInit): Promise<Response> => {
    startedAborted.push(init?.signal?.aborted === true);
    const step = steps[requests++];
    if (!step) throw new Error("Unexpected provider request");
    if (step === "stall") {
      const signal = init?.signal;
      if (!signal) throw new Error("The fixture request needs an abort signal");
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => {
          abortedRequests++;
          reject(new DOMException("Request aborted", "AbortError"));
        };
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      });
    }
    if (step === "network") throw new TypeError("fetch failed");
    if (step === "rate-limit")
      return new Response("Rate limited", {
        status: 429,
        headers: { "retry-after-ms": String(retryAfterMs) },
      });
    const delta =
      step === "tool"
        ? {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: `call_${requests}`,
                type: "function",
                function: { name: "Read", arguments: '{"path":"fixture.txt"}' },
              },
            ],
          }
        : { role: "assistant", content: step === "stream" ? "partial" : "Recovered" };
    const chunk = (value: unknown, finish: string | null) =>
      `data: ${JSON.stringify({ id: "completion", object: "chat.completion.chunk", created: 1, model: "fixture-model", choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`;
    if (step === "stream") {
      let sent = false;
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (!sent) {
              sent = true;
              controller.enqueue(new TextEncoder().encode(chunk(delta, null)));
            } else controller.error(new Error("terminated"));
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    }
    return new Response(
      chunk(delta, null) +
        chunk({}, step === "tool" ? "tool_calls" : "stop") +
        "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  vi.stubGlobal("fetch", fetch);
  const runtime = new DesktopAgentRuntime({
    sessionId: "fixture-session",
    mode: "agent",
    provider,
    thinkingLevel: "off",
    commandShell: {
      id: "bash",
      label: "Bash",
      dialect: "posix",
      available: true,
      isDefault: true,
    },
    host: {
      async call<T>(method: string): Promise<T> {
        if (method === "tools.fileBatchCapabilities") return { version: 1, supported: false } as T;
        if (method === "session.appendMessage") return undefined as T;
        if (method !== "tools.execute")
          throw new Error(`Unexpected host method: ${method}`);
        reads++;
        return { ok: true, content: "fixture contents" } as T;
      },
    },
    onEvent: (event) => events.push(event),
  });
  const subagent = new SubagentRun({
    definition: {
      name: "fixture",
      description: "Read fixture",
      prompt: "Read fixture",
      source: "builtin",
      tools: ["Read"],
    },
    sessionId: "fixture-session",
    parentToolCallId: "task",
    task: "Read fixture",
    provider,
    thinkingLevel: "off",
    systemPrompt: "Read and report",
    tools: [
      {
        name: "Read",
        label: "Read",
        description: "Read fixture",
        parameters: Type.Object({ path: Type.String() }),
        execute: async () => {
          reads++;
          return { content: [{ type: "text", text: "fixture contents" }], details: {} };
        },
      },
    ],
    onEvent: (event) => events.push(event),
  });
  return { runtime, subagent, events, requests: () => requests, reads: () => reads,
    abortedRequests: () => abortedRequests, startedAborted };
}

async function settle<T>(promise: Promise<T>, seconds = 180): Promise<T> {
  let settled = false;
  // Attach handlers before advancing clocks so expected terminal rejections
  // never become unhandled rejections in the test process.
  const observed = promise.then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  void observed.then(() => {
    settled = true;
  });
  for (let tick = 0; tick < seconds && !settled; tick++)
    await vi.advanceTimersByTimeAsync(1000);
  expect(settled, "run settles inside the bounded recovery window").toBe(true);
  const result = await observed;
  if ("error" in result) throw result.error;
  return result.value;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("provider recovery through real agent loops (#699)", () => {
  for (const [idleTimeout, failures] of [[180_000, 10], [30_000, 1]] as const) {
    it(`keeps ${failures} rate-limit waits outside the ${idleTimeout}ms stream idle budget`, async () => {
      vi.useFakeTimers();
      vi.stubEnv("PI_DESKTOP_STREAM_IDLE_TIMEOUT_MS", String(idleTimeout));
      const f = fixture([...Array<Step>(failures).fill("rate-limit"), "success"], 30_000);
      try {
        await settle(f.runtime.prompt("Report after the provider becomes available."), 400);
        expect(f.requests()).toBe(failures + 1);
        expect(f.events.filter((event) => event.event.type === "error")).toHaveLength(0);
        expect(f.events.some(({ event }) => event.type === "message_end" &&
          event.message.content === "Recovered" && event.message.status === "complete")).toBe(true);
        const attempts = f.events.flatMap(({ event }) =>
          event.type === "status" && event.status.activity?.phase === "retrying"
            ? [event.status.activity.attempt] : []);
        expect(attempts).toEqual(Array.from({ length: failures }, (_, index) => index + 1));
      } finally {
        await f.runtime.dispose();
      }
    });
  }

  it("aborts a silent attempt and retries with a fresh request signal", async () => {
    vi.useFakeTimers();
    vi.stubEnv("PI_DESKTOP_STREAM_IDLE_TIMEOUT_MS", "30000");
    const f = fixture(["stall", "success"]);
    try {
      await settle(f.runtime.prompt("Recover from a silent provider."));
      expect(f.requests()).toBe(2);
      expect(f.abortedRequests()).toBe(1);
      expect(f.startedAborted).toEqual([false, false]);
      expect(f.events.filter(({ event }) => event.type === "error")).toHaveLength(0);
      expect(f.events.some(({ event }) => event.type === "message_end" &&
        event.message.content === "Recovered" && event.message.status === "complete")).toBe(true);
    } finally {
      await f.runtime.dispose();
    }
  });

  it("keeps repeated idle timeouts inside the shared retry budget", async () => {
    vi.useFakeTimers();
    vi.stubEnv("PI_DESKTOP_STREAM_IDLE_TIMEOUT_MS", "30000");
    const f = fixture(Array<Step>(11).fill("stall"));
    try {
      await settle(f.runtime.prompt("Report."), 450);
      expect(f.requests()).toBe(11);
      expect(f.abortedRequests()).toBe(11);
      const errors = f.events.filter(({ event }) => event.type === "error");
      expect(errors).toHaveLength(1);
      expect(errors[0]?.event).toMatchObject({
        type: "error", error: { code: "STREAM_FAILED", details: { retryAttempt: 10 } },
      });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(f.requests()).toBe(11);
    } finally {
      await f.runtime.dispose();
    }
  });

  for (const owner of ["session", "subagent"] as const) {
    for (const failure of ["network", "rate-limit", "stream"] as const) {
      it(`${owner} recovers independent ${failure} outages across eleven successful tool rounds`, async () => {
        vi.useFakeTimers();
        const f = fixture([
          ...Array.from({ length: 11 }, (): Step[] => [failure, "tool"]).flat(),
          failure,
          "success",
        ]);
        try {
          if (owner === "session")
            await settle(f.runtime.prompt("Read repeatedly, then report."));
          else expect((await settle(f.subagent.run())).status).toBe("completed");
          expect(f.reads()).toBe(11);
          expect(f.requests()).toBe(24);
          expect(f.events.filter((e) => e.event.type === "error")).toHaveLength(0);
          expect(
            f.events.some(
              (e) =>
                e.event.type === "message_end" &&
                e.event.message.content === "Recovered" &&
                e.event.message.status === "complete",
            ),
          ).toBe(true);
          if (owner === "session") {
            const retryAttempts = f.events.flatMap((e) =>
              e.event.type === "status" && e.event.status.activity?.phase === "retrying"
                ? [e.event.status.activity.attempt]
                : [],
            );
            expect(retryAttempts).toEqual(Array(12).fill(1));
          }
        } finally {
          await f.runtime.dispose();
        }
      });
    }
  }

  it("keeps failures bounded after a recovered tool response and reports the exhausted budget", async () => {
    vi.useFakeTimers();
    const f = fixture(["network", "tool", ...Array<Step>(11).fill("network")]);
    try {
      await settle(f.runtime.prompt("Read, then report."));
      expect(f.reads()).toBe(1);
      expect(f.requests()).toBe(13);
      const errors = f.events.filter((e) => e.event.type === "error");
      expect(errors).toHaveLength(1);
      expect(errors[0]?.event).toMatchObject({
        type: "error",
        error: { code: "NETWORK_ERROR", details: { retryAttempt: 10 } },
      });
      expect(f.events.filter((e) => e.event.type === "agent_end")).toHaveLength(1);
    } finally {
      await f.runtime.dispose();
    }
  });

  for (const owner of ["session", "subagent"] as const) {
    it(`${owner} does not replenish the budget on partial output or a phase change`, async () => {
      vi.useFakeTimers();
      const f = fixture(
        Array.from({ length: 11 }, (_, i): Step => (i % 2 ? "stream" : "network")),
      );
      try {
        if (owner === "session") {
          await settle(f.runtime.prompt("Report."));
          expect(f.events.filter((e) => e.event.type === "error")).toEqual([
            expect.objectContaining({
              event: expect.objectContaining({
                error: expect.objectContaining({
                  details: expect.objectContaining({ retryAttempt: 10 }),
                }),
              }),
            }),
          ]);
        } else expect((await settle(f.subagent.run())).status).toBe("failed");
        expect(f.requests()).toBe(11);
        expect(f.reads()).toBe(0);
      } finally {
        await f.runtime.dispose();
      }
    });
  }

  it.each(["network", "rate-limit"] as const)("cancels a %s retry wait without opening another provider request", async (failure) => {
    vi.useFakeTimers();
    const f = fixture([failure], 30_000);
    try {
      const prompt = f.runtime.prompt("Report.").catch((error) => error);
      await vi.waitFor(() =>
        expect(
          f.events.some(
            (e) =>
              e.event.type === "status" && e.event.status.activity?.phase === "retrying",
          ),
        ).toBe(true),
      );
      await f.runtime.abort();
      await settle(prompt);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(f.requests()).toBe(1);
      expect(f.events.filter((e) => e.event.type === "agent_end")).toHaveLength(1);
      expect(
        f.events.some(
          (e) => e.event.type === "error" && e.event.error.code === "NETWORK_ERROR",
        ),
      ).toBe(false);
    } finally {
      await f.runtime.dispose();
    }
  });
});
