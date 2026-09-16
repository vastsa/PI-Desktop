import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { NativePiSessionService } from "./native-pi-session.js";
import {
  acquireNativePiSessionLease,
  guardNativePiSessionManager,
} from "./native-pi-session-lease.js";

const roots: string[] = [];

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network forbidden in native fixtures"));
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(options: { newline?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "pi-desktop-native-"));
  roots.push(root);
  const agentDir = join(root, "agent");
  const sessionRoot = join(agentDir, "sessions");
  const project = join(root, "project");
  const group = join(sessionRoot, "--project--");
  mkdirSync(group, { recursive: true });
  mkdirSync(project);
  const file = join(group, "fixture.jsonl");
  const entries = [
    { type: "session", version: 3, id: "native-id", timestamp: "2026-09-14T00:00:00.000Z", cwd: project },
    { type: "message", id: "u1", parentId: null, timestamp: "2026-09-14T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 } },
    { type: "model_change", id: "m1", parentId: "u1", timestamp: "2026-09-14T00:00:02.000Z", provider: "test-provider", modelId: "test-model" },
    { type: "thinking_level_change", id: "t1", parentId: "m1", timestamp: "2026-09-14T00:00:03.000Z", thinkingLevel: "high" },
    { type: "custom", id: "c1", parentId: "t1", timestamp: "2026-09-14T00:00:04.000Z", customType: "fixture", data: { preserved: true } },
    { type: "custom_message", id: "cm1", parentId: "c1", timestamp: "2026-09-14T00:00:05.000Z", customType: "fixture", content: "context", display: false },
    { type: "message", id: "a1", parentId: "cm1", timestamp: "2026-09-14T00:00:06.000Z", message: { role: "assistant", content: [{ type: "text", text: "answer" }], provider: "test-provider", model: "test-model", stopReason: "stop", timestamp: 2, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } },
    { type: "compaction", id: "cp1", parentId: "a1", timestamp: "2026-09-14T00:00:07.000Z", summary: "summary", firstKeptEntryId: "a1", tokensBefore: 10, retainedTail: [{ role: "user", content: "preserve unknown fields" }] },
    { type: "message", id: "branch", parentId: "u1", timestamp: "2026-09-14T00:00:08.000Z", message: { role: "assistant", content: [{ type: "text", text: "active branch" }], provider: "test-provider", model: "test-model", stopReason: "stop", timestamp: 3, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } },
    { type: "future_entry", id: "future", parentId: "branch", timestamp: "2026-09-14T00:00:09.000Z", opaque: { untouched: true } },
  ];
  const text = entries.map((entry) => JSON.stringify(entry)).join("\n") + (options.newline === false ? "" : "\n");
  writeFileSync(file, text);
  return { root, agentDir, sessionRoot, project, file, text };
}

describe("NativePiSessionService", () => {
  it("lists and projects a native v3 tree without changing its bytes", async () => {
    const f = fixture();
    const service = new NativePiSessionService({ agentDir: f.agentDir, sessionRoot: f.sessionRoot });
    const before = readFileSync(f.file);
    const sessions = await service.list();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ source: "pi-native", projectPath: f.project, providerId: "test-provider", modelId: "test-model" });
    const detail = service.detail(sessions[0].id);
    expect(detail?.messages.map((message) => message.content)).toEqual(["hello", "active branch"]);
    expect(readFileSync(f.file)).toEqual(before);
  });

  it("searches native metadata and active-branch message text without rewriting JSONL", async () => {
    const f = fixture();
    const service = new NativePiSessionService({ agentDir: f.agentDir, sessionRoot: f.sessionRoot });
    const [summary] = await service.list();
    const before = readFileSync(f.file);

    const titlePage = await service.search("hello");
    expect(titlePage.nextOffset).toBeNull();
    expect(titlePage.hits).toHaveLength(1);
    expect(titlePage.hits[0]).toMatchObject({
      session: { id: summary.id },
      metadataMatch: true,
    });

    const messagePage = await service.search("active branch");
    expect(messagePage.hits[0]).toMatchObject({
      metadataMatch: false,
      messageCount: 1,
      matches: [{ messageId: "branch", role: "assistant" }],
    });
    expect(await service.search("not present")).toEqual({ hits: [], nextOffset: null });
    expect(readFileSync(f.file)).toEqual(before);
  });

  it("centers native detail reads on a requested search message", async () => {
    const f = fixture();
    const service = new NativePiSessionService({ agentDir: f.agentDir, sessionRoot: f.sessionRoot });
    const [summary] = await service.list();
    const detail = service.detail(summary.id, {
      messageAround: "branch",
      messageLimit: 1,
      contentLimit: 1,
    });
    expect(detail).toMatchObject({
      messages: [{ id: "branch", content: "active branch" }],
      messageStart: 1,
      messageEnd: 2,
      hasMoreBefore: true,
    });
  });

  it("keeps a newline-less session browseable but read-only and byte-pure", async () => {
    const f = fixture({ newline: false });
    const service = new NativePiSessionService({ agentDir: f.agentDir, sessionRoot: f.sessionRoot });
    const sessions = await service.list();
    expect(sessions[0].readOnlyReason).toBe("missing-trailing-newline");
    expect(sessions[0].capabilities?.canPrompt).toBe(false);
    expect(readFileSync(f.file, "utf8")).toBe(f.text);
  });

  it("appends through SessionManager and refuses a stale concurrent writer", () => {
    const f = fixture();
    const lease = acquireNativePiSessionLease(f.file);
    const manager = SessionManager.open(f.file);
    guardNativePiSessionManager(manager, lease);
    manager.appendMessage({ role: "user", content: [{ type: "text", text: "desktop turn" }], timestamp: Date.now() });
    const afterOwnAppend = readFileSync(f.file, "utf8");
    expect(afterOwnAppend).toContain("desktop turn");
    writeFileSync(f.file, `${afterOwnAppend}${JSON.stringify({ type: "custom", id: "foreign", parentId: manager.getLeafId(), timestamp: new Date().toISOString(), customType: "foreign" })}\n`);
    expect(() => manager.appendMessage({ role: "user", content: [{ type: "text", text: "must not write" }], timestamp: Date.now() })).toThrow(/changed/i);
    expect(readFileSync(f.file, "utf8")).not.toContain("must not write");
    lease.release();
  });

  it("continues through AgentSession and appends the faux-model turn to the original file", async () => {
    const f = fixture();
    const model = {
      id: "test-model",
      name: "Test Model",
      api: "openai-completions",
      provider: "test-provider",
      baseUrl: "http://127.0.0.1/unused",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 16_000,
      maxTokens: 1_000,
    };
    const response: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "fixture response" }],
      api: "openai-completions",
      provider: "test-provider",
      model: "test-model",
      stopReason: "stop",
      timestamp: Date.now(),
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    const fauxRuntime = {
      getModel: () => model,
      hasConfiguredAuth: () => true,
      streamSimple: () => {
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => {
          stream.push({ type: "start", partial: response });
          stream.push({ type: "done", reason: "stop", message: response });
          stream.end(response);
        });
        return stream;
      },
    };
    const service = new NativePiSessionService({
      agentDir: f.agentDir,
      sessionRoot: f.sessionRoot,
      modelRuntimeFactory: async () => fauxRuntime as any,
    });
    const [summary] = await service.list();
    const before = readFileSync(f.file, "utf8");
    await service.prompt(summary.id, "desktop prompt", () => undefined);
    await expect.poll(() => readFileSync(f.file, "utf8")).toContain("fixture response");
    const after = readFileSync(f.file, "utf8");
    expect(after.startsWith(before)).toBe(true);
    expect(after.match(/desktop prompt/g)).toHaveLength(1);
    expect(after.match(/fixture response/g)).toHaveLength(1);
    const reopened = SessionManager.open(f.file);
    expect(reopened.getLeafId()).not.toBe("future");
    service.disposeAll();
  });

  it("reclaims a stale dead-owner lease only when the file stayed append-only", () => {
    const f = fixture();
    const first = acquireNativePiSessionLease(f.file);
    const lockPath = `${f.file}.pi-desktop.lock`;
    const record = JSON.parse(readFileSync(lockPath, "utf8"));
    first.release();
    writeFileSync(lockPath, `${JSON.stringify({ ...record, pid: 2_147_483_647 })}\n`);
    const reclaimed = acquireNativePiSessionLease(f.file);
    reclaimed.release();
  });

  it("blocks a second desktop writer and releases ownership", () => {
    const f = fixture();
    const first = acquireNativePiSessionLease(f.file);
    expect(() => acquireNativePiSessionLease(f.file)).toThrow(/already open/i);
    first.release();
    const next = acquireNativePiSessionLease(f.file);
    next.release();
  });
});

