import { createServer } from "node:http";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

type CwdProbe = { cwd: string; getCwd: string; exec: string };

/** A trusted extension whose `where` command reports every cwd it can see (#1459). */
async function probeExtensionCwd(options: { projectPath?: string; scratchDir: string; root: string }) {
  const key = `__piCwdProbe_${Math.random().toString(36).slice(2)}`;
  const entry = join(options.root, "cwd-probe.ts");
  writeFileSync(entry, `export default function (pi) {
    pi.registerCommand("where", { handler: async (_args, ctx) => {
      const run = await pi.exec(process.execPath, ["-e", "process.stdout.write(process.cwd())"]);
      globalThis[${JSON.stringify(key)}] = { cwd: ctx.cwd, getCwd: ctx.sessionManager.getCwd(), exec: run.stdout };
    } });
  }`);
  const runtime = new DesktopAgentRuntime({
    host: { call: async () => ({}), onNotification: () => () => {} } as never,
    sessionId: "cwd-probe",
    ...(options.projectPath ? { projectPath: options.projectPath } : {}),
    scratchDir: options.scratchDir,
    mode: "agent",
    thinkingLevel: "off",
    provider: {
      id: "fixture", name: "Fixture", apiKey: "", authKind: "none",
      baseUrl: "http://127.0.0.1:1/v1", modelId: "fixture",
      supportsReasoning: false, supportedThinkingLevels: ["off"],
    },
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    trustedExtensions: [{ id: entry, entry, label: "Cwd probe", root: options.root, source: "plugin" }],
    onEvent: () => {},
  });
  try {
    await runtime.loadTrustedExtensions();
    expect(await runtime.runTrustedExtensionCommand("where", "")).toEqual({ handled: true });
    return (globalThis as Record<string, unknown>)[key] as CwdProbe;
  } finally {
    await runtime.dispose();
    delete (globalThis as Record<string, unknown>)[key];
  }
}

