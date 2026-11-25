import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "ts-import-hooks.mjs")));
const { createLanWorkspace } = await import("../../electron/main/lan-webui/workspace.ts");
export const { createLanServer } = await import("../../electron/main/lan-webui/server.ts");

/** A fake Desktop: host-core catalog, Agent Host bridge and internal IPC. */
export function desktop() {
  const groups = [
    { id: "g-a", name: "Alpha", primaryPath: "/work/a", roots: [{ path: "/work/a", name: "a", position: 0 }], pinned: false, lastOpenedAt: 2, createdAt: 0, updatedAt: 0 },
    { id: "g-b", name: "Beta", primaryPath: "/work/b", roots: [{ path: "/work/b", name: "b", position: 0 }, { path: "/work/b2", name: "b2", position: 1 }], pinned: false, lastOpenedAt: 1, createdAt: 0, updatedAt: 0 },
    { id: "g-r", name: "Remote", primaryPath: "/remote", roots: [], pinned: false, lastOpenedAt: 3, createdAt: 0, updatedAt: 0, remote: { hostKey: "h", path: "/x" } },
  ];
  const sessions = [
    { id: "s-a1", title: "Fix login", projectPath: "/work/a", mode: "agent", updatedAt: "2026-11-01" },
    { id: "s-b1", title: "Second root chat", projectPath: "/work/b2", mode: "agent", updatedAt: "2026-11-02" },
    { id: "s-plan", title: "A plan", projectPath: "/work/a", mode: "plan", updatedAt: "2026-10-01" },
    { id: "s-tmp", title: "Scratch", projectPath: null, mode: "agent", updatedAt: "2026-11-03" },
  ];
  const meta = { projectMeta: {}, sessionMeta: {} };
  const calls = [];
  const turns = [];
  const activeTurns = new Map();
  const queue = new Map();
  let created = 0;
  const host = {
    async call(method, params) {
      if (method === "project.groups.list") return { groups };
      if (method === "session.list") return { sessions };
      if (method === "session.get") {
        const session = sessions.find((s) => s.id === params.id);
        return {
          session: session && {
            ...session,
            messageStart: 0,
            hasMoreBefore: false,
            messages: [
              { id: "m1", role: "user", content: "hello" },
              { id: "m2", role: "assistant", content: "hi there" },
              { id: "m3", role: "tool", content: "/secret/path output", toolName: "Bash" },
              { id: "m4", role: "assistant", content: "nested", parentToolCallId: "t1" },
            ],
          },
        };
      }
      throw new Error(`unexpected host call ${method}`);
    },
  };
  const bridge = {
    agentHost: {
      async startTurn(principal, params) {
        turns.push({ principal, params });
        if (activeTurns.has(params.sessionId) && params.admission === "reject_if_busy") {
          throw Object.assign(new Error("busy"), { code: "AGENT_BUSY" });
        }
        const id = `turn-${turns.length}`;
        if (activeTurns.has(params.sessionId)) queue.set(params.sessionId, [...(queue.get(params.sessionId) ?? []), { id, content: params.input.text }]);
        else activeTurns.set(params.sessionId, `run-${id}`);
        return { turn: { id } };
      },
    },
    queue: {
      list: (sessionId) => queue.get(sessionId) ?? [],
      async remove(turnId) {
        for (const [key, entries] of queue) queue.set(key, entries.filter((entry) => entry.id !== turnId));
      },
    },
    pendingInteractiveRequests: async (sessionId) => ({ asks: [], permissions: sessionId === "s-b1" ? [{}] : [] }),
  };
  const organization = {
    read: () => structuredClone(meta),
    patch(entry) {
      const bucket = entry.kind === "project" ? meta.projectMeta : meta.sessionMeta;
      bucket[entry.key] = { ...(bucket[entry.key] ?? {}), ...entry.patch };
    },
  };
  const workspace = createLanWorkspace({
    getHost: () => host,
    getBridge: () => bridge,
    channels: { sessionCreate: "create", sessionRename: "rename", projectGroupRename: "groupRename", agentAbort: "abort" },
    activeTurns,
    organization,
    notifyDesktop: (sessionId) => calls.push(["notify", sessionId ?? null]),
    async invoke(channel, args) {
      calls.push([channel, args]);
      if (channel === "create") {
        const id = `s-new-${++created}`;
        sessions.push({ id, title: "", projectPath: args[0].projectPath ?? null, mode: "agent", updatedAt: "2026-11-09" });
        return { session: { id } };
      }
      if (channel === "rename") {
        const session = sessions.find((s) => s.id === args[0]);
        session.title = args[1];
        return {};
      }
      if (channel === "abort") {
        activeTurns.delete(args[0].sessionId);
        return { ok: true };
      }
      return {};
    },
  });
  return { workspace, calls, turns, activeTurns, queue, meta, sessions, groups };
}

/** A tiny cookie-keeping browser against the real HTTP listener. */
export function browser(origin) {
  const jar = new Map();
  let csrf = "";
  const cookie = () => [...jar].map(([key, value]) => `${key}=${value}`).join("; ");
  const request = async (method, path, body, extra = {}) => {
    const headers = { Accept: "application/json", ...extra };
    if (jar.size) headers.Cookie = cookie();
    if (method === "POST") {
      headers["Content-Type"] = "application/json";
      if (csrf && !("X-CSRF-Token" in extra)) headers["X-CSRF-Token"] = csrf;
    }
    const response = await fetch(`${origin}${path}`, { method, headers, body: method === "POST" ? JSON.stringify(body ?? {}) : undefined });
    for (const raw of response.headers.getSetCookie()) {
      const [pair] = raw.split(";");
      const [name, value] = pair.split("=");
      if (value) jar.set(name, value);
      else jar.delete(name);
    }
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  return {
    request,
    events: (path, signal) => fetch(`${origin}${path}`, { headers: { Cookie: cookie() }, signal }),
    async signIn() {
      const me = await request("GET", "/v1/me");
      csrf = me.body.csrf;
      return me;
    },
  };
}

