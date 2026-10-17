import { randomUUID } from "node:crypto";
import { LocalRequestError, Type, contentText, toToolDeclaration, type SystemMessage } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { MessageEntry } from "./pi-runtime-types.js";
import type { UiMessage } from "@pi-desktop/shared";
import * as Value from "typebox/value";

const systemSchema = Type.Object({
  role: Type.Literal("system"),
  content: Type.String(),
  timestamp: Type.Number({ minimum: 0, maximum: 8.64e15 }),
  sections: Type.Optional(Type.Record(Type.String(), Type.Union([Type.String(), Type.Null()]))),
  toolsAdded: Type.Optional(Type.Array(Type.Object({
    name: Type.String({ minLength: 1 }), description: Type.String(),
    parameters: Type.Record(Type.String(), Type.Unknown()),
    constrainedSampling: Type.Optional(Type.Union([
      Type.Literal(false),
      Type.Object({ type: Type.Literal("json_schema"), strict: Type.Union([Type.Literal("prefer"), Type.Literal("require")]) }),
      Type.Object({ type: Type.Literal("grammar"), variants: Type.Record(Type.String(), Type.Unknown()) }),
    ])),
  }))),
  toolsRemoved: Type.Optional(Type.Array(Type.Object({ name: Type.String({ minLength: 1 }) }))),
});

export function readSystemMessage(value: unknown): SystemMessage {
  if (typeof value === "string") value = JSON.parse(value);
  if (!Value.Check(systemSchema, value)) throw new Error("Invalid persisted model system message");
  // Tool parameter schemas and grammar variants are JSON objects at this boundary.
  return value as SystemMessage;
}

function serializedSystemMessage(message: SystemMessage): string {
  return JSON.stringify({
    ...message,
    content: contentText(message.content),
    ...(message.toolsAdded ? { toolsAdded: message.toolsAdded.map(toToolDeclaration) } : {}),
  });
}

/** Reorder only internal rows, whose following user row may have arrived first. */
export function orderSystemRows(history: readonly UiMessage[]): UiMessage[] {
  const rows = history.filter((row) => !row.modelSystem);
  const seen = new Set<string>();
  for (const row of history) {
    if (!row.modelSystem) continue;
    if (row.role !== "system" || row.modelSystem.version !== 1) {
      throw new Error("Invalid model system record");
    }
    const key = serializedSystemMessage(readSystemMessage(row.modelSystem.messageJson));
    if (seen.has(key)) continue;
    seen.add(key);
    const before = row.modelSystem.beforeMessageId;
    let index = before ? rows.findIndex((candidate) => candidate.id === before) : -1;
    if (index < 0 && row.modelSystem.afterMessageId) {
      const previous = rows.findIndex((candidate) => candidate.id === row.modelSystem?.afterMessageId);
      if (previous >= 0) {
        index = previous + 1;
        while (rows[index]?.modelSystem) index++;
      }
    }
    rows.splice(index < 0 ? rows.length : index, 0, row);
  }
  return rows;
}

/** Persist provider-neutral declarations before dispatch; never persist a folded request. */
export class SystemTranscriptJournal {
  private readonly ids = new WeakMap<AgentMessage, string>();
  private readonly serializedIds = new Set<string>();
  private readonly pending = new WeakMap<AgentMessage, string>();
  private readonly checkpoints = new Set<string>();

  restore(row: UiMessage): SystemMessage {
    const message = readSystemMessage(row.modelSystem?.messageJson);
    this.ids.set(message, row.id);
    this.serializedIds.add(serializedSystemMessage(message));
    return message;
  }

  isPersisted(message: AgentMessage): boolean {
    if (message.role !== "system") return false;
    if (this.ids.has(message)) return true;
    const key = serializedSystemMessage(message);
    return this.serializedIds.has(key) || this.checkpoints.has(key);
  }

  async persist(
    messages: readonly AgentMessage[],
    entries: MessageEntry[],
    append: (row: UiMessage) => Promise<void>,
  ): Promise<void> {
    for (let index = 0; index < messages.length; index++) {
      const message = messages[index];
      if (message.role !== "system" || this.isPersisted(message)) continue;
      const following = messages.slice(index + 1).find((candidate) => candidate.role !== "system");
      const nextEntry = following && entries.find((entry) => entry.message === following);
      const preceding = messages.slice(0, index).reverse().find((candidate) => candidate.role !== "system");
      const previousEntry = preceding && entries.find((entry) => entry.message === preceding);
      const id = this.pending.get(message) ?? randomUUID();
      this.pending.set(message, id);
      const serializedKey = serializedSystemMessage(message);
      const row: UiMessage = {
        id, role: "system", content: "", createdAt: new Date(message.timestamp).toISOString(),
        modelSystem: {
          version: 1,
          messageJson: serializedKey,
          ...(nextEntry ? { beforeMessageId: nextEntry.id } : {}),
          ...(previousEntry ? { afterMessageId: previousEntry.id } : {}),
        },
      };
      try {
        await append(row);
      } catch (cause) {
        // Stop before dispatch. Retrying the provider cannot repair a failed
        // durable write, and the original host error may contain private paths.
        throw new LocalRequestError("request-preparation", { cause });
      }
      this.ids.set(message, id);
      this.serializedIds.add(serializedKey);
      this.pending.delete(message);
      const entry: MessageEntry = {
        type: "message", id, seq: entries.length, parentId: null,
        timestamp: message.timestamp, message,
      };
      const position = nextEntry ? entries.indexOf(nextEntry) : entries.length;
      entries.splice(position, 0, entry);
      entries.forEach((item, seq) => { item.seq = seq; item.parentId = entries[seq - 1]?.id ?? null; });
    }
  }

  rememberCheckpoint(message: unknown): void {
    this.checkpoints.add(serializedSystemMessage(readSystemMessage(message)));
  }

  remember(message: AgentMessage, id: string): void {
    this.ids.set(message, id);
    if (message.role === "system") this.serializedIds.add(serializedSystemMessage(message));
  }
}
