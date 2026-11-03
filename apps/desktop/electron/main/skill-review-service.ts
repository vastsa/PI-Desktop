/**
 * The one place that actually calls a model to review a finished turn for
 * skill-worthy material (ADR 0377).
 *
 * This replaces the bundled `cn.star.skill-learning` plugin. Same shape as the
 * retired memory-extraction service had on purpose: fire-and-forget after the
 * turn has already finished, one pass per session at a time, every failure a log
 * line. Memory no longer works that way (ADR 0378) — the agent writes its own
 * notes through the `memory` tool — but skill review still needs a pass over the
 * finished turn, because what a session taught is only visible in hindsight.
 *
 * The plugin owned its own skill store on disk; core already has the CRUD
 * surface, so this service only ever talks to `skills.*` RPCs. Nothing here
 * writes files.
 *
 * Rules:
 *
 * - **Opt-out, not opt-in.** Skill learning is a core capability the user asked
 *   for, so it runs by default and `skillReviewAfterTurn: false` turns it off.
 * - **Cooldown per session.** A burst of tool-using turns must not spend a
 *   completion each; `skillReviewMinIntervalSec` (default 120) is the floor.
 * - **Three tool calls is the gate.** A one-command turn teaches nothing, but a
 *   typical real task here is 3-6 calls; a higher bar means the library never
 *   grows. `skillReviewAfterToolCalls` overrides it.
 * - **Skip is the normal answer.** Most turns teach nothing; the prompt says so
 *   and an empty decision costs nothing but the completion.
 * - **Never fails a turn.** The turn is already persisted when this runs.
 */
import {
  SKILL_REVIEW_SYSTEM,
  buildSkillReviewUser,
  completionText,
  readSkillReview,
  shrinkReviewUser,
  splitSkillDocument,
  type SkillCatalogEntry,
  type SkillReviewDecision,
  type SkillReviewOp,
  type SkillReviewSnapshot,
} from "@pi-desktop/agent-runtime";
import type { AppSettings } from "@pi-desktop/shared";
import { OAUTH_AUTH_KIND, type VendorOAuth } from "./oauth";
import { pluginCompleteContext } from "./plugin-agent-complete";
import { completeOneShot } from "@pi-desktop/agent-runtime";

const REVIEW_TIMEOUT_MS = 60_000;
const MAX_SKILL_BODIES = 6;
const DEFAULT_MIN_INTERVAL_SEC = 120;
/**
 * Three tool calls is the floor: a one-command turn teaches nothing reusable,
 * but a typical real task in this app is 3-6 calls, so a higher gate would mean
 * the library almost never grows.
 */
const DEFAULT_MIN_TOOL_CALLS = 3;

type HostLike = {
  call: <T = unknown>(method: string, params?: unknown) => Promise<T>;
};

type SessionMessage = {
  role?: string;
  content?: unknown;
  toolName?: string;
};

type SessionLike = {
  id?: string;
  projectPath?: string | null;
  /**
   * The provider/model this session runs on. The review completion must use the
   * session's own pair: a session can point at a different provider than the
   * global default, and using the default spends the completion against a
   * provider that may reject it outright.
   */
  providerId?: string;
  modelId?: string;
  messages?: SessionMessage[];
};

type SkillRecord = {
  id?: string;
  name?: string;
  description?: string;
};

export type SkillReviewDependencies = {
  settings: () => Promise<AppSettings>;
  session: (id: string) => Promise<SessionLike | undefined>;
  resolveLaunch: (
    sessionId: string,
    session: Record<string, unknown>,
    settings: AppSettings,
    options: Record<string, unknown>,
  ) => Promise<any>;
  vendorOAuth: VendorOAuth;
  host: () => HostLike | null;
  logger: {
    app: (category: string, level: string, event: string, data?: unknown) => void;
  };
  /** Injectable for tests; defaults to the runtime's one-shot completion. */
  complete?: typeof completeOneShot;
  /** Injectable clock for the cooldown, so tests do not sleep. */
  now?: () => number;
  /**
   * Called after a review actually changed the library. The caller turns this
   * into a user-visible notice; without it a background pass is invisible.
   */
  onReviewed?: (summary: {
    sessionId: string;
    ops: Array<{ action: string; name: string }>;
  }) => void;
};

export type SkillReviewRequest = {
  sessionId: string;
  /** False for chat-only turns, which rarely produce a reusable procedure. */
  usedTools: boolean;
  /** How many tools ran this turn; the review gate uses it. */
  toolCallCount?: number;
  /** Only Agent turns are reviewed; Plan/Goal have a denial-only tool set. */
  mode?: string;
};

function messageText(message: SessionMessage): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        const record = part as Record<string, unknown> | null;
        return (record?.text as string) || "";
      })
      .join("");
  }
  return "";
}

