import { describe, expect, it } from "vitest";

import {
  createHostQueueStore,
  createHostSessionPort,
  fromHostQueueEntry,
  toSessionSummary,
  withSessionProjectIds,
} from "./host-ports.js";

describe("host ports", () => {
  it("maps a host session record to the Agent Host summary without leaking the absolute path", () => {
    const summary = toSessionSummary({
      id: "s1",
      title: "Fix build",
      projectId: "proj",
      projectPath: "/home/user/work/pi",
      mode: "plan",
      permissionMode: "accept-edits",
      planningState: "awaiting_approval",
      createdAt: "2026-09-18T00:00:00.000Z",
    });
    expect(summary).toEqual({
      id: "s1",
      title: "Fix build",
      projectId: "proj",
      workspaceIdentity: expect.stringMatching(/^[a-f0-9]{64}$/u),
      workspaceLabel: "pi",
      mode: "plan",
      permissionMode: "accept-edits",
      planningState: "awaiting_approval",
      createdAt: "2026-09-18T00:00:00.000Z",
      updatedAt: "2026-09-18T00:00:00.000Z",
    });
    expect(JSON.stringify(summary)).not.toContain("/home/user/work/pi");
    expect(
      toSessionSummary({
        id: "x",
        mode: "weird",
        permissionMode: "yolo",
        planningState: "?",
      }),
    ).toMatchObject({
      mode: "agent",
      permissionMode: "ask",
      planningState: "inactive",
    });
  });

  it("pages history backwards from an item id", async () => {
    const messages = ["m1", "m2", "m3", "m4"].map((id) => ({
      id,
      role: "assistant" as const,
      content: id,
      createdAt: "2026-09-18T00:00:00.000Z",
      status: "complete" as const,
    }));
    const port = createHostSessionPort(() => ({
      async call<T>() {
        return { session: { id: "s1", messages } } as T;
      },
    }));
    const page = await port.history("s1", { limit: 2, beforeItemId: "m4" });
    expect(page.items.map((item) => item.id)).toEqual(["m2", "m3"]);
    expect(page.hasMore).toBe(true);
    const tail = await port.history("s1", { limit: 10 });
    expect(tail.items.map((item) => item.id)).toEqual(["m1", "m2", "m3", "m4"]);
    expect(tail.hasMore).toBe(false);
    expect(await createHostSessionPort(() => null).get("s1")).toBeNull();
  });

  it("bounds the transcript read for metadata lookups but not for history pages", async () => {
    const calls: Array<Record<string, unknown> | undefined> = [];
    const port = createHostSessionPort(() => ({
      async call<T>(_method: string, params?: Record<string, unknown>) {
        calls.push(params);
        return { session: { id: "s1", messages: [] } } as T;
      },
    }));
    await port.get("s1");
    await port.history("s1", { limit: 10 });
    expect(calls).toEqual([{ id: "s1", messageLimit: 1 }, { id: "s1" }]);
  });

  it("decorates the attach summary with the project id resolved from the project path", async () => {
    // The renderer replaces its cached summary with the attach snapshot, so a
    // bare host record (project path only) used to drop the row from its
    // sidebar project group.
    const port = createHostSessionPort(() => ({
      async call<T>(method: string) {
        if (method === "projects.list") {
          return {
            projects: [{ id: 7, path: "/remote/app", name: "app" }],
          } as T;
        }
        return {
          session: { id: "s1", projectPath: "/remote/app", messages: [] },
        } as T;
      },
    }));
    const summary = await port.get("s1");
    expect(summary).toMatchObject({
      id: "s1",
      projectId: "7",
      workspaceLabel: "app",
    });
    // A session whose project was removed keeps no fabricated id.
    const orphanPort = createHostSessionPort(() => ({
      async call<T>(method: string) {
        if (method === "projects.list") return { projects: [] } as T;
        return {
          session: { id: "s2", projectPath: "/remote/gone", messages: [] },
        } as T;
      },
    }));
    const orphan = await orphanPort.get("s2");
    expect(orphan?.projectId).toBeUndefined();
    // No project path means no projects.list round-trip at all.
    const calls: string[] = [];
    const plainPort = createHostSessionPort(() => ({
      async call<T>(method: string) {
        calls.push(method);
        return { session: { id: "s3", messages: [] } } as T;
      },
    }));
    await plainPort.get("s3");
    expect(calls).toEqual(["session.get"]);
  });

  it("keeps an authoritative projectId in a mixed batch and only falls back byPath for records without one", async () => {
    const host = {
      async call<T>(method: string) {
        if (method === "projects.list") {
          return {
            projects: [{ id: 7, path: "/p", name: "p" }],
          } as T;
        }
        throw new Error(`unexpected ${method}`);
      },
    };
    const summaries = await withSessionProjectIds(host, [
      { id: "explicit", projectId: "authoritative-id", projectPath: "/p" },
      { id: "missing", projectPath: "/p" },
    ]);
    // The explicit record keeps its own id — byPath must not overwrite it.
    expect(summaries[0]).toMatchObject({ id: "explicit", projectId: "authoritative-id" });
    // The record without an id is decorated from the projects table.
    expect(summaries[1]).toMatchObject({ id: "missing", projectId: "7" });
  });

  it("decorates port.get with the same project id the session list decoration yields", async () => {
    // Maintainer acceptance: the shared decoration (createHostSessionPort.get
    // vs. session/list via withSessionProjectIds) must produce identical
    // project ids for the same record, or attach snapshots ungroup rows.
    const host = {
      async call<T>(method: string, params?: Record<string, unknown>) {
        if (method === "projects.list") {
          return {
            projects: [{ id: 7, path: "/remote/app", name: "app" }],
          } as T;
        }
        if (method === "session.get") {
          expect(params).toMatchObject({ id: "s1" });
          return {
            session: { id: "s1", projectPath: "/remote/app", messages: [] },
          } as T;
        }
        throw new Error(`unexpected ${method}`);
      },
    };
    const record = { id: "s1", projectPath: "/remote/app" };
    const [listed] = await withSessionProjectIds(host, [record]);
    const port = createHostSessionPort(() => host);
    const attached = await port.get("s1");
    expect(attached).not.toBeNull();
    expect(attached!.projectId).toBe(listed!.projectId);
    expect(attached!.projectId).toBe("7");
  });

  it("round-trips queue records through the host-core RPC shape", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> =
      [];
    const store = createHostQueueStore(() => ({
      async call<T>(method: string, params: Record<string, unknown> = {}) {
        calls.push({ method, params });
        if (method === "session.queueList") {
          return {
            entries: [
              {
                id: "q1",
                sessionId: "s1",
                principal: "phone",
                inputHash: "h",
                content: "later",
                permissionMode: "auto",
                position: 1,
                priority: 2,
                createdAt: "2026-09-18T00:00:00.000Z",
              },
            ],
          } as T;
        }
        if (method === "session.queueRemove") return { removed: true } as T;
        if (method === "session.queueReorder") return { moved: false } as T;
        return {} as T;
      },
    }));
    const [record] = await store.listAll();
    expect(record).toMatchObject({
      id: "q1",
      principalSubject: "phone",
      effectivePermissionMode: "auto",
      priority: 2,
    });
    expect(record?.createdAt).toBe(Date.parse("2026-09-18T00:00:00.000Z"));
    await store.push({
      ...record!,
      attachments: [{ path: "/x", name: "x", kind: "file" }],
    });
    expect(calls.at(-1)?.params).toMatchObject({
      id: "q1",
      principal: "phone",
      permissionMode: "auto",
    });
    expect(await store.remove("q1")).toBe(true);
    expect(await store.reorder!("q1", "up")).toBe(false);
    expect(
      fromHostQueueEntry({
        id: "q",
        sessionId: "s",
        principal: "p",
        inputHash: "h",
        content: "c",
        permissionMode: "nope",
        position: 1,
        createdAt: "bad",
      }),
    ).toMatchObject({
      effectivePermissionMode: "ask",
      createdAt: 0,
    });
  });

  it("fails closed when the host is gone", async () => {
    const store = createHostQueueStore(() => null);
    expect(await store.listAll()).toEqual([]);
    await expect(store.remove("q1")).rejects.toMatchObject({
      code: "AGENT_UNAVAILABLE",
    });
  });
});
