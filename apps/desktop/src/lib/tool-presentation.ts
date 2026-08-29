import type { UiMessage } from "@pi-desktop/shared";
import {
  delegationLifecycleKind,
  getToolAction,
  getToolSummaryKey,
  type ToolAction,
} from "./tool-display";
import { reviewChangeFromMessage } from "./workspace-review";

/*
 * Structured presentation of one tool call (D192).
 *
 * Tool payloads are well-shaped — Read returns file content, Bash returns
 * stdout/stderr/exitCode, Grep returns path/line hits — so the transcript
 * renders them as content, terminal output, diffs and match lists instead of
 * dumping `JSON.stringify` into a <pre>. Everything here is pure and
 * label-free: blocks carry a semantic `role` and the React layer maps roles to
 * translated headings.
 *
 * Only genuinely unknown nested values (plugin tools returning objects) still
 * fall back to pretty-printed JSON.
 */

/** Beyond this, syntax highlighting costs more than it is worth on expand. */
const MAX_HIGHLIGHT_BYTES = 100_000;
const MAX_HIGHLIGHT_LINES = 800;
/** Rendered list caps; the remainder is reported, never silently dropped. */
const MAX_LIST_ITEMS = 200;
const MAX_DIFF_LINES = 400;
const DIFF_CONTEXT_LINES = 2;
/** Longer single-line strings become their own block instead of a field row. */
const MAX_FIELD_VALUE = 120;
/** Internal review snapshots are rendered by ReviewChangeCard, not as fields. */
const HIDDEN_KEYS = new Set(["review"]);

export type ToolPresentationMessage = {
  role?: string;
  content?: string;
  toolName?: string;
  toolArgs?: unknown;
  toolResult?: unknown;
  toolStatus?: string;
};

export type ToolChip =
  | { role: "exit" | "matches" | "files" | "replacements"; count: number }
  | { role: "truncated" | "scratch" }
  | { role: "size"; text: string };

export type ToolBlockRole =
  | "content"
  | "written"
  | "command"
  | "stdout"
  | "stderr"
  | "diff"
  | "files"
  | "matches"
  | "details"
  | "output"
  | "input"
  | "notice"
  | "error";

export type ToolDiffLine = { type: "add" | "del" | "context"; text: string };
export type ToolMatchGroup = {
  path: string;
  lines: { line: number; text: string }[];
};
export type ToolFieldRow = { label: string; value: string };

type BlockBase = {
  role: ToolBlockRole;
  /** Raw key for generic payload entries; overrides the role heading. */
  label?: string;
};

export type ToolBlock =
  | (BlockBase & {
      kind: "code";
      text: string;
      lang: string;
      highlight: boolean;
      tone?: "error";
    })
  | (BlockBase & {
      kind: "diff";
      lines: ToolDiffLine[];
      hidden: number;
      copy: string;
    })
  | (BlockBase & { kind: "files"; paths: string[]; hidden: number })
  | (BlockBase & { kind: "matches"; groups: ToolMatchGroup[]; hidden: number })
  | (BlockBase & { kind: "fields"; rows: ToolFieldRow[] })
  | (BlockBase & { kind: "note"; text: string; code?: string });

