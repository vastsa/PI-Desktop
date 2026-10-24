import { memo } from "react";
import type { AgentActivity, UiMessage } from "@pi-desktop/shared";
import type { AssistantTurnPart } from "../../../lib/assistant-turns";
import type { SubagentOutcome, SubagentTiming } from "../../../lib/subagent-topology";
import { useAppStore } from "../../../stores/app-store";
import { Markdown } from "../../../components/Markdown";
import { useSmoothText } from "../../../hooks/useSmoothText";
import { useSlotSessionId } from "../../../plugins/renderer-slots/use-slots";
import { GenUiCards } from "../gen-ui/GenUiCard";
import { useGenUiSplit } from "../gen-ui/gen-ui-split";
import { isGenUiRemoteOwner } from "../gen-ui/gen-ui-source";
import { ActivityGroup } from "./ActivityGroup";
import { AssistantErrorMessage } from "./shared";
import { useRenderBlocks, type RenderBlock } from "./render-blocks";

/** Message bubble that optionally applies smooth text release. */
const SmoothMessageBubble = memo(function SmoothMessageBubble({ message, streaming }: {
  message: UiMessage;
  streaming: boolean;
}) {
  const smoothStreaming = useAppStore((s) => s.settings?.smoothStreaming !== false);
  // Opt-in feature: an absent setting keeps cards out of the transcript.
  const inlineVisualizations = useAppStore((s) => s.settings?.inlineVisualizations === true);
  const prefersReducedMotion = typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const enabled = smoothStreaming && !prefersReducedMotion;
  const displayContent = useSmoothText(message.content || "", streaming, enabled);
  const showCursor = streaming && enabled && Boolean(displayContent);
  const genUi = useGenUiSplit(displayContent, streaming, inlineVisualizations);
  // Cards load the pane session's own copy, never the session a path names.
  const sessionId = useSlotSessionId();
  const remote = useAppStore((s) =>
    isGenUiRemoteOwner(sessionId, s.sessions.find((session) => session.id === sessionId)),
  );
  return (
    <div
      className={`message-bubble assistant-turn-fragment${streaming ? " streaming" : ""}${showCursor ? " smooth-cursor" : ""}`}
      data-message-id={message.id}
    >
      {genUi.content ? <div className="prose-chat"><Markdown source={genUi.content} streaming={streaming} /></div> : null}
      <GenUiCards references={genUi.references} sessionId={sessionId} remote={remote} />
      {message.error ? <AssistantErrorMessage message={message} /> : null}
    </div>
  );
});

function partKey(part: AssistantTurnPart) {
  if (part.kind === "message") return part.message.id;
  const first = part.items[0];
  return `activity-${first.message.id}-${first.kind}${first.kind === "hostedSearch" ? `-${first.round.id}` : ""}`;
}

/**
 * Whether a rendered part owns the active tail.
 *
 * A command-folding segment may coalesce contiguous activity parts into a new
 * part object while keeping the source rows. The active tail is the last entry
 * part, so the coalesced part's last row is the same row object; no id fallback
 * or nested scan is needed.
 */
function partOwnsActivePart(
  part: AssistantTurnPart,
  activePart: AssistantTurnPart,
): boolean {
  if (part === activePart) return true;
  if (part.kind !== "activity" || activePart.kind !== "activity") {
    return false;
  }
  const activeRow = activePart.items.at(-1);
  return activeRow !== undefined && part.items.at(-1) === activeRow;
}

type PartContext = {
  isActive: boolean;
  activePart?: AssistantTurnPart;
  runtimeActivity?: AgentActivity;
  turnDelegationStatuses: ReadonlyMap<string, SubagentOutcome>;
  turnDelegationTimings: ReadonlyMap<string, SubagentTiming>;
};

const TurnPartBlock = memo(function TurnPartBlock({
  block, isActive, activePart, runtimeActivity,
  turnDelegationStatuses, turnDelegationTimings,
}: PartContext & { block: RenderBlock<AssistantTurnPart> }) {
  return <>{block.items.map((part) => part.kind === "activity" ? (
    <ActivityGroup
      embedded
      key={partKey(part)}
      items={part.items}
      endedAt={part.endedAt}
      isActive={part === activePart}
      runtimeActivity={part === activePart ? runtimeActivity : undefined}
      turnDelegationStatuses={turnDelegationStatuses}
      turnDelegationTimings={turnDelegationTimings}
    />
  ) : (
    <SmoothMessageBubble
      key={part.message.id}
      message={part.message}
      streaming={isActive && part.message.status === "streaming"}
    />
  ))}</>;
});

export const AssistantTurnParts = memo(function AssistantTurnParts({ parts, ...context }: PartContext & {
  parts: readonly AssistantTurnPart[];
}) {
  const blocks = useRenderBlocks(parts, partKey);
  const activeSourcePart = context.activePart;
  return <>{blocks.map((block) => {
    // The active tail is an entry part, but an off-mode segment may wrap its
    // rows in a new merged part. Match by source row so the group that owns the
    // live step still gets its active defaults.
    const activePart = activeSourcePart
      ? block.items.find((part) => partOwnsActivePart(part, activeSourcePart))
      : undefined;
    return <TurnPartBlock
      key={block.key}
      block={block}
      isActive={context.isActive}
      activePart={activePart}
      runtimeActivity={activePart ? context.runtimeActivity : undefined}
      turnDelegationStatuses={context.turnDelegationStatuses}
      turnDelegationTimings={context.turnDelegationTimings}
    />;
  })}</>;
});