function configureModelFiles<T extends ReturnType<typeof fixture>>(f: T) {
  writeFileSync(join(f.agentDir, "models.json"), JSON.stringify({ providers: {
    "test-provider": { baseUrl: "http://127.0.0.1/unused", api: "openai-completions", models: [{
      id: "test-model", name: "Fixture", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 16000, maxTokens: 1000,
    }] },
  } }));
  writeFileSync(join(f.agentDir, "auth.json"), JSON.stringify({ "test-provider": { type: "api_key", key: "synthetic-test-key" } }));
  writeFileSync(join(f.agentDir, "settings.json"), JSON.stringify({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 50 }, compaction: { enabled: false } }));
  return { ...f, modelRuntimeFactory: () => ModelRuntime.create({
    authPath: join(f.agentDir, "auth.json"), modelsPath: join(f.agentDir, "models.json"), allowModelNetwork: false,
  }) };
}

async function configuredFixture() {
  return configureModelFiles(fixture());
}

function response(stopReason: "stop" | "error" = "stop"): AssistantMessage {
  return { role: "assistant", content: [{ type: "text", text: "fixture reply" }], api: "openai-completions",
    provider: "test-provider", model: "test-model", stopReason, timestamp: Date.now(),
    ...(stopReason === "error" ? { errorMessage: "503 overloaded" } : {}),
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}

function fauxStream(message = response()) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    if (message.stopReason === "error") stream.push({ type: "error", reason: "error", error: message });
    else stream.push({ type: "done", reason: "stop", message });
    stream.end(message);
  });
  return stream;
}

