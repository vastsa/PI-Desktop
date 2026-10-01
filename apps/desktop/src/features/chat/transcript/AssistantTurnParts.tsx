import { memo } from "react";
import type { AgentActivity, UiMessage } from "@pi-desktop/shared";
import type { AssistantTurnPart } from "../../../lib/assistant-turns";
import type { SubagentOutcome, SubagentTiming } from "../../../lib/subagent-topology";
import { useAppStore } from "../../../stores/app-store";
import { Markdown } from "../../../components/Markdown";
import { useSmoothText } from "../../../hooks/useSmoothText";
import { ActivityGroup } from "./ActivityGroup";
import { AssistantErrorMessage } from "./shared";
import { useRenderBlocks, type RenderBlock } from "./render-blocks";

/** Message bubble that optionally applies smooth text release. */
const SmoothMessageBubble = memo(function SmoothMessageBubble({ message, streaming }: {
  message: UiMessage;
  streaming: boolean;
}) {
  const smoothStreaming = useAppStore((s) => s.settings?.smoothStreaming !== false);
  const prefersReducedMotion = typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const enabled = smoothStreaming && !prefersReducedMotion;
  const displayContent = useSmoothText(message.content || "", streaming, enabled);
  const showCursor = streaming && enabled && (displayContent.length < (message.content || "").length);
  return (
    <div
      className={`message-bubble assistant-turn-fragment${streaming ? " streaming" : ""}${showCursor ? " smooth-cursor" : ""}`}
      data-message-id={message.id}
    >
      {displayContent ? <div className="prose-chat"><Markdown source={displayContent} /></div> : null}
      {message.error ? <AssistantErrorMessage message={message} /> : null}
    </div>
  );
});

function partKey(part: AssistantTurnPart) {
  if (part.kind === "message") return part.message.id;
  const first = part.items[0];
  return `activity-${first.message.id}-${first.kind}${first.kind === "hostedSearch" ? `-${first.round.id}` : ""}`;
}

type PartContext = {
  isActive: boolean;
  activePart?: AssistantTurnPart;
  lastActivityPart?: AssistantTurnPart;
  runtimeActivity?: AgentActivity;
  turnDelegationStatuses: ReadonlyMap<string, SubagentOutcome>;
  turnDelegationTimings: ReadonlyMap<string, SubagentTiming>;
};

const TurnPartBlock = memo(function TurnPartBlock({
  block, isActive, activePart, lastActivityPart, runtimeActivity,
  turnDelegationStatuses, turnDelegationTimings,
}: PartContext & { block: RenderBlock<AssistantTurnPart> }) {
  return <>{block.items.map((part) => part.kind === "activity" ? (
    <ActivityGroup
      embedded
      key={partKey(part)}
      items={part.items}
      endedAt={part.endedAt}
      isActive={part === activePart}
      isLast={part === lastActivityPart}
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
  return <>{blocks.map((block) => {
    const activePart = context.activePart && block.items.includes(context.activePart) ? context.activePart : undefined;
    const lastActivityPart = context.lastActivityPart && block.items.includes(context.lastActivityPart) ? context.lastActivityPart : undefined;
    return <TurnPartBlock
      key={block.key}
      block={block}
      isActive={context.isActive}
      activePart={activePart}
      lastActivityPart={lastActivityPart}
      runtimeActivity={activePart ? context.runtimeActivity : undefined}
      turnDelegationStatuses={context.turnDelegationStatuses}
      turnDelegationTimings={context.turnDelegationTimings}
    />;
  })}</>;
});