export type ToolPresentationOptions = {
  /** Drop the argument the collapsed row already shows as its summary. */
  hideSummaryArg?: boolean;
  /**
   * Drop a delegate's report from a `Task` body. The transcript nests the
   * delegate's own rows under the call, and its last answer row already is the
   * report, so showing both would print it twice (ADR 0062).
   */
  hideDelegateReport?: boolean;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringAt(
  record: Record<string, unknown> | null,
  ...keys: string[]
): string | null {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return null;
}

function numberAt(
  record: Record<string, unknown> | null,
  key: string,
): number | null {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Text blocks of a pi-ai tool result envelope, joined. */
function envelopeText(envelope: Record<string, unknown>): string | null {
  if (!Array.isArray(envelope.content)) return null;
  const parts = envelope.content.flatMap((block) => {
    const record = asRecord(block);
    return record?.type === "text" && typeof record.text === "string"
      ? [record.text]
      : [];
  });
  return parts.length > 0 ? parts.join("\n") : null;
}

/**
 * Unwrap `{ content, details }` down to the single payload worth showing.
 * `details` holds the structured host result; the content blocks repeat it as
 * text for the model, so showing both would duplicate every byte.
 */
export function toolResultPayload(message: ToolPresentationMessage): unknown {
  const raw = message.toolResult;
  if (raw === undefined || raw === null || raw === "") {
    return message.content ? message.content : undefined;
  }
  if (typeof raw === "string") return raw;
  const envelope = asRecord(raw);
  if (!envelope) return raw;
  if (envelope.details !== undefined && envelope.details !== null) {
    return envelope.details;
  }
  return envelopeText(envelope) ?? envelope;
}

/**
 * A delegate's report. `toolResultPayload` prefers the `details` object, which
 * for `Task` holds only counters, so the report has to be read from the text
 * blocks of the raw envelope.
 */
function delegateReport(message: ToolPresentationMessage): string | null {
  const raw = message.toolResult;
  if (typeof raw === "string") return raw.trim() ? raw : null;
  const envelope = asRecord(raw);
  const text = envelope ? envelopeText(envelope) : null;
  return text && text.trim() ? text : null;
}

/** The envelope's own text, used for a lifecycle row's one-line summary. */
function envelopeTextOf(message: ToolPresentationMessage): string | null {
  const raw = message.toolResult;
  if (typeof raw === "string") return raw.trim() ? raw.trim() : null;
  const envelope = asRecord(raw);
  const text = envelope ? envelopeText(envelope) : null;
  return text && text.trim() ? text.trim() : null;
}

/**
 * A lifecycle row's roster as field rows: one line per subagent, named, with
 * its status and runtime. Without this the row falls back to a JSON dump of
 * `delegations[]`, which is the least readable part of a delegation (D268).
 */
function rosterRows(
  details: Record<string, unknown> | null,
): ToolBlock | null {
  if (!details) return null;
  const entries = [
    ...(Array.isArray(details.delegations) ? details.delegations : []),
    ...(Array.isArray(details.stopped) ? details.stopped : []),
  ];
  const rows: ToolFieldRow[] = [];
  for (const entry of entries) {
    const record = asRecord(entry);
    if (!record) continue;
    const agent = typeof record.agent === "string" ? record.agent : "";
    const status = typeof record.status === "string" ? record.status : "";
    const startedAt = numberAt(record, "startedAt");
    const completedAt = numberAt(record, "completedAt");
    const seconds =
      startedAt !== null && completedAt !== null
        ? Math.max(0, Math.round((completedAt - startedAt) / 1000))
        : null;
    const turns = numberAt(record, "turns");
    const parts = [
      status,
      seconds !== null ? `${seconds}s` : null,
      turns !== null ? `${turns} turns` : null,
    ].filter((part): part is string => Boolean(part));
    rows.push({
      label: agent || String(record.delegationId ?? ""),
      value: parts.join(" · "),
    });
  }
  return rows.length > 0 ? { kind: "fields", role: "details", rows } : null;
}

function countLines(text: string): number {
  let lines = 1;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) lines += 1;
  }
  return lines;
}

/** Extension-derived Shiki tag; `resolveLang` normalizes it at render time. */
export function langForPath(path: string | null): string {
  if (!path) return "";
  const base = path.split(/[/\\]/).pop() ?? "";
  if (/^dockerfile/i.test(base)) return "dockerfile";
  if (/^makefile$/i.test(base)) return "makefile";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  const ext = base.slice(dot + 1).toLowerCase();
  return ext.length <= 10 ? ext : "";
}

