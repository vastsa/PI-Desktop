import { createHash } from "node:crypto";
import {
  LAN_TEMPORARY_PROJECT,
  modelWireIdsEqual,
  trustedExtensionAgentKeyFromProviderId,
  type AgentEventEnvelope,
  type LanConversation,
  type LanMessage,
  type LanModelCatalog,
  type LanPage,
  type LanProject,
  type LanSession,
  type ProjectGroupRecord,
} from "@pi-desktop/shared";
import { readLanModelOptions, type ReadCachedModels } from "./models";
import type { LanMeta, LanOrganization } from "./organization";
import { normalizeProjectKey } from "./organization";
import { LanError, type LanChange, type LanRequest } from "./ports";

export type LanHost = { call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> };
type Principal = { subject: string; roles: Array<"viewer" | "controller">; pairedDevice: boolean };
export type LanBridge = {
  agentHost: {
    startTurn(principal: Principal, params: {
      sessionId: string;
      admission: "queue" | "reject_if_busy";
      idempotencyKey?: string;
      input: { text: string };
      context: { requestId: string };
    }): Promise<{ turn: { id: string } }>;
  };
  queue: {
    list(sessionId: string): Array<{ id: string; content: string }>;
    remove(turnId: string): Promise<void>;
  };
  pendingInteractiveRequests(sessionId: string): Promise<{ asks: unknown[]; permissions: unknown[] }>;
};
export type LanWorkspaceDeps = {
  getHost(): LanHost | null;
  getBridge(): LanBridge | null;
  invoke(channel: string, args: unknown[]): Promise<unknown>;
  channels: { sessionCreate: string; sessionConfigure: string; sessionRename: string; projectGroupRename: string; agentAbort: string };
  acquireSessionOperation(sessionId: string): Promise<() => void>;
  readCachedModels: ReadCachedModels;
  activeTurns: ReadonlyMap<string, string>;
  organization: Pick<LanOrganization, "read" | "patch">;
  /** Ask Desktop to refresh its catalog (and an idle open transcript); never navigates. */
  notifyDesktop(sessionId?: string): void;
};

type HostSession = {
  id: string;
  title?: string;
  projectPath?: string | null;
  mode?: string;
  source?: string;
  providerId?: string | null;
  modelId?: string | null;
  scheduledRun?: boolean;
  remoteWorkspace?: unknown;
  updatedAt?: string;
};
type HostMessage = { id: string; role: string; content?: unknown; toolName?: string; parentToolCallId?: string };
type HostDetail = HostSession & { messages?: HostMessage[]; messageStart?: number; hasMoreBefore?: boolean };

const PAGE = 50;
const HISTORY_PAGE = 50;
const MAX_TEXT = 64 * 1024;
const MAX_TOOL_TEXT = 600;
const MAX_PROMPT = 256 * 1024;
const MAX_NAME = 120;

const revision = (...parts: unknown[]) =>
  createHash("sha1").update(JSON.stringify(parts)).digest("base64url").slice(0, 12);
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

function stringField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === "string" ? value : undefined;
}

function oneOrganizeField(body: Record<string, unknown>): ["name", string] | ["pinned" | "archived", boolean] {
  const fields = (["name", "pinned", "archived"] as const).filter((key) => body[key] !== undefined);
  if (fields.length !== 1) throw new LanError(400, "INVALID_ARGUMENT");
  const field = fields[0]!;
  const value = body[field];
  if (field === "name") {
    const name = typeof value === "string" ? value.trim() : "";
    if (!name || name.length > MAX_NAME) throw new LanError(400, "INVALID_ARGUMENT");
    return ["name", name];
  }
  if (typeof value !== "boolean") throw new LanError(400, "INVALID_ARGUMENT");
  return [field, value];
}

