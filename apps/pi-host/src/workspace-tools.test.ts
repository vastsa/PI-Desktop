import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HostRpc } from "@pi-desktop/host-runtime";
import { createWorkspaceTools } from "./workspace-tools.js";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const owner = { deviceId: "paired-device", connectionId: "connection-a" };
const input = (path: string) => ({ path, sessionId: "local-session", turnId: "local-turn", toolCallId: "call-1", toolName: "Read" as const, args: { path: "README.md" } });
const directory = async () => { const dir = await mkdtemp(join(tmpdir(), "remote-tools-")); dirs.push(dir); return dir; };

describe("owner workspace tools", () => {
  it("canonicalizes root and dispatches only the pure runner, without project/session/provider writes", async () => {
    const dir = await directory();
    const link = `${dir}-link`; dirs.push(link); await symlink(dir, link);
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const host: HostRpc = { async call<T>(method: string, params: Record<string, unknown> = {}) { calls.push({ method, params }); return { ok: true, content: "remote file" } as T; } };
    const tools = createWorkspaceTools(() => host);
    expect(await tools.execute(input(link), owner)).toEqual({ ok: true, content: "remote file", toolCallId: "call-1" });
    expect(calls).toHaveLength(1); expect(calls[0]?.method).toBe("tools.workspaceExecute");
    expect(calls[0]?.params.path).not.toBe(link);
    expect(calls[0]?.params.sessionId).not.toBe("local-session");
    await expect(tools.execute(input(link), owner)).rejects.toMatchObject({ code: "CONFLICT" });
    await tools.execute(input(link), { ...owner, deviceId: "another-device" });
    expect(calls[1]?.params.sessionId).not.toBe(calls[0]?.params.sessionId);
  });
  it("adds the git proxy address only for a session that has one, looked up by the raw session id", async () => {
    const dir = await directory();
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const host: HostRpc = { async call<T>(method: string, params: Record<string, unknown> = {}) { calls.push({ method, params }); return { ok: true, content: "" } as T; } };
    const lookups: Array<[string, string, string]> = [];
    const tools = createWorkspaceTools(() => host, { gitProxyUrlFor: (connectionId, sessionId, path) => {
      lookups.push([connectionId, sessionId, path]);
      return sessionId === "local-session" && connectionId === "connection-a" ? "http://127.0.0.1:4321/handle/" : undefined;
    } });
    const bash = { ...input(dir), toolName: "Bash", args: { command: "git status" } };
    await tools.execute(bash, owner);
    await tools.execute({ ...bash, sessionId: "other-session" }, owner);
    await tools.execute({ ...bash, toolCallId: "call-2" }, { ...owner, connectionId: "connection-b" });
    expect(lookups).toEqual([["connection-a", "local-session", calls[0]?.params.path], ["connection-a", "other-session", calls[0]?.params.path], ["connection-b", "local-session", calls[0]?.params.path]]);
    expect(calls[0]?.params.gitProxyUrl).toBe("http://127.0.0.1:4321/handle/");
    // host-core still gets the hashed session id, not the raw one.
    expect(calls[0]?.params.sessionId).not.toBe("local-session");
    expect(Object.hasOwn(calls[1]!.params, "gitProxyUrl")).toBe(false);
    expect(Object.hasOwn(calls[2]!.params, "gitProxyUrl")).toBe(false);
    // Without the option the call is exactly what it was.
    const plain: Array<Record<string, unknown>> = [];
    const plainHost: HostRpc = { async call<T>(_method: string, params: Record<string, unknown> = {}) { plain.push(params); return { ok: true, content: "" } as T; } };
    await createWorkspaceTools(() => plainHost).execute(input(dir), owner);
    expect(Object.keys(plain[0]!).sort()).toEqual(["args", "path", "sessionId", "toolCallId", "toolName", "turnId"]);
  });
  it("rejects unknown tools, relative paths, oversized args and unavailable roots without RPC", async () => {
    let calls = 0;
    const host: HostRpc = { async call<T>() { calls++; return {} as T; } };
    const tools = createWorkspaceTools(() => host);
    await expect(tools.execute(input("relative"), owner)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(tools.execute({ ...input("/"), args: { content: "x".repeat(1024 * 1024) } }, owner)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(tools.execute(input("/nonexistent/remote-fixture"), owner)).rejects.toMatchObject({ code: "REMOTE_PATH_NOT_FOUND" });
    expect(calls).toBe(0);
  });
  it("disconnect cancels owned active calls and never accepts a late result", async () => {
    const dir = await directory();
    let release: (() => void) | undefined;
    let started: (() => void) | undefined;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const methods: string[] = [];
    const host: HostRpc = { async call<T>(method: string) {
      methods.push(method);
      if (method === "tools.workspaceExecute") { started?.(); await new Promise<void>(resolve => { release = resolve; }); }
      return { ok: true, content: "late" } as T;
    } };
    const tools = createWorkspaceTools(() => host);
    const pending = tools.execute(input(dir), owner);
    await ready;
    await tools.abort({ sessionId: "local-session", toolCallId: "call-1" }, { ...owner, deviceId: "other" });
    expect(methods).toEqual(["tools.workspaceExecute"]);
    await tools.disconnect(owner.connectionId);
    const rejection = expect(pending).rejects.toMatchObject({ code: "AGENT_UNAVAILABLE" });
    release?.(); await rejection;
    expect(methods).toEqual(["tools.workspaceExecute", "tools.workspaceAbort"]);
  });
});
