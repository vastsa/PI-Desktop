import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { DesktopAgentRuntime } from "../runtime.js";
import { clearTrustedExtensionCache } from "./runner.js";

const MARKER = "CTX-MARKER";

// Spec 16 §6, issue #1838: `context` fires before every provider request of a
// run, the first one included, and its replacement shapes only that request.
it("emits context before every provider request without persisting the replacement", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-context-event-"));
  const requests: Array<{ messages: unknown[] }> = [];
  // The first request answers with a tool call, so run 1 also has a follow-up
  // request after the tool result; every later request answers with text.
  const replies = [true, false, false];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    const call = replies.shift() ?? false;
    const delta = call
      ? { role: "assistant", tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "missing_tool", arguments: "{}" } }] }
      : { role: "assistant", content: "Ready." };
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end([
      `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta, finish_reason: call ? "tool_calls" : "stop" }] })}`,
      "data: [DONE]",
    ].join("\n\n") + "\n\n");
  });
  const persisted: unknown[] = [];
  let runtime: DesktopAgentRuntime | undefined;
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture address");
    const entry = join(root, "context.ts");
    writeFileSync(entry, `export default function (pi) {
      globalThis.__contextEventCalls = 0;
      pi.on("context", (event) => {
        globalThis.__contextEventCalls += 1;
        return { messages: [...event.messages, { role: "user", content: "${MARKER}", timestamp: 0 }] };
      });
    }`);
    runtime = new DesktopAgentRuntime({
      host: {
        call: async <T>(method: string, params?: unknown): Promise<T> => {
          if (method === "tools.fileBatchCapabilities") return { version: 1, supported: false } as T;
          if (method === "session.appendMessage") {
            persisted.push((params as { message: unknown }).message);
            return undefined as T;
          }
          throw new Error(`Unexpected host call: ${method}`);
        },
        onNotification: () => () => {},
      },
      sessionId: "context-event-fixture",
      projectPath: root,
      mode: "agent",
      thinkingLevel: "off",
      compactionSettings: { enabled: false, reserveTokens: 0, keepRecentTokens: 0 },
      provider: {
        id: "fixture", name: "Fixture", apiKey: "", authKind: "none",
        baseUrl: `http://127.0.0.1:${address.port}/v1`, modelId: "fixture",
        supportsReasoning: false, supportedThinkingLevels: ["off"],
      },
      commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
      trustedExtensions: [{ id: "context", entry, label: "Context", root, source: "plugin" }],
      onEvent: () => {},
    });
    await runtime.loadTrustedExtensions();
    await runtime.prompt("First turn.");
    await runtime.prompt("Second turn.");

    // Run 1: first request (tool call) + follow-up after the tool result. Run 2: first request.
    expect(requests).toHaveLength(3);
    expect((globalThis as { __contextEventCalls?: number }).__contextEventCalls).toBe(3);
    for (const request of requests) {
      expect(JSON.stringify(request.messages).split(MARKER)).toHaveLength(2);
    }
    expect(JSON.stringify(requests[1]?.messages)).toContain('"tool_call_id":"call-1"');
    expect(persisted.length).toBeGreaterThan(0);
    expect(JSON.stringify(persisted)).not.toContain(MARKER);
  } finally {
    await runtime?.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    clearTrustedExtensionCache();
    delete (globalThis as { __contextEventCalls?: number }).__contextEventCalls;
    rmSync(root, { recursive: true, force: true });
  }
});