export function createLanWorkspace(deps: LanWorkspaceDeps) {
  const live = new Map<string, string>();
  const listeners = new Set<(change: LanChange) => void>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const emit = (change: LanChange) => {
    for (const listener of listeners) listener(change);
  };
  const emitSoon = (sessionId: string) => {
    if (timers.has(sessionId)) return;
    timers.set(sessionId, setTimeout(() => {
      timers.delete(sessionId);
      emit({ sessionId });
    }, 200));
  };

  const host = (): LanHost => {
    const value = deps.getHost();
    if (!value) throw new LanError(503, "DESKTOP_UNAVAILABLE");
    return value;
  };
  const bridge = (): LanBridge => {
    const value = deps.getBridge();
    if (!value) throw new LanError(503, "DESKTOP_UNAVAILABLE");
    return value;
  };

  async function groups(): Promise<ProjectGroupRecord[]> {
    const result = await host().call<{ groups?: ProjectGroupRecord[] }>("project.groups.list");
    return (result.groups ?? []).filter((group) => !group.remote);
  }

  function projectView(group: ProjectGroupRecord, meta: LanMeta): LanProject {
    const own = meta.projectMeta[normalizeProjectKey(group.primaryPath)] ?? {};
    const label = own.name ?? group.name;
    const pinned = own.pinned ?? group.pinned;
    const archived = own.archived === true;
    return { id: group.id, label, pinned, archived, revision: revision(label, pinned, archived) };
  }

  /**
   * Folder-named legacy projects often share a name (several `apps`). Add the
   * parent folder name to repeated labels; never the absolute path.
   */
  function distinctViews(list: ProjectGroupRecord[], meta: LanMeta) {
    const entries = list.map((group) => ({ group, view: projectView(group, meta) }));
    const counts = new Map<string, number>();
    for (const { view } of entries) counts.set(view.label, (counts.get(view.label) ?? 0) + 1);
    for (const entry of entries) {
      if ((counts.get(entry.view.label) ?? 0) < 2) continue;
      const parts = normalizeProjectKey(entry.group.primaryPath).split("/").filter(Boolean);
      const parent = parts.length > 1 ? parts[parts.length - 2] : "";
      if (parent) entry.view = { ...entry.view, label: `${entry.view.label} · ${parent}` };
    }
    return entries;
  }

  /** Root path → group id, so a session can be attributed to one project. */
  function rootIndex(list: ProjectGroupRecord[]): Map<string, ProjectGroupRecord> {
    const index = new Map<string, ProjectGroupRecord>();
    for (const group of list) {
      index.set(normalizeProjectKey(group.primaryPath), group);
      for (const root of group.roots ?? []) index.set(normalizeProjectKey(root.path), group);
    }
    return index;
  }

  /** `undefined` = not attributable (hidden); `null` = temporary. */
  function projectOf(session: HostSession, index: Map<string, ProjectGroupRecord>): string | null | undefined {
    const path = session.projectPath?.trim();
    if (!path) return null;
    return index.get(normalizeProjectKey(path))?.id;
  }

  function sessionView(session: HostSession, projectId: string | null, meta: LanMeta, projectLabel: string | null = null): LanSession {
    const own = meta.sessionMeta[session.id] ?? {};
    const title = session.title?.trim() || "";
    const pinned = own.pinned === true;
    const archived = own.archived === true;
    const running = deps.activeTurns.has(session.id);
    return {
      id: session.id,
      projectId,
      title,
      pinned,
      archived,
      revision: revision(title, pinned, archived),
      readOnly: (session.mode ?? "agent") !== "agent" || (session.source !== undefined && session.source !== "desktop"),
      status: running ? "running" : "idle",
      updatedAt: session.updatedAt ?? "",
      projectLabel,
    };
  }

  const isLocalDesktopSession = (session: HostSession) =>
    !session.id.startsWith("remote:") && !session.id.startsWith("native-pi:");

  async function hostSessions(): Promise<HostSession[]> {
    const result = await host().call<{ sessions?: HostSession[] }>("session.list");
    return (result.sessions ?? []).filter(isLocalDesktopSession);
  }

  /** Resolve only sessions in the current local catalog or temporary workspace. */
  async function requireLocalSession(sessionId: string) {
    if (!sessionId || sessionId.startsWith("remote:") || sessionId.startsWith("native-pi:")) {
      throw new LanError(404, "NOT_FOUND");
    }
    const [list, sessions] = await Promise.all([groups(), hostSessions()]);
    const session = sessions.find((candidate) => candidate.id === sessionId);
    if (!session) throw new LanError(404, "NOT_FOUND");
    const projectId = projectOf(session, rootIndex(list));
    if (projectId === undefined) throw new LanError(404, "NOT_FOUND");
    const meta = deps.organization.read();
    const label = projectId === null ? null : projectLabels(list, meta).get(projectId) ?? null;
    const group = projectId === null ? undefined : list.find((candidate) => candidate.id === projectId);
    const projectArchived = group !== undefined && projectView(group, meta).archived;
    return { session, view: sessionView(session, projectId, meta, label), projectArchived };
  }

  function projectLabels(list: ProjectGroupRecord[], meta: LanMeta): Map<string, string> {
    return new Map(distinctViews(list, meta).map(({ group, view }) => [group.id, view.label]));
  }

  async function requireLocalProject(projectId: string) {
    const group = (await groups()).find((candidate) => candidate.id === projectId);
    if (!group) throw new LanError(404, "NOT_FOUND");
    const meta = deps.organization.read();
    return { group, meta, view: projectView(group, meta) };
  }

  function page<T>(items: T[], cursor: string | null): LanPage<T> {
    const start = Math.max(0, Number.parseInt(cursor ?? "0", 10) || 0);
    const slice = items.slice(start, start + PAGE);
    return { items: slice, nextCursor: start + PAGE < items.length ? String(start + PAGE) : null };
  }

  const matches = (text: string, query: string) => !query || text.toLowerCase().includes(query.toLowerCase());

  async function listProjects(query: URLSearchParams): Promise<LanPage<LanProject>> {
    const meta = deps.organization.read();
    const archivedOnly = query.get("archived") === "1";
    const q = (query.get("q") ?? "").trim();
    const list = distinctViews(await groups(), meta)
      .filter(({ view }) => view.archived === archivedOnly && matches(view.label, q))
      .sort((a, b) => Number(b.view.pinned) - Number(a.view.pinned) || b.group.lastOpenedAt - a.group.lastOpenedAt)
      .map(({ view }) => view);
    return page(list, query.get("cursor"));
  }

  /**
   * Sessions of one project, of the Temporary scope, or — without a
   * `projectId` — of every visible scope, most recent first with running work
   * lifted to the top. The all-scope list leaves out sessions of archived
   * projects unless archived items are requested.
   */
  async function listSessions(query: URLSearchParams): Promise<LanPage<LanSession>> {
    const everywhere = !query.has("projectId");
    const requested = query.get("projectId") ?? "";
    const wantTemporary = requested === LAN_TEMPORARY_PROJECT;
    const [list, sessions] = await Promise.all([groups(), hostSessions()]);
    if (!everywhere && !wantTemporary && !list.some((group) => group.id === requested)) throw new LanError(404, "NOT_FOUND");
    const index = rootIndex(list);
    const meta = deps.organization.read();
    const labels = projectLabels(list, meta);
    const archivedOnly = query.get("archived") === "1";
    const archivedProjects = new Set(list.filter((group) => projectView(group, meta).archived).map((group) => group.id));
    const q = (query.get("q") ?? "").trim();
    const items: LanSession[] = [];
    for (const session of sessions) {
      const projectId = projectOf(session, index);
      if (projectId === undefined) continue;
      if (!everywhere && projectId !== (wantTemporary ? null : requested)) continue;
      if (everywhere && !archivedOnly && projectId !== null && archivedProjects.has(projectId)) continue;
      const view = sessionView(session, projectId, meta, projectId === null ? null : labels.get(projectId) ?? null);
      if (view.archived === archivedOnly && matches(view.title, q)) items.push(view);
    }
    items.sort(everywhere
      ? (a, b) => Number(b.status === "running") - Number(a.status === "running") || b.updatedAt.localeCompare(a.updatedAt)
      : (a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt));
    return page(items, query.get("cursor"));
  }

  function projectMessage(message: HostMessage): LanMessage | null {
    if (message.parentToolCallId) return null;
    const text = typeof message.content === "string" ? message.content : "";
    if (message.role === "user" || message.role === "assistant") {
      return { id: message.id, role: message.role, text: clip(text, MAX_TEXT) };
    }
    if (message.role === "tool") {
      const label = message.toolName ? `${message.toolName}` : "";
      return { id: message.id, role: "tool", text: clip(label, MAX_TOOL_TEXT) };
    }
    return null;
  }

  async function history(sessionId: string, cursor: string | null): Promise<LanPage<LanMessage>> {
    const before = cursor === null ? undefined : Number.parseInt(cursor, 10);
    if (before !== undefined && (!Number.isInteger(before) || before < 0)) throw new LanError(400, "INVALID_ARGUMENT");
    const result = await host().call<{ session?: HostDetail | null }>("session.get", {
      id: sessionId,
      messageLimit: HISTORY_PAGE,
      contentLimit: MAX_TEXT,
      ...(before !== undefined ? { messageBefore: before } : {}),
    });
    const detail = result.session;
    if (!detail) throw new LanError(404, "NOT_FOUND");
    const items = (detail.messages ?? []).map(projectMessage).filter((m): m is LanMessage => m !== null);
    const start = detail.messageStart ?? 0;
    return { items, nextCursor: detail.hasMoreBefore && start > 0 ? String(start) : null };
  }

  async function conversation(sessionId: string): Promise<LanConversation> {
    const local = await requireLocalSession(sessionId);
    const { session, view } = local;
    const [messages, pending] = await Promise.all([
      history(sessionId, null),
      deps.getBridge()?.pendingInteractiveRequests(sessionId).catch(() => ({ asks: [], permissions: [] })) ??
        Promise.resolve({ asks: [], permissions: [] }),
    ]);
    const waiting = pending.permissions.length ? "approval" : pending.asks.length ? "input" : null;
    const queue = (deps.getBridge()?.queue.list(sessionId) ?? []).map((entry) => ({
      id: entry.id,
      text: clip(entry.content, 2000),
    }));
    return {
      session: { ...view, status: waiting ? "waiting" : view.status },
      messages,
      liveText: live.get(sessionId) ?? null,
      activeTurnId: deps.activeTurns.get(sessionId) ?? null,
      waiting,
      queue,
      modelLabel: session.modelId ?? null,
      canSelectModel: !modelRestriction(local),
    };
  }

  type LocalSession = Awaited<ReturnType<typeof requireLocalSession>>;
  function modelRestriction({ session, view, projectArchived }: LocalSession) {
    if (view.readOnly || session.remoteWorkspace || session.scheduledRun ||
      (session.providerId && trustedExtensionAgentKeyFromProviderId(session.providerId))) return "READ_ONLY";
    if (view.archived || projectArchived) return "ARCHIVED";
    return null;
  }

  function modelPrecondition({ session }: LocalSession) {
    return {
      projectPath: session.projectPath ?? null,
      providerId: session.providerId ?? null,
      modelId: session.modelId ?? null,
    };
  }

  async function requireModelSession(sessionId: string) {
    const local = await requireLocalSession(sessionId);
    const denied = modelRestriction(local);
    if (denied) throw new LanError(409, denied);
    return { ...local, modelRevision: revision(sessionId, local.view.projectId, modelPrecondition(local)) };
  }

  async function listSessionModels(sessionId: string): Promise<LanModelCatalog> {
    const local = await requireModelSession(sessionId);
    const items = await readLanModelOptions(host(), deps.readCachedModels);
    const activeModelId = local.session.modelId;
    const selected = activeModelId && items.find(({ providerId, modelId }) =>
      providerId === local.session.providerId && modelWireIdsEqual(modelId, activeModelId));
    return { items, selected: selected ? { providerId: selected.providerId, modelId: selected.modelId } : null, revision: local.modelRevision };
  }

  async function setSessionModel(sessionId: string, body: Record<string, unknown>) {
    const { providerId, modelId, revision: expectedRevision } = body;
    if (Object.keys(body).length !== 3 || typeof providerId !== "string" || !providerId ||
      typeof modelId !== "string" || !modelId || typeof expectedRevision !== "string" ||
      !/^[A-Za-z0-9_-]{12}$/.test(expectedRevision)) throw new LanError(400, "INVALID_ARGUMENT");

    const release = await deps.acquireSessionOperation(sessionId);
    try {
      const before = await requireModelSession(sessionId);
      if (expectedRevision !== before.modelRevision) throw new LanError(409, "CONFLICT");
      const options = await readLanModelOptions(host(), deps.readCachedModels, providerId);
      if (!options.some((option) => option.modelId === modelId)) throw new LanError(409, "MODEL_UNAVAILABLE");
      const runtime = bridge();
      const pending = await runtime.pendingInteractiveRequests(sessionId);
      const local = await requireModelSession(sessionId);
      if (expectedRevision !== local.modelRevision) throw new LanError(409, "CONFLICT");
      if (pending.asks.length || pending.permissions.length || deps.activeTurns.has(sessionId) ||
        runtime.queue.list(sessionId).length) throw new LanError(409, "MODEL_BUSY");
      // The Host repeats the scope/model comparison under its write lock.
      await deps.invoke(deps.channels.sessionConfigure, [sessionId, {
        mode: "agent", providerId, modelId, expectedAgentModel: modelPrecondition(local),
      }]);
      deps.notifyDesktop();
      emit({ sessionId });
      return { ok: true };
    } catch (error) {
      const code = (error as { errorCode?: unknown })?.errorCode;
      if (code === "CONFLICT") throw new LanError(409, "CONFLICT");
      if (code === "NOT_FOUND") throw new LanError(404, "NOT_FOUND");
      if (code === "PLAN_CONFIGURATION_BLOCKED") throw new LanError(409, "MODEL_BUSY");
      throw error;
    } finally {
      release();
    }
  }

  async function createSession(body: Record<string, unknown>) {
    const projectId = body.projectId === null ? null : stringField(body, "projectId");
    if (projectId === undefined) throw new LanError(400, "INVALID_ARGUMENT");
    let projectPath: string | undefined;
    if (projectId !== null) {
      const { group, view } = await requireLocalProject(projectId);
      if (view.archived) throw new LanError(409, "ARCHIVED");
      projectPath = group.primaryPath;
    }
    const created = (await deps.invoke(deps.channels.sessionCreate, [projectPath ? { projectPath } : {}])) as {
      session?: { id?: string } | null;
    };
    const id = created?.session?.id;
    if (!id) throw new LanError(500, "FAILED");
    deps.notifyDesktop();
    emit({});
    return { id };
  }

  async function organizeProject(projectId: string, body: Record<string, unknown>) {
    const [field, value] = oneOrganizeField(body);
    const { group, view } = await requireLocalProject(projectId);
    if (body.revision !== view.revision) throw new LanError(409, "CONFLICT");
    if (field === "archived" && value === true) {
      const index = rootIndex([group]);
      const busy = (await hostSessions()).some(
        (session) => projectOf(session, index) === group.id && deps.activeTurns.has(session.id),
      );
      if (busy) throw new LanError(409, "BUSY");
    }
    if (field === "name") {
      await deps.invoke(deps.channels.projectGroupRename, [{ groupId: group.id, name: value }]);
    }
    deps.organization.patch({ kind: "project", key: group.primaryPath, patch: { [field]: value } });
    deps.notifyDesktop();
    emit({});
    return { ok: true };
  }

  async function organizeSession(sessionId: string, body: Record<string, unknown>) {
    const [field, value] = oneOrganizeField(body);
    const { view } = await requireLocalSession(sessionId);
    if (body.revision !== view.revision) throw new LanError(409, "CONFLICT");
    if (field === "archived" && value === true) {
      const queued = deps.getBridge()?.queue.list(sessionId).length ?? 0;
      if (deps.activeTurns.has(sessionId) || queued > 0) throw new LanError(409, "BUSY");
    }
    if (field === "name") {
      await deps.invoke(deps.channels.sessionRename, [sessionId, value]);
      deps.organization.patch({ kind: "session", key: sessionId, patch: { manualTitle: true } });
    } else {
      deps.organization.patch({ kind: "session", key: sessionId, patch: { [field]: value } });
    }
    deps.notifyDesktop(sessionId);
    emit({ sessionId });
    return { ok: true };
  }

  async function sendTurn(deviceId: string, sessionId: string, body: Record<string, unknown>, key: string | null) {
    const text = stringField(body, "text")?.trim() ?? "";
    if (!text) throw new LanError(400, "INVALID_ARGUMENT");
    if (Buffer.byteLength(text) > MAX_PROMPT) throw new LanError(413, "PAYLOAD_TOO_LARGE");
    const { view } = await requireLocalSession(sessionId);
    if (view.readOnly) throw new LanError(409, "READ_ONLY");
    if (view.archived) throw new LanError(409, "ARCHIVED");
    const principal: Principal = { subject: `lan:${deviceId}`, roles: ["viewer", "controller"], pairedDevice: false };
    try {
      const result = await bridge().agentHost.startTurn(principal, {
        sessionId,
        admission: body.queue === true ? "queue" : "reject_if_busy",
        ...(key ? { idempotencyKey: `lan:${deviceId}:${key}` } : {}),
        input: { text },
        context: { requestId: `lan-${Date.now().toString(36)}` },
      });
      deps.notifyDesktop(sessionId);
      emitSoon(sessionId);
      return { id: result.turn.id };
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      if (code === "AGENT_BUSY") throw new LanError(409, "BUSY");
      if (code === "FORBIDDEN") throw new LanError(403, "FORBIDDEN");
      if (code === "AGENT_UNAVAILABLE") throw new LanError(503, "DESKTOP_UNAVAILABLE");
      throw new LanError(500, "FAILED");
    }
  }

  async function interrupt(turnId: string, body: Record<string, unknown>) {
    const sessionId = stringField(body, "sessionId") ?? "";
    await requireLocalSession(sessionId);
    if (deps.activeTurns.get(sessionId) !== turnId) return { ok: true, stopped: false };
    await deps.invoke(deps.channels.agentAbort, [{ sessionId, turnId }]);
    emitSoon(sessionId);
    return { ok: true, stopped: true };
  }

  async function cancel(turnId: string, body: Record<string, unknown>) {
    const sessionId = stringField(body, "sessionId") ?? "";
    await requireLocalSession(sessionId);
    const queue = bridge().queue;
    if (!queue.list(sessionId).some((entry) => entry.id === turnId)) return { ok: true, canceled: false };
    await queue.remove(turnId);
    emitSoon(sessionId);
    return { ok: true, canceled: true };
  }

  return {
    async handle(request: LanRequest, key: string | null): Promise<unknown> {
      const { method, path, deviceId, query, body } = request;
      const parts = path.split("/").filter(Boolean).map(decodeURIComponent); // ["v1", ...]
      const [, resource, id, sub] = parts;
      if (method === "GET") {
        if (resource === "projects" && !id) return listProjects(query);
        if (resource === "sessions" && !id) return listSessions(query);
        if (resource === "sessions" && id && !sub) return conversation(id);
        if (resource === "sessions" && id && sub === "models" && parts.length === 4) return listSessionModels(id);
        if (resource === "sessions" && id && sub === "history") {
          await requireLocalSession(id);
          return history(id, query.get("cursor"));
        }
      } else {
        if (resource === "sessions" && !id) return createSession(body);
        if (resource === "projects" && id && sub === "organize") return organizeProject(id, body);
        if (resource === "sessions" && id && sub === "organize") return organizeSession(id, body);
        if (resource === "sessions" && id && sub === "turns") return sendTurn(deviceId, id, body, key);
        if (resource === "sessions" && id && sub === "model" && parts.length === 4) return setSessionModel(id, body);
        if (resource === "turns" && id?.endsWith(":interrupt")) return interrupt(id.slice(0, -10), body);
        if (resource === "turns" && id?.endsWith(":cancel")) return cancel(id.slice(0, -7), body);
      }
      throw new LanError(404, "NOT_FOUND");
    },

    /** Session-scoped change notifications; the listener filters out non-local ids. */
    subscribe(listener: (change: LanChange) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    /** Whether a change for `sessionId` belongs to a visible local session. */
    async mayReveal(sessionId: string): Promise<boolean> {
      try {
        await requireLocalSession(sessionId);
        return true;
      } catch {
        return false;
      }
    },

    /** Catalog changes made on Desktop (or by another device). */
    catalogChanged(): void {
      emit({});
    },

    ingest(envelope: AgentEventEnvelope): void {
      if (envelope.parentToolCallId) return;
      const { sessionId, event } = envelope;
      switch (event.type) {
        case "message_start":
          if (event.message.role === "assistant") live.set(sessionId, "");
          break;
        case "message_update": {
          if (event.message.role !== "assistant") break;
          if (event.stream === "delta") {
            const base = event.resetText ? "" : live.get(sessionId) ?? "";
            live.set(sessionId, clip(base + (event.deltaText ?? ""), MAX_TEXT));
          } else {
            live.set(sessionId, clip(event.message.content ?? "", MAX_TEXT));
          }
          break;
        }
        case "message_end":
          live.delete(sessionId);
          break;
        case "agent_end":
          live.delete(sessionId);
          deps.notifyDesktop(sessionId);
          break;
        case "tool_start":
        case "tool_end":
        case "tool_permission_request":
        case "asktool_request":
        case "agent_start":
        case "status":
        case "user_message_persisted":
          break;
        default:
          return;
      }
      emitSoon(sessionId);
    },

    dispose(): void {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      listeners.clear();
      live.clear();
    },
  };
}

export type LanWorkspace = ReturnType<typeof createLanWorkspace>;
