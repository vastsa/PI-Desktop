/**
 * Tool policy level of a turn (ADR mode-definitions).
 *
 * Mirrors host-core `sessions::tool_policy`, which stays authoritative: an
 * open run's stage permission, else the session definition's permission,
 * else the builtin mapping. Any id without a definition other than `agent`
 * fails closed to `contract`, the Plan hard deny.
 */
import { modeStage, type Mode, type ModeDefinition, type ModePermission, type ModeTurnContext } from "@pi-desktop/shared";

export type ModePolicyInput = {
  modeId: Mode;
  /** Definition the session runs; ignored unless its id is `modeId`. */
  definition?: ModeDefinition;
  /** Trusted per-turn run context; present only for a claimed run turn. */
  modeTurn?: ModeTurnContext;
};

/** The definition that belongs to `modeId`, if the caller supplied one. */
export function ownModeDefinition(modeId: Mode, definition: ModeDefinition | undefined): ModeDefinition | undefined {
  return definition && definition.id === modeId ? definition : undefined;
}

export function modePolicyLevel({ modeId, definition, modeTurn }: ModePolicyInput): ModePermission {
  const own = ownModeDefinition(modeId, definition);
  if (own && modeTurn) return modeStage(own, modeTurn.stageId)?.permission ?? "contract";
  if (own) return own.permission;
  return modeId === "agent" ? "agent" : "contract";
}

/**
 * Computer use and scheduled-task tools belong to the builtin Agent mode
 * itself, not to every agent-level mode or stage; the Host gates them the
 * same way.
 */
export function offersAgentModeOnlyTools(modeId: Mode): boolean {
  return modeId === "agent";
}