function transcriptOf(session: SessionLike | undefined): SkillReviewSnapshot["messages"] {
  const out: SkillReviewSnapshot["messages"] = [];
  for (const message of session?.messages ?? []) {
    const role =
      message?.role === "assistant" ? "assistant" : message?.role === "user" ? "user" : null;
    if (!role) continue;
    const content = messageText(message).trim();
    if (!content) continue;
    out.push({ role, content, toolName: message.toolName });
  }
  return out;
}

export function createSkillReviewService(deps: SkillReviewDependencies) {
  const complete = deps.complete ?? completeOneShot;
  const now = deps.now ?? Date.now;
  const lastReviewAt = new Map<string, number>();
  const running = new Set<string>();

  async function learnedCatalog(host: HostLike): Promise<{
    catalog: SkillCatalogEntry[];
    bodies: Array<{ name: string; content: string }>;
  }> {
    let skills: SkillRecord[] = [];
    try {
      const listed = await host.call<{ skills?: SkillRecord[] }>("skills.list", {
        level: "global",
      });
      skills = listed?.skills ?? [];
    } catch (error) {
      deps.logger.app("skill-review", "warn", "skill catalog read failed", {
        data: String(error),
      });
      return { catalog: [], bodies: [] };
    }

    const catalog: SkillCatalogEntry[] = skills
      .filter((skill) => skill?.name)
      .map((skill) => ({ name: String(skill.name), description: skill.description }));

    const bodies: Array<{ name: string; content: string }> = [];
    for (const skill of skills.slice(0, MAX_SKILL_BODIES)) {
      if (!skill?.id || !skill?.name) continue;
      try {
        const read = await host.call<{ body?: string | null }>("skills.read", {
          id: skill.id,
          level: "global",
        });
        if (read?.body) bodies.push({ name: String(skill.name), content: read.body });
      } catch {
        // A single unreadable skill must not sink the whole review.
      }
    }
    return { catalog, bodies };
  }

  async function applyOp(host: HostLike, op: SkillReviewOp, catalog: SkillRecord[]): Promise<boolean> {
    if (op.action === "create") {
      const parts = splitSkillDocument(op.content, op.name);
      const name = parts.name || op.name;
      // Directory shape: `<id>/SKILL.md`, so the skill can own references/ later.
      await host.call("skills.create", {
        level: "global",
        shape: "dir",
        name,
        description: parts.description,
        body: parts.body,
      });
      return true;
    }

    const target = catalog.find(
      (skill) => skill.name && String(skill.name).toLowerCase() === op.name.toLowerCase(),
    );
    if (!target?.id) return false;

    if (op.action === "write_file") {
      // Appends a references/<topic>.md beside the skill. No document rewrite.
      await host.call("skills.writeFile", {
        id: target.id,
        path: op.file_path,
        content: op.content,
      });
      return true;
    }

    // patch: read -> replace -> update. Core has no patch RPC, and doing the
    // replacement here keeps `skills.update` the only writer of SKILL.md.
    const read = await host.call<{ body?: string | null }>("skills.read", {
      id: target.id,
      level: "global",
    });
    const body = read?.body ?? "";
    if (!body.includes(op.old_string)) return false;
    const next = body.replace(op.old_string, op.new_string);
    await host.call("skills.update", { id: target.id, level: "global", body: next });
    return true;
  }

  async function run(request: SkillReviewRequest): Promise<number> {
    /**
     * Every early exit is logged. Without this a skipped review and a review
     * that never fired look identical in the log, which makes the feature
     * impossible to diagnose from a real session.
     */
    const skip = (reason: string, extra?: Record<string, unknown>): number => {
      deps.logger.app("skill-review", "info", "skill review skipped", {
        sessionId: request.sessionId,
        data: { reason, toolCallCount: request.toolCallCount ?? 0, ...extra },
      });
      return 0;
    };

    if (!request.usedTools) return skip("no-tools");
    if (request.mode && request.mode !== "agent") return skip("mode", { mode: request.mode });
    const host = deps.host();
    if (!host) return skip("host-unavailable");

    const settings = await deps.settings();
    // Absent means on: this is a core capability, not an opt-in experiment.
    const enabled = (settings as Record<string, unknown>).skillReviewAfterTurn !== false;
    if (!enabled) return skip("disabled-by-setting");

    const minToolCalls =
      Number((settings as Record<string, unknown>).skillReviewAfterToolCalls) ||
      DEFAULT_MIN_TOOL_CALLS;
    const toolCallCount = request.toolCallCount ?? 0;
    if (toolCallCount < minToolCalls) return skip("too-few-tools", { min: minToolCalls });

    const minIntervalSec =
      Number((settings as Record<string, unknown>).skillReviewMinIntervalSec) ||
      DEFAULT_MIN_INTERVAL_SEC;
    const last = lastReviewAt.get(request.sessionId) ?? 0;
    if (now() - last < minIntervalSec * 1000) {
      return skip("cooldown", { sinceLastSec: Math.round((now() - last) / 1000) });
    }

    const session = await deps.session(request.sessionId);
    const messages = transcriptOf(session);
    if (messages.length === 0) return skip("empty-transcript");

    // The session's own provider first; the global default is only a fallback.
    const providerId = session?.providerId || settings.defaultProviderId;
    const modelId = session?.modelId || settings.defaultModelId;
    if (!providerId || !modelId) return skip("no-model", { sessionPinned: false });

    const { catalog, bodies } = await learnedCatalog(host);

    const launch = await deps.resolveLaunch(
      request.sessionId,
      (session ?? {}) as Record<string, unknown>,
      settings,
      { mode: "agent", providerId, modelId, thinkingLevel: "off" },
    );
    const provider = {
      ...launch.sidecarParams.provider,
      ...(launch.sidecarParams.provider.authKind === OAUTH_AUTH_KIND
        ? { resolveAuth: () => deps.vendorOAuth.resolveAuth(launch.providerId) }
        : {}),
    };

    const snapshot: SkillReviewSnapshot = {
      workspace: session?.projectPath ?? undefined,
      toolCallCount,
      learnedCatalog: catalog,
      skillBodies: bodies,
      messages,
    };
    const user = buildSkillReviewUser(snapshot);

    /** One review completion. Kept separate so a malformed answer can retry. */
    const completeOnce = async (userText: string): Promise<string> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REVIEW_TIMEOUT_MS);
      try {
        const context = pluginCompleteContext({
          modelKey: `${providerId}/${modelId}`,
          thinkingLevel: "off",
          system: SKILL_REVIEW_SYSTEM,
          messages: [{ role: "user", content: userText }],
        });
        const result = await complete(provider, context, launch.sidecarParams.thinkingLevel, {
          signal: controller.signal,
          sessionId: request.sessionId,
          emptyErrorCode: "INVALID_ARGUMENT",
          emptyErrorMessage: "The model returned no text.",
        });
        return completionText(result);
      } finally {
        clearTimeout(timer);
      }
    };

    let text = await completeOnce(user);
    let decision = readSkillReview(text);
    if (!decision) {
      // One retry with the model's own words fed back. A prose answer is the
      // single most common failure here, and a second, blunter instruction
      // usually lands; giving up on the first miss throws away a paid call.
      deps.logger.app("skill-review", "info", "skill review retrying", {
        sessionId: request.sessionId,
        data: { reason: "no-json", sample: text.slice(0, 200) },
      });
      const retryUser = `${user}\n\n---\n你的上一条回复不是 JSON：\n${shrinkReviewUser(text, 2000)}\n\n现在只输出一个 JSON 对象，不要解释、不要 markdown 围栏。没有值得沉淀的内容就输出 {"decision":"skip","reason":"...","ops":[]}。`;
      text = await completeOnce(retryUser);
      decision = readSkillReview(text);
    }

    // Cooldown starts now, whether or not the model decided to write anything:
    // the cost was the completion, and a skip must not invite a retry loop.
    lastReviewAt.set(request.sessionId, now());

    if (!decision) {
      deps.logger.app("skill-review", "warn", "skill review failed", {
        sessionId: request.sessionId,
        data: { reason: "no-json-after-retry", sample: text.slice(0, 300) },
      });
      return 0;
    }
    if (decision.decision === "skip" || decision.ops.length === 0) {
      deps.logger.app("skill-review", "info", "skill review skipped", {
        sessionId: request.sessionId,
        data: { reason: decision.reason ?? "no ops", toolCallCount },
      });
      return 0;
    }

    // The catalog may have changed between read and write; re-read the ids.
    const listed = await host.call<{ skills?: SkillRecord[] }>("skills.list", {
      level: "global",
    });
    const records = listed?.skills ?? [];

    const appliedOps: Array<{ action: string; name: string }> = [];
    for (const op of decision.ops) {
      try {
        if (await applyOp(host, op, records)) {
          appliedOps.push({ action: op.action, name: op.name });
        }
      } catch (error) {
        deps.logger.app("skill-review", "warn", "skill review op failed", {
          sessionId: request.sessionId,
          data: { op: op.action, name: op.name, error: String(error) },
        });
      }
    }

    deps.logger.app("skill-review", "info", "skill review applied", {
      sessionId: request.sessionId,
      data: { ops: decision.ops.length, applied: appliedOps.length, reason: decision.reason },
    });
    // Surface it in the UI: a background pass the user never sees is
    // indistinguishable from one that did not run.
    if (appliedOps.length > 0) deps.onReviewed?.({ sessionId: request.sessionId, ops: appliedOps });
    return appliedOps.length;
  }

  return {
    /** Fire and forget: the turn is already persisted when this runs. */
    schedule(request: SkillReviewRequest): void {
      if (!request.usedTools) return;
      if (running.has(request.sessionId)) return;
      running.add(request.sessionId);
      void run(request)
        .catch((error: unknown) => {
          deps.logger.app("skill-review", "warn", "skill review failed", {
            sessionId: request.sessionId,
            data: String(error),
          });
        })
        .finally(() => running.delete(request.sessionId));
    },
    /** Exposed so a test or a future "review now" command can await the pass. */
    run,
  };
}
