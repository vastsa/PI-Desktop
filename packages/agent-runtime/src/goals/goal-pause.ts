/** Owner pause closeout is control context, never a new user task. */
export const GOAL_PAUSE_NOTICE = "Goal paused by the user. Stop pursuing the objective now. Do not start tools, delegate work, plan or perform further substantive actions. Safely finish only operations already running. Give a brief handoff: work completed, unfinished work and any active operations. Then end this conversation promptly. Do not report the Goal completed or resume it. Prefer one reply; at most three further model requests are permitted.";

export class GoalPauseCloseout {
  private requested = false;
  private requests = 0;
  request(): boolean {
    if (this.requested) return false;
    this.requested = true; return true;
  }
  reset(): void { this.requested = false; this.requests = 0; }
  get active(): boolean { return this.requested; }
  modelRequest(): void {
    if (this.exhausted) throw new Error("Paused Goal closeout request limit reached");
    if (this.requested) this.requests++;
  }
  get exhausted(): boolean { return this.requested && this.requests >= 3; }
  allowsTool(name: string): boolean {
    return !this.requested || ["GetGoal", "UpdateGoal", "TaskStop", "TaskList"].includes(name);
  }
}