function codeBlock(
  role: ToolBlockRole,
  text: string,
  lang = "",
  extra?: { tone?: "error"; label?: string },
): ToolBlock {
  return {
    kind: "code",
    role,
    text,
    lang,
    highlight:
      lang !== "" &&
      text.length <= MAX_HIGHLIGHT_BYTES &&
      countLines(text) <= MAX_HIGHLIGHT_LINES,
    ...(extra?.tone ? { tone: extra.tone } : {}),
    ...(extra?.label ? { label: extra.label } : {}),
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Minimal line diff for an Edit's `old_string` → `new_string`. Both sides are
 * localized snippets, so trimming the shared head/tail to a little context is
 * enough to make the actual replacement obvious.
 */
export function buildDiffLines(
  oldText: string,
  newText: string,
): ToolDiffLine[] {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  let head = 0;
  while (
    head < oldLines.length &&
    head < newLines.length &&
    oldLines[head] === newLines[head]
  ) {
    head += 1;
  }
  let tail = 0;
  while (
    tail < oldLines.length - head &&
    tail < newLines.length - head &&
    oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]
  ) {
    tail += 1;
  }
  const lines: ToolDiffLine[] = [];
  for (let i = Math.max(0, head - DIFF_CONTEXT_LINES); i < head; i += 1) {
    lines.push({ type: "context", text: oldLines[i] });
  }
  for (let i = head; i < oldLines.length - tail; i += 1) {
    lines.push({ type: "del", text: oldLines[i] });
  }
  for (let i = head; i < newLines.length - tail; i += 1) {
    lines.push({ type: "add", text: newLines[i] });
  }
  const tailStart = oldLines.length - tail;
  const tailEnd = Math.min(oldLines.length, tailStart + DIFF_CONTEXT_LINES);
  for (let i = tailStart; i < tailEnd; i += 1) {
    lines.push({ type: "context", text: oldLines[i] });
  }
  return lines;
}

function diffBlock(oldText: string, newText: string): ToolBlock | null {
  const lines = buildDiffLines(oldText, newText);
  if (!lines.some((line) => line.type !== "context")) return null;
  const sign = (line: ToolDiffLine) =>
    line.type === "add" ? "+" : line.type === "del" ? "-" : " ";
  return {
    kind: "diff",
    role: "diff",
    lines: lines.slice(0, MAX_DIFF_LINES),
    hidden: Math.max(0, lines.length - MAX_DIFF_LINES),
    copy: lines.map((line) => `${sign(line)}${line.text}`).join("\n"),
  };
}

function filesBlock(paths: string[], label?: string): ToolBlock | null {
  if (paths.length === 0) return null;
  return {
    kind: "files",
    role: "files",
    paths: paths.slice(0, MAX_LIST_ITEMS),
    hidden: Math.max(0, paths.length - MAX_LIST_ITEMS),
    ...(label ? { label } : {}),
  };
}

/** Group Grep hits by file so repeated paths collapse into one heading. */
function matchesBlock(hits: unknown[]): ToolBlock | null {
  const groups: ToolMatchGroup[] = [];
  let total = 0;
  let hidden = 0;
  for (const hit of hits) {
    const record = asRecord(hit);
    const path = stringAt(record, "path", "file");
    const line = numberAt(record, "line");
    if (!path || line === null) continue;
    if (total >= MAX_LIST_ITEMS) {
      hidden += 1;
      continue;
    }
    total += 1;
    const text = typeof record?.text === "string" ? record.text : "";
    const last = groups[groups.length - 1];
    if (last && last.path === path) last.lines.push({ line, text });
    else groups.push({ path, lines: [{ line, text }] });
  }
  return groups.length > 0
    ? { kind: "matches", role: "matches", groups, hidden }
    : null;
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? (value as string[])
    : null;
}

/** Grep's `count` output mode: one row per file, `path` → number of hits. */
function countsBlock(value: unknown): ToolBlock | null {
  if (!Array.isArray(value)) return null;
  const rows: ToolFieldRow[] = [];
  for (const entry of value.slice(0, MAX_LIST_ITEMS)) {
    const record = asRecord(entry);
    const path = stringAt(record, "path", "file");
    const count = numberAt(record, "count");
    if (!path || count === null) continue;
    rows.push({ label: path, value: String(count) });
  }
  return rows.length > 0 ? { kind: "fields", role: "matches", rows } : null;
}

/**
 * Readable rendering for payloads with no per-tool mapping (plugin tools, MCP
 * results): scalars become field rows, long or multi-line strings become their
 * own labeled block, and only nested objects keep a JSON body.
 */
function recordBlocks(
  record: Record<string, unknown>,
  role: ToolBlockRole,
): ToolBlock[] {
  const rows: ToolFieldRow[] = [];
  const extra: ToolBlock[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined || value === null || HIDDEN_KEYS.has(key)) continue;
    if (typeof value === "string") {
      if (value === "") continue;
      if (value.includes("\n") || value.length > MAX_FIELD_VALUE) {
        extra.push(codeBlock(role, value, langForPath(key), { label: key }));
      } else {
        rows.push({ label: key, value });
      }
      continue;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      rows.push({ label: key, value: String(value) });
      continue;
    }
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      const strings = stringArray(value);
      if (strings) {
        const block = filesBlock(strings, key);
        if (block) extra.push(block);
        continue;
      }
      const grouped = matchesBlock(value);
      if (grouped) {
        extra.push(grouped);
        continue;
      }
    }
    extra.push(codeBlock(role, safeJson(value), "json", { label: key }));
  }
  return rows.length > 0 ? [{ kind: "fields", role, rows }, ...extra] : extra;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * What actually happened to a command, read from what the shell returned rather
 * than from the status of the call that carried it: a command that exits
 * non-zero has failed even when the tool call around it succeeded, and a shell
 * that was killed reports no code at all (D227). `unknown` means the row has
 * nothing to claim — an imported or half-written message — so it says nothing.
 */
