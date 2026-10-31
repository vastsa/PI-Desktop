import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateContextTokens, estimateTokens } from "./pi-runtime-estimates.js";
import {
  createBranchSummaryMessage,
  createCompactionSummaryMessage,
} from "./pi-runtime-messages.js";
import {
  buildContextEntries,
  sessionEntryToContextMessages,
} from "./session-context.js";
import type {
  CompactionPreparation,
  CompactionSettings,
  Entry,
  FileOperations,
  Result,
} from "./pi-runtime-types.js";
import { CompactionError } from "./pi-runtime-types.js";

export type CutPoint = {
  firstKeptEntryIndex: number;
  turnStartIndex: number;
  isSplitTurn: boolean;
};

function messageFromEntry(entry: Entry): AgentMessage | undefined {
  switch (entry.type) {
    case "message":
      return entry.message;
    case "branch_summary":
      return createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp) as AgentMessage;
    case "compaction":
      return createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp) as AgentMessage;
    case "custom":
      return undefined;
  }
}

function messageForSummary(entry: Entry): AgentMessage | undefined {
  return entry.type === "compaction" ? undefined : messageFromEntry(entry);
}

function findValidCutPoints(entries: Entry[], startIndex: number, endIndex: number): number[] {
  const cutPoints: number[] = [];
  for (let index = startIndex; index < endIndex; index++) {
    const entry = entries[index];
    if (!entry) continue;
    if (entry.type === "branch_summary") {
      cutPoints.push(index);
      continue;
    }
    if (entry.type !== "message") continue;
    switch (entry.message.role) {
      case "bashExecution":
      case "custom":
      case "branchSummary":
      case "compactionSummary":
      case "user":
      case "assistant":
        cutPoints.push(index);
        break;
    }
  }
  return cutPoints;
}

export function findTurnStartIndex(entries: Entry[], entryIndex: number, startIndex: number): number {
  for (let index = entryIndex; index >= startIndex; index--) {
    const entry = entries[index];
    if (entry?.type === "branch_summary") return index;
    if (entry?.type !== "message") continue;
    if (entry.message.role === "user" || entry.message.role === "bashExecution") return index;
  }
  return -1;
}

export function findCutPoint(
  entries: Entry[],
  startIndex: number,
  endIndex: number,
  keepRecentTokens: number,
): CutPoint {
  const cutPoints = findValidCutPoints(entries, startIndex, endIndex);
  if (cutPoints.length === 0) {
    return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
  }
  let accumulatedTokens = 0;
  let cutIndex = cutPoints[0]!;
  for (let index = endIndex - 1; index >= startIndex; index--) {
    const entry = entries[index];
    if (entry?.type !== "message") continue;
    accumulatedTokens += estimateTokens(entry.message);
    if (accumulatedTokens < keepRecentTokens) continue;
    cutIndex = cutPoints.find((point) => point >= index) ?? cutIndex;
    break;
  }
  while (cutIndex > startIndex) {
    const previous = entries[cutIndex - 1];
    if (previous?.type === "compaction" || previous?.type === "message") break;
    cutIndex--;
  }
  const cutEntry = entries[cutIndex];
  const startsAtUser = cutEntry?.type === "message" && cutEntry.message.role === "user";
  const turnStartIndex = startsAtUser ? -1 : findTurnStartIndex(entries, cutIndex, startIndex);
  return {
    firstKeptEntryIndex: cutIndex,
    turnStartIndex,
    isSplitTurn: !startsAtUser && turnStartIndex !== -1,
  };
}

function createFileOperations(): FileOperations {
  return { read: new Set(), written: new Set(), edited: new Set() };
}

/** Record one assistant message's Read/Write/Edit paths. Mutates `fileOps`. */
export function collectMessageFileOperations(
  message: AgentMessage,
  fileOps: FileOperations,
): void {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return;
  for (const block of message.content) {
    if (!block || block.type !== "toolCall") continue;
    const args = block.arguments;
    const path = args && typeof args.path === "string" ? args.path : undefined;
    if (!path) continue;
    switch (block.name) {
      case "read": fileOps.read.add(path); break;
      case "write": fileOps.written.add(path); break;
      case "edit": fileOps.edited.add(path); break;
    }
  }
}

