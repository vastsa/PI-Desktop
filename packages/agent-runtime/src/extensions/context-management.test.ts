import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { genericModelConfig } from "../model-capabilities.js";
import { DesktopAgentRuntime } from "../runtime.js";
import { clearTrustedExtensionCache } from "./runner.js";

// Issue #2596: a trusted extension that manages the model context itself takes
// over from Desktop's automatic compaction for the session it is loaded in.

type Fixture = {
  root: string;
  server: Server;
  requests: Array<Record<string, unknown>>;
  runtime?: DesktopAgentRuntime;
  events: Array<Record<string, unknown>>;
};

const fixtures: Fixture[] = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.runtime?.dispose();
    fixture.server.closeAllConnections();
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
    rmSync(fixture.root, { recursive: true, force: true });
  }
  clearTrustedExtensionCache();
  delete (globalThis as { __beforeCompactCalls?: number }).__beforeCompactCalls;
});

/** Roughly 24K tokens: above the 16K hard limit of a 32K-window model. */
const HUGE_PROMPT = `Please read this. ${"fixture-text ".repeat(8_000)}`;

async function startFixture(extensionSource: string | undefined): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "pi-context-management-"));
  const requests: Array<Record<string, unknown>> = [];
  // The first request answers with a tool call so the run also builds a
  // follow-up request through `prepareNextTurn`; later requests answer text.
  const replies = [true];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body) as Record<string, unknown>);
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
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  const fixture: Fixture = { root, server, requests, events: [] };
  fixtures.push(fixture);
  const trustedExtensions = [];
  if (extensionSource !== undefined) {
    const entry = join(root, "manager.ts");
    writeFileSync(entry, extensionSource);
    trustedExtensions.push({ id: "manager", entry, label: "Manager", root, source: "plugin" as const });
  }
  fixture.runtime = new DesktopAgentRuntime({
    host: {
      call: async <T>(method: string): Promise<T> => {
        if (method === "tools.fileBatchCapabilities") return { version: 1, supported: false } as T;
        return undefined as T;
      },
      onNotification: () => () => {},
    },
    sessionId: "context-management-fixture",
    projectPath: root,
    mode: "agent",
    thinkingLevel: "off",
    provider: {
      id: "fixture", name: "Fixture", apiKey: "", authKind: "none",
      baseUrl: `http://127.0.0.1:${address.port}/v1`, modelId: "fixture",
      supportsReasoning: false, supportedThinkingLevels: ["off"],
      modelConfig: { ...genericModelConfig("fixture"), contextWindow: 32_000, maxTokens: 4_000 },
    },
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    trustedExtensions,
    onEvent: (envelope) => {
      fixture.events.push((envelope as { event: Record<string, unknown> }).event);
    },
  });
  await fixture.runtime.loadTrustedExtensions();
  return fixture;
}

function toolNames(request: Record<string, unknown>): string[] {
  const tools = (request.tools ?? []) as Array<{ function?: { name?: string } }>;
  return tools.map((tool) => tool.function?.name ?? "");
}

const TRIMMING_MANAGER = `export default function (pi) {
  globalThis.__beforeCompactCalls = 0;
  pi.setContextManagement("external");
  pi.on("session_before_compact", () => {
    globalThis.__beforeCompactCalls += 1;
    return { cancel: true };
  });
  pi.on("context", (event) => ({
    messages: event.messages.map((message) =>
      message.role === "user" && JSON.stringify(message.content).includes("fixture-text")
        ? { ...message, content: "Please read this (trimmed by the manager)." }
        : message),
  }));
}`;

it("keeps native compaction tools when no extension manages the context", async () => {
  const fixture = await startFixture(undefined);
  await fixture.runtime!.prompt("Small turn.");
  expect(fixture.requests.length).toBeGreaterThan(0);
  expect(toolNames(fixture.requests[0]!)).toContain("new_context");
});

it("hands the context to an extension that declares external management", async () => {
  const fixture = await startFixture(TRIMMING_MANAGER);
  await fixture.runtime!.prompt(HUGE_PROMPT);

  // Both the first request and the follow-up after the tool result went out,
  // shaped by the extension; Desktop neither compacted nor failed the turn.
  expect(fixture.requests).toHaveLength(2);
  for (const request of fixture.requests) {
    const body = JSON.stringify(request);
    expect(body).not.toContain("fixture-text");
    expect(body).toContain("trimmed by the manager");
    expect(body).not.toContain("context_budget");
    expect(toolNames(request)).not.toContain("new_context");
  }
  expect((globalThis as { __beforeCompactCalls?: number }).__beforeCompactCalls).toBe(0);
  expect(fixture.events.some((event) => event.type === "error")).toBe(false);
});

it("still refuses a request the extension leaves above the hard limit", async () => {
  const fixture = await startFixture(`export default function (pi) {
    pi.setContextManagement("external");
  }`);
  await fixture.runtime!.prompt(HUGE_PROMPT);

  expect(fixture.requests).toHaveLength(0);
  expect(fixture.events).toContainEqual(expect.objectContaining({
    type: "error",
    error: expect.objectContaining({ code: "CONTEXT_TOO_LARGE" }),
  }));
});

it("ignores a declaration made after the extension loaded", async () => {
  const fixture = await startFixture(`export default function (pi) {
    pi.on("session_start", () => { pi.setContextManagement("external"); });
  }`);
  await fixture.runtime!.prompt("Small turn.");
  expect(toolNames(fixture.requests[0]!)).toContain("new_context");
  const runner = (fixture.runtime as unknown as {
    extensionRunner?: { getDiagnostics(): Array<{ kind: string; member?: string }> };
  }).extensionRunner;
  expect(runner?.getDiagnostics()).toContainEqual(expect.objectContaining({
    kind: "rejected_registration",
    member: "setContextManagement",
  }));
});
