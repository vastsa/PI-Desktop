import { createServer, type IncomingHttpHeaders } from "node:http";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import type { AgentEventEnvelope } from "@pi-desktop/shared";
import { DesktopAgentRuntime } from "./runtime.js";
import type { RuntimeProviderConfig } from "./provider-binding.js";

describe("custom Completions through a strict HTTP gateway (#2278)", () => {
  it("completes repeated turns while keeping distinct sessions identifiable", async () => {
    const requests: Array<{
      headers: IncomingHttpHeaders;
      body: Record<string, unknown>;
    }> = [];
    const server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      requests.push({ headers: request.headers, body: JSON.parse(body) });
      // Reproduce the external edge's observed rejection before streaming.
      if (request.headers.session_id !== undefined) {
        response.writeHead(400, { "content-type": "text/plain" });
        response.end("Bad Request");
        return;
      }
      const completion = {
        id: "fixture-completion",
        object: "chat.completion.chunk",
        created: 1,
        model: "fixture-model",
        choices: [{
          index: 0,
          delta: { role: "assistant", content: "Reply from strict gateway" },
          finish_reason: "stop",
        }],
      };
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`data: ${JSON.stringify(completion)}\n\ndata: [DONE]\n\n`);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture port");
    const provider: RuntimeProviderConfig = {
      id: "custom-gateway",
      name: "Strict gateway",
      vendorKey: "custom",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      modelId: "fixture-model",
      apiKey: "fixture-only",
      apiStyle: "chat_completions",
      supportsReasoning: false,
      supportedThinkingLevels: ["off"],
    };
    const events: AgentEventEnvelope[] = [];
    const runtimes: DesktopAgentRuntime[] = [];
    const createRuntime = (sessionId: string) => {
      const runtime = new DesktopAgentRuntime({
        sessionId, mode: "agent", provider, thinkingLevel: "off",
        commandShell: {
          id: "bash", label: "Bash", dialect: "posix",
          available: true, isDefault: true,
        },
        host: {
          async call<T>(method: string): Promise<T> {
            if (method === "tools.fileBatchCapabilities") return { version: 1, supported: false } as T;
            if (method === "session.appendMessage") return undefined as T;
            throw new Error(`Unexpected host method: ${method}`);
          },
        },
        onEvent: (event) => events.push(event),
      });
      runtimes.push(runtime);
      return runtime;
    };
    try {
      const first = createRuntime("session-a");
      await first.prompt("hi");
      await first.prompt("hi again");
      await createRuntime("session-b").prompt("hi");

      expect(events.filter(({ event }) => event.type === "error")).toEqual([]);
      const replies = events.flatMap(({ event }) =>
        event.type === "message_end" && event.message.role === "assistant"
          ? [event.message] : []);
      expect(replies).toHaveLength(3);
      expect(replies.every(message =>
        message.status === "complete" && message.content === "Reply from strict gateway")).toBe(true);
      expect(requests).toHaveLength(3);
      expect(requests.map(({ headers }) => headers.session_id)).toEqual([
        undefined, undefined, undefined,
      ]);
      for (const header of ["x-session-affinity", "x-client-request-id"]) {
        expect(requests.map(({ headers }) => headers[header])).toEqual([
          "session-a", "session-a", "session-b",
        ]);
      }
      expect(requests.map(({ body }) => body.prompt_cache_key)).toEqual([
        "session-a", "session-a", "session-b",
      ]);
    } finally {
      try {
        await Promise.all(runtimes.map(runtime => runtime.dispose()));
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      }
    }
  });
});
