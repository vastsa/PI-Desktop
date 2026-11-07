import type { UiMessage } from "@pi-desktop/shared";
import { messageContentFacts } from "./transcript-summary";

export type ConversationMinimapMarker = {
  id: string;
  preview: string;
};

export const CONVERSATION_MINIMAP_PREVIEW_MAX_CHARS = 280;

export function shouldRenderConversationMinimap({
  markerCount,
  overflows,
  hasEarlier,
}: {
  markerCount: number;
  overflows: boolean;
  hasEarlier: boolean;
}): boolean {
  return hasEarlier || (markerCount >= 2 && overflows);
}

/** Build one marker per user message; assistant output is not outlined. */
export function buildConversationMinimapMarkers(
  messages: UiMessage[],
): ConversationMinimapMarker[] {
  const markers: ConversationMinimapMarker[] = [];
  for (const message of messages) {
    if (message.role !== "user") continue;
    markers.push({
      id: message.id,
      preview: messageContentFacts(message).trimmedContent.slice(
        0, CONVERSATION_MINIMAP_PREVIEW_MAX_CHARS,
      ),
    });
  }
  return markers;
}
