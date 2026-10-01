import type { ContextCompactionMark, UiMessage } from "@pi-desktop/shared";
import {
  buildTranscriptEntries,
  messageThinking,
  reuseTranscriptEntries,
  type AssistantActivityItem,
  type AssistantTurnEntry,
  type AssistantTurnPart,
  type TranscriptEntry,
} from "./assistant-turns";
import {
  getSessionMessageSnapshot,
  SESSION_MESSAGE_BLOCK_SIZE,
} from "./session-transcript-updates";
import { isDelegationStartTool } from "./tool-display";
import { messageContentFacts } from "./transcript-summary";

export type TranscriptProjection = {
  entries: TranscriptEntry[];
  visible: UiMessage[];
  history: TranscriptEntry[];
};

type Location = {
  entry: number;
  part?: number;
  item?: number;
  delegateItem?: number;
};

type MessageShape = {
  visible: boolean;
  thinking: boolean;
  content: boolean;
  answer: boolean;
};

type ProjectionState = {
  source: ReturnType<typeof getSessionMessageSnapshot>;
  messages: UiMessage[];
  compactions: readonly ContextCompactionMark[];
  projection: TranscriptProjection;
  locations: Map<string, Location[]>;
  visiblePositions: Map<string, number>;
};

const NO_COMPACTIONS: readonly ContextCompactionMark[] = [];
const shapes = new WeakMap<UiMessage, MessageShape>();
const owners = new WeakMap<object, ProjectionState>();
const snapshots = new WeakMap<UiMessage[], WeakMap<readonly ContextCompactionMark[], TranscriptProjection>>();

function shape(message: UiMessage): MessageShape {
  const cached = shapes.get(message);
  if (cached) return cached;
  const content = messageContentFacts(message).hasContent;
  const thinking = Boolean(messageThinking(message));
  const value = {
    content,
    thinking,
    visible: message.role !== "assistant" || content || thinking || Boolean(message.hostedSearch || message.error),
    answer: message.parentToolCallId
      ? content || Boolean(message.error)
      : content || !thinking || Boolean(message.error),
  };
  shapes.set(message, value);
  return value;
}

function canReplace(previous: UiMessage, next: UiMessage): boolean {
  if (
    previous.id !== next.id || previous.role !== next.role ||
    previous.parentToolCallId !== next.parentToolCallId ||
    previous.agentName !== next.agentName || previous.createdAt !== next.createdAt ||
    previous.toolCallId !== next.toolCallId || previous.toolName !== next.toolName ||
    previous.hostedSearch !== next.hostedSearch
  ) return false;
  if (isDelegationStartTool(previous.toolName) && (
    previous.toolArgs !== next.toolArgs || previous.toolResult !== next.toolResult
  )) return false;
  // Tool rows always occupy one activity slot, including their first output.
  // Parent user/system rows likewise do not split when their text changes.
  if (previous.role === "tool" || (!previous.parentToolCallId &&
    (previous.role === "user" || previous.role === "system"))) return true;
  const before = shape(previous);
  const after = shape(next);
  return before.visible === after.visible && before.thinking === after.thinking &&
    before.content === after.content && before.answer === after.answer;
}

function indexProjection(projection: TranscriptProjection) {
  const locations = new Map<string, Location[]>();
  const add = (message: UiMessage, location: Location) => {
    const existing = locations.get(message.id);
    if (existing) existing.push(location);
    else locations.set(message.id, [location]);
  };
  projection.entries.forEach((entry, entryIndex) => {
    if (entry.kind === "message") add(entry.message, { entry: entryIndex });
    if (entry.kind !== "assistant-turn") return;
    entry.parts.forEach((part, partIndex) => {
      if (part.kind === "message") {
        add(part.message, { entry: entryIndex, part: partIndex });
        return;
      }
      part.items.forEach((item, itemIndex) => {
        const location = { entry: entryIndex, part: partIndex, item: itemIndex };
        add(item.message, location);
        if (item.kind === "tool") item.delegate?.items.forEach((child, delegateItem) => {
          add(child.message, { ...location, delegateItem });
        });
      });
    });
  });
  const visiblePositions = new Map(projection.visible.map((message, index) => [message.id, index]));
  return { locations, visiblePositions };
}

