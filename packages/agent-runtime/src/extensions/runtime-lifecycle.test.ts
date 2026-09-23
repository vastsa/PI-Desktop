import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentEventEnvelope } from "@pi-desktop/shared";
import { DesktopAgentRuntime } from "../runtime.js";
import { clearTrustedExtensionCache } from "./runner.js";

afterEach(() => clearTrustedExtensionCache());

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("Desktop extension lifecycle", () => {
  it("does not apply a session rename locally after its invocation is cancelled", async () => {
    const rename = deferred<Record<string, never>>();
    const runtime = new DesktopAgentRuntime({
      host: {
        call: async (method: string) => method === "session.rename" ? rename.promise : {},
        onNotification: () => () => {},
      } as never,
      sessionId: "hooks-test",
      mode: "agent",
      thinkingLevel: "off",
      provider: {
        id: "fixture", name: "Fixture", apiKey: "", authKind: "none",
        baseUrl: "http://127.0.0.1:1/v1", modelId: "fixture",
        supportsReasoning: false, supportedThinkingLevels: ["off"],
      },
      commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
      onEvent: () => {},
    });
    const bridge = (runtime as unknown as {
      createExtensionBridge(): { setSessionName(name: string, signal?: AbortSignal): Promise<void> };
      extensionSessionName?: string;
    }).createExtensionBridge();
    const operation = new AbortController();
    const pending = bridge.setSessionName("stale", operation.signal);
    operation.abort();
    rename.resolve({});
    await pending;
    expect((runtime as unknown as { extensionSessionName?: string }).extensionSessionName).toBeUndefined();
    await runtime.dispose();
  });

  it.each([
    { action: "abort", event: "before_agent_start" },
    { action: "dispose", event: "before_agent_start" },
    { action: "abort", event: "before_provider_headers" },
    { action: "dispose", event: "before_provider_headers" },
  ] as const)("$action during $event prevents a provider request", async ({ action, event }) => {
    const root = mkdtempSync(join(tmpdir(), "pi-hooks-lifecycle-"));
    const entered = deferred<void>();
    const answer = deferred<{ kind: "confirm"; value: boolean }>();
    let requests = 0;
    let wait = true;
    const server = createServer((_request, response) => {
      requests += 1;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end([
        `data: ${JSON.stringify({ id: "test", choices: [{ index: 0, delta: { role: "assistant", content: "Recovered" }, finish_reason: null }] })}`,
        `data: ${JSON.stringify({ id: "test", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}`,
        "data: [DONE]",
      ].join("\n\n") + "\n\n");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture address");
    const entry = join(root, "extension.ts");
    writeFileSync(entry, `export default function (pi) {
      pi.on("${event}", async (_event, ctx) => {
        await ctx.ui.confirm("Check", "Continue?");
        return { systemPrompt: "Late prompt" };
      });
    }`);
    const events: AgentEventEnvelope[] = [];
    const runtime = new DesktopAgentRuntime({
      host: {
        call: async (method: string) => {
          if (method === "extensions.ui.request") {
            entered.resolve();
            return wait ? answer.promise : { kind: "confirm", value: true };
          }
          return {};
        },
        onNotification: () => () => {},
      } as never,
      sessionId: "hooks-test",
      projectPath: root,
      mode: "agent",
      thinkingLevel: "off",
      provider: {
        id: "fixture", name: "Fixture", apiKey: "", authKind: "none",
        baseUrl: `http://127.0.0.1:${address.port}/v1`, modelId: "fixture",
        supportsReasoning: false, supportedThinkingLevels: ["off"],
      },
      commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
      trustedExtensions: [{ id: entry, entry, label: "Lifecycle", root, source: "plugin" }],
      onEvent: (event) => events.push(event),
    });
    try {
      await runtime.loadTrustedExtensions();
      const prompting = runtime.prompt("First");
      const rejected = expect(prompting).rejects.toMatchObject({ name: "AbortError" });
      await entered.promise;
      await runtime[action]();
      await rejected;
      expect(requests).toBe(0);
      answer.resolve({ kind: "confirm", value: true });
      if (action === "abort") {
        wait = false;
        await runtime.prompt("Try again");
        expect(requests).toBe(1);
        expect(JSON.stringify(events)).toContain("Recovered");
      }
    } finally {
      answer.resolve({ kind: "confirm", value: true });
      await runtime.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  });
});
