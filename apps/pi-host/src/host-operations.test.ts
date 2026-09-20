import { mkdtemp, realpath, rm } from "node:fs/promises";
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
});