export function runOutcome(
  message: ToolPresentationMessage,
): "running" | "denied" | "failed" | "ok" | "unknown" {
  if (message.toolStatus === "running") return "running";
  if (message.toolStatus === "denied") return "denied";
  const details = asRecord(toolResultPayload(message));
  if (details && "exitCode" in details) {
    return numberAt(details, "exitCode") === 0 ? "ok" : "failed";
  }
  if (message.toolStatus === "error") return "failed";
  if (message.toolStatus === "success") return "ok";
  return "unknown";
}

/** Cheap outcome badges for the collapsed row: no stringify, property reads. */
export function toolResultChips(message: ToolPresentationMessage): ToolChip[] {
  const details = asRecord(toolResultPayload(message));
  if (!details) return [];
  const action = getToolAction(message.toolName);
  const chips: ToolChip[] = [];
  const exitCode = numberAt(details, "exitCode");
  // A successful exit is already implied by the row status; only failures earn
  // a badge.
  if (exitCode !== null && exitCode !== 0) {
    chips.push({ role: "exit", count: exitCode });
  }
  const count = numberAt(details, "count");
  const counted =
    Array.isArray(details.matches) ||
    Array.isArray(details.files) ||
    Array.isArray(details.counts);
  if (count !== null && counted) {
    chips.push({ role: action === "list" ? "files" : "matches", count });
  }
  const replacements = numberAt(details, "replacements");
  if (replacements !== null && replacements > 0) {
    chips.push({ role: "replacements", count: replacements });
  }
  const bytes = numberAt(details, "bytes") ?? numberAt(details, "fileBytes");
  if (bytes !== null) chips.push({ role: "size", text: formatBytes(bytes) });
  if (details.truncated === true) chips.push({ role: "truncated" });
  if (details.root === "scratch") chips.push({ role: "scratch" });
  return chips;
}

/**
 * Whether the row has anything to expand. Kept property-read cheap: streaming
 * replaces the message object on every tick, and collapsed rows only need to
 * know whether the caret should show.
 */
export function hasToolDetails(message: ToolPresentationMessage): boolean {
  const payload = toolResultPayload(message);
  if (typeof payload === "string") {
    if (payload !== "") return true;
  } else if (payload !== undefined) {
    const record = asRecord(payload);
    if (!record || Object.keys(record).length > 0) return true;
  }
  const args = asRecord(message.toolArgs);
  if (args) return Object.keys(args).length > 0;
  return message.toolArgs !== undefined;
}