function collectFileOperations(
  messages: AgentMessage[],
  entries: Entry[],
  previousCompactionIndex: number,
): FileOperations {
  const fileOps = createFileOperations();
  if (previousCompactionIndex >= 0) {
    const previous = entries[previousCompactionIndex];
    const details = previous?.type === "compaction" ? previous.details : undefined;
    if (details && typeof details === "object" && !Array.isArray(details)) {
      const record = details as Record<string, unknown>;
      if (Array.isArray(record.readFiles)) {
        for (const path of record.readFiles) if (typeof path === "string") fileOps.read.add(path);
      }
      if (Array.isArray(record.modifiedFiles)) {
        for (const path of record.modifiedFiles) if (typeof path === "string") fileOps.edited.add(path);
      }
    }
  }
  for (const message of messages) collectMessageFileOperations(message, fileOps);
  return fileOps;
}

/** Build the desktop-owned preparation used by host-core checkpoint compaction. */
export function prepareCompaction(
  pathEntries: Entry[],
  settings: CompactionSettings,
): Result<CompactionPreparation | undefined> {
  try {
    if (pathEntries.length === 0 || pathEntries.at(-1)?.type === "compaction") {
      return { ok: true, value: undefined };
    }
    let previousCompactionIndex = -1;
    for (let index = pathEntries.length - 1; index >= 0; index--) {
      if (pathEntries[index]?.type === "compaction") {
        previousCompactionIndex = index;
        break;
      }
    }

    const previousCompaction = previousCompactionIndex >= 0
      ? pathEntries[previousCompactionIndex]
      : undefined;
    const previousSummary = previousCompaction?.type === "compaction"
      ? previousCompaction.summary
      : undefined;
    const virtualRetainedEntries: Entry[] = previousCompaction?.type === "compaction"
      ? previousCompaction.retainedTail.map((message, index) => ({
          type: "message",
          id: `${previousCompaction.id}:retained:${index}`,
          parentId: index === 0
            ? previousCompaction.id
            : `${previousCompaction.id}:retained:${index - 1}`,
          seq: previousCompaction.seq,
          timestamp: message.timestamp,
          message,
        }))
      : [];
    const compactableEntries = previousCompactionIndex >= 0
      ? [...virtualRetainedEntries, ...pathEntries.slice(previousCompactionIndex + 1)]
      : pathEntries;
    const cutPoint = findCutPoint(compactableEntries, 0, compactableEntries.length, settings.keepRecentTokens);
    const historyEnd = cutPoint.isSplitTurn
      ? cutPoint.turnStartIndex
      : cutPoint.firstKeptEntryIndex;
    const messagesToSummarize: AgentMessage[] = [];
    for (let index = 0; index < historyEnd; index++) {
      const message = messageForSummary(compactableEntries[index]!);
      if (message) messagesToSummarize.push(message);
    }
    const turnPrefixMessages: AgentMessage[] = [];
    if (cutPoint.isSplitTurn) {
      for (let index = cutPoint.turnStartIndex; index < cutPoint.firstKeptEntryIndex; index++) {
        const message = messageForSummary(compactableEntries[index]!);
        if (message) turnPrefixMessages.push(message);
      }
    }
    const retainedTail: AgentMessage[] = [];
    for (let index = cutPoint.firstKeptEntryIndex; index < compactableEntries.length; index++) {
      const message = messageForSummary(compactableEntries[index]!);
      if (message) retainedTail.push(message);
    }
    const fileOps = collectFileOperations(messagesToSummarize, pathEntries, previousCompactionIndex);
    if (cutPoint.isSplitTurn) {
      for (const message of turnPrefixMessages) collectMessageFileOperations(message, fileOps);
    }
    const contextMessages = buildContextEntries(pathEntries).flatMap((entry) =>
      sessionEntryToContextMessages(entry),
    );
    return {
      ok: true,
      value: {
        messagesToSummarize,
        turnPrefixMessages,
        retainedTail,
        isSplitTurn: cutPoint.isSplitTurn,
        tokensBefore: estimateContextTokens(contextMessages).tokens,
        ...(previousSummary !== undefined ? { previousSummary } : {}),
        fileOps,
        settings,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: new CompactionError("summarization_failed", message) };
  }
}
