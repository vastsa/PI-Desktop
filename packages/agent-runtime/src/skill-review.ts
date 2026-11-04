/**
 * Skill learning review — the in-core replacement for the
 * `cn.star.skill-learning` plugin (ADR 0377).
 *
 * The plugin used to own this loop. Keeping it in core means the capability
 * ships with the app instead of depending on a bundled plugin the user has to
 * trust and can accidentally disable.
 *
 * Division of labour, deliberately the same as memory extraction:
 *
 * - **This module is pure.** Prompts, snapshot packing, output parsing and
 *   normalisation only. No IO, no host calls, so `vitest` can cover it.
 * - **The host owns storage.** A `create` op becomes `skills.create`; a `patch`
 *   op becomes `skills.read` + string replacement + `skills.update`. Core
 *   already has the whole skill CRUD surface, so no second file layout is
 *   invented here.
 *
 * One thing the plugin did that this module cannot do through RPC, and does
 * not pretend to:
 *
 * - The plugin's "thin draft rejected" guard. Core does not validate authoring
 *   quality, so the guide in the system prompt is the only lever. A model that
 *   ignores it writes a thin skill; that is a prompt problem, not a store one.
 *
 * Resource writes are no longer in that list: `write_file` maps to
 * `skills.writeFile`, which writes `references/<topic>.md` beside the skill's
 * `SKILL.md` (ADR 0377 added that write path).
 */

/** Authoring bar, shared by the review prompt and the `/learn` command. */
export const SKILL_AUTHORING_GUIDE = `SKILL.md quality bar:

Frontmatter:
- name: lowercase-hyphenated, matches the directory.
- description: ONE sentence, <=120 characters, ends with a period. State when to use it, not the implementation.

Required body sections (Chinese headings are fine: 何时使用 / 工作流程 / 陷阱 / 验证):
1. Title + 2-3 sentence intro: what it does, what it does NOT do.
2. ## When to Use — concrete trigger phrases AND a Do-not-use list.
3. ## Procedure — numbered steps. Commands, URLs, flags and error strings MUST be copied verbatim from the session. Never invent flags.
4. ## Pitfalls — things that look like success but are not (for example an HTTP 200 HTML body), plus the correction.
5. ## Verification — one checkable criterion (file exists, UI shows X, command output contains Y).

Depth:
- Capture decision rules, not a recap of this afternoon. Class-level names (openai-compatible-base-url), never fix-issue-12.
- Frame tools as PI: read, write, edit, bash, grep, glob.
- Prefer patching an existing skill over creating a near-duplicate.`;

/** System prompt for one review pass. Output must be JSON only. */
export const SKILL_REVIEW_SYSTEM = `You review one finished PI-Desktop agent turn and decide whether the learned skill library should change.

Return ONLY JSON, no markdown fences:
{
  "decision": "skip" | "update",
  "reason": "short reason",
  "ops": []
}

ops items:
- {"action":"write_file","name":"existing-skill-name","file_path":"references/topic.md","content":"<markdown>"}
- {"action":"patch","name":"existing-skill-name","old_string":"exact unique substring of that skill's body","new_string":"replacement"}
- {"action":"create","name":"class-level-name","content":"<full SKILL.md including frontmatter>"}

Choose the cheapest op that records what you learned:
- write_file adds a new references/<topic>.md beside the skill. Prefer this for anything that is a self-contained lesson: a pitfall, a recipe, a failure mode, a table. It does not touch the existing document, so it is always safe.
- patch corrects existing text in SKILL.md. Only when the existing text is wrong or incomplete.
- create starts a new skill. Only when no managed skill below covers this class of work.

${SKILL_AUTHORING_GUIDE}

Review rules:
- A session that taught something reusable MUST produce at least one op. Only answer skip when the turn really carried nothing reusable: small talk, a one-off lookup, an unresolved failure, or work already covered verbatim by a skill below.
- Reading repository state, answering a question, or running a few read-only commands is NOT automatically a skip — if the turn established a decision rule, a command that finally worked, an ordering constraint, or a trap, record it.
- Never record "tool X is broken", and never save a failed attempt sequence as a recommended practice.
- Distill exact commands, status codes, paths and decision rules from the transcript. Do not generalise away the numbers.
- At most 5 ops. An update with empty ops is invalid — use skip instead.
- Do not reference skills that are not in the managed catalog below.`;

/** Prompt body for an explicit user-driven `/learn` request. */
export const SKILL_LEARN_PREFIX = `[skill-learning /learn]
The user wants you to distill a reusable skill from what they described below.

The request may mix SOURCES (directories, URLs, "what we just did") and REQUIREMENTS (focus, skip). Honour both.

Do this:
1. Gather sources with read / grep / glob / bash. Do not invent flags or APIs you did not see.
2. If an existing skill already covers this class, patch it after reading it.
3. Otherwise create a class-level skill.
4. Author to the quality bar below. Thin summaries are a waste of the turn — write the full sections.
5. Large prose sources: keep SKILL.md as a distilled index of rules and tables, not a lossy recap.

${SKILL_AUTHORING_GUIDE}

User request:
`;

