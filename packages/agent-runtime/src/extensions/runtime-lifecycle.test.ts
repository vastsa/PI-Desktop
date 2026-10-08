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