/** Clone only changed paths; previously published render snapshots stay immutable. */
function replaceMessages(state: ProjectionState, changes: UiMessage[]): TranscriptProjection {
  const previous = state.projection;
  const entries = previous.entries.slice();
  let visible = previous.visible;
  let historyChanged = false;
  const turns = new Map<number, AssistantTurnEntry>();
  const parts = new Map<AssistantTurnPart, AssistantTurnPart>();
  const items = new Map<AssistantActivityItem, AssistantActivityItem>();
  for (const message of changes) {
    const visibleIndex = state.visiblePositions.get(message.id);
    if (visibleIndex !== undefined) {
      if (visible === previous.visible) visible = visible.slice();
      visible[visibleIndex] = message;
    }
    for (const location of state.locations.get(message.id) ?? []) {
      const original = previous.entries[location.entry];
      historyChanged ||= location.entry < entries.length - 1;
      if (original.kind === "message") {
        entries[location.entry] = { ...original, message };
        continue;
      }
      if (original.kind !== "assistant-turn" || location.part === undefined) continue;
      let turn = turns.get(location.entry);
      if (!turn) {
        turn = { ...original, parts: original.parts.slice() };
        turns.set(location.entry, turn);
        entries[location.entry] = turn;
      }
      const originalPart = original.parts[location.part];
      if (originalPart.kind === "message") {
        turn.parts[location.part] = { ...originalPart, message };
        continue;
      }
      if (location.item === undefined) continue;
      let part = parts.get(originalPart);
      if (!part) {
        part = { ...originalPart, items: originalPart.items.slice() };
        parts.set(originalPart, part);
        turn.parts[location.part] = part;
      }
      if (part.kind !== "activity") continue;
      const originalItem = originalPart.items[location.item];
      let item = items.get(originalItem);
      if (!item) {
        item = originalItem.kind === "tool" && originalItem.delegate
          ? { ...originalItem, delegate: { ...originalItem.delegate, items: originalItem.delegate.items.slice() } }
          : { ...originalItem };
        items.set(originalItem, item);
        part.items[location.item] = item;
      }
      if (location.delegateItem !== undefined) {
        if (item.kind === "tool" && item.delegate) {
          item.delegate.items[location.delegateItem] = {
            ...item.delegate.items[location.delegateItem], message,
          };
        }
      } else {
        item.message = message;
      }
    }
  }
  const unchanged = !turns.size && entries.every((entry, index) => entry === previous.entries[index]);
  return {
    entries: unchanged ? previous.entries : entries,
    visible,
    history: historyChanged ? entries.slice(0, -1) : previous.history,
  };
}

function incremental(state: ProjectionState, messages: UiMessage[], source: ProjectionState["source"]): TranscriptProjection | undefined {
  if (!source.unique || !state.source.unique || messages.length !== state.messages.length) return undefined;
  const changes: UiMessage[] = [];
  for (let blockIndex = 0; blockIndex < source.blocks.length; blockIndex++) {
    const block = source.blocks[blockIndex];
    if (block === state.source.blocks[blockIndex]) continue;
    for (let offset = 0; offset < block.length; offset++) {
      const next = block[offset];
      const previous = state.messages[blockIndex * SESSION_MESSAGE_BLOCK_SIZE + offset];
      if (previous === next) continue;
      if (!previous || !canReplace(previous, next)) return undefined;
      changes.push(next);
    }
  }
  return changes.length ? replaceMessages(state, changes) : state.projection;
}

/**
 * The exact source snapshot owns reuse. Comparing immutable blocks also handles
 * skipped/deferred React renders without retaining a chain of prior updates.
 * Structural changes use the full builder; ordinary deltas never revisit old
 * content or grouping. Array/block reference copies remain linear shallow work.
 */
export function getTranscriptProjection(
  messages: UiMessage[],
  compactions: readonly ContextCompactionMark[] = NO_COMPACTIONS,
): TranscriptProjection {
  const cached = snapshots.get(messages)?.get(compactions);
  if (cached) return cached;
  const source = getSessionMessageSnapshot(messages);
  const previous = owners.get(source.owner);
  const matching = previous?.compactions === compactions;
  let projection = matching ? incremental(previous, messages, source) : undefined;
  let locations = previous?.locations;
  let visiblePositions = previous?.visiblePositions;
  if (!projection) {
    const built = buildTranscriptEntries(messages, compactions);
    const entries = reuseTranscriptEntries(matching ? previous.projection.entries : undefined, built.entries);
    projection = { entries, visible: built.visible, history: entries.slice(0, -1) };
    ({ locations, visiblePositions } = indexProjection(projection));
    for (const message of messages) shape(message);
  }
  // Old deferred inputs may be queried after newer ones. They can be cached,
  // but must not move the current owner's cursor backwards.
  if (!previous || source.generation >= previous.source.generation) {
    owners.set(source.owner, {
      source, messages, compactions, projection,
      locations: locations!, visiblePositions: visiblePositions!,
    });
  }
  let byCompactions = snapshots.get(messages);
  if (!byCompactions) {
    byCompactions = new WeakMap();
    snapshots.set(messages, byCompactions);
  }
  byCompactions.set(compactions, projection);
  return projection;
}
