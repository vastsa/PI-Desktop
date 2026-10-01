/**
 * The message a message-anchored slot sees (`PluginSlotMessage`,
 * `docs/plugin-plan/slot-contract.html` §2): its id, the role the slot is
 * for, its text and its time. Nothing else of the host's message crosses into
 * plugin code.
 */
import type { PluginSlotMessage } from "@pi-desktop/plugin-sdk";
import type { UiMessage } from "@pi-desktop/shared";

export function slotMessage<Role extends PluginSlotMessage["role"]>(
  role: Role,
  message: Pick<UiMessage, "id" | "content" | "createdAt">,
): PluginSlotMessage & { readonly role: Role } {
  return {
    id: message.id,
    role,
    content: message.content,
    createdAt: message.createdAt,
  };
}