describe("native continuation review regressions", () => {
  it("uses the real offline credential/catalog and reports missing exact auth/model", async () => {
    const f = await configuredFixture();
    const service = new NativePiSessionService({ agentDir: f.agentDir, sessionRoot: f.sessionRoot });
    const [summary] = await service.list();
    expect(summary.capabilities?.canPrompt).toBe(true);
    expect(service.detail(summary.id)?.capabilities?.canPrompt).toBe(true);
    writeFileSync(join(f.agentDir, "auth.json"), "{}");
    expect((await service.list())[0].readOnlyReason).toBe("provider-unavailable");
    expect(service.detail(summary.id)?.readOnlyReason).toBe("provider-unavailable");
    await expect(service.prompt(summary.id, "no fallback", () => {})).rejects.toMatchObject({ errorCode: "NATIVE_PI_PROVIDER_UNAVAILABLE" });
  });

  it("settles retries once, rejects overlap without disposal, acknowledges distinct durable users, and keeps own idle lease usable", async () => {
    const f = await configuredFixture();
    const events: import("@pi-desktop/shared").AgentEventEnvelope[] = [];
    let calls = 0;
    const requestTools: unknown[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(ModelRuntime.prototype, "streamSimple").mockImplementation((_model, context) => {
      requestTools.push(context.tools ?? []);
      calls++;
      if (calls === 1) return fauxStream(response("error"));
      const stream = createAssistantMessageEventStream();
      void gate.then(() => { const m = response(); stream.push({ type: "done", reason: "stop", message: m }); stream.end(m); });
      return stream;
    });
    const service = new NativePiSessionService(f);
    try {
      const [summary] = await service.list();
      await service.prompt(summary.id, "same prompt", (e) => events.push(e), "optimistic-1");
      await expect.poll(() => calls).toBe(2);
      expect(events.filter((e) => e.event.type === "agent_end")).toHaveLength(0);
      expect(service.status(summary.id).status.isRunning).toBe(true);
      expect(service.detail(summary.id)?.capabilities).toMatchObject({ canPrompt: false, canStop: true });
      await expect(service.prompt(summary.id, "overlap", () => {})).rejects.toMatchObject({ errorCode: "AGENT_BUSY" });
      expect(service.status(summary.id).status.isRunning).toBe(true);
      release();
      await expect.poll(() => events.filter((e) => e.event.type === "agent_end").length).toBe(1);
      expect((await service.list())[0].capabilities?.canPrompt).toBe(true);
      expect(service.detail(summary.id)?.capabilities?.canPrompt).toBe(true);
      await service.prompt(summary.id, "same prompt", (e) => events.push(e), "optimistic-2");
      await expect.poll(() => events.filter((e) => e.event.type === "agent_end").length).toBe(2);
      const acknowledgements = events.filter((e) => e.event.type === "user_message_persisted").map((e) => e.event);
      expect(acknowledgements).toHaveLength(2);
      expect(acknowledgements).toMatchObject([{ optimisticMessageId: "optimistic-1" }, { optimisticMessageId: "optimistic-2" }]);
      const users = service.detail(summary.id)!.messages.filter((m) => m.content === "same prompt");
      expect(users).toHaveLength(2);
      expect(new Set(users.map((m) => m.id)).size).toBe(2);
      expect(readFileSync(f.file, "utf8")).not.toContain("optimistic-");
      expect(requestTools).toEqual([[], [], []]);
      const foreign = new NativePiSessionService(f);
      expect((await foreign.list())[0].readOnlyReason).toBe("busy");
    } finally { release(); service.disposeAll(); }
    expect(existsSync(`${f.file}.pi-desktop.lock`)).toBe(false);
  });

  it("makes reclaimable dead-owner leases reachable via list/detail without stealing live leases", async () => {
    const f = await configuredFixture();
    const lease = acquireNativePiSessionLease(f.file);
    const record = JSON.parse(readFileSync(`${f.file}.pi-desktop.lock`, "utf8"));
    lease.release();
    writeFileSync(`${f.file}.pi-desktop.lock`, JSON.stringify({ ...record, pid: 2147483647 }));
    const service = new NativePiSessionService(f);
    const [summary] = await service.list();
    expect(summary.capabilities?.canPrompt).toBe(true);
    expect(service.detail(summary.id)?.capabilities?.canPrompt).toBe(true);
    vi.spyOn(ModelRuntime.prototype, "streamSimple").mockImplementation(() => fauxStream());
    await service.prompt(summary.id, "reclaimed", () => {});
    await expect.poll(() => service.status(summary.id).status.isRunning).toBe(false);
    service.disposeAll();
  });

  it("binds native startup/resources once before prompting with guarded original-file appends", async () => {
    const f = await configuredFixture();
    mkdirSync(join(f.agentDir, "extensions"));
    const skill = join(f.root, "fixture-skill.md");
    writeFileSync(skill, "---\nname: fixture-skill\ndescription: Discovered fixture skill\n---\nFixture instructions\n");
    writeFileSync(join(f.agentDir, "extensions", "fixture.js"), `export default function(pi) {
      let restored = false;
      pi.on("session_start", (_event, ctx) => {
        restored = ctx.sessionManager.getEntries().some(e => e.customType === "fixture" && e.data?.preserved);
        pi.appendEntry("startup", { restored, mode: ctx.mode, hasUI: ctx.hasUI });
        pi.setActiveTools(["read", "bash", "write", "edit"]);
      });
      pi.on("resources_discover", () => ({ skillPaths: [${JSON.stringify(skill)}] }));
      pi.on("before_agent_start", (event) => ({ systemPrompt: event.systemPrompt + " RESTORED=" + restored }));
    }`);
    const requests: { systemPrompt?: string; tools: unknown[]; messages: unknown }[] = [];
    vi.spyOn(ModelRuntime.prototype, "streamSimple").mockImplementation((_model, context) => {
      requests.push({ systemPrompt: context.systemPrompt, tools: context.tools ?? [], messages: context.messages });
      return fauxStream();
    });
    const service = new NativePiSessionService(f);
    try {
      const [summary] = await service.list();
      await service.prompt(summary.id, "/skill:fixture-skill test startup", () => {});
      await expect.poll(() => service.status(summary.id).status.isRunning).toBe(false);
      expect(requests).toHaveLength(1);
      expect(requests[0].systemPrompt).toContain("RESTORED=true");
      expect(JSON.stringify(requests[0].messages)).toContain("Fixture instructions");
      expect(requests[0].tools).toEqual([]);
      const text = readFileSync(f.file, "utf8");
      expect(text.startsWith(f.text)).toBe(true);
      expect(text.match(/"customType":"startup"/g)).toHaveLength(1);
      expect(text).toContain('"hasUI":false');
      expect(text).toContain('"restored":true');
    } finally { service.disposeAll(); }
  });

  it("disposes session and releases ownership on bind failure so opening can be retried", async () => {
    const f = await configuredFixture();
    vi.spyOn(ModelRuntime.prototype, "streamSimple").mockImplementation(() => fauxStream());
    const bind = vi.spyOn(AgentSession.prototype, "bindExtensions").mockRejectedValueOnce(new Error("binding failed"));
    const dispose = vi.spyOn(AgentSession.prototype, "dispose");
    const service = new NativePiSessionService(f);
    const [summary] = await service.list();
    await expect(service.prompt(summary.id, "test", () => {})).rejects.toThrow("binding failed");
    expect(bind).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    expect(existsSync(`${f.file}.pi-desktop.lock`)).toBe(false);
    expect(service.status(summary.id).status.isRunning).toBe(false);
  });

  it("aborts after persistence without removing or replacing the native user row", async () => {
    const f = await configuredFixture();
    vi.spyOn(ModelRuntime.prototype, "streamSimple").mockImplementation((_model, _ctx, options) => {
      const stream = createAssistantMessageEventStream();
      options?.signal?.addEventListener("abort", () => {
        const m = { ...response(), stopReason: "aborted" as const, content: [] };
        stream.push({ type: "error", reason: "aborted", error: m }); stream.end(m);
      });
      return stream;
    });
    const service = new NativePiSessionService(f);
    try {
      const [summary] = await service.list();
      await service.prompt(summary.id, "preserve on stop", () => {}, "optimistic-abort");
      await expect.poll(() => service.detail(summary.id)!.messages.filter((m) => m.content === "preserve on stop").length).toBe(1);
      await service.abort(summary.id);
      expect(service.detail(summary.id)!.messages.filter((m) => m.content === "preserve on stop")).toHaveLength(1);
      expect(service.status(summary.id).status.isRunning).toBe(false);
    } finally { service.disposeAll(); }
  });
});


describe("native fork children", () => {
  function forkFixture() {
    const root = mkdtempSync(join(tmpdir(), "pi-desktop-native-fork-"));
    roots.push(root);
    const agentDir = join(root, "agent");
    const sessionRoot = join(agentDir, "sessions");
    const project = join(root, "project");
    const group = join(sessionRoot, "--project--");
    mkdirSync(group, { recursive: true });
    mkdirSync(project);
    const file = join(group, "fork.jsonl");
    const assistant = (id: string, parentId: string, text: string, timestamp: string) => ({
      type: "message", id, parentId, timestamp,
      message: { role: "assistant", content: [{ type: "text", text }], provider: "test-provider", model: "test-model", stopReason: "stop", timestamp: Date.parse(timestamp), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
    });
    const entries = [
      { type: "session", version: 3, id: "native-id", timestamp: "2026-09-14T00:00:00.000Z", cwd: project },
      { type: "message", id: "u1", parentId: null, timestamp: "2026-09-14T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 } },
      assistant("sibling", "u1", "sibling answer", "2026-09-14T00:00:02.000Z"),
      { type: "model_change", id: "m1", parentId: "u1", timestamp: "2026-09-14T00:00:03.000Z", provider: "test-provider", modelId: "test-model" },
      { type: "thinking_level_change", id: "t1", parentId: "m1", timestamp: "2026-09-14T00:00:04.000Z", thinkingLevel: "off" },
      { type: "custom", id: "c1", parentId: "t1", timestamp: "2026-09-14T00:00:05.000Z", customType: "fixture", data: { preserved: true } },
      { type: "custom_message", id: "cm1", parentId: "c1", timestamp: "2026-09-14T00:00:06.000Z", customType: "fixture", content: "context", display: false },
      assistant("a1", "cm1", "first answer", "2026-09-14T00:00:07.000Z"),
      { type: "thinking_level_change", id: "t2", parentId: "a1", timestamp: "2026-09-14T00:00:08.000Z", thinkingLevel: "high" },
      { type: "label", id: "lbl1", parentId: "t2", timestamp: "2026-09-14T00:00:09.000Z", targetId: "a1", label: "bookmark" },
      { type: "compaction", id: "cp1", parentId: "lbl1", timestamp: "2026-09-14T00:00:10.000Z", summary: "compacted", firstKeptEntryId: "a1", tokensBefore: 10, retainedTail: [{ role: "user", content: "keep unknown" }] },
      assistant("a2", "cp1", "second answer", "2026-09-14T00:00:11.000Z"),
      { type: "future_entry", id: "future", parentId: "a2", timestamp: "2026-09-14T00:00:12.000Z", opaque: { untouched: true } },
    ];
    const text = entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
    writeFileSync(file, text);
    return { root, agentDir, sessionRoot, project, file, text, group };
  }

  const groupEntries = (group: string) =>
    readdirSync(group).filter((name) => !name.endsWith(".pi-desktop.lock")).sort();

  const errorCode = (fn: () => unknown) => {
    try { fn(); return undefined; } catch (error) { return (error as { errorCode?: string }).errorCode; }
  };

  const newChildPath = (f: { group: string }, before: string[]) => {
    const after = groupEntries(f.group);
    const created = after.filter((name) => !before.includes(name));
    expect(created.filter((name) => name.includes(".tmp"))).toEqual([]);
    expect(created).toHaveLength(1);
    return join(f.group, created[0]);
  };

  it("forks the current branch into one durable child without touching the parent", async () => {
    const f = await configureModelFiles(forkFixture());
    const service = new NativePiSessionService(f);
    try {
      const [summary] = await service.list();
      const parentBytes = readFileSync(f.file, "utf8");
      const before = groupEntries(f.group);
      const child = service.fork({ id: summary.id, title: "Fork: hello" });

      const childPath = newChildPath(f, before);
      const childEntries = readFileSync(childPath, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
      const header = childEntries[0];
      expect(header).toMatchObject({ type: "session", version: 3, cwd: f.project, parentSession: realpathSync(f.file) });
      expect(header.id).not.toBe("native-id");
      const ids = childEntries.map((entry) => entry.id).filter(Boolean);
      expect(ids).not.toContain("sibling");
      expect(ids).not.toContain("lbl1");
      expect(childEntries.some((entry) => entry.id === "cp1" && entry.retainedTail?.[0]?.content === "keep unknown")).toBe(true);
      expect(childEntries.some((entry) => entry.id === "future" && entry.opaque?.untouched === true)).toBe(true);
      const label = childEntries.find((entry) => entry.type === "label");
      expect(label).toMatchObject({ targetId: "a1", label: "bookmark" });
      // The child continues the parent from the branch endpoint, and the
      // parent is byte-identical after the fork.
      expect(readFileSync(f.file, "utf8")).toBe(parentBytes);
      expect(child.title).toBe("Fork: hello");
      expect(child.messages.map((message) => message.content)).toEqual(["hello", "first answer", "compacted", "second answer"]);
      expect(child).toMatchObject({ source: "pi-native", modelId: "test-model", thinkingLevel: "high" });
      expect(child.capabilities?.canPrompt).toBe(true);
      expect(service.detail(child.id)?.title).toBe("Fork: hello");
    } finally { service.disposeAll(); }
  });

  it("anchored forks keep the branch ancestry and exclude later and sibling entries", async () => {
    const f = await configureModelFiles(forkFixture());
    const service = new NativePiSessionService(f);
    try {
      const [summary] = await service.list();
      const parentBytes = readFileSync(f.file, "utf8");
      const child = service.fork({ id: summary.id, title: "Anchored", throughMessageId: "a1" });
      expect(child.messages.map((message) => message.content)).toEqual(["hello", "first answer"]);
      expect(child.messages.map((message) => message.id)).not.toContain("future");
      expect(child.providerId).toBe("test-provider");
      // The anchored branch saved thinking off explicitly; the parent's later
      // high level is a different branch and must not leak into the child.
      expect(child.thinkingLevel).toBe("off");
      expect(readFileSync(f.file, "utf8")).toBe(parentBytes);
    } finally { service.disposeAll(); }
  });

  it("makes a first-user fork durable immediately with the parent saved model and thinking", async () => {
    const f = await configureModelFiles(forkFixture());
    const service = new NativePiSessionService(f);
    try {
      const [summary] = await service.list();
      const parentBytes = readFileSync(f.file, "utf8");
      const before = groupEntries(f.group);
      const child = service.fork({ id: summary.id, title: "First user", throughMessageId: "u1" });
      expect(child.messages.map((message) => message.content)).toEqual(["hello"]);
      expect(child).toMatchObject({ providerId: "test-provider", modelId: "test-model", thinkingLevel: "high" });
      const childPath = newChildPath(f, before);
      // The saved-session fallback is recorded in the child itself, never in a
      // Desktop provider or in the parent file.
      const opened = SessionManager.open(childPath);
      expect(opened.buildSessionContext().model).toEqual({ provider: "test-provider", modelId: "test-model" });
      expect(opened.buildSessionContext().thinkingLevel).toBe("high");
      expect(readFileSync(f.file, "utf8")).toBe(parentBytes);
    } finally { service.disposeAll(); }
  });

  it("appends a reopened first-user child without rewriting either file", async () => {
    const f = await configureModelFiles(forkFixture());
    vi.spyOn(ModelRuntime.prototype, "streamSimple").mockImplementation(() => fauxStream());
    const service = new NativePiSessionService(f);
    try {
      const [summary] = await service.list();
      const parentBytes = readFileSync(f.file, "utf8");
      const before = groupEntries(f.group);
      const child = service.fork({ id: summary.id, title: "First user", throughMessageId: "u1" });
      const childPath = newChildPath(f, before);
      const childId = JSON.parse(readFileSync(childPath, "utf8").split("\n")[0]).id as string;
      const childBytes = readFileSync(childPath, "utf8");
      await service.prompt(child.id, "follow-up", () => {});
      await expect.poll(() => service.status(child.id).status.isRunning).toBe(false);
      const after = readFileSync(childPath, "utf8");
      expect(after.startsWith(childBytes)).toBe(true);
      expect(after.match(/follow-up/g)).toHaveLength(1);
      expect(after.match(/fixture reply/g)).toHaveLength(1);
      const reopened = SessionManager.open(childPath);
      const branch = reopened.getBranch().filter((entry) => entry.type === "message");
      expect(branch.map((entry) => entry.message.role)).toEqual(["user", "user", "assistant"]);
      expect(new Set(branch.map((entry) => entry.id)).size).toBe(3);
      expect(reopened.getSessionId()).toBe(childId);
      expect(readFileSync(f.file, "utf8")).toBe(parentBytes);
    } finally { service.disposeAll(); }
  });
  it("leaves the catalog unchanged for wrong-branch, read-only and busy forks", async () => {
    const f = await configureModelFiles(forkFixture());
    const service = new NativePiSessionService(f);
    try {
      const [summary] = await service.list();
      const before = groupEntries(f.group);
      expect(errorCode(() => service.fork({ id: summary.id, throughMessageId: "sibling" }))).toBe("INVALID_ARGUMENT");
      expect(errorCode(() => service.fork({ id: summary.id, throughMessageId: "missing" }))).toBe("INVALID_ARGUMENT");
      expect(errorCode(() => service.fork({ id: "native-pi:unknown" }))).toBe("NOT_FOUND");
      expect(groupEntries(f.group)).toEqual(before);

      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      vi.spyOn(ModelRuntime.prototype, "streamSimple").mockImplementation(() => {
        const stream = createAssistantMessageEventStream();
        void gate.then(() => { const message = response(); stream.push({ type: "done", reason: "stop", message }); stream.end(message); });
        return stream;
      });
      await service.prompt(summary.id, "hold the turn", () => {});
      await expect.poll(() => service.status(summary.id).status.isRunning).toBe(true);
      expect(errorCode(() => service.fork({ id: summary.id }))).toBe("AGENT_BUSY");
      expect(groupEntries(f.group)).toEqual(before);
      release();
      await expect.poll(() => service.status(summary.id).status.isRunning).toBe(false);
    } finally { service.disposeAll(); }


    const readOnly = await configureModelFiles(fixture({ newline: false }));
    const readOnlyService = new NativePiSessionService(readOnly);
    try {
      const [summary] = await readOnlyService.list();
      expect(errorCode(() => readOnlyService.fork({ id: summary.id }))).toBe("NATIVE_PI_MISSING_TRAILING_NEWLINE");
      expect(groupEntries(join(readOnly.sessionRoot, "--project--"))).toEqual(["fixture.jsonl"]);
    } finally { readOnlyService.disposeAll(); }
  });

  it("emits a provisional stream row replaced by the durable entry id", async () => {
    const f = await configureModelFiles(forkFixture());
    vi.spyOn(ModelRuntime.prototype, "streamSimple").mockImplementation(() => {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const live = response();
        live.content = [{ type: "text", text: "fixture " }];
        stream.push({ type: "start", partial: live });
        live.content = [{ type: "text", text: "fixture reply" }];
        stream.push({ type: "text_delta", contentIndex: 0, delta: "reply", partial: live });
        stream.push({ type: "done", reason: "stop", message: live });
        stream.end(live);
      });
      return stream;
    });
    const service = new NativePiSessionService(f);
    const events: import("@pi-desktop/shared").AgentEventEnvelope[] = [];
    try {
      const [summary] = await service.list();
      await service.prompt(summary.id, "stream me", (envelope) => events.push(envelope), "optimistic-stream");
      await expect.poll(() => service.status(summary.id).status.isRunning).toBe(false);
      const started = events.find((envelope) => envelope.event.type === "message_start");
      expect(started?.event).toMatchObject({ message: { role: "assistant", status: "streaming" } });
      expect(events.some((envelope) => envelope.event.type === "message_update")).toBe(true);
      const startedId = (started!.event as any).message.id as string;
      const ended = events.find((envelope) => envelope.event.type === "message_end" && (envelope.event as any).message.role === "assistant");
      const durableId = (ended!.event as any).message.id as string;
      expect(durableId).not.toBe(startedId);
      // The terminal event names the exact provisional row it replaces; no
      // renderer-side role/status heuristic is involved.
      expect((ended!.event as any).replacesMessageId).toBe(startedId);
      expect(events.filter((envelope) => envelope.event.type === "message_end" && (envelope.event as any).message.id === durableId)).toHaveLength(1);
    } finally { service.disposeAll(); }
  });

  it("returns the whole child transcript and leaves general detail paging alone", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-desktop-native-longfork-"));
    roots.push(root);
    const agentDir = join(root, "agent");
    const sessionRoot = join(agentDir, "sessions");
    const project = join(root, "project");
    const group = join(sessionRoot, "--project--");
    mkdirSync(group, { recursive: true });
    mkdirSync(project);
    const file = join(group, "long.jsonl");
    const entries: any[] = [
      { type: "session", version: 3, id: "long-parent", timestamp: "2026-09-14T00:00:00.000Z", cwd: project },
      { type: "model_change", id: "m1", parentId: null, provider: "test-provider", modelId: "test-model", timestamp: "2026-09-14T00:00:00.500Z" },
    ];
    let parentId = "m1";
    for (let index = 0; index < 520; index += 1) {
      entries.push({
        type: "message", id: `u${index}`, parentId,
        timestamp: new Date(1_700_000_000_000 + index * 1_000).toISOString(),
        message: { role: "user", content: [{ type: "text", text: `row ${index}` }], timestamp: index },
      });
      parentId = `u${index}`;
    }
    writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    const f = await configureModelFiles({ root, agentDir, sessionRoot, project, file, text: "", group });
    const service = new NativePiSessionService(f);
    try {
      const [summary] = await service.list();
      const child = service.fork({ id: summary.id, title: "Long child" });
      expect(child.messages).toHaveLength(520);
      expect(child.messages[0].content).toBe("row 0");
      expect(child.messages.at(-1)?.content).toBe("row 519");
      expect(child.messageStart).toBe(0);
      expect(child.hasMoreBefore).toBe(false);
      expect(child.messageCount).toBe(520);
      // Ordinary detail paging keeps its bounded newest-page contract.
      const paged = service.detail(child.id);
      expect(paged?.messages).toHaveLength(100);
      expect(paged?.hasMoreBefore).toBe(true);
    } finally { service.disposeAll(); }
  });

  it("normalizes the child cwd from the SDK header instead of the raw parent string", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-desktop-native-cwdfork-"));
    roots.push(root);
    const agentDir = join(root, "agent");
    const sessionRoot = join(agentDir, "sessions");
    const project = join(root, "project");
    const group = join(sessionRoot, "--project--");
    mkdirSync(group, { recursive: true });
    mkdirSync(project);
    const file = join(group, "raw-cwd.jsonl");
    const rawCwd = `${project}//`;
    const entries = [
      { type: "session", version: 3, id: "raw-parent", timestamp: "2026-09-14T00:00:00.000Z", cwd: rawCwd },
      { type: "model_change", id: "m1", parentId: null, provider: "test-provider", modelId: "test-model", timestamp: "2026-09-14T00:00:00.500Z" },
      { type: "message", id: "u1", parentId: "m1", timestamp: "2026-09-14T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 } },
    ];
    writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    const f = await configureModelFiles({ root, agentDir, sessionRoot, project, file, text: "", group });
    const service = new NativePiSessionService(f);
    try {
      const [summary] = await service.list();
      const child = service.fork({ id: summary.id, title: "Normalized cwd" });
      expect(child.projectPath).toBe(project);
      expect(service.detail(child.id)?.id).toBe(child.id);
      const childPath = join(group, groupEntries(group).find((name) => name.endsWith(".jsonl") && name !== "raw-cwd.jsonl")!);  // eslint-disable-line no-restricted-syntax
      const childHeader = JSON.parse(readFileSync(childPath, "utf8").split("\n")[0]);
      expect(childHeader.cwd).toBe(project);
      expect((await service.list()).some((row) => row.id === child.id)).toBe(true);
    } finally { service.disposeAll(); }
  });

  it("refuses a live foreign lease and reclaims only a dead-owner lease", async () => {
    const f = await configureModelFiles(forkFixture());
    const service = new NativePiSessionService(f);
    try {
      const [summary] = await service.list();
      const before = groupEntries(f.group);
      const parentBytes = readFileSync(f.file, "utf8");
      const foreign = acquireNativePiSessionLease(f.file);
      const lockPath = `${f.file}.pi-desktop.lock`;
      const record = JSON.parse(readFileSync(lockPath, "utf8"));
      try {
        expect((await service.list()).find((row) => row.id === summary.id)?.readOnlyReason).toBe("busy");
        expect(errorCode(() => service.fork({ id: summary.id, title: "blocked" }))).toBe("NATIVE_PI_SESSION_BUSY");
        expect(groupEntries(f.group)).toEqual(before);
        expect(readFileSync(f.file, "utf8")).toBe(parentBytes);
      } finally { foreign.release(); }
      writeFileSync(lockPath, `${JSON.stringify({ ...record, pid: 2_147_483_647 })}\n`);
      const child = service.fork({ id: summary.id, title: "reclaimed" });
      expect(child.title).toBe("reclaimed");
      expect(existsSync(lockPath)).toBe(false);
      expect(readFileSync(f.file, "utf8")).toBe(parentBytes);
    } finally { service.disposeAll(); }
  });

  it("refuses a changed owned runtime but still forks a provider-unavailable parent as data", async () => {
    const changed = await configureModelFiles(forkFixture());
    vi.spyOn(ModelRuntime.prototype, "streamSimple").mockImplementation(() => fauxStream());
    const changedService = new NativePiSessionService(changed);
    try {
      const [summary] = await changedService.list();
      await changedService.prompt(summary.id, "open idle runtime", () => {});
      await expect.poll(() => changedService.status(summary.id).status.isRunning).toBe(false);
      const current = readFileSync(changed.file, "utf8");
      writeFileSync(changed.file, `${current}${JSON.stringify({ type: "custom", id: "foreign-append", parentId: "future", timestamp: new Date().toISOString(), customType: "foreign" })}\n`);
      const after = readFileSync(changed.file, "utf8");
      expect(errorCode(() => changedService.fork({ id: summary.id, title: "stale" }))).toBe("NATIVE_PI_SESSION_CHANGED");
      expect(readFileSync(changed.file, "utf8")).toBe(after);
      expect(groupEntries(changed.group)).toEqual(["fork.jsonl"]);
    } finally { changedService.disposeAll(); }

    const noauth = await configureModelFiles(forkFixture());
    rmSync(join(noauth.agentDir, "auth.json"));
    const noauthService = new NativePiSessionService(noauth);
    try {
      const [summary] = await noauthService.list();
      expect(summary.readOnlyReason).toBe("provider-unavailable");
      const parentBytes = readFileSync(noauth.file, "utf8");
      const child = noauthService.fork({ id: summary.id, title: "data only" });
      expect(child.readOnlyReason).toBe("provider-unavailable");
      expect(child.messages.map((message) => message.content)).toEqual(["hello", "first answer", "compacted", "second answer"]);
      expect(readFileSync(noauth.file, "utf8")).toBe(parentBytes);
      await expect(noauthService.prompt(child.id, "needs auth", () => {})).rejects.toMatchObject({ errorCode: "NATIVE_PI_PROVIDER_UNAVAILABLE" });
    } finally { noauthService.disposeAll(); }
  });

  it("never deletes a foreign publication and classifies the failure path-free", async () => {
    const f = await configureModelFiles(forkFixture());
    const parentBytes = readFileSync(f.file, "utf8");
    const before = groupEntries(f.group);
    let foreignPath = "";
    vi.resetModules();
    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();
      return {
        ...actual,
        linkSync: (source: string, target: string) => {
          actual.copyFileSync(source, target, actual.constants.COPYFILE_EXCL);
          foreignPath = target;
          throw Object.assign(new Error("fixture collision"), { code: "EEXIST" });
        },
      };
    });
    try {
      const { NativePiSessionService: MockedService } = await import("./native-pi-session.js");
      const service = new MockedService(f);
      try {
        const [summary] = await service.list();
        let failure: any;
        try { service.fork({ id: summary.id, title: "collision" }); } catch (error) { failure = error; }
        expect(failure?.errorCode).toBe("NATIVE_PI_FORK_IO_ERROR");
        expect(failure?.message).not.toContain(f.group);
        expect(existsSync(foreignPath)).toBe(true);
        expect(readFileSync(foreignPath, "utf8")).toContain("collision");
        expect(groupEntries(f.group).sort()).toEqual(before.concat([foreignPath.split("/").at(-1)!]).sort());
        expect(readFileSync(f.file, "utf8")).toBe(parentBytes);
      } finally { service.disposeAll(); }
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  it("cleans its own partial staging write without leaking the temp file", async () => {
    const f = await configureModelFiles(forkFixture());
    const before = groupEntries(f.group);
    const parentBytes = readFileSync(f.file, "utf8");
    vi.resetModules();
    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();
      const paths = new Map<number, string>();
      return {
        ...actual,
        openSync: (path: any, flags: any, mode: any) => {
          const fd = actual.openSync(path, flags, mode);
          paths.set(fd as number, String(path));
          return fd;
        },
        writeFileSync: (fd: number, data: any, ...rest: any[]) => {
          if (paths.get(fd)?.endsWith(".tmp")) {
            actual.writeFileSync(fd, Buffer.from(data as string).subarray(0, 12));
            throw Object.assign(new Error("fixture ENOSPC"), { code: "ENOSPC" });
          }
          return actual.writeFileSync(fd, data, ...rest);
        },
      };
    });
    try {
      const { NativePiSessionService: MockedService } = await import("./native-pi-session.js");
      const service = new MockedService(f);
      try {
        const [summary] = await service.list();
        let failure: any;
        try { service.fork({ id: summary.id, title: "partial" }); } catch (error) { failure = error; }
        expect(failure?.errorCode).toBe("NATIVE_PI_FORK_IO_ERROR");
        expect(groupEntries(f.group)).toEqual(before);
        expect(readFileSync(f.file, "utf8")).toBe(parentBytes);
      } finally { service.disposeAll(); }
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  it("never deletes a staging file whose bytes were replaced", async () => {
    const f = await configureModelFiles(forkFixture());
    const before = groupEntries(f.group);
    let tempPath = "";
    vi.resetModules();
    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();
      let replaced = false;
      return {
        ...actual,
        openSync: (path: any, flags: any, mode: any) => {
          const fd = actual.openSync(path, flags, mode);
          if (String(path).endsWith(".tmp")) tempPath = String(path);
          return fd;
        },
        fsyncSync: (fd: number) => {
          if (!replaced && tempPath) {
            replaced = true;
            const bytes = actual.readFileSync(tempPath);
            actual.writeFileSync(tempPath, Buffer.alloc(bytes.length, 0x78));
            actual.appendFileSync(f.file, `${JSON.stringify({ type: "custom", id: "drift-2", parentId: "future", timestamp: new Date().toISOString(), customType: "drift" })}\n`);
          }
          return actual.fsyncSync(fd);
        },
      };
    });
    try {
      const { NativePiSessionService: MockedService } = await import("./native-pi-session.js");
      const service = new MockedService(f);
      try {
        const [summary] = await service.list();
        let failure: any;
        try { service.fork({ id: summary.id, title: "replaced" }); } catch (error) { failure = error; }
        expect(failure?.errorCode).toBe("NATIVE_PI_SESSION_CHANGED");
        // The modified staging file is not ours to delete; no child is published.
        expect(tempPath).not.toBe("");
        expect(existsSync(tempPath)).toBe(true);
        expect(readFileSync(tempPath).equals(Buffer.alloc(1, 0x78))).toBe(false);
        expect(groupEntries(f.group).filter((name) => name.endsWith(".jsonl"))).toEqual(before);
      } finally { service.disposeAll(); }
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  it("refuses and preserves an in-place-altered staging payload", async () => {
    // Converts the parent's staging-payload repro into a suite regression: the
    // stage keeps its inode, size, and header id and only its bytes change, so
    // dev/ino/size alone cannot catch it - the content hash must gate
    // publication. A deterministic same-process tamper is not a claim that an
    // uncooperative OS-level writer is impossible; the residual race is the
    // documented snapshot-check limitation.
    const f = await configureModelFiles(forkFixture());
    const parentBytes = readFileSync(f.file, "utf8");
    let childPath = "";
    vi.resetModules();
    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();
      return {
        ...actual,
        linkSync: (source: any, target: any) => {
          const changed = actual.readFileSync(source, "utf8").replace('"hello"', '"mutan"');
          actual.writeFileSync(source, changed);
          childPath = String(target);
          return actual.linkSync(source, target);
        },
      };
    });
    try {
      const { NativePiSessionService: MockedService } = await import("./native-pi-session.js");
      const service = new MockedService(f);
      try {
        const [summary] = await service.list();
        let failure: any;
        try { service.fork({ id: summary.id, title: "tampered" }); } catch (error) { failure = error; }
        expect(failure?.errorCode).toBe("NATIVE_PI_SESSION_CHANGED");
        expect(failure?.message).not.toContain(f.group);
        // Uncertain bytes are preserved under both names, never renamed or deleted.
        expect(existsSync(childPath)).toBe(true);
        expect(readFileSync(childPath, "utf8")).toContain('"mutan"');
        expect(groupEntries(f.group).some((name) => name.endsWith(".tmp"))).toBe(true);
        expect(readFileSync(f.file, "utf8")).toBe(parentBytes);
        await expect(service.list()).resolves.toEqual(expect.any(Array));
      } finally { service.disposeAll(); }
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  it("refuses a replaced staging inode even when the bytes match", async () => {
    const f = await configureModelFiles(forkFixture());
    const parentBytes = readFileSync(f.file, "utf8");
    let childPath = "";
    vi.resetModules();
    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();
      return {
        ...actual,
        linkSync: (source: any, target: any) => {
          // Same bytes, new inode: only the dev/ino comparison can catch this.
          const previous = `${source}.previous`;
          actual.renameSync(source, previous);
          actual.copyFileSync(previous, source);
          actual.unlinkSync(previous);
          childPath = String(target);
          return actual.linkSync(source, target);
        },
      };
    });
    try {
      const { NativePiSessionService: MockedService } = await import("./native-pi-session.js");
      const service = new MockedService(f);
      try {
        const [summary] = await service.list();
        let failure: any;
        try { service.fork({ id: summary.id, title: "replaced" }); } catch (error) { failure = error; }
        expect(failure?.errorCode).toBe("NATIVE_PI_SESSION_CHANGED");
        expect(failure?.message).not.toContain(f.group);
        expect(existsSync(childPath)).toBe(true);
        expect(readFileSync(childPath, "utf8")).toContain('"hello"');
        expect(readFileSync(f.file, "utf8")).toBe(parentBytes);
      } finally { service.disposeAll(); }
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  it("fails closed without publishing when the parent drifts during staging", async () => {
    const f = await configureModelFiles(forkFixture());
    const before = groupEntries(f.group);
    vi.resetModules();
    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();
      let appended = false;
      return {
        ...actual,
        fsyncSync: (fd: number) => {
          if (!appended) {
            appended = true;
            actual.appendFileSync(f.file, `${JSON.stringify({ type: "custom", id: "drift", parentId: "future", timestamp: new Date().toISOString(), customType: "drift" })}\n`);
          }
          return actual.fsyncSync(fd);
        },
      };
    });
    try {
      const { NativePiSessionService: MockedService } = await import("./native-pi-session.js");
      const service = new MockedService(f);
      try {
        const [summary] = await service.list();
        const beforeDrift = readFileSync(f.file, "utf8");
        let failure: any;
        try { service.fork({ id: summary.id, title: "drift" }); } catch (error) { failure = error; }
        expect(failure?.errorCode).toBe("NATIVE_PI_SESSION_CHANGED");
        expect(groupEntries(f.group)).toEqual(before);
        const afterDrift = readFileSync(f.file, "utf8");
        expect(afterDrift.startsWith(beforeDrift)).toBe(true);
        expect(afterDrift).toContain('"drift"');
      } finally { service.disposeAll(); }
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });
});

describe("independent native ownership, identity and tool regressions", () => {
  it("keeps an owned settled lease promptable across refreshes", async () => {
    const f = await configuredFixture();
    vi.spyOn(ModelRuntime.prototype, "streamSimple").mockImplementation(() => fauxStream());
    const service = new NativePiSessionService(f);
    try {
      const [summary] = await service.list();
      await service.prompt(summary.id, "first", () => {});
      await expect.poll(() => service.status(summary.id).status.isRunning).toBe(false);
      expect((await service.list())[0].capabilities?.canPrompt).toBe(true);
      expect(service.detail(summary.id)?.capabilities?.canPrompt).toBe(true);
      await service.prompt(summary.id, "second", () => {});
      await expect.poll(() => service.status(summary.id).status.isRunning).toBe(false);
      expect(service.detail(summary.id)!.messages.filter((m) => m.content === "second")).toHaveLength(1);
    } finally { service.disposeAll(); }
  });

  it("acknowledges persisted native user IDs before terminal completion without storing caller IDs", async () => {
    const f = await configuredFixture();
    vi.spyOn(ModelRuntime.prototype, "streamSimple").mockImplementation(() => fauxStream());
    const service = new NativePiSessionService(f);
    const events: import("@pi-desktop/shared").AgentEventEnvelope[] = [];
    try {
      const [summary] = await service.list();
      for (const optimisticId of ["caller-1", "caller-2"]) {
        await service.prompt(summary.id, "identical", (event) => events.push(event), optimisticId);
        await expect.poll(() => service.status(summary.id).status.isRunning).toBe(false);
      }
      const acks = events.filter((e) => e.event.type === "user_message_persisted");
      expect(acks).toHaveLength(2);
      for (const ack of acks) {
        if (ack.event.type !== "user_message_persisted") throw new Error("wrong event");
        const durableId = ack.event.message.id;
        expect(service.detail(summary.id)!.messages.some((m) => m.id === durableId)).toBe(true);
        expect(events.findIndex((e) => e.turnId === ack.turnId && e.event.type === "agent_end")).toBeGreaterThan(events.indexOf(ack));
      }
      expect(readFileSync(f.file, "utf8")).not.toContain("caller-");
    } finally { service.disposeAll(); }
  });

  it("sends zero native tools to the model", async () => {
    const f = await configuredFixture();
    const requests: unknown[] = [];
    vi.spyOn(ModelRuntime.prototype, "streamSimple").mockImplementation((_model, context) => { requests.push(context.tools ?? []); return fauxStream(); });
    const service = new NativePiSessionService(f);
    try {
      const [summary] = await service.list();
      await service.prompt(summary.id, "no tools", () => {});
      await expect.poll(() => service.status(summary.id).status.isRunning).toBe(false);
      expect(requests).toEqual([[]]);
    } finally { service.disposeAll(); }
  });

  it("cleans up a real failing startup hook and permits a repaired extension to bind", async () => {
    const f = await configuredFixture();
    mkdirSync(join(f.agentDir, "extensions"));
    const extension = join(f.agentDir, "extensions", "bad.js");
    writeFileSync(extension, 'export default function(pi) { pi.on("session_start", () => { throw new Error("fixture startup failure"); }); }');
    const service = new NativePiSessionService(f);
    const [summary] = await service.list();
    await expect(service.prompt(summary.id, "bad startup", () => {})).rejects.toThrow("fixture startup failure");
    expect(existsSync(`${f.file}.pi-desktop.lock`)).toBe(false);
    rmSync(extension);
    vi.spyOn(ModelRuntime.prototype, "streamSimple").mockImplementation(() => fauxStream());
    try {
      await service.prompt(summary.id, "repaired", () => {});
      await expect.poll(() => service.status(summary.id).status.isRunning).toBe(false);
    } finally { service.disposeAll(); }
  });
});


describe("native settlement and reclaim boundaries", () => {
  it("publishes terminal completion only after delayed settled hooks append", async () => {
    const f = await configuredFixture();
    mkdirSync(join(f.agentDir, "extensions"));
    writeFileSync(join(f.agentDir, "extensions", "settled.js"), `export default function(pi) {
      pi.on("agent_settled", async () => {
        await new Promise(resolve => setTimeout(resolve, 30));
        pi.appendEntry("settled-persisted", { done: true });
      });
    }`);
    vi.spyOn(ModelRuntime.prototype, "streamSimple").mockImplementation(() => fauxStream());
    const service = new NativePiSessionService(f);
    const terminalBytes: string[] = [];
    try {
      const [summary] = await service.list();
      await service.prompt(summary.id, "settle fully", (envelope) => {
        if (envelope.event.type === "agent_end") terminalBytes.push(readFileSync(f.file, "utf8"));
      });
      await expect.poll(() => service.status(summary.id).status.isRunning).toBe(false);
      expect(terminalBytes).toHaveLength(1);
      expect(terminalBytes[0]).toContain('"customType":"settled-persisted"');
      expect(service.detail(summary.id)?.capabilities?.canPrompt).toBe(true);
    } finally { service.disposeAll(); }
  });

  it("permits only complete same-file append extensions for dead-local capability recovery", async () => {
    const f = await configuredFixture();
    const lease = acquireNativePiSessionLease(f.file);
    const lockPath = `${f.file}.pi-desktop.lock`;
    const record = JSON.parse(readFileSync(lockPath, "utf8"));
    lease.release();
    const service = new NativePiSessionService(f);
    for (const lock of [record, { ...record, hostname: "remote-fixture", pid: 2147483647 }, { pid: 2147483647 }, "malformed"]) {
      writeFileSync(lockPath, typeof lock === "string" ? lock : JSON.stringify(lock));
      expect((await service.list())[0].readOnlyReason).toBe("busy");
    }
    writeFileSync(lockPath, JSON.stringify({ ...record, pid: 2147483647 }));
    writeFileSync(f.file, f.text + JSON.stringify({ type: "custom", id: "append", parentId: "future", customType: "recovered", timestamp: new Date().toISOString() }) + "\n");
    expect((await service.list())[0].capabilities?.canPrompt).toBe(true);
    expect(JSON.parse(readFileSync(lockPath, "utf8")).pid).toBe(2147483647);
    const reclaimed = acquireNativePiSessionLease(f.file);
    reclaimed.release();
    writeFileSync(lockPath, JSON.stringify({ ...record, pid: 2147483647 }));
    writeFileSync(f.file, f.text.replace('"hello"', '"changed"'));
    expect((await service.list())[0].readOnlyReason).toBe("busy");
  });
});