describe("Desktop extension lifecycle", () => {
  it("does not let an expired extension callback overwrite or detach a newer context sample", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-context-owner-"));
    const entry = join(root, "observer.mjs");
    writeFileSync(entry, `export default function (pi) {
      let prior;
      pi.registerCommand("observe", { handler: (_args, ctx) => {
        prior = ctx.ui.setProviderContext; prior({used: 10_000});
      }});
      pi.registerCommand("replace", { handler: (_args, ctx) => {
        ctx.ui.setProviderContext({used: 20_000});
        prior({used: 99_000}); prior(undefined);
      }});
      pi.registerCommand("clear", { handler: (_args, ctx) => ctx.ui.setProviderContext(undefined) });
    }`);
    const seen: unknown[] = [];
    const runtime = new DesktopAgentRuntime({
      host: { call: async (method: string, params: { request?: { kind: string; snapshot?: unknown } }) => {
        if (method === "extensions.ui.request" && params.request?.kind === "contextSnapshot") seen.push(params.request.snapshot);
        return {};
      }, onNotification: () => () => {} } as never,
      sessionId: "context-owner", projectPath: root, mode: "agent", thinkingLevel: "off",
      provider: { id: "fixture", name: "Fixture", apiKey: "", authKind: "none", baseUrl: "http://127.0.0.1:1/v1", modelId: "fixture", supportsReasoning: false, supportedThinkingLevels: ["off"] },
      commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
      trustedExtensions: [{ id: entry, entry, label: "Observer", root, source: "plugin" }], onEvent: () => {},
    });
    try {
      await runtime.loadTrustedExtensions();
      for (const name of ["observe", "replace"]) expect(await runtime.runTrustedExtensionCommand(name, "")).toEqual({ handled: true });
      expect(seen).toMatchObject([{ providerId: "fixture", modelId: "fixture", tokens: 10_000 }, { providerId: "fixture", modelId: "fixture", tokens: 20_000 }]);
      await runtime.runTrustedExtensionCommand("clear", "");
      expect(seen.at(-1)).toBeNull();
    } finally {
      await runtime.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("calibrates only the context budget numerator from provider telemetry while preserving local hardLimit, trailing deltas, rollback, and compaction boundaries", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-context-upstream-budget-"));
    const entry = join(root, "observer.mjs");
    writeFileSync(entry, `export default function (pi) {
      pi.registerCommand("set", { handler: (args, ctx) => {
        const parsed = args.trim() ? JSON.parse(args) : undefined;
        ctx.ui.setProviderContext(parsed);
      }});
      pi.registerCommand("usage", { handler: (_args, ctx) => {
        ctx.ui.notify(JSON.stringify(ctx.getContextUsage()));
      }});
    }`);
    const seen: Array<Record<string, unknown> | null> = [];
    const notices: string[] = [];
    const runtime = new DesktopAgentRuntime({
      host: {
        call: async (method: string, params: { request?: { kind: string; snapshot?: Record<string, unknown> | null; message?: string } }) => {
          if (method === "extensions.ui.request" && params.request?.kind === "contextSnapshot") {
            seen.push(params.request.snapshot ?? null);
          }
          if (method === "extensions.ui.request" && params.request?.kind === "notify" && params.request.message) {
            notices.push(params.request.message);
          }
          return {};
        },
        onNotification: () => () => {},
      } as never,
      sessionId: "context-upstream-budget",
      projectPath: root,
      mode: "agent",
      thinkingLevel: "off",
      provider: {
        id: "gateway",
        name: "Local Gateway",
        apiKey: "local",
        authKind: "none",
        baseUrl: "http://127.0.0.1:1/v1",
        modelId: "gateway/coder-pro",
        supportsReasoning: false,
        supportedThinkingLevels: ["off"],
        modelConfig: {
          source: "generic",
          name: "gateway/coder-pro",
          baseUrl: "http://127.0.0.1:1/v1",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 256_000,
          maxTokens: 32_000,
        },
      },
      commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
      trustedExtensions: [{ id: entry, entry, label: "Observer", root, source: "plugin" }],
      onEvent: () => {},
    });
    try {
      await runtime.loadTrustedExtensions();
      const rt = runtime as any;
      const u1 = { role: "user" as const, content: "hello", timestamp: 1 };
      const a1 = {
        role: "assistant" as const,
        content: [{ type: "text", text: "world" }],
        stopReason: "stop",
        usage: { input: 205_000, output: 5_000, cacheRead: 0, cacheWrite: 0, totalTokens: 210_000 },
        timestamp: 2,
      };
      rt.appendLiveEntry("u1", u1);
      rt.appendLiveEntry("a1", a1);
      rt.setAgentMessages([...rt.agent.state.messages, u1, a1]);
      rt.lastProviderRequest = {
        model: rt.model,
        compaction: rt.activeCompaction,
        lastInputMessage: u1,
        assistantMessage: a1,
        settled: "ok",
      };

      // 1. Aligns numerator to 160,000 while keeping local hardLimit (224,000) separate from upstream size (1,000,000).
      await runtime.runTrustedExtensionCommand("set", JSON.stringify({ used: 160_000, size: 1_000_000 }));
      await runtime.runTrustedExtensionCommand("usage", "");
      const latestSnap = () => seen.at(-1) as Record<string, any> | null;
      expect(latestSnap()).toEqual({
        providerId: "gateway",
        modelId: "gateway/coder-pro",
        tokens: 160_000,
        hardLimit: 224_000,
      });
      expect(JSON.parse(notices.at(-1)!)).toMatchObject({
        tokens: 160_000,
        contextWindow: 224_000,
      });

      // 2. Appending unsent local messages adds trailing delta on top of 160,000 and triggers auto-compaction at 201,600.
      const extra = { role: "user" as const, content: "x".repeat(170_000), timestamp: 3 };
      const withExtraBudget = rt.contextBudget([...rt.liveSessionContext().messages, extra]);
      expect(withExtraBudget.tokens).toBeGreaterThanOrEqual(201_600);
      expect(withExtraBudget.hardLimit).toBe(224_000);
      expect(rt.automaticCompactionNeeded([extra])).toBe(true);

      // 3. Starting a new in-flight request (`{}` before receipt arrives) keeps the settled prefix anchor;
      //    an unsettled mid-stream sample rolls back if that request fails.
      const u2 = { role: "user" as const, content: "follow up ".repeat(400), timestamp: 4 };
      rt.appendLiveEntry("u2", u2);
      rt.setAgentMessages([...rt.agent.state.messages, u2]);
      const settledPlusDelta = rt.contextBudget(rt.agent.state.messages).tokens;
      expect(settledPlusDelta).toBeGreaterThan(160_000);
      const inFlightReq = {
        model: rt.model,
        compaction: rt.activeCompaction,
        lastInputMessage: u2,
      };
      rt.lastProviderRequest = inFlightReq;
      await runtime.runTrustedExtensionCommand("set", "{}");
      expect(Object.keys(latestSnap()!).sort()).toEqual(["hardLimit", "modelId", "providerId", "tokens"]);
      expect(latestSnap()?.tokens).toBe(settledPlusDelta);

      await runtime.runTrustedExtensionCommand("set", JSON.stringify({ used: 195_000, size: 1_000_000 }));
      expect(latestSnap()?.tokens).toBe(195_000);
      rt.retireProviderRequestAnchor(inFlightReq);
      expect(latestSnap()?.tokens).toBe(settledPlusDelta);

      // 3b. A genuine upstream checkpoint drop (24,000) is respected despite an older high assistant.usage (210,000) when local text is small.
      const checkpointedReq = {
        model: rt.model,
        compaction: rt.activeCompaction,
        lastInputMessage: u2,
        settled: "ok" as const,
      };
      rt.lastProviderRequest = checkpointedReq;
      await runtime.runTrustedExtensionCommand("set", JSON.stringify({ used: 24_000, size: 1_000_000 }));
      expect(latestSnap()?.tokens).toBe(24_000);
      expect(latestSnap()?.hardLimit).toBe(224_000);

      // 4. Candidate checkpoint & persisted compaction clear the pre-compaction anchor without polluting post-compaction budget.
      const candidateCheckpoint = {
        id: "cp-1",
        summary: "compact summary",
        firstKeptMessageId: "u2",
        throughMessageId: "u2",
        tokensBefore: settledPlusDelta,
        retainedTail: [],
        createdAt: new Date().toISOString(),
      };
      const postBudget = rt.contextBudget(rt.liveSessionContext(candidateCheckpoint).messages);
      expect(postBudget.tokens).toBeLessThan(20_000);
      expect(postBudget.hardLimit).toBe(224_000);

      // 5. Safety floor prevents a low/zero upstream report from hiding a large uncompacted local transcript.
      const bigUser = { role: "user" as const, content: "y".repeat(820_000), timestamp: 5 };
      rt.appendLiveEntry("big", bigUser);
      rt.setAgentMessages([...rt.agent.state.messages, bigUser]);
      rt.lastProviderRequest = {
        model: rt.model,
        compaction: rt.activeCompaction,
        lastInputMessage: bigUser,
        settled: "ok",
      };
      await runtime.runTrustedExtensionCommand("set", JSON.stringify({ used: 12_000, size: 1_000_000 }));
      expect(rt.contextBudget(rt.liveSessionContext().messages).tokens).toBeGreaterThanOrEqual(195_000);
    } finally {
      await runtime.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("loads trusted extensions once when the first calls race the lazy import", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-hooks-load-race-"));
    const entry = join(root, "extension.ts");
    writeFileSync(entry, `export default function (pi) { pi.registerCommand("hello", { handler: () => {} }); }`);
    let commandPublications = 0;
    const runtime = new DesktopAgentRuntime({
      host: {
        call: async (method: string) => {
          if (method === "extensions.commands.publish") commandPublications += 1;
          return {};
        },
        onNotification: () => () => {},
      } as never,
      sessionId: "hooks-load-race",
      projectPath: root,
      mode: "agent",
      thinkingLevel: "off",
      provider: {
        id: "fixture", name: "Fixture", apiKey: "", authKind: "none",
        baseUrl: "http://127.0.0.1:1/v1", modelId: "fixture",
        supportsReasoning: false, supportedThinkingLevels: ["off"],
      },
      commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
      trustedExtensions: [{ id: entry, entry, label: "Lifecycle", root, source: "plugin" }],
      onEvent: () => {},
    });

    try {
      await Promise.all([runtime.loadTrustedExtensions(), runtime.loadTrustedExtensions()]);
      expect(commandPublications).toBe(1);
      expect(runtime.getTrustedExtensionReports()).toMatchObject([
        { extensionId: entry, state: "loaded", commandNames: ["hello"] },
      ]);
    } finally {
      await runtime.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("gives extensions the session scratch as cwd in a temporary session (#1459)", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-hooks-cwd-scratch-"));
    // Scratch is created lazily (D114): it does not exist before the first use.
    const scratchDir = join(root, "data", "scratch", "cwd-probe");
    try {
      const seen = await probeExtensionCwd({ scratchDir, root });
      expect(existsSync(scratchDir)).toBe(true);
      expect(seen.cwd).toBe(scratchDir);
      expect(seen.getCwd).toBe(scratchDir);
      expect(realpathSync(seen.exec)).toBe(realpathSync(scratchDir));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the project root as extension cwd in a project session", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-hooks-cwd-project-"));
    const scratchDir = join(root, "data", "scratch", "cwd-probe");
    try {
      const seen = await probeExtensionCwd({ projectPath: root, scratchDir, root });
      expect(seen.cwd).toBe(root);
      expect(seen.getCwd).toBe(root);
      expect(realpathSync(seen.exec)).toBe(realpathSync(root));
      expect(existsSync(scratchDir)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

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

it("retains local extension loading but rejects implicit workspace exec for a remote root", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-remote-extension-"));
  const key = `__remoteExtension_${Math.random().toString(36).slice(2)}`;
  const entry = join(root, "extension.ts");
  writeFileSync(entry, `export default function (pi) {
    pi.registerCommand("probe", { handler: async (_args, ctx) => {
      let errorCode;
      try { await pi.exec(process.execPath, ["-e", "process.stdout.write('wrong-machine')"]); }
      catch (error) { errorCode = error.errorCode; }
      const local = await pi.exec(process.execPath, ["-e", "process.stdout.write('local-model-helper')"], { cwd: ${JSON.stringify(root)} });
      globalThis[${JSON.stringify(key)}] = { cwd: ctx.cwd, errorCode, helper: local.stdout };
    } });
  }`);
  const runtime = new DesktopAgentRuntime({
    host: { call: async () => ({}), onNotification: () => () => {} } as never,
    sessionId: "remote-extension", remoteWorkspace: { hostKey: "ssh", path: "/remote/workspace" },
    mode: "agent", thinkingLevel: "off",
    provider: { id: "local-model", name: "Local", apiKey: "", authKind: "none", baseUrl: "http://127.0.0.1:1/v1", modelId: "fixture", supportsReasoning: false, supportedThinkingLevels: ["off"] },
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    trustedExtensions: [{ id: entry, entry, label: "Local model helper", root, source: "plugin" }],
    onEvent: () => {},
  });
  try {
    await runtime.loadTrustedExtensions();
    expect(runtime.getTrustedExtensionReports()).toMatchObject([{ state: "loaded" }]);
    expect(await runtime.runTrustedExtensionCommand("probe", "")).toEqual({ handled: true });
    expect((globalThis as Record<string, unknown>)[key]).toEqual({ cwd: "/remote/workspace", errorCode: "CAPABILITY_UNAVAILABLE", helper: "local-model-helper" });
  } finally {
    await runtime.dispose(); delete (globalThis as Record<string, unknown>)[key]; rmSync(root, { recursive: true, force: true });
  }
});
