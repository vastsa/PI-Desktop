import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { RacpError } from "@pi-desktop/agent-host";

import { createHostOperations } from "./host-operations.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function fakeHost(calls: Array<{ method: string; params: unknown }>, projectPath: string) {
  const sessions = new Map<string, Record<string, unknown>>([["s1", { id: "s1", title: "One", mode: "agent", permissionMode: "ask", projectPath }]]);
  return {
    async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      calls.push({ method, params });
      switch (method) {
        case "session.list":
          return { sessions: [...sessions.values()] } as T;
        case "session.get":
          return { session: sessions.get(String(params.id)) ?? null } as T;
        case "session.create": {
          const created = { id: "s2", title: params.title ?? "New", mode: params.mode ?? "agent", permissionMode: "ask", projectPath: params.projectPath };
          sessions.set("s2", created);
          return { session: created } as T;
        }
        case "session.configure": {
          const current = sessions.get(String(params.id));
          if (!current) throw Object.assign(new Error("session not found"), { errorCode: "NOT_FOUND" });
          const next = { ...current, ...(params.permissionMode ? { permissionMode: params.permissionMode } : {}), mode: params.mode };
          sessions.set(String(params.id), next);
          return { session: next } as T;
        }
        case "session.rename":
        case "session.delete":
          return { ok: true } as T;
        case "projects.list":
          return { projects: [{ id: 7, path: projectPath, name: "proj" }] } as T;
        case "projects.create":
          return { project: { id: 8, path: params.path, name: "app" } } as T;
        default:
          throw new Error(`unexpected ${method}`);
      }
    },
  };
}

