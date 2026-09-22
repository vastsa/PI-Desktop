import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, dirname } from "node:path";
import {
  CURRENT_SESSION_VERSION,
  DefaultResourceLoader,
  ModelRuntime,
  ProjectTrustStore,
  SessionManager,
  SettingsManager,
  createAgentSession,
  hasTrustRequiringProjectResources,
  parseSessionEntries,
  type AgentSession,
  type AgentSessionEvent,
  type SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import { normalizeToolName } from "@pi-desktop/shared";
import type {
  AgentEvent,
  AgentEventEnvelope,
  SessionDetail,
  SessionSearchPage,
  SessionSummary,
  ThinkingLevel,
  UiMessage,
} from "@pi-desktop/shared";
import {
  NativePiSessionLease,
  guardNativePiSessionManager,
  nativePiSnapshot,
  type NativePiSnapshot,
} from "./native-pi-session-lease.js";

export const NATIVE_PI_SESSION_PREFIX = "native-pi:";

export type NativePiReadOnlyReason =
  | "busy"
  | "changed-externally"
  | "invalid-session"
  | "legacy-format"
  | "missing-cwd"
  | "missing-trailing-newline"
  | "provider-unavailable"
  | "project-untrusted";

type NativeSessionRecord = {
  id: string;
  path: string;
  nativeId: string;
  cwd: string;
};

function searchContains(text: string, query: string): boolean {
  return text.toLowerCase().includes(query.toLowerCase());
}

function searchExcerpt(text: string, query: string, budget = 180): string {
  const characters = Array.from(text);
  if (characters.length <= budget) return text;
  const match = text.toLowerCase().indexOf(query.toLowerCase());
  const start = match < 0 ? 0 : Math.max(0, match - Math.floor(budget / 3));
  const end = Math.min(characters.length, start + budget);
  return `${start > 0 ? "…" : ""}${characters.slice(start, end).join("")}${end < characters.length ? "…" : ""}`;
}

function stableId(path: string, nativeId: string): string {
  return `${NATIVE_PI_SESSION_PREFIX}${createHash("sha256")
    .update(`${path}\0${nativeId}`)
    .digest("base64url")
    .slice(0, 24)}`;
}

function inside(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function textContent(content: unknown): { text: string; thinking?: string } {
  if (typeof content === "string") return { text: content };
  if (!Array.isArray(content)) return { text: "" };
  const text: string[] = [];
  const thinking: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (Reflect.get(block, "type") === "text" && typeof Reflect.get(block, "text") === "string") {
      text.push(Reflect.get(block, "text"));
    }
    if (Reflect.get(block, "type") === "thinking" && typeof Reflect.get(block, "thinking") === "string") {
      thinking.push(Reflect.get(block, "thinking"));
    }
  }
  return { text: text.join("\n"), ...(thinking.length ? { thinking: thinking.join("\n") } : {}) };
}

function uiMessage(entry: SessionMessageEntry): UiMessage | undefined {
  const message = entry.message as any;
  const content = textContent(message.content);
  if (message.role === "user") {
    return { id: entry.id, role: "user", content: content.text, createdAt: entry.timestamp, status: "complete" };
  }
  if (message.role === "assistant") {
    return {
      id: entry.id,
      role: "assistant",
      content: content.text,
      ...(content.thinking ? { thinking: content.thinking } : {}),
      createdAt: entry.timestamp,
      status: message.stopReason === "error" ? "error" : message.stopReason === "aborted" ? "aborted" : "complete",
      ...(typeof message.model === "string" ? { modelId: message.model } : {}),
      ...(typeof message.provider === "string" ? { providerId: message.provider } : {}),
    };
  }
  if (message.role === "toolResult") {
    return {
      id: entry.id,
      role: "tool",
      content: content.text,
      createdAt: entry.timestamp,
      status: "complete",
      toolCallId: typeof message.toolCallId === "string" ? message.toolCallId : undefined,
      toolName:
        typeof message.toolName === "string" ? normalizeToolName(message.toolName) : undefined,
      toolResult: message.details ?? message.content,
      toolStatus: message.isError ? "error" : "success",
      isError: message.isError === true,
    };
  }
  return undefined;
}

function visibleMessages(manager: SessionManager): UiMessage[] {
  const messages: UiMessage[] = [];
  for (const entry of manager.getBranch()) {
    if (entry.type === "message") {
      const projected = uiMessage(entry);
      if (projected) messages.push(projected);
    } else if (entry.type === "custom_message" && entry.display) {
      const content = textContent(entry.content);
      messages.push({
        id: entry.id,
        role: "system",
        content: content.text,
        createdAt: entry.timestamp,
        status: "complete",
      });
    } else if (entry.type === "compaction" || entry.type === "branch_summary") {
      messages.push({
        id: entry.id,
        role: "system",
        content: entry.summary,
        createdAt: entry.timestamp,
        status: "complete",
      });
    }
  }
  return messages;
}

function thinkingLevel(value: string): ThinkingLevel {
  return value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh"
    ? value
    : "off";
}

function walkJsonl(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
    }
  }
  return files;
}

export type NativePiRuntimeNotifier = (envelope: AgentEventEnvelope) => void;

/**
 * A file this operation actually created. Cleanup proves ownership from the
 * exact inode AND the exact content (hash for a complete file, prefix match
 * for a partial staging write), so a same-size foreign rewrite or a path
 * replacement is never deleted.
 */
type OwnedFile = {
  path: string;
  dev: number;
  ino: number;
};

