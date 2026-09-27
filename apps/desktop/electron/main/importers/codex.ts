import { promises as fs } from "node:fs";
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

// Codex prepends synthetic user messages carrying repo instructions/env info.
function isSyntheticUserText(text: string): boolean {
  return (
    text.startsWith("<") ||
    text.startsWith("# AGENTS.md") ||
    text.startsWith("You are Codex")
  );
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

async function listSessionFiles(): Promise<string[]> {
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
  await walk(SESSIONS_DIR, 0);
  return out;
}

export const codexImporter: SessionImporter = {
  source: "codex",

  async scan(): Promise<ExternalSessionSummary[]> {
    const files = await listSessionFiles();
    const summaries: ExternalSessionSummary[] = [];
    for (const filePath of files) {
      const parsed = await parseFile(filePath);
      if (!parsed) continue;
      const firstUser = parsed.items.find(({ item }) => {
        if (item.type !== "message" || item.role !== "user") return false;
        const text = itemText(item);
        return !!text && !isSyntheticUserText(text);
      });
      if (!firstUser) continue;
      summaries.push({
        source: "codex",
        externalId: parsed.externalId,
        title: truncateTitle(itemText(firstUser.item)) || parsed.externalId,
        projectPath: parsed.cwd,
        model: null,
        createdAt: toIso(parsed.startedAt),
        updatedAt: toIso(parsed.lastAt, toIso(parsed.startedAt)),
        messageCount: parsed.items.length,
        filePath,
      });
    }
    return summaries;
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
