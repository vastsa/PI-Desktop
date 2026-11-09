import type { Mode, PlanningState } from "@pi-desktop/shared";

/**
 * Which sessions the plan proposal pipeline (ADR 0053) speaks for
 * (ADR mode-definitions).
 *
 * The pipeline owns the mode of Agent and Plan sessions: entering Plan,
 * submitting a proposal and resolving it move the session between the two.
 * Goal runs as a staged mode and user modes have no proposal, yet host-core
 * still answers `planning` for every session that is not in Agent. That
 * answer must not show Plan-style planning copy for those sessions and must
 * not rename them to `plan`. A legacy Goal proposal that still awaits
 * approval keeps its approval state so it can be resolved.
 */
export function planningOwnsMode(mode: Mode | undefined): boolean {
  return mode === undefined || mode === "agent" || mode === "plan";
}

/** The planning state the renderer shows for a session in `mode`. */
export function visiblePlanningState(
  mode: Mode | undefined,
  hostState: PlanningState,
  proposalPending: boolean,
): PlanningState {
  if (planningOwnsMode(mode) || hostState === "inactive") return hostState;
  return hostState === "awaiting_approval" && proposalPending ? "awaiting_approval" : "inactive";
}

/**
 * The session mode after a plan update. `inactive` from the Host means the
 * session is in Agent again, whatever the renderer last knew; otherwise a
 * mode the pipeline does not own is left as it is.
 */
export function modeAfterPlanningUpdate(
  mode: Mode | undefined,
  hostState: PlanningState,
  projectedMode: () => Mode,
): Mode {
  if (mode === undefined || planningOwnsMode(mode) || hostState === "inactive") return projectedMode();
  return mode;
}
