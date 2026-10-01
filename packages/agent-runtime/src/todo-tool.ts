import { Type } from "@earendil-works/pi-ai";

export const todoWriteDescription =
  "Write the task checklist for the current session so the user can see progress on multi-step work. Use for work that needs 3+ distinct steps or spans multiple files/subsystems; do not use for a single-step action, a question, a read, or a review. Every call replaces the full list in display order. States are pending, in_progress, completed, and cancelled; only one item may be in_progress. Keep items short and concrete, update the list as work starts and finishes, and never leave pending items when the task is done. Content longer than 500 Unicode characters is truncated by the host with a warning.";

export const todoWriteParameters = {
  todos: Type.Array(
    Type.Object({
      // The host owns normalization and reports any truncation to the model.
      content: Type.String({ minLength: 1 }),
      status: Type.Union([
        Type.Literal("pending"),
        Type.Literal("in_progress"),
        Type.Literal("completed"),
        Type.Literal("cancelled"),
      ]),
      priority: Type.Optional(
        Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")]),
      ),
    }),
    { maxItems: 50 },
  ),
};
