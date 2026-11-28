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

  it("fetches the newest and older history windows, keeping item cursors exclusive per session", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const port = createHostSessionPort(() => ({
      async call<T>(method: string, params: Record<string, unknown> = {}) {
        expect(method).toBe("session.historyPage");
        calls.push(params);
        const { id, messageLimit, beforeItemId } = params;
        const ids = id === "s1" ? ["m1", "m2", "m3", "shared", "m5"] : ["x1", "shared", "x3"];
        const anchor = typeof beforeItemId === "string" ? ids.indexOf(beforeItemId) : -1;
        const end = anchor === -1 ? ids.length : anchor;
        const start = Math.max(0, end - Number(messageLimit));
        const messages = ids.slice(start, end).map((id) => ({
          id, role: "assistant", content: `資料 ${id} 🧭`, createdAt: "2026-09-18T00:00:00.000Z", status: "complete",
        }));
        return { messages, hasMoreBefore: start > 0 } as T;
      },
    }));
    const tail = await port.history("s1", { limit: 2 });
    expect(tail.items.map((item) => item.id)).toEqual(["shared", "m5"]);
    expect(tail.hasMore).toBe(true);
    expect(tail.items[0]?.content).toMatchObject({ content: "資料 shared 🧭" });
    const page = await port.history("s1", { limit: 2, beforeItemId: "shared" });
    expect(page.items.map((item) => item.id)).toEqual(["m2", "m3"]);
    expect(page.hasMore).toBe(true);
    const first = await port.history("s1", { limit: 2, beforeItemId: "m2" });
    expect(first.items.map((item) => item.id)).toEqual(["m1"]);
    expect(first.hasMore).toBe(false);
    await expect(port.history("s1", { limit: 2, beforeItemId: "m1" })).resolves.toEqual({ items: [], hasMore: false });
    const other = await port.history("s2", { limit: 2, beforeItemId: "shared" });
    expect(other.items.map((item) => item.id)).toEqual(["x1"]);
    expect(other.hasMore).toBe(false);
    await expect(port.history("s1", { limit: 2, beforeItemId: "deleted" })).resolves.toEqual(tail);
    expect(calls).toEqual([
      { id: "s1", messageLimit: 2 },
      { id: "s1", messageLimit: 2, beforeItemId: "shared" },
      { id: "s1", messageLimit: 2, beforeItemId: "m2" },
      { id: "s1", messageLimit: 2, beforeItemId: "m1" },
      { id: "s2", messageLimit: 2, beforeItemId: "shared" },
      { id: "s1", messageLimit: 2, beforeItemId: "deleted" },
    ]);
    expect(await createHostSessionPort(() => null).get("s1")).toBeNull();
  });

  it("walks one-item logical pages using first position and the newest payload", async () => {
    const pages = new Map([
      [undefined, { id: "D", content: "D", hasMore: true }],
      ["D", { id: "C", content: "C", hasMore: true }],
      ["C", { id: "B", content: "Bnew", hasMore: true }],
      ["B", { id: "A", content: "A", hasMore: false }],
    ]);
    const port = createHostSessionPort(() => ({
      async call<T>(method: string, { id, messageLimit, beforeItemId }: Record<string, unknown> = {}) {
        expect(method).toBe("session.historyPage");
        expect(id).toBe("s1");
        expect(messageLimit).toBe(1);
        const page = pages.get(typeof beforeItemId === "string" ? beforeItemId : undefined);
        if (!page) throw new Error("Unexpected history cursor");
        return { messages: [{ id: page.id, role: "assistant", content: page.content }], hasMoreBefore: page.hasMore } as T;
      },
    }));
    let beforeItemId: string | undefined;
    for (const content of ["D", "C", "Bnew", "A"]) {
      const page = await port.history("s1", { limit: 1, beforeItemId });
      expect(page).toMatchObject({ items: [{ content: { content } }], hasMore: content !== "A" });
      beforeItemId = page.items[0]?.id;
    }
  });

  it("shrinks an oversize history page without clipping an item's content", async () => {
    const content = "資料 🧭".repeat(100);
    const port = createHostSessionPort(() => ({
      async call<T>(_method: string, params: Record<string, unknown> = {}) {
        expect(_method).toBe("session.historyPage");
        expect(params).not.toHaveProperty("contentLimit");
        if (params.messageLimit !== 1) throw Object.assign(new Error("response too large"), { errorCode: "LIMIT_EXCEEDED" });
        return {
          messages: [{ id: "latest", role: "assistant", content, createdAt: "2026-09-18T00:00:00.000Z", status: "complete" }],
          hasMoreBefore: true,
        } as T;
      },
    }));
    const page = await port.history("s1", { limit: 2 });
    expect(page).toMatchObject({ items: [{ id: "latest", content: { content } }], hasMore: true });
  });

  it("bounds both the message count and message content for metadata lookups", async () => {
    const calls: Array<Record<string, unknown> | undefined> = [];
    const port = createHostSessionPort(() => ({
      async call<T>(_method: string, params?: Record<string, unknown>) {
        calls.push(params);
        return { session: { id: "s1", messages: [] } } as T;
      },
    }));
    await port.get("s1");
    expect(calls).toEqual([{ id: "s1", messageLimit: 1, contentLimit: 1 }]);
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
