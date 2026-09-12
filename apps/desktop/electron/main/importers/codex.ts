import { createReadStream } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import { createInterface } from "node:readline";
import os from "node:os";
import path from "node:path";
import type {
  ExternalSessionSummary,
  ImportedSession,
  ImportedUiMessage,
  SessionImporter,
} from "./types";
import { importedSessionId, toIso, truncateTitle } from "./types";

const SESSIONS_DIR = path.join(os.homedir(), ".codex", "sessions");

interface CodexItem {
  type?: string;
  role?: string;
  content?: Array<Record<string, any>>;
  name?: string;
  arguments?: string;
  call_id?: string;
  output?: string;
}

interface ParsedCodexFile {
  externalId: string;
  cwd: string | null;
  startedAt: string | null;
  lastAt: string | null;
  items: Array<{ item: CodexItem; timestamp: string | null }>;
}

function itemText(item: CodexItem): string {
  if (!Array.isArray(item.content)) return "";
  return item.content
    .filter(
      (c) =>
        (c.type === "input_text" || c.type === "output_text" || c.type === "text") &&
        typeof c.text === "string",
    )
    .map((c) => c.text)
    .join("\n")
    .trim();
}

// Codex prepends synthetic user messages carrying repo instructions, IDE
// context, and tooling state, so the first real user message (the scan title)
// must skip them. The list is evidence-driven from real archives (#265):
// newer Codex builds inject an IDE-context family alongside the original
// AGENTS.md block. Real user messages can legitimately start with "# "
// (pasted markdown such as "# Role: …"), so matching stays on the exact
// evidenced prefixes instead of a blanket "#" rule — extend the list when a
// new injection shows up, one archive sample at a time.
const SYNTHETIC_USER_PREFIXES = [
  "<",
  "# AGENTS.md",
  "# Context from my IDE setup",
  "# In app browser:",
  "# Browser comments:",
  "# Files mentioned by the user:",
  "# Diff comments:",
  "# Selected text:",
  "# Review findings:",
  "You are Codex",
];

function isSyntheticUserText(text: string): boolean {
  return SYNTHETIC_USER_PREFIXES.some((prefix) => text.startsWith(prefix));
}

async function parseFile(filePath: string): Promise<ParsedCodexFile | null> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
  const parsed: ParsedCodexFile = {
    externalId: "",
    cwd: null,
    startedAt: null,
    lastAt: null,
    items: [],
  };
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: Record<string, any>;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    // Newer format wraps everything in {timestamp, type, payload}.
    if (obj.type === "session_meta" && obj.payload) {
      parsed.externalId = obj.payload.id ?? parsed.externalId;
      parsed.cwd = obj.payload.cwd ?? parsed.cwd;
      parsed.startedAt = obj.payload.timestamp ?? obj.timestamp ?? parsed.startedAt;
      continue;
    }
    if (obj.type === "response_item" && obj.payload) {
      parsed.items.push({ item: obj.payload, timestamp: obj.timestamp ?? null });
      if (obj.timestamp) parsed.lastAt = obj.timestamp;
      continue;
    }
    // Older format: first line is a bare session header, items are bare lines.
    if (!parsed.externalId && obj.id && obj.timestamp && !obj.type) {
      parsed.externalId = obj.id;
      parsed.startedAt = obj.timestamp;
      parsed.cwd = obj.cwd ?? null;
      continue;
    }
    if (
      obj.type === "message" ||
      obj.type === "function_call" ||
      obj.type === "function_call_output"
    ) {
      parsed.items.push({ item: obj, timestamp: obj.timestamp ?? null });
      if (obj.timestamp) parsed.lastAt = obj.timestamp;
    }
  }
  if (!parsed.externalId) {
    parsed.externalId = path.basename(filePath, ".jsonl");
  }
  return parsed.items.length > 0 ? parsed : null;
}

async function listSessionFiles(dir: string = SESSIONS_DIR): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, depth: number) => {
    let entries: string[] = [];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry);
      if (entry.endsWith(".jsonl")) {
        out.push(full);
      } else if (depth < 3) {
        await walk(full, depth + 1);
      }
    }
  };
  await walk(dir, 0);
  return out;
}

// ---------- Scan (#264): sampled metadata extraction for large archives ----------
//
// A real Codex archive accumulates gigabytes of `.jsonl`, and the scan only
// needs the session title (first real user message), timestamps, cwd, and a
// count. Fully reading and JSON-parsing every file blocked the main process
// for ~8s at 865 files / 2.6GB. Files at or below the threshold keep the
// exact full parse; larger files are sampled:
//
// - head chunk: parsed line by line for session_meta/header fields and the
//   first real user message (if the head runs out first, streaming continues
//   until the message is found, so sampled scans never drop a session);
// - tail chunk: the last `"timestamp"` value, falling back to startedAt like
//   the full parse does;
// - messageCount: null (the UI shows "—" — counting items exactly would
//   require reading the whole file, which sampling exists to avoid).