function resultBlocks(
  action: ToolAction,
  message: ToolPresentationMessage,
  args: Record<string, unknown> | null,
  payload: unknown,
  options: ToolPresentationOptions = {},
): ToolBlock[] {
  const details = asRecord(payload);
  const blocks: ToolBlock[] = [];
  /**
   * Set once a mapping has said everything there is to say about the result, so
   * an empty body is read as "it printed nothing" rather than as a payload the
   * generic fallback still has to render (D226).
   */
  let mapped = false;
  const error = stringAt(details, "error");
  if (error) {
    const code = stringAt(details, "code");
    blocks.push({
      kind: "note",
      role: "error",
      text: error,
      ...(code ? { code } : {}),
    });
  }

  switch (action) {
    case "read": {
      const content = stringAt(details, "content");
      if (content !== null) {
        const path = stringAt(details, "path") ?? stringAt(args, "path");
        blocks.push(codeBlock("content", content, langForPath(path)));
      }
      break;
    }
    case "write": {
      const content = stringAt(args, "content");
      if (content !== null) {
        const path = stringAt(args, "path") ?? stringAt(details, "path");
        blocks.push(codeBlock("written", content, langForPath(path)));
      }
      break;
    }
    case "edit": {
      const oldText = stringAt(args, "old_string", "oldString");
      const newText = stringAt(args, "new_string", "newString");
      // Workspace edits already own a ReviewChangeCard with the real diff;
      // only scratch edits and imported sessions need one here.
      const reviewed =
        reviewChangeFromMessage(message as unknown as UiMessage) !== null;
      if (oldText !== null && newText !== null && !reviewed) {
        const block = diffBlock(oldText, newText);
        if (block) blocks.push(block);
      }
      break;
    }
    case "run": {
      const command = stringAt(args, "command", "cmd");
      // The head already prints the command and copies it, so repeating it here
      // would open a body that says the same thing twice before reaching the
      // output the reader expanded for (D226). A permission card has no head of
      // its own, so it still shows the command it is asking about.
      if (command !== null && !options.hideSummaryArg) {
        blocks.push(codeBlock("command", command, "bash"));
      }
      const stdout = stringAt(details, "stdout");
      if (stdout !== null) blocks.push(codeBlock("stdout", stdout));
      const stderr = stringAt(details, "stderr");
      if (stderr !== null) {
        blocks.push(codeBlock("stderr", stderr, "", { tone: "error" }));
      }
      mapped = command !== null;
      break;
    }
    case "list": {
      const paths = stringArray(details?.matches) ?? stringArray(details?.files);
      const block = paths ? filesBlock(paths) : null;
      if (block) blocks.push(block);
      break;
    }
    case "search": {
      const hits = details?.matches;
      // `outputMode` decides the shape: content → path/line hits,
      // filesWithMatches → a path list, count → hits per file.
      const block = Array.isArray(hits) ? matchesBlock(hits) : null;
      const paths = block ? null : stringArray(details?.files);
      const grouped = block ?? (paths ? filesBlock(paths) : null);
      const resolved = grouped ?? countsBlock(details?.counts);
      if (resolved) blocks.push(resolved);
      break;
    }
    case "delegate": {
      // A lifecycle row (ADR 0089) has no brief and no report of its own: it
      // reports on subagents. Its body is the roster the runtime returned, as
      // a named table rather than the raw `delegations[]` JSON (D268).
      if (delegationLifecycleKind(message.toolName)) {
        const text = envelopeTextOf(message);
        if (text) blocks.push({ kind: "note", role: "notice", text });
        const roster = rosterRows(details);
        if (roster) blocks.push(roster);
        break;
      }
      // A delegation reads as brief in, report out. The counters that pi hands
      // back (`turns`, `toolCalls`, `usage`) are a footer, and `agent` already
      // labels the row, so neither repeats here.
      const brief = stringAt(args, "task");
      if (brief !== null) {
        blocks.push(codeBlock("input", brief, "markdown", { label: "task" }));
      }
      const report = options.hideDelegateReport
        ? null
        : delegateReport(message);
      if (report !== null) blocks.push(codeBlock("output", report, "markdown"));
      const counters = details
        ? Object.fromEntries(
            Object.entries(details).filter(
              ([key]) => key !== "agent" && key !== "error",
            ),
          )
        : {};
      if (Object.keys(counters).length > 0) {
        blocks.push(...recordBlocks(counters, "details"));
      }
      break;
    }
    default:
      break;
  }

  // Host-side scoping notes ("results are truncated…", "N long lines were cut")
  // explain a short result, so they ride along with the blocks they qualify.
  const notice = stringAt(details, "notice");
  if (notice && blocks.length > 0) {
    blocks.push({ kind: "note", role: "notice", text: notice });
  }

  if (blocks.length > 0 || mapped) return blocks;
  // No per-tool mapping matched: render the payload itself readably.
  if (typeof payload === "string" && payload.trim()) {
    return [codeBlock("output", payload)];
  }
  if (details) return recordBlocks(details, "details");
  if (payload !== undefined && payload !== null) {
    return [codeBlock("output", safeJson(payload), "json")];
  }
  return [];
}

/**
 * Build the expanded body of a tool row. Called only while the row is open —
 * the work here is proportional to the payload, not to the render frequency.
 */
export function buildToolPresentation(
  message: ToolPresentationMessage,
  options: ToolPresentationOptions = {},
): ToolBlock[] {
  const action = getToolAction(message.toolName);
  const args = asRecord(message.toolArgs);
  const payload = toolResultPayload(message);
  const blocks = resultBlocks(action, message, args, payload, options);
  if (!args) return blocks;

  // Arguments are worth showing when the result blocks did not already carry
  // them (Read content, Bash command) and for opaque tools whose arguments are
  // the interesting part. A delegation places its own brief, so it opts out.
  // A run row's command was withheld above because the head shows it, so the
  // body must not print it back as an argument the moment a command prints
  // nothing (D226).
  const headHasCommand =
    action === "run" &&
    options.hideSummaryArg === true &&
    getToolSummaryKey(message.toolName, args) !== null;
  const wantArgs =
    action !== "delegate" &&
    !headHasCommand &&
    (blocks.length === 0 ||
      blocks.every(
        (block) => block.role === "error" || block.role === "notice",
      ) ||
      action === "use" ||
      action === "fork" ||
      action === "fetch");
  if (!wantArgs) return blocks;
  const summaryKey = options.hideSummaryArg
    ? getToolSummaryKey(message.toolName, args)
    : null;
  const remaining = Object.fromEntries(
    Object.entries(args).filter(([key]) => key !== summaryKey),
  );
  if (Object.keys(remaining).length === 0) return blocks;
  return [...blocks, ...recordBlocks(remaining, "input")];
}