describe("pi-host operations over host-core", () => {
  it("maps sessions, creates under a project id, and refuses configuration while busy", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pi-host-ops-")));
    dirs.push(root);
    const calls: Array<{ method: string; params: unknown }> = [];
    let busy = false;
    const operations = createHostOperations({
      getHost: () => fakeHost(calls, root),
      runtime: { compact: async () => ({ accepted: true }), isBusy: () => busy },
      browseRoot: root,
    });
    const listed = await operations.sessions.list();
    expect(listed[0]).toMatchObject({ id: "s1", workspaceLabel: root.split("/").pop() });
    const created = await operations.sessions.create({ title: "T", projectId: "7", permissionMode: "auto" }, { subject: "d", roles: ["owner"] });
    expect(created.permissionMode).toBe("auto");
    expect(calls.find((call) => call.method === "session.create")?.params).toMatchObject({ projectPath: root });
    await expect(operations.sessions.create({ projectId: "99" }, { subject: "d", roles: ["owner"] })).rejects.toMatchObject({ code: "NOT_FOUND" });
    busy = true;
    await expect(operations.sessions.configure("s1", { mode: "plan" })).rejects.toMatchObject({ code: "CONFLICT" });
    busy = false;
    expect((await operations.sessions.configure("s1", { permissionMode: "accept-edits" })).permissionMode).toBe("accept-edits");
  });

  it("registers only existing directories and browses inside the root only", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pi-host-ops-")));
    dirs.push(root);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(root, "work", "app"), { recursive: true });
    await mkdir(join(root, ".hidden"), { recursive: true });
    const operations = createHostOperations({ getHost: () => fakeHost([], root), runtime: { compact: async () => ({ accepted: true }), isBusy: () => false }, browseRoot: root });
    const registered = await operations.projects.register(join(root, "work", "app"));
    expect(registered).toMatchObject({ id: "8", label: "app" });
    await expect(operations.projects.register(join(root, "missing"))).rejects.toMatchObject({ code: "REMOTE_PATH_NOT_FOUND" });
    await expect(operations.projects.register("relative/path")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    const top = await operations.projects.browse();
    expect(top.entries.map((entry) => entry.name)).toEqual(["work"]);
    expect(top.parent).toBeUndefined();
    const nested = await operations.projects.browse(join(root, "work"));
    expect(nested.entries.map((entry) => entry.name)).toEqual(["app"]);
    expect(nested.parent).toBeDefined();
    await expect(operations.projects.browse("/")).rejects.toMatchObject({ code: "REMOTE_PATH_FORBIDDEN" });
  });

  it("canonicalizes a symlink browse root without allowing symlink escapes", async () => {
    const scratch = await realpath(await mkdtemp(join(tmpdir(), "pi-host-browse-root-")));
    dirs.push(scratch);
    const root = join(scratch, "root");
    const linkedRoot = join(scratch, "linked-root");
    const outside = join(scratch, "outside");
    await mkdir(join(root, "work"), { recursive: true });
    await mkdir(outside);
    await symlink(root, linkedRoot, "dir");
    await symlink(outside, join(root, "escape"), "dir");
    const operations = createHostOperations({
      getHost: () => fakeHost([], root),
      runtime: { compact: async () => ({ accepted: true }), isBusy: () => false },
      browseRoot: linkedRoot,
    });
    const top = await operations.projects.browse();
    expect(top).toEqual({ path: root, entries: [{ name: "work", path: join(root, "work") }] });
    const nested = await operations.projects.browse(top.entries[0]!.path);
    expect(nested).toEqual({ path: join(root, "work"), parent: root, entries: [] });
    expect(await operations.projects.browse(linkedRoot)).toEqual(top);
    await expect(operations.projects.browse(join(linkedRoot, "escape")))
      .rejects.toMatchObject({ code: "REMOTE_PATH_FORBIDDEN" });
    await expect(operations.projects.browse(outside))
      .rejects.toMatchObject({ code: "REMOTE_PATH_FORBIDDEN" });
  });

  it("serves workspace reads against the session root and refuses escapes", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pi-host-ops-")));
    dirs.push(root);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(root, "README.md"), "hello", "utf8");
    const operations = createHostOperations({ getHost: () => fakeHost([], root), runtime: { compact: async () => ({ accepted: true }), isBusy: () => false } });
    expect((await operations.workspace.list("s1", "")).entries.map((entry) => entry.name)).toEqual(["README.md"]);
    expect(await operations.workspace.read("s1", "README.md")).toMatchObject({ kind: "text", content: "hello" });
    await expect(operations.workspace.read("s1", "../../etc/passwd")).rejects.toMatchObject({ code: "REMOTE_PATH_FORBIDDEN" });
    await expect(operations.workspace.read("s1", "nope.txt")).rejects.toMatchObject({ code: "REMOTE_PATH_FORBIDDEN" });
    await expect(operations.workspace.list("s9", "")).rejects.toBeInstanceOf(RacpError);
    const diff = await operations.workspace.diff("s1");
    expect(diff.repo).toBe(false);
  });

  it("publishes only runnable models and the window of the newest request", async () => {
    const models = createHostOperations({
      getHost: () => ({
        async call<T>(method: string): Promise<T> {
          switch (method) {
            case "providers.list":
              return { providers: [
                {
                  id: "p1", name: "DeepSeek", enabled: true, hasSecret: true, authKind: "api_key",
                  contextWindow: 90_800,
                  models: [
                    { id: "deepseek-v4.1-flash", contextWindow: 90_800, thinkingLevels: ["off", "low"], fastModeAllowed: true },
                    { id: "deepseek-v4.1", contextWindow: 0 },
                  ],
                },
                { id: "p2", name: "No key", enabled: true, hasSecret: false, authKind: "api_key", models: [{ id: "hidden" }] },
                { id: "p3", name: "Off", enabled: false, hasSecret: true, authKind: "api_key", models: [{ id: "off-model" }] },
              ] } as T;
            case "providers.listModels":
              return { models: [
                { providerId: "p1", modelId: "deepseek-v4.1", displayName: "DeepSeek V4.1", capabilities: ["tool_call"] },
              ] } as T;
            case "settings.get":
              return { defaultProviderId: "p1", defaultModelId: "deepseek-v4.1-flash" } as T;
            case "session.turnUsage":
              return { usage: {
                inputTokens: 40, outputTokens: 4, cacheReadTokens: 250, cacheWriteTokens: 0,
                reasoningTokens: 2, totalTokens: 294, providerId: "p1", modelId: "deepseek-v4.1-flash",
              } } as T;
            default:
              throw new Error(`unexpected ${method}`);
          }
        },
      }),
      runtime: { compact: async () => ({ accepted: true }), isBusy: () => false },
    });

    const catalog = await models.models!.list();
    expect(catalog).toMatchObject({ defaultProviderId: "p1", defaultModelId: "deepseek-v4.1-flash" });
    expect(catalog.models.map((row) => `${row.providerId}:${row.modelId}`)).toEqual([
      "p1:deepseek-v4.1-flash", "p1:deepseek-v4.1",
    ]);
    // The alias/display name and catalog capability enrich the selected model;
    // the provider-level window fills a binding that omits one.
    expect(catalog.models[1]).toMatchObject({ displayName: "DeepSeek V4.1", contextWindow: 90_800, capabilities: ["tool_call"] });
    expect(catalog.models[0]).toMatchObject({ displayName: "deepseek-v4.1-flash", contextWindow: 90_800, fastMode: true });

    const usage = await models.usage!.read("s1");
    expect(usage.contextWindow).toBe(90_800);
    expect(usage.usage).toEqual({
      inputTokens: 40, outputTokens: 4, cacheReadTokens: 250, reasoningTokens: 2, totalTokens: 294,
    });
  });

  it("reports no usage for a session without a completed model request", async () => {
    const models = createHostOperations({
      getHost: () => ({
        async call<T>(method: string): Promise<T> {
          if (method === "session.turnUsage") return { usage: null } as T;
          throw new Error(`unexpected ${method}`);
        },
      }),
      runtime: { compact: async () => ({ accepted: true }), isBusy: () => false },
    });
    expect(await models.usage!.read("s1")).toEqual({});
  });
});