type CompleteOwnedFile = OwnedFile & {
  size: number;
  hash: string;
};

function hashBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Stage a branch the SDK built in memory (private non-jsonl temp, mode 0600).
 * `wx` guarantees this never overwrites a file that appeared at the same path.
 */
function stageNativeBranchFile(path: string, fileEntries: unknown[]): CompleteOwnedFile {
  const payload = Buffer.from(
    fileEntries.map((entry) => `${JSON.stringify(entry)}\n`).join(""),
    "utf8",
  );
  const fd = openSync(path, "wx", 0o600);
  let owned: OwnedFile;
  try {
    const stats = fstatSync(fd);
    owned = { path, dev: stats.dev, ino: stats.ino };
  } catch (error) {
    try { closeSync(fd); } catch { /* nothing provable to clean */ }
    throw error;
  }
  try {
    writeFileSync(fd, payload);
    fsyncSync(fd);
    closeSync(fd);
  } catch (error) {
    try { closeSync(fd); } catch { /* already closed */ }
    removeOwnedPartialFile(owned, payload);
    throw error;
  }
  return { ...owned, size: payload.length, hash: hashBytes(payload) };
}

/**
 * True while the path is still this exact inode with the exact bytes this
 * operation wrote. Used both as a delete guard and as the payload-integrity
 * gate before and after publication, so a same-inode/same-size rewrite cannot
 * be returned as a child or deleted as ours.
 */
function ownsCompleteFile(file: CompleteOwnedFile): boolean {
  try {
    const stats = lstatSync(file.path);
    if (stats.dev !== file.dev || stats.ino !== file.ino || stats.size !== file.size) {
      return false;
    }
    return hashBytes(readFileSync(file.path)) === file.hash;
  } catch {
    return false;
  }
}