export type SkillReviewOp =
  | { action: "create"; name: string; content: string }
  | { action: "patch"; name: string; old_string: string; new_string: string }
  | { action: "write_file"; name: string; file_path: string; content: string };

export type SkillReviewDecision = {
  decision: "skip" | "update";
  reason?: string;
  ops: SkillReviewOp[];
};

export type SkillCatalogEntry = { name: string; description?: string };

export type SkillReviewSnapshot = {
  workspace?: string;
  toolCallCount?: number;
  learnedCatalog: SkillCatalogEntry[];
  skillBodies: Array<{ name: string; content: string }>;
  messages: Array<{ role: string; content: string; toolName?: string }>;
};

/** Flatten whatever the completion layer returned into plain text. */
export function completionText(completion: unknown): string {
  if (completion == null) return "";
  if (typeof completion === "string") return completion;
  const value = completion as Record<string, unknown>;
  if (typeof value.text === "string") return value.text;
  if (typeof value.content === "string") return value.content;
  if (Array.isArray(value.content)) {
    return value.content
      .map((part) => {
        if (typeof part === "string") return part;
        const record = part as Record<string, unknown> | null;
        return (record?.text as string) || (record?.content as string) || "";
      })
      .join("");
  }
  if (value.message) return completionText(value.message);
  if (typeof value.output === "string") return value.output;
  try {
    return JSON.stringify(completion);
  } catch {
    return String(completion);
  }
}

/** Pack one turn into the user message of the review completion. */
export function buildSkillReviewUser(snapshot: SkillReviewSnapshot): string {
  const catalog = snapshot.learnedCatalog.length
    ? snapshot.learnedCatalog
        .map((entry) => `- ${entry.name}: ${entry.description || ""}`)
        .join("\n")
    : "(none yet)";

  let bodies = "";
  let budget = 60_000;
  for (const skill of snapshot.skillBodies) {
    const chunk = String(skill.content || "").slice(0, 12_000);
    if (!chunk) continue;
    if (budget - chunk.length < 0) break;
    bodies += `\n\n----- existing skill ${skill.name} -----\n${chunk}`;
    budget -= chunk.length;
  }

  const messages = snapshot.messages
    .map((message) => `## ${message.role}${message.toolName ? ` (${message.toolName})` : ""}\n${message.content}`)
    .join("\n\n");

  return [
    `Workspace: ${snapshot.workspace || "?"}`,
    `Tool calls this turn: ${snapshot.toolCallCount ?? "?"}`,
    "",
    "Managed skills:",
    catalog + bodies,
    "",
    "Transcript (truncated):",
    messages,
  ].join("\n");
}

/** Shrink a user message for a retry after the model rejected it as too long. */
export function shrinkReviewUser(user: string, maxChars = 40_000): string {
  const text = String(user || "");
  const cap = Number(maxChars) || 40_000;
  if (text.length <= cap) return text;
  const head = text.slice(0, Math.floor(cap * 0.35));
  const tail = text.slice(-Math.floor(cap * 0.6));
  return `${head}\n\n[...truncated for retry...]\n\n${tail}`;
}

/** Pull the first JSON object out of a completion, tolerating code fences. */
export function extractJsonObject(text: string): unknown {
  const raw = String(text || "").trim();
  if (!raw) throw new Error("review output was empty");
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : raw).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("review output had no JSON object");
  const slice = body.slice(start, end + 1);
  try {
    return JSON.parse(slice);
  } catch {
    // A trailing comma or a stray comment is the common near-miss; repair the
    // two shapes a model actually produces rather than failing the turn.
    const repaired = slice
      .replace(/\/\/[^\n]*/g, "")
      .replace(/,\s*([}\]])/g, "$1");
    return JSON.parse(repaired);
  }
}

/**
 * Phrases that mean "nothing worth learning here".
 *
 * Small models answer a review prompt in prose surprisingly often, especially
 * at `thinkingLevel: "off"`. Treating a prose refusal as `skip` is right: the
 * alternative is throwing away a paid completion and logging a failure for what
 * is actually the expected answer. The match is deliberately narrow — it only
 * fires when there is no JSON at all and the text reads like a refusal.
 */
/**
 * Beyond this length a completion is a report, not a one-line refusal.
 *
 * A delivery summary ("script written, 9 pitfalls documented, all tests pass")
 * contains the very material the review exists to record, so it must never be
 * read as "nothing to learn" — it has to go to the retry instead.
 */
const PROSE_SKIP_MAX_CHARS = 400;