export const CODEX_SCAN_FULL_PARSE_MAX_BYTES = 5 * 1024 * 1024;
const CODEX_SCAN_HEAD_BYTES = 1024 * 1024;
const CODEX_SCAN_TAIL_BYTES = 256 * 1024;

interface CodexScanMeta {
  externalId: string;
  cwd: string | null;
  startedAt: string | null;
  lastAt: string | null;
  /** File mtime, the honest fallback when stored timestamps are corrupt (#265). */
  mtimeMs: number | null;
  /** Exact item count, or null when the file was too large to scan fully. */
  itemCount: number | null;
  /** Whether any item line was seen (mirrors `parsed.items.length > 0`). */
  sawItem: boolean;
  firstUserText: string | null;
}

function newScanMeta(): CodexScanMeta {
  return {
    externalId: "",
    cwd: null,
    startedAt: null,
    lastAt: null,
    mtimeMs: null,
    itemCount: 0,
    sawItem: false,
    firstUserText: null,
  };
}

/** Mirrors parseFile's per-line semantics for the fields scan() reads. */
function applyCodexLine(line: string, meta: CodexScanMeta): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  let obj: Record<string, any>;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return;
  }
  // Newer format wraps everything in {timestamp, type, payload}.
  if (obj.type === "session_meta" && obj.payload) {
    meta.externalId = obj.payload.id ?? meta.externalId;
    meta.cwd = obj.payload.cwd ?? meta.cwd;
    meta.startedAt = obj.payload.timestamp ?? obj.timestamp ?? meta.startedAt;
    return;
  }
  if (obj.type === "response_item" && obj.payload) {
    if (meta.itemCount !== null) meta.itemCount += 1;
    meta.sawItem = true;
    if (obj.timestamp) meta.lastAt = obj.timestamp;
    if (meta.firstUserText === null) {
      const item = obj.payload as CodexItem;
      if (item.type === "message" && item.role === "user") {
        const text = itemText(item);
        if (text && !isSyntheticUserText(text)) meta.firstUserText = text;
      }
    }
    return;
  }
  // Older format: first line is a bare session header, items are bare lines.
  if (!meta.externalId && obj.id && obj.timestamp && !obj.type) {
    meta.externalId = obj.id;
    meta.startedAt = obj.timestamp;
    meta.cwd = obj.cwd ?? null;
    return;
  }
  if (
    obj.type === "message" ||
    obj.type === "function_call" ||
    obj.type === "function_call_output"
  ) {
    if (meta.itemCount !== null) meta.itemCount += 1;
    meta.sawItem = true;
    if (obj.timestamp) meta.lastAt = obj.timestamp;
    if (meta.firstUserText === null && obj.type === "message" && obj.role === "user") {
      const text = itemText(obj as CodexItem);
      if (text && !isSyntheticUserText(text)) meta.firstUserText = text;
    }
  }
}

/** Last top-level timestamp in the final tail bytes, or null. */
async function readTailTimestamp(
  handle: fs.FileHandle,
  size: number,
): Promise<string | null> {
  const start = Math.max(0, size - CODEX_SCAN_TAIL_BYTES);
  const length = size - start;
  const buf = Buffer.alloc(length);
  const read = await handle.read(buf, 0, length, start);
  // Drop the (possibly partial) first line unless the tail starts at BOF.
  let from = 0;
  if (start > 0) {
    const firstNewline = buf.indexOf(0x0a);
    if (firstNewline === -1) return null;
    from = firstNewline + 1;
  }
  const text = buf.toString("utf8", from, read.bytesRead);
  let last: string | null = null;
  for (const line of text.split("\n")) {
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      // Match parseFile's `obj.timestamp` behavior. A nested payload
      // timestamp is not the record timestamp and must not move updatedAt.
      if (typeof obj.timestamp === "string" && obj.timestamp) {
        last = obj.timestamp;
      }
    } catch {
      // The first or last line can be partial at the sample boundary.
    }
  }
  return last;
}

/**
 * Sampled scan for files above the full-parse threshold. Returns null when the
 * file holds no items at all (mirroring the full parse), so callers can skip it.
 */
