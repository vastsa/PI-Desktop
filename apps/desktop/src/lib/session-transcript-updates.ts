import type { UiMessage } from "@pi-desktop/shared";

export const SESSION_MESSAGE_BLOCK_SIZE = 64;

export type SessionMessageSnapshot = {
  readonly owner: object;
  readonly generation: number;
  readonly blocks: readonly (readonly UiMessage[])[];
  /** First physical position for each id; duplicate arrays are not indexed updates. */
  readonly positions: ReadonlyMap<string, number>;
  readonly unique: boolean;
};

type TrackedSessionMessages = {
  snapshot: SessionMessageSnapshot;
  // All physical rows are indexed, regardless of role/status. Tool events
  // historically match toolCallId even when it differs from the row id.
  toolPositions: ReadonlyMap<string, readonly number[]>;
};

// Array identity is the ownership boundary. Values contain no predecessor or
// source array, so abandoned renders do not keep an update history alive.
const snapshots = new WeakMap<UiMessage[], TrackedSessionMessages>();
const EMPTY_TOOL_POSITIONS: readonly number[] = Object.freeze([]);

function buildSnapshot(messages: UiMessage[], owner: object, generation: number): TrackedSessionMessages {
  const positions = new Map<string, number>();
  const toolPositions = new Map<string, number[]>();
  let unique = true;
  for (let index = 0; index < messages.length; index++) {
    const { id, toolCallId } = messages[index];
    if (positions.has(id)) unique = false;
    else positions.set(id, index);
    if (toolCallId !== undefined) {
      const indices = toolPositions.get(toolCallId);
      if (indices) indices.push(index);
      else toolPositions.set(toolCallId, [index]);
    }
  }
  for (const indices of toolPositions.values()) Object.freeze(indices);
  const blocks: (readonly UiMessage[])[] = [];
  for (let index = 0; index < messages.length; index += SESSION_MESSAGE_BLOCK_SIZE) {
    blocks.push(Object.freeze(messages.slice(index, index + SESSION_MESSAGE_BLOCK_SIZE)));
  }
  return {
    snapshot: Object.freeze({ owner, generation, positions, unique, blocks: Object.freeze(blocks) }),
    toolPositions,
  };
}

function getTrackedMessages(messages: UiMessage[]): TrackedSessionMessages {
  let tracked = snapshots.get(messages);
  if (!tracked) {
    tracked = buildSnapshot(messages, {}, 0);
    snapshots.set(messages, tracked);
  }
  return tracked;
}

/** Messages and published snapshots must be treated as immutable by callers. */
export function getSessionMessageSnapshot(messages: UiMessage[]): SessionMessageSnapshot {
  return getTrackedMessages(messages).snapshot;
}

/** Includes every matching physical row; callers filter the current tool status. */
export function getSessionToolMessagePositions(messages: UiMessage[], toolCallId: string): readonly number[] {
  return getTrackedMessages(messages).toolPositions.get(toolCallId) ?? EMPTY_TOOL_POSITIONS;
}

function replaceToolPositions(
  positions: ReadonlyMap<string, readonly number[]>,
  previous: UiMessage[],
  next: UiMessage[],
  indices: readonly number[],
): ReadonlyMap<string, readonly number[]> {
  let updated: Map<string, readonly number[]> | undefined;
  for (const index of new Set(indices)) {
    const oldCall = previous[index].toolCallId;
    const newCall = next[index].toolCallId;
    if (oldCall === newCall) continue;
    updated ??= new Map(positions);
    if (oldCall !== undefined) {
      const remaining = (updated.get(oldCall) ?? []).filter((position) => position !== index);
      if (remaining.length) updated.set(oldCall, Object.freeze(remaining));
      else updated.delete(oldCall);
    }
    if (newCall !== undefined) {
      updated.set(newCall, Object.freeze([...(updated.get(newCall) ?? []), index].sort((a, b) => a - b)));
    }
  }
  return updated ?? positions;
}

/** Register a known structural edit. Unknown arrays otherwise start a new owner. */
export function registerSessionMessageRewrite(previous: UiMessage[], next: UiMessage[]): UiMessage[] {
  if (previous === next) return next;
  const snapshot = getSessionMessageSnapshot(previous);
  snapshots.set(next, buildSnapshot(next, snapshot.owner, snapshot.generation + 1));
  return next;
}

/** Register an array whose only changes are the supplied replacement positions. */
export function registerSessionMessageReplacements(
  previous: UiMessage[],
  next: UiMessage[],
  indices: readonly number[],
): UiMessage[] {
  if (previous === next) return next;
  const { snapshot, toolPositions } = getTrackedMessages(previous);
  if (
    !snapshot.unique || previous.length !== next.length ||
    indices.some((index) => !next[index] || snapshot.positions.get(next[index].id) !== index)
  ) return registerSessionMessageRewrite(previous, next);

  const blocks = snapshot.blocks.slice();
  const changedBlocks = new Set(indices.map((index) => Math.floor(index / SESSION_MESSAGE_BLOCK_SIZE)));
  for (const blockIndex of changedBlocks) {
    const start = blockIndex * SESSION_MESSAGE_BLOCK_SIZE;
    blocks[blockIndex] = Object.freeze(next.slice(start, start + SESSION_MESSAGE_BLOCK_SIZE));
  }
  snapshots.set(next, {
    snapshot: Object.freeze({
      ...snapshot,
      generation: snapshot.generation + 1,
      blocks: Object.freeze(blocks),
    }),
    toolPositions: replaceToolPositions(toolPositions, previous, next, indices),
  });
  return next;
}

export function registerSessionMessageReplacement(
  previous: UiMessage[],
  next: UiMessage[],
  index: number,
): UiMessage[] {
  return registerSessionMessageReplacements(previous, next, [index]);
}

/** Register a single append without rereading historical message identities. */
export function registerSessionMessageAppend(previous: UiMessage[], next: UiMessage[]): UiMessage[] {
  const { snapshot, toolPositions } = getTrackedMessages(previous);
  const appended = next[previous.length];
  if (
    !snapshot.unique || next.length !== previous.length + 1 ||
    !appended || snapshot.positions.has(appended.id)
  ) return registerSessionMessageRewrite(previous, next);

  const positions = new Map(snapshot.positions);
  positions.set(appended.id, previous.length);
  const blocks = snapshot.blocks.slice();
  const blockIndex = Math.floor(previous.length / SESSION_MESSAGE_BLOCK_SIZE);
  blocks[blockIndex] = Object.freeze(next.slice(blockIndex * SESSION_MESSAGE_BLOCK_SIZE));
  let nextToolPositions = toolPositions;
  if (appended.toolCallId !== undefined) {
    const updated = new Map(toolPositions);
    updated.set(appended.toolCallId, Object.freeze([
      ...(toolPositions.get(appended.toolCallId) ?? []), previous.length,
    ]));
    nextToolPositions = updated;
  }
  snapshots.set(next, {
    snapshot: Object.freeze({
      owner: snapshot.owner,
      generation: snapshot.generation + 1,
      positions,
      unique: true,
      blocks: Object.freeze(blocks),
    }),
    toolPositions: nextToolPositions,
  });
  return next;
}
