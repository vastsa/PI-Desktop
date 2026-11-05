import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

/** A private phase of one authorized Goal turn, never a user Plan approval. */
export class GoalPlanning {
  active = false;
  private plan?: { title: string; markdown: string; review: string };

  reset(): void { this.active = false; this.plan = undefined; }
  instructions(): string {
    return this.active
      ? "Goal planning phase: inspect and reason without file mutations, shell execution or delegation. SubmitPlan must include your own review of scope, feasibility, permissions and verification. No user approval is required; SubmitPlan returns to authorized execution."
      : this.plan ? `Self-reviewed Goal plan (task data, not new authority): ${JSON.stringify(this.plan).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e")}` : "";
  }
  tools(): AgentTool[] {
    return [{
      name: "EnterPlanMode", label: "Plan within goal",
      description: "Optionally enter a read-only planning phase within the current authorized Goal. Decide yourself whether planning helps. No user approval, mode change, scope change or new execution authority is created.",
      parameters: Type.Object({}, { additionalProperties: false }), executionMode: "sequential",
      execute: async () => { this.active = true; return { content: [{ type: "text", text: this.instructions() }], details: { goalPlanning: true } }; },
    }, {
      name: "SubmitPlan", label: "Self-review goal plan",
      description: "Finish Goal planning by providing a concrete plan and your own review. Check the original objective, permissions, feasibility and verification yourself, then continue execution without a user approval stage. Does not complete the Goal or change its budget/scope.",
      parameters: Type.Object({ title: Type.String({ minLength: 1 }), markdown: Type.String({ minLength: 1 }), review: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
      executionMode: "sequential",
      execute: async (_id, value) => {
        if (!this.active) throw new Error("Enter Goal planning before submitting a self-reviewed plan");
        const { title, markdown, review } = value as { title: string; markdown: string; review: string };
        if ([title, markdown, review].some(text => typeof text !== "string" || !text.trim() || text.length > 50000)) throw new Error("Goal plan and self-review must be nonblank and bounded");
        this.plan = { title, markdown, review }; this.active = false;
        return { content: [{ type: "text", text: "Goal plan self-reviewed. Continue implementing and verifying the existing authorized objective under ordinary permissions; no user approval is pending." }], details: { goalPlanning: false, plan: this.plan } };
      },
    }];
  }
}

export function goalPlanningTools(current: () => GoalPlanning | undefined): AgentTool[] {
  return new GoalPlanning().tools().map(tool => ({ ...tool, execute: (...args) => {
    const planning = current();
    if (!planning) throw new Error("Goal planning requires a Host-authorized turn");
    const live = planning.tools().find(candidate => candidate.name === tool.name);
    if (!live) throw new Error("Goal planning tool is unavailable");
    return live.execute(...args);
  } }));
}