async function scanLargeFile(
  filePath: string,
  size: number,
  handle: fs.FileHandle,
): Promise<CodexScanMeta | null> {
  const meta = newScanMeta();
  meta.itemCount = null;

  // Head: parse the leading complete lines for meta fields and the title.
  const headLength = Math.min(CODEX_SCAN_HEAD_BYTES, size);
  const headBuf = Buffer.alloc(headLength);
  const head = await handle.read(headBuf, 0, headLength, 0);
  const headLastNewline = headBuf.lastIndexOf(0x0a, head.bytesRead - 1);
  const headBytes = headLastNewline === -1 ? head.bytesRead : headLastNewline + 1;
  for (const line of headBuf.toString("utf8", 0, headBytes).split("\n")) {
    applyCodexLine(line, meta);
  }

  if (meta.firstUserText === null) {
    // The title lives deeper than the head chunk (large synthetic preamble):
    // stream on from the last complete line, parsing until it is found. If
    // the head contains no newline, restart at byte zero so an oversized first
    // JSON line is not parsed from its middle and silently discarded.
    const stream = createReadStream(filePath, {
      start: headLastNewline === -1 ? 0 : headBytes,
      encoding: "utf8",
    });
    const lines = createInterface({
      input: stream,
      crlfDelay: Infinity,
    });
    for await (const line of lines) {
      applyCodexLine(line, meta);
      if (meta.firstUserText !== null) break;
    }
    lines.close();
    stream.destroy();
  }

  if (meta.startedAt !== null && headBytes < size) {
    const tail = await readTailTimestamp(handle, size);
    if (tail !== null) meta.lastAt = tail;
  }
  if (!meta.sawItem) return null;
  if (!meta.externalId) meta.externalId = path.basename(filePath, ".jsonl");
  return meta;
}

async function scanFile(filePath: string): Promise<CodexScanMeta | null> {
  let handle: fs.FileHandle;
  let stats: Awaited<ReturnType<typeof handle.stat>>;
  try {
    handle = await fs.open(filePath, "r");
    stats = await handle.stat();
  } catch {
    return null;
  }
  try {
    if (stats.size <= CODEX_SCAN_FULL_PARSE_MAX_BYTES) {
      const meta = newScanMeta();
      meta.mtimeMs = stats.mtimeMs;
      const stream = createReadStream(filePath, { encoding: "utf8" });
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      for await (const line of lines) {
        applyCodexLine(line, meta);
      }
      lines.close();
      stream.destroy();
      if (!meta.sawItem) return null;
      if (!meta.externalId) meta.externalId = path.basename(filePath, ".jsonl");
      return meta;
    }
    const meta = await scanLargeFile(filePath, stats.size, handle);
    if (meta) meta.mtimeMs = stats.mtimeMs;
    return meta;
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

export async function scanCodexSessions(
  dir: string = SESSIONS_DIR,
): Promise<ExternalSessionSummary[]> {
  const files = await listSessionFiles(dir);
  const summaries: ExternalSessionSummary[] = [];
  for (const filePath of files) {
    const meta = await scanFile(filePath);
    if (!meta || meta.firstUserText === null) continue;
    // A corrupt or out-of-range stored timestamp must not rewrite the
    // session's history to the import moment (#265): the file's own mtime is
    // the honest fallback for both ends.
    const fileTime = toIso(meta.mtimeMs);
    summaries.push({
      source: "codex",
      externalId: meta.externalId,
      title: truncateTitle(meta.firstUserText) || meta.externalId,
      projectPath: meta.cwd,
      model: null,
      createdAt: toIso(meta.startedAt, fileTime),
      updatedAt: toIso(meta.lastAt, toIso(meta.startedAt, fileTime)),
      messageCount: meta.itemCount,
      filePath,
    });
  }
  return summaries;
}

export const codexImporter: SessionImporter = {
  source: "codex",

  async scan(): Promise<ExternalSessionSummary[]> {
    return scanCodexSessions();
  },

  async convert(summary: ExternalSessionSummary): Promise<ImportedSession> {
    const parsed = await parseFile(summary.filePath);
    const messages: ImportedUiMessage[] = [];
    const pendingCalls = new Map<string, { name: string; args: unknown }>();

    for (const { item, timestamp } of parsed?.items ?? []) {
      const createdAt = toIso(timestamp, summary.createdAt);
      if (item.type === "message") {
        const text = itemText(item);
        if (!text || (item.role === "user" && isSyntheticUserText(text))) continue;
        messages.push({
          id: crypto.randomUUID(),
          role: item.role === "user" ? "user" : "assistant",
          content: text,
          createdAt,
          status: item.role === "assistant" ? "complete" : undefined,
        });
      } else if (item.type === "function_call" && item.call_id) {
        let args: unknown = item.arguments;
        try {
          args = JSON.parse(item.arguments ?? "");
        } catch {
          // keep raw string
        }
        pendingCalls.set(item.call_id, { name: item.name ?? "tool", args });
      } else if (item.type === "function_call_output" && item.call_id) {
        const pending = pendingCalls.get(item.call_id);
        pendingCalls.delete(item.call_id);
        const output = typeof item.output === "string" ? item.output : JSON.stringify(item.output);
        messages.push({
          id: crypto.randomUUID(),
          role: "tool",
          content: output,
          createdAt,
          toolName: pending?.name,
          toolCallId: item.call_id,
          toolStatus: "success",
          toolArgs: pending?.args,
          toolResult: output,
          status: "complete",
        });
      }
    }

    return {
      session: {
        id: importedSessionId("codex", summary.externalId),
        title: summary.title,
        projectPath: summary.projectPath,
        modelId: summary.model,
        providerId: null,
        mode: "agent",
        createdAt: summary.createdAt,
        updatedAt: summary.updatedAt,
      },
      messages,
    };
  },
};
