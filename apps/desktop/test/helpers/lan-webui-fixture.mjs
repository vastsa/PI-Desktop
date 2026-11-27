import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "ts-import-hooks.mjs")));
const { createLanWorkspace } = await import("../../electron/main/lan-webui/workspace.ts");
export const { createLanServer } = await import("../../electron/main/lan-webui/server.ts");

/** Markdown, consecutive tool steps and unsafe content the page must defuse. */
const richTranscript = [
  { id: "r1", role: "user", content: "How do I run the tests?" },
  { id: "r2", role: "assistant", content: "Checking the scripts." },
  { id: "r3", role: "tool", content: "/secret/path package.json", toolName: "Read" },
  { id: "r4", role: "tool", content: "/secret/path ok", toolName: "Bash" },
  {
    id: "r5",
    role: "assistant",
    content: [
      "Run **all** tests:",
      "",
      "```sh",
      "pnpm test",
      "```",
      "",
      "- unit",
      "- e2e",
      "",
      "See [docs](https://example.com/docs) or [local](file:///etc/passwd).",
      "",
      "![diagram](https://example.com/x.png)",
      "",
      "<script>window.__pwned = true</script>",
    ].join("\n"),
  },
];

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
    { id: "s-ssh", title: "SSH session", projectPath: "/remote", mode: "agent" },
    { id: "s-ungrouped", title: "Ungrouped", projectPath: "/unregistered", mode: "agent" },
  ];
  const meta = { projectMeta: {}, sessionMeta: {} };
  const calls = [];
  const turns = [];
  const activeTurns = new Map();
  const queue = new Map();
  const providers = [
    { id: "local-ai", name: "Local AI", enabled: true, authKind: "none", models: [
      { id: "swift-chat", alias: "Swift" }, { id: "steady-chat", alias: "Steady" },
      { id: "retired-chat" }, { id: "gpt-image-1" },
    ], baseUrl: "https://private.example.test" },
    { id: "inactive", name: "Inactive", enabled: false, hasSecret: true, models: [{ id: "hidden-chat" }] },
    { id: "signed-out", name: "Signed out", enabled: true, authKind: "oauth", hasSecret: false, models: [{ id: "unavailable-chat" }] },
  ];
  let created = 0;
  const host = {
    async call(method, params) {
      if (method === "project.groups.list") return { groups };
      if (method === "session.list") return { sessions };
      if (method === "providers.list") return { providers };
      if (method === "settings.get") return { imageGeneration: { providerId: "local-ai", modelId: "gpt-image-1" } };
      if (method === "session.get") {
        const session = sessions.find((s) => s.id === params.id);
        return {
          session: session && {
            ...session,
            messageStart: 0,
            hasMoreBefore: false,
            messages: params.id === "s-tmp" ? richTranscript : params.id.startsWith("s-new-") ? [] : [
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
  const workspaceDeps = {
    getHost: () => host,
    getBridge: () => bridge,
    channels: { sessionCreate: "create", sessionConfigure: "configure", sessionRename: "rename", projectGroupRename: "groupRename", agentAbort: "abort" },
    acquireSessionOperation: async () => () => {},
    readCachedModels: async () => [{ modelId: "retired-chat", discoveryState: "unlisted" }, { modelId: "unconfigured-chat" }],
    activeTurns,
    async invoke(channel, args) {
      calls.push([channel, args]);
      if (channel === "create") {
        const id = `s-new-${++created}`;
        sessions.push({ id, title: "", projectPath: args[0].projectPath ?? null, mode: "agent", updatedAt: "2026-11-09" });
        return { session: { id } };
      }
      if (channel === "configure") {
        const [id, { providerId, modelId }] = args;
        const session = sessions.find((s) => s.id === id);
        Object.assign(session, { providerId, modelId });
        return { session };
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
  };
  const workspace = createLanWorkspace({
    ...workspaceDeps,
    organization,
    notifyDesktop: (sessionId) => calls.push(["notify", sessionId ?? null]),
  });
  return { workspace, workspaceDeps, calls, turns, activeTurns, queue, meta, sessions, groups };
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