function removeOwnedCompleteFile(file: CompleteOwnedFile): boolean {
  if (!ownsCompleteFile(file)) return false;
  try {
    unlinkSync(file.path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Clean up a staging file whose write failed part-way: the path must still be
 * our inode and its bytes must be a prefix of the payload we were writing.
 */
function removeOwnedPartialFile(file: OwnedFile, payload: Buffer): boolean {
  try {
    const stats = lstatSync(file.path);
    if (stats.dev !== file.dev || stats.ino !== file.ino || stats.size > payload.length) {
      return false;
    }
    const bytes = readFileSync(file.path);
    if (!bytes.equals(payload.subarray(0, bytes.length))) return false;
    unlinkSync(file.path);
    return true;
  } catch {
    return false;
  }
}

const NATIVE_FORK_ERROR_CODES = new Set([
  "AGENT_BUSY",
  "INVALID_ARGUMENT",
  "NOT_FOUND",
  "PERMISSION_DENIED",
  "NATIVE_PI_SESSION_BUSY",
  "NATIVE_PI_SESSION_CHANGED",
  "NATIVE_PI_INVALID_SESSION",
  "NATIVE_PI_LEGACY_FORMAT",
  "NATIVE_PI_MISSING_TRAILING_NEWLINE",
  "NATIVE_PI_MISSING_CWD",
]);

const nativeServices = new Map<string, NativePiSessionService>();

export function nativePiService(options: { agentDir?: string; sessionRoot?: string } = {}): NativePiSessionService {
  const agentDir = resolve(options.agentDir ?? join(homedir(), ".pi", "agent"));
  const sessionRoot = resolve(options.sessionRoot ?? join(agentDir, "sessions"));
  const key = `${agentDir}\0${sessionRoot}`;
  let service = nativeServices.get(key);
  if (!service) {
    service = new NativePiSessionService({ agentDir, sessionRoot });
    nativeServices.set(key, service);
  }
  return service;
}

class NativePiRuntime {
  private unsubscribe?: () => void;
  private turnId?: string;
  private userMessageId?: string;
  private currentAssistant?: UiMessage;

  constructor(
    readonly id: string,
    private readonly session: AgentSession,
    private readonly lease: NativePiSessionLease,
    private readonly notify: NativePiRuntimeNotifier,
  ) {
    this.unsubscribe = session.subscribe((event) => this.onEvent(event));
  }

  get isRunning(): boolean {
    return this.turnId !== undefined;
  }

  async prompt(content: string, turnId: string, userMessageId?: string): Promise<void> {
    if (this.isRunning) {
      throw Object.assign(new Error("session already has an active turn"), { errorCode: "AGENT_BUSY" });
    }
    this.lease.assertUnchanged();
    this.turnId = turnId;
    this.userMessageId = userMessageId;
    try {
      await this.session.prompt(content);
    } catch (error) {
      // A rejected run persists nothing; close the provisional stream row so
      // the panel never keeps a bubble for a reply that never happened.
      if (this.currentAssistant) {
        this.emit({ type: "message_end", message: { ...this.currentAssistant, status: "error" } });
        this.currentAssistant = undefined;
      }
      this.turnId = undefined;
      this.userMessageId = undefined;
      throw error;
    }
    // SDK prompt resolves after agent_settled hooks and final persistence,
    // including retries/compaction. A rejected run emits only the error path.
    // Extension commands may also resolve without starting an agent run.
    if (this.turnId === turnId) this.settle();
  }

  assertUnchanged(): void {
    this.lease.assertUnchanged();
  }

  private settle(): void {
    if (!this.turnId) return;
    const turnId = this.turnId;
    this.turnId = undefined;
    this.userMessageId = undefined;
    this.notify({ sessionId: this.id, turnId, ts: Date.now(), event: { type: "agent_end", messageIds: [] } });
  }

  async abort(): Promise<void> {
    await this.session.abort();
  }

  dispose(): void {
    this.unsubscribe?.();
    this.session.dispose();
    this.lease.release();
  }

  private emit(event: AgentEvent): void {
    this.notify({ sessionId: this.id, turnId: this.turnId, ts: Date.now(), event });
  }

  private onEvent(event: AgentSessionEvent): void {
    if (event.type === "agent_start" || event.type === "turn_start") {
      this.emit({ type: event.type });
    } else if (event.type === "message_start") {
      // The durable entry id is minted when the SDK appends the finished
      // message, so the live row carries a provisional id that the renderer
      // replaces on `message_end`.
      if (event.message.role === "assistant") {
        const content = textContent((event.message as { content?: unknown }).content);
        this.currentAssistant = {
          id: randomUUID(),
          role: "assistant",
          content: content.text,
          ...(content.thinking ? { thinking: content.thinking } : {}),
          createdAt: new Date().toISOString(),
          status: "streaming",
        };
        this.emit({ type: "message_start", message: this.currentAssistant });
      }
    } else if (event.type === "message_update") {
      if (this.currentAssistant && event.message.role === "assistant") {
        const content = textContent((event.message as { content?: unknown }).content);
        this.currentAssistant = {
          ...this.currentAssistant,
          content: content.text,
          thinking: content.thinking,
          status: "streaming",
        };
        this.emit({ type: "message_update", message: this.currentAssistant });
      }
    } else if (event.type === "turn_end") {
      this.emit({ type: "turn_end" });
    } else if (event.type === "tool_execution_start") {
      this.emit({ type: "tool_start", toolCallId: event.toolCallId, toolName: event.toolName, args: event.args });
    } else if (event.type === "tool_execution_update") {
      this.emit({ type: "tool_update", toolCallId: event.toolCallId, partialResult: event.partialResult });
    } else if (event.type === "tool_execution_end") {
      this.emit({ type: "tool_end", toolCallId: event.toolCallId, result: event.result, isError: event.isError });
    }
  }

  rememberMessage(id: string): void {
    const entry = this.session.sessionManager.getEntry(id);
    if (entry?.type !== "message") return;
    const projected = uiMessage(entry);
    if (!projected) return;
    if (projected.role === "user" && this.userMessageId) {
      this.emit({ type: "user_message_persisted", optimisticMessageId: this.userMessageId, message: projected });
      this.userMessageId = undefined;
    } else if (projected.role === "assistant" && this.currentAssistant) {
      // The durable SDK entry replaces the live provisional row; the renderer
      // re-keys exactly that message id instead of guessing by role/status.
      const replacesMessageId = this.currentAssistant.id;
      this.currentAssistant = undefined;
      this.emit({ type: "message_end", message: projected, replacesMessageId });
    } else {
      if (projected.role === "assistant") this.currentAssistant = undefined;
      this.emit({ type: "message_end", message: projected });
    }
  }
}

export class NativePiSessionService {
  private readonly root: string;
  private readonly agentDir: string;
  private readonly records = new Map<string, NativeSessionRecord>();
  private readonly runtimes = new Map<string, NativePiRuntime>();
  private readonly opening = new Set<string>();
  private modelRuntime?: ModelRuntime;
  private readonly modelRuntimeFactory: () => Promise<ModelRuntime>;

  constructor(options: {
    agentDir?: string;
    sessionRoot?: string;
    modelRuntimeFactory?: () => Promise<ModelRuntime>;
  } = {}) {
    this.agentDir = resolve(options.agentDir ?? join(homedir(), ".pi", "agent"));
    this.root = resolve(options.sessionRoot ?? join(this.agentDir, "sessions"));
    this.modelRuntimeFactory =
      options.modelRuntimeFactory ??
      (() =>
        ModelRuntime.create({
          authPath: join(this.agentDir, "auth.json"),
          modelsPath: join(this.agentDir, "models.json"),
          allowModelNetwork: false,
          refreshOnCreate: true,
        }));
  }

  async list(): Promise<SessionSummary[]> {
    let root: string;
    try {
      root = realpathSync(this.root);
    } catch {
      return [];
    }
    const modelRuntime = await this.modelRuntimeFactory().catch(() => undefined);
    this.modelRuntime = modelRuntime;
    const trustStore = new ProjectTrustStore(this.agentDir);
    const summaries = await Promise.all(
      walkJsonl(root).map(async (candidate) => {
        try {
          const path = realpathSync(candidate);
          if (!inside(root, path) || lstatSync(path).isSymbolicLink()) return undefined;
          const snap = nativePiSnapshot(path);
          const entries = parseSessionEntries(snap.bytes.toString("utf8"));
          const header = entries.find((entry) => entry.type === "session") as any;
          if (!header || typeof header.id !== "string") return undefined;
          const manager = SessionManager.inMemory(header.cwd ?? "", undefined, entries);
          const id = stableId(path, header.id);
          const branch = manager.getBranch();
          const messageCount = branch.filter((entry) => entry.type === "message").length;
          const firstUser = branch.find((entry) => entry.type === "message" && (entry as SessionMessageEntry).message.role === "user") as SessionMessageEntry | undefined;
          const context = manager.buildSessionContext();
          const createdAt = typeof header.timestamp === "string" ? header.timestamp : new Date(statSync(path).birthtimeMs).toISOString();
          const updatedAt = branch.at(-1)?.timestamp ?? createdAt;
          const cwd = typeof header.cwd === "string" ? header.cwd : "";
          this.records.set(id, { id, path, nativeId: header.id, cwd });
          let reason = this.structuralReadOnlyReason(snap, header, cwd);
          if (!reason && hasTrustRequiringProjectResources(cwd) && trustStore.get(cwd) !== true) {
            reason = "project-untrusted";
          }
          if (
            !reason &&
            (!context.model ||
              !modelRuntime?.getModel(context.model.provider, context.model.modelId) ||
              !modelRuntime.hasConfiguredAuth(context.model.provider))
          ) {
            reason = "provider-unavailable";
          }
          if (!reason) reason = this.ownershipReadOnlyReason(id, path, snap);
          return {
            id,
            title: manager.getSessionName() ?? (firstUser ? textContent((firstUser.message as any).content).text.slice(0, 80) : header.id),
            messageCount,
            ...(cwd && existsSync(cwd) ? { projectPath: cwd } : {}),
            ...(context.model ? { providerId: context.model.provider, modelId: context.model.modelId } : {}),
            mode: "agent" as const,
            thinkingLevel: thinkingLevel(context.thinkingLevel),
            permissionMode: "inherit" as const,
            source: "pi-native" as const,
            capabilities: { canPrompt: !reason, canStop: this.runtimes.get(id)?.isRunning ?? false, canRefresh: true },
            ...(reason ? { readOnlyReason: reason } : {}),
            updatedAt,
            createdAt,
          } as SessionSummary;
        } catch {
          return undefined;
        }
      }),
    );
    return summaries
      .filter((session): session is SessionSummary => Boolean(session))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async search(query: string): Promise<SessionSearchPage> {
    const normalized = query.trim();
    if (!normalized) return { hits: [], nextOffset: null };
    if (normalized.length > 500) throw new Error("query exceeds 500 characters");

    const sessions = await this.list();
    const hits: SessionSearchPage["hits"] = [];
    for (const session of sessions) {
      const record = this.records.get(session.id);
      if (!record) continue;
      try {
        const snapshot = nativePiSnapshot(record.path);
        const entries = parseSessionEntries(snapshot.bytes.toString("utf8"));
        const header = entries.find((entry) => entry.type === "session") as any;
        this.validateIdentity(record, header);
        const manager = SessionManager.inMemory(record.cwd, undefined, entries);
        const messages = visibleMessages(manager).filter(
          (message) =>
            (message.role === "user" || message.role === "assistant") &&
            searchContains(message.content, normalized),
        );
        const metadataMatch =
          searchContains(session.title, normalized) || searchContains(record.cwd, normalized);
        if (!metadataMatch && messages.length === 0) continue;
        hits.push({
          session,
          projectName: null,
          metadataMatch,
          messageCount: messages.length,
          matches: messages
            .sort(
              (left, right) =>
                right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id),
            )
            .slice(0, 2)
            .map((message) => ({
              messageId: message.id,
              role: message.role as "user" | "assistant",
              createdAt: message.createdAt,
              snippet: searchExcerpt(message.content, normalized),
            })),
        });
      } catch {
        // A file changing during discovery is omitted from this read-only
        // projection; the next refresh will retry it from a fresh snapshot.
      }
    }
    hits.sort(
      (left, right) =>
        right.session.updatedAt.localeCompare(left.session.updatedAt) ||
        left.session.id.localeCompare(right.session.id),
    );
    return { hits, nextOffset: null };
  }

  detail(
    id: string,
    options: {
      messageBefore?: number;
      messageAround?: string;
      messageLimit?: number;
      contentLimit?: number;
    } = {},
  ): SessionDetail | null {
    const record = this.record(id);
    const snap = nativePiSnapshot(record.path);
    const entries = parseSessionEntries(snap.bytes.toString("utf8"));
    const header = entries.find((entry) => entry.type === "session") as any;
    this.validateIdentity(record, header);
    const manager = SessionManager.inMemory(record.cwd, undefined, entries);
    const all = visibleMessages(manager);
    const limit = Math.max(1, Math.min(options.messageLimit ?? 100, 500));
    const around = options.messageAround?.trim();
    const aroundIndex = around ? all.findIndex((message) => message.id === around) : -1;
    const start = aroundIndex >= 0
      ? Math.max(0, aroundIndex - Math.floor(limit / 2))
      : Math.max(0, Math.min(options.messageBefore ?? all.length, all.length) - limit);
    const before = aroundIndex >= 0
      ? Math.min(all.length, start + limit)
      : Math.min(options.messageBefore ?? all.length, all.length);
    const messages = all.slice(start, before).map((message) => ({
      ...message,
      content:
        options.contentLimit && message.id !== around
          ? message.content.slice(0, options.contentLimit)
          : message.content,
    }));
    const context = manager.buildSessionContext();
    let reason = this.structuralReadOnlyReason(snap, header, record.cwd);
    if (!reason && hasTrustRequiringProjectResources(record.cwd) && new ProjectTrustStore(this.agentDir).get(record.cwd) !== true) {
      reason = "project-untrusted";
    }
    if (!reason && (!context.model || !this.modelRuntime?.getModel(context.model.provider, context.model.modelId) ||
        !this.modelRuntime.hasConfiguredAuth(context.model.provider))) reason = "provider-unavailable";
    if (!reason) reason = this.ownershipReadOnlyReason(id, record.path, snap);
    return {
      id,
      title: manager.getSessionName() ?? record.nativeId,
      messageCount: all.length,
      ...(record.cwd && existsSync(record.cwd) ? { projectPath: record.cwd } : {}),
      ...(context.model ? { providerId: context.model.provider, modelId: context.model.modelId } : {}),
      mode: "agent",
      thinkingLevel: thinkingLevel(context.thinkingLevel),
      permissionMode: "inherit",
      source: "pi-native",
      capabilities: { canPrompt: !reason, canStop: this.runtimes.get(id)?.isRunning ?? false, canRefresh: true },
      ...(reason ? { readOnlyReason: reason } : {}),
      createdAt: typeof header.timestamp === "string" ? header.timestamp : new Date(snap.mtimeMs).toISOString(),
      updatedAt: manager.getBranch().at(-1)?.timestamp ?? new Date(snap.mtimeMs).toISOString(),
      messages,
      messageStart: start,
      ...(aroundIndex >= 0 ? { messageEnd: before, hasMoreAfter: before < all.length } : {}),
      hasMoreBefore: start > 0,
    } as SessionDetail;
  }

  /**
   * Branch a native session into a new canonical child JSONL file.
   *
   * Branch semantics come from the SDK (`createBranchedSession`) against an
   * in-memory view of the parent bytes, so ancestry, label re-chaining,
   * compaction re-parenting, and unknown entries follow the SDK's own rules
   * without touching the parent file or its live manager. The child is
   * published through an exclusive temporary file plus a same-directory
   * hardlink: a failed fork never exposes a partial child, never overwrites an
   * existing file, and leaves the parent untouched.
   */
  /**
   * Public fork entry point. Every failure, including precheck filesystem
   * errors, leaves as a typed or path-free classified error: raw fs messages
   * can contain absolute paths and must never cross the preload boundary.
   */
  fork(input: { id: string; title?: string; throughMessageId?: string }): SessionDetail {
    try {
      return this.forkInternal(input);
    } catch (error) {
      const code = (error as { errorCode?: string })?.errorCode;
      if (code && NATIVE_FORK_ERROR_CODES.has(code)) throw error;
      // Keep the original (path-bearing) failure for local logs only.
      console.error("[native-pi] fork failed:", error);
      throw Object.assign(new Error("Native Pi fork could not create the child session"), {
        errorCode: "NATIVE_PI_FORK_IO_ERROR",
      });
    }
  }

  private forkInternal(input: { id: string; title?: string; throughMessageId?: string }): SessionDetail {
    const record = this.record(input.id);
    if (this.opening.has(record.id) || this.runtimes.get(record.id)?.isRunning) {
      throw Object.assign(new Error("Native Pi session has an active turn"), { errorCode: "AGENT_BUSY" });
    }
    const before = nativePiSnapshot(record.path);
    const entries = parseSessionEntries(before.bytes.toString("utf8"));
    const header = entries.find((entry) => entry.type === "session") as any;
    this.validateIdentity(record, header);
    const structuralReason = this.structuralReadOnlyReason(before, header, record.cwd);
    if (structuralReason) {
      throw Object.assign(new Error(`Native Pi session is read-only: ${structuralReason}`), {
        errorCode: `NATIVE_PI_${structuralReason.toUpperCase().replaceAll("-", "_")}`,
      });
    }
    // The same ownership state list()/detail() report also gates a fork. An
    // owned idle runtime keeps its lease (it is ours and validated below); any
    // other live, remote, or malformed writer refuses. A dead local owner with
    // unchanged/complete append-only bytes stays reclaimable.
    const ownedRuntime = this.runtimes.get(record.id);
    const ownership = this.ownershipReadOnlyReason(record.id, record.path, before);
    if (ownership === "changed-externally") {
      throw Object.assign(new Error("Native Pi session changed in another client; reload before continuing"), {
        errorCode: "NATIVE_PI_SESSION_CHANGED",
      });
    }
    if (ownership === "busy") {
      throw Object.assign(new Error("Native Pi session is already open for writing"), {
        errorCode: "NATIVE_PI_SESSION_BUSY",
      });
    }
    const requestedTitle = typeof input.title === "string" ? input.title.trim().replace(/\s+/g, " ").slice(0, 200) : "";
    const throughMessageId = typeof input.throughMessageId === "string" ? input.throughMessageId.trim() : "";

    const branch = SessionManager.inMemory(record.cwd, undefined, entries);
    let anchorId: string | null;
    if (throughMessageId) {
      const anchor = branch.getEntry(throughMessageId);
      if (!anchor || anchor.type !== "message" || !branch.getBranch().some((entry) => entry.id === throughMessageId)) {
        throw Object.assign(new Error("Fork anchor is not a message on the active branch"), { errorCode: "INVALID_ARGUMENT" });
      }
      anchorId = throughMessageId;
    } else {
      anchorId = branch.getLeafId();
      if (!anchorId) {
        throw Object.assign(new Error("Native Pi session has no branch to fork"), { errorCode: "INVALID_ARGUMENT" });
      }
    }
    const parentContext = branch.buildSessionContext();
    const firstUser = branch.getBranch().find(
      (entry) => entry.type === "message" && (entry as SessionMessageEntry).message.role === "user",
    ) as SessionMessageEntry | undefined;
    const defaultTitle = branch.getSessionName() ||
      (firstUser ? textContent((firstUser.message as { content?: unknown }).content).text.trim().slice(0, 80) : "") ||
      record.nativeId;

    // Without an owned runtime, hold a short-lived lease over the exact source
    // snapshot so another Desktop writer cannot interleave while the child is
    // built. An owned runtime validates its own lease instead of stealing it.
    const sourceLease = ownedRuntime ? undefined : NativePiSessionLease.acquire(record.path, before);
    let staging: CompleteOwnedFile | undefined;
    let published: CompleteOwnedFile | undefined;
    try {
      const directory = realpathSync(dirname(record.path));
      const root = realpathSync(this.root);
      if (!inside(root, directory)) {
        throw Object.assign(new Error("Native Pi session path is outside the allowed root"), {
          errorCode: "PERMISSION_DENIED",
        });
      }
      branch.createBranchedSession(anchorId);
      const childId = branch.getSessionId();
      const branchedEntries = branch.getBranch();
      const branchContext = branch.buildSessionContext();
      if (!branchContext.model && parentContext.model) {
        // A first-user anchor carries no model entry. Continue from the source
        // session's own saved model; never a Desktop provider or auth fallback.
        branch.appendModelChange(parentContext.model.provider, parentContext.model.modelId);
      }
      if (!branchedEntries.some((entry) => entry.type === "thinking_level_change") && parentContext.thinkingLevel !== "off") {
        // Only when the anchored branch saved no thinking level at all: an
        // explicit "off" on the branch stays meaningful.
        branch.appendThinkingLevelChange(parentContext.thinkingLevel);
      }
      branch.appendSessionInfo(requestedTitle || defaultTitle);
      // Context is read after the metadata appends so the child reports the
      // fallback model/thinking it actually carries.
      const childContext = branch.buildSessionContext();
      const childHeader = branch.getHeader();
      if (!childHeader) throw new Error("Native Pi fork produced no session header");
      // parentSession is the canonical source path; it stays inside the file
      // and never crosses the preload boundary.
      const fileEntries = [{ ...childHeader, parentSession: record.path }, ...branch.getEntries()];
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const childPath = join(directory, `${stamp}_${childId}.jsonl`);
      const tempPath = join(directory, `.${childId}.${randomUUID()}.tmp`);
      staging = stageNativeBranchFile(tempPath, fileEntries);
      // Re-check the source right before publication: byte drift, a replaced
      // canonical path/root, or a turn that started while this child was being
      // built fails the fork closed.
      if (this.opening.has(record.id) || this.runtimes.get(record.id)?.isRunning) {
        throw Object.assign(new Error("Native Pi session has an active turn"), { errorCode: "AGENT_BUSY" });
      }
      if (ownedRuntime) ownedRuntime.assertUnchanged();
      else sourceLease?.assertUnchanged();
      const afterSource = nativePiSnapshot(record.path);
      if (
        afterSource.dev !== before.dev ||
        afterSource.ino !== before.ino ||
        afterSource.hash !== before.hash ||
        realpathSync(record.path) !== record.path ||
        realpathSync(dirname(record.path)) !== directory
      ) {
        throw Object.assign(new Error("Native Pi session changed while forking; reload before continuing"), {
          errorCode: "NATIVE_PI_SESSION_CHANGED",
        });
      }
      // The staged payload is the exact bytes this fork intends to publish.
      // Verify it before the no-clobber link so an in-place alteration (same
      // inode, same size, same header id) is refused, not returned. Uncertain
      // bytes stay on disk; the cleanup guards refuse to delete them.
      if (!ownsCompleteFile(staging)) {
        throw Object.assign(new Error("Native Pi session changed while forking; reload before continuing"), {
          errorCode: "NATIVE_PI_SESSION_CHANGED",
        });
      }
      // No-clobber publication: a foreign file at the final path makes link
      // fail and is never removed. Only the exact published inode is tracked.
      linkSync(staging.path, childPath);
      published = {
        path: childPath,
        dev: staging.dev,
        ino: staging.ino,
        size: staging.size,
        hash: staging.hash,
      };
      removeOwnedCompleteFile(staging);
      staging = undefined;
      // Integrity gate after the link and before any projection or registry
      // write: the final child must still be the published inode with exactly
      // the staged bytes (dev/ino/size/hash). A mismatch fails closed and
      // leaves the altered file untouched.
      const childSnapshot = nativePiSnapshot(childPath);
      if (
        childSnapshot.dev !== published.dev ||
        childSnapshot.ino !== published.ino ||
        childSnapshot.size !== published.size ||
        childSnapshot.hash !== published.hash
      ) {
        throw Object.assign(new Error("Native Pi session changed while forking; reload before continuing"), {
          errorCode: "NATIVE_PI_SESSION_CHANGED",
        });
      }
      const writtenHeader = parseSessionEntries(childSnapshot.bytes.toString("utf8"))
        .find((entry) => entry.type === "session") as any;
      if (!writtenHeader || writtenHeader.id !== childId || childSnapshot.bytes.at(-1) !== 0x0a) {
        throw new Error("Native Pi fork produced an invalid session file");
      }
      const resolvedChild = realpathSync(childPath);
      if (resolvedChild !== childPath || !inside(root, resolvedChild)) {
        throw Object.assign(new Error("Native Pi fork path is outside the session root"), {
          errorCode: "PERMISSION_DENIED",
        });
      }
      const childCwd = typeof writtenHeader.cwd === "string" ? writtenHeader.cwd : record.cwd;
      const allMessages = visibleMessages(branch);
      const childRecord = {
        id: stableId(resolvedChild, childId),
        path: resolvedChild,
        nativeId: childId,
        cwd: childCwd,
      };
      const childDetail = this.projectChildDetail(
        childRecord,
        childSnapshot,
        writtenHeader,
        childContext,
        allMessages,
        branch.getSessionName() ?? record.nativeId,
      );
      this.records.set(childRecord.id, childRecord);
      return childDetail;
    } catch (error) {
      if (staging) removeOwnedCompleteFile(staging);
      if (published) removeOwnedCompleteFile(published);
      throw error;
    } finally {
      sourceLease?.release();
    }
  }

  /**
   * Full fork response: the child's whole projected transcript (fork parity
   * with the Desktop host contract), independent of general detail paging.
   * ModelRuntime is read from the already initialized snapshot; a fork never
   * performs model network initialization.
   */
  private projectChildDetail(
    record: NativeSessionRecord,
    snap: NativePiSnapshot,
    header: any,
    context: { model?: { provider: string; modelId: string } | null; thinkingLevel: string },
    messages: UiMessage[],
    title: string,
  ): SessionDetail {
    let reason = this.structuralReadOnlyReason(snap, header, record.cwd);
    if (!reason && hasTrustRequiringProjectResources(record.cwd) && new ProjectTrustStore(this.agentDir).get(record.cwd) !== true) {
      reason = "project-untrusted";
    }
    if (
      !reason &&
      (!context.model ||
        !this.modelRuntime?.getModel(context.model.provider, context.model.modelId) ||
        !this.modelRuntime.hasConfiguredAuth(context.model.provider))
    ) {
      reason = "provider-unavailable";
    }
    if (!reason && !NativePiSessionLease.canAcquire(record.path, snap)) {
      reason = "busy";
    }
    return {
      id: record.id,
      title,
      messageCount: messages.length,
      ...(record.cwd && existsSync(record.cwd) ? { projectPath: record.cwd } : {}),
      ...(context.model ? { providerId: context.model.provider, modelId: context.model.modelId } : {}),
      mode: "agent",
      thinkingLevel: thinkingLevel(context.thinkingLevel),
      permissionMode: "inherit",
      source: "pi-native",
      capabilities: { canPrompt: !reason, canStop: false, canRefresh: true },
      ...(reason ? { readOnlyReason: reason } : {}),
      createdAt: typeof header.timestamp === "string" ? header.timestamp : new Date(snap.mtimeMs).toISOString(),
      updatedAt: new Date(snap.mtimeMs).toISOString(),
      messages,
      messageStart: 0,
      hasMoreBefore: false,
    } as SessionDetail;
  }

  async prompt(id: string, content: string, notify: NativePiRuntimeNotifier, userMessageId?: string): Promise<{ accepted: true; turnId: string }> {
    let runtime = this.runtimes.get(id);
    if (runtime?.isRunning || this.opening.has(id)) {
      throw Object.assign(new Error("session already has an active turn"), { errorCode: "AGENT_BUSY" });
    }
    if (!runtime) {
      this.opening.add(id);
      try { runtime = await this.openRuntime(id, notify); }
      finally { this.opening.delete(id); }
    }
    const turnId = randomUUID();
    void runtime.prompt(content, turnId, userMessageId).catch((error) => {
      notify({
        sessionId: id,
        turnId,
        ts: Date.now(),
        event: {
          type: "error",
          error: { code: (error as any)?.errorCode ?? "NATIVE_PI_RUNTIME_ERROR", message: error instanceof Error ? error.message : String(error), retriable: false },
        },
      });
      runtime?.dispose();
      this.runtimes.delete(id);
    });
    return { accepted: true, turnId };
  }

  status(id: string): { status: { sessionId: string; isRunning: boolean; pendingToolConfirmations: number } } {
    return {
      status: {
        sessionId: id,
        isRunning: this.runtimes.get(id)?.isRunning ?? false,
        pendingToolConfirmations: 0,
      },
    };
  }

  async abort(id: string): Promise<{ ok: boolean }> {
    await this.runtimes.get(id)?.abort();
    return { ok: true };
  }

  dispose(id: string): void {
    this.runtimes.get(id)?.dispose();
    this.runtimes.delete(id);
  }

  disposeAll(): void {
    for (const runtime of this.runtimes.values()) runtime.dispose();
    this.runtimes.clear();
  }

  private ownershipReadOnlyReason(id: string, path: string, snap: NativePiSnapshot): NativePiReadOnlyReason | undefined {
    const runtime = this.runtimes.get(id);
    if (runtime) {
      try { runtime.assertUnchanged(); }
      catch { return "changed-externally"; }
      return runtime.isRunning ? "busy" : undefined;
    }
    return this.opening.has(id) || !NativePiSessionLease.canAcquire(path, snap) ? "busy" : undefined;
  }

  private record(id: string): NativeSessionRecord {
    if (!id.startsWith(NATIVE_PI_SESSION_PREFIX)) throw new Error("not a native Pi session");
    const record = this.records.get(id);
    if (!record) {
      throw Object.assign(new Error("Native Pi session not found; refresh sessions and try again"), { errorCode: "NOT_FOUND" });
    }
    const root = realpathSync(this.root);
    const path = realpathSync(record.path);
    if (!inside(root, path) || lstatSync(path).isSymbolicLink()) {
      throw Object.assign(new Error("Native Pi session path is outside the allowed root"), { errorCode: "PERMISSION_DENIED" });
    }
    return { ...record, path };
  }

  private validateIdentity(record: NativeSessionRecord, header: any): void {
    if (!header || header.type !== "session" || header.id !== record.nativeId || header.cwd !== record.cwd) {
      throw Object.assign(new Error("Native Pi session identity changed; refresh before continuing"), { errorCode: "NATIVE_PI_SESSION_CHANGED" });
    }
  }

  private structuralReadOnlyReason(snap: NativePiSnapshot, header: any, cwd: string): NativePiReadOnlyReason | undefined {
    if (!snap.bytes.length || !snap.validJsonl || !header || header.type !== "session") {
      return "invalid-session";
    }
    if (header.version !== CURRENT_SESSION_VERSION) return "legacy-format";
    if (snap.bytes.at(-1) !== 0x0a) return "missing-trailing-newline";
    if (!cwd || !existsSync(cwd) || !statSync(cwd).isDirectory()) return "missing-cwd";
    return undefined;
  }

  private async openRuntime(id: string, notify: NativePiRuntimeNotifier): Promise<NativePiRuntime> {
    const record = this.record(id);
    const snap = nativePiSnapshot(record.path);
    const entries = parseSessionEntries(snap.bytes.toString("utf8"));
    const header = entries.find((entry) => entry.type === "session") as any;
    this.validateIdentity(record, header);
    const structuralReason = this.structuralReadOnlyReason(snap, header, record.cwd);
    if (structuralReason) throw Object.assign(new Error(`Native Pi session is read-only: ${structuralReason}`), { errorCode: `NATIVE_PI_${structuralReason.toUpperCase().replaceAll("-", "_")}` });

    const trustStore = new ProjectTrustStore(this.agentDir);
    if (hasTrustRequiringProjectResources(record.cwd) && trustStore.get(record.cwd) !== true) {
      throw Object.assign(new Error("Native Pi project resources are not trusted"), { errorCode: "NATIVE_PI_PROJECT_UNTRUSTED" });
    }
    const contextManager = SessionManager.inMemory(record.cwd, undefined, entries);
    const context = contextManager.buildSessionContext();
    if (!context.model) {
      throw Object.assign(new Error("Native Pi session has no saved provider/model"), { errorCode: "NATIVE_PI_PROVIDER_UNAVAILABLE" });
    }
    const modelRuntime = await this.modelRuntimeFactory();
    const model = modelRuntime.getModel(context.model.provider, context.model.modelId);
    if (!model || !modelRuntime.hasConfiguredAuth(context.model.provider)) {
      throw Object.assign(new Error(`Native Pi provider is unavailable: ${context.model.provider}/${context.model.modelId}`), { errorCode: "NATIVE_PI_PROVIDER_UNAVAILABLE" });
    }

    const lease = NativePiSessionLease.acquire(record.path, snap);
    let session: AgentSession | undefined;
    let runtime: NativePiRuntime | undefined;
    try {
      lease.assertUnchanged();
      const manager = SessionManager.open(record.path);
      this.guardManagerWrites(manager, lease, (_message, entryId) => runtime?.rememberMessage(entryId));
      const settingsManager = SettingsManager.create(record.cwd, this.agentDir, { projectTrusted: true });
      const resourceLoader = new DefaultResourceLoader({ cwd: record.cwd, agentDir: this.agentDir, settingsManager });
      await resourceLoader.reload();
      const created = await createAgentSession({
        cwd: record.cwd,
        agentDir: this.agentDir,
        sessionManager: manager,
        settingsManager,
        resourceLoader,
        modelRuntime,
        model,
        noTools: "all",
        thinkingLevel: thinkingLevel(context.thinkingLevel),
      });
      // The persistent manager has already parsed the complete native branch;
      // AgentSession owns all later appends to that same file.
      session = created.session;
      runtime = new NativePiRuntime(id, session, lease, notify);
      const unsupported = async (): Promise<never> => {
        throw Object.assign(new Error("Native Pi session control is unsupported"), { errorCode: "NATIVE_PI_UNSUPPORTED" });
      };
      const startupErrors = created.extensionsResult.errors.map((error) => error.error);
      let binding = true;
      // createAgentSession has already wired extensionsResult.runtime. Omitting
      // uiContext selects the SDK headless UI and correctly reports hasUI=false.
      await session.bindExtensions({
        mode: "print",
        uiContext: undefined,
        commandContextActions: {
          waitForIdle: () => created.session.waitForIdle(),
          newSession: unsupported, fork: unsupported, navigateTree: unsupported,
          switchSession: unsupported, reload: unsupported,
        },
        abortHandler: () => { void created.session.abort(); },
        shutdownHandler: () => { throw new Error("Native Pi shutdown is unsupported"); },
        onError: (error) => {
          if (binding) startupErrors.push(error.error);
          else notify({ sessionId: id, ts: Date.now(), event: { type: "message_end", message: {
            id: randomUUID(), role: "system", status: "error", createdAt: new Date().toISOString(),
            content: `Native Pi extension ${error.extensionPath} (${error.event}): ${error.error}`,
          } } });
        },
      });
      binding = false;
      if (startupErrors.length) throw new Error(`Native Pi extension startup failed: ${startupErrors.join("; ")}`);
      this.runtimes.set(id, runtime);
      return runtime;
    } catch (error) {
      if (runtime) runtime.dispose();
      else { session?.dispose(); lease.release(); }
      this.runtimes.delete(id);
      throw error;
    }
  }

  private guardManagerWrites(
    manager: SessionManager,
    lease: NativePiSessionLease,
    onMessage: (message: object, entryId: string) => void,
  ): void {
    guardNativePiSessionManager(manager, lease, onMessage);
  }
}