const SKIP_PHRASES = [
  "skip",
  "no json",
  "nothing to",
  "nothing worth",
  "not worth",
  "no skill",
  "no update",
  "no changes",
  "无需",
  "没有可",
  "没什么",
  "跳过",
  "不需要",
];

/**
 * Interpret a completion that carried no JSON object.
 *
 * Returns a skip decision **only** when the text reads like a short refusal.
 * A long answer is a report, not a refusal: a session that produced a delivery
 * summary clearly has material worth recording, so the caller must retry with a
 * harder prompt rather than silently discarding the turn. Getting this wrong is
 * how a review of 80 tool calls ends as "nothing to learn".
 */
export function interpretProseSkip(text: string): SkillReviewDecision | null {
  const body = String(text || "").trim();
  if (!body) return { decision: "skip", reason: "empty review output", ops: [] };
  // Anything beyond a sentence or two is a report; never read it as a refusal.
  if (body.length > PROSE_SKIP_MAX_CHARS) return null;
  const lower = body.toLowerCase();
  const looksLikeSkip = SKIP_PHRASES.some((phrase) => lower.includes(phrase));
  if (!looksLikeSkip) return null;
  const reason = body.length > 200 ? `${body.slice(0, 200)}…` : body;
  return { decision: "skip", reason: `prose skip: ${reason}`, ops: [] };
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

/**
 * Keep only the ops core can actually apply.
 *
 * `write_file` is accepted because core skills may ship resources beside their
 * `SKILL.md` (`skills.writeFile`), which is the cheap incremental path: a new
 * `references/<topic>.md` records a lesson without rewriting the document.
 */
export function normalizeSkillReview(parsed: unknown): SkillReviewDecision {
  const record = (parsed ?? {}) as Record<string, unknown>;
  const decision = record.decision === "update" ? "update" : "skip";
  const reason = typeof record.reason === "string" ? record.reason : undefined;
  if (decision === "skip") return { decision: "skip", reason, ops: [] };

  const rawOps = Array.isArray(record.ops) ? record.ops : [];
  const ops: SkillReviewOp[] = [];
  for (const entry of rawOps) {
    const op = (entry ?? {}) as Record<string, unknown>;
    const name = readString(op, "name").trim();
    if (!name) continue;
    if (op.action === "create") {
      const content = readString(op, "content");
      if (content.trim()) ops.push({ action: "create", name, content });
      continue;
    }
    if (op.action === "patch") {
      const oldString = readString(op, "old_string");
      const newString = readString(op, "new_string");
      if (oldString && oldString !== newString) {
        ops.push({ action: "patch", name, old_string: oldString, new_string: newString });
      }
      continue;
    }
    if (op.action === "write_file") {
      const filePath = readString(op, "file_path").trim();
      const content = readString(op, "content");
      if (filePath && content.trim()) {
        ops.push({ action: "write_file", name, file_path: filePath, content });
      }
    }
  }

  if (ops.length === 0) {
    return { decision: "skip", reason: reason || "update with no applicable ops", ops: [] };
  }
  return { decision: "update", reason, ops };
}

/** Parse + normalise in one step; throws when the model emitted no JSON. */
export function parseSkillReview(text: string): SkillReviewDecision {
  return normalizeSkillReview(extractJsonObject(text));
}

/**
 * Parse a review completion, falling back to a prose-refusal reading.
 *
 * Order matters: a real JSON decision always wins, so a model that answers
 * properly is never second-guessed by the phrase list. `null` means "not JSON
 * and not a recognisable refusal" — the caller may retry once, then give up.
 */
export function readSkillReview(text: string): SkillReviewDecision | null {
  try {
    return parseSkillReview(text);
  } catch {
    return interpretProseSkip(text);
  }
}

export type SkillDocumentParts = {
  name: string;
  description: string;
  body: string;
};

/**
 * Split a full SKILL.md into the fields `skills.create` takes.
 *
 * The model is asked for frontmatter + body, while the host stores name,
 * description and body as separate columns. A missing description falls back to
 * the first body line so a skill is never created with an empty one.
 */
export function splitSkillDocument(content: string, fallbackName = ""): SkillDocumentParts {
  const raw = String(content || "").replace(/\r\n/g, "\n").trim();
  let name = fallbackName.trim();
  let description = "";
  let body = raw;

  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (match) {
    const front = match[1];
    body = match[2].trim();
    for (const line of front.split("\n")) {
      const field = line.match(/^\s*([A-Za-z_-]+)\s*:\s*(.*)$/);
      if (!field) continue;
      const key = field[1].toLowerCase();
      const value = field[2].trim().replace(/^["']|["']$/g, "");
      if (key === "name" && value) name = value;
      if (key === "description" && value) description = value;
    }
  }

  if (!description) {
    const firstLine = body.split("\n").find((line) => line.trim() && !line.trim().startsWith("#"));
    description = (firstLine || "").trim().slice(0, 120);
  }

  return { name, description, body };
}
