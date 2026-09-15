// ADR 0257: adaptive thinking level. The agent inspects and changes the
// session's thinking level through these two tools. Guidance is embedded in
// the tool descriptions (static text loaded once per session), never in the
// per-turn system prompt, so the prompt-cache prefix survives.
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export default function (pi) {
  pi.registerTool(
    defineTool({
      name: "get_thinking_level",
      label: "Get thinking level",
      description:
        "Inspect the current thinking level and the levels the selected model supports. " +
        "Call this when the level is uncertain; do not poll it every turn.",
      parameters: Type.Object({}),
      async execute() {
        const level = pi.getThinkingLevel();
        const supported = pi.getThinkingLevels();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ level, supported }),
            },
          ],
          details: { level, supported },
        };
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "set_thinking_level",
      label: "Set thinking level",
      description:
        "Set the thinking level for solving the current task. Proactively raise it for " +
        "ambiguity, debugging, risky changes, or multi-step synthesis; keep it low for " +
        "routine trivial operations. Use get_thinking_level first when uncertain. " +
        "With persist=false (default) the change lasts for the current turn and reverts " +
        "afterwards; with persist=true it becomes the session baseline.",
      parameters: Type.Object({
        level: Type.Union(
          LEVELS.map((value) => Type.Literal(value)),
          { description: "Thinking level to apply" },
        ),
        persist: Type.Optional(
          Type.Boolean({
            description:
              "true keeps the level as the session baseline; false (default) applies it to the current turn only",
          }),
        ),
      }),
      async execute(_id, params) {
        const accepted = pi.setThinkingLevel(params.level, {
          persist: params.persist === true,
        });
        if (!accepted) {
          return {
            content: [
              {
                type: "text",
                text: `Rejected "${params.level}". Valid levels: ${LEVELS.join(", ")}.`,
              },
            ],
            details: { ok: false },
          };
        }
        const effective = pi.getThinkingLevel();
        const scope = params.persist === true ? "session baseline" : "current turn (reverts afterwards)";
        return {
          content: [
            {
              type: "text",
              text: `Thinking level set to "${effective}" for the ${scope}.`,
            },
          ],
          details: { ok: true, level: effective, persist: params.persist === true },
        };
      },
    }),
  );
}
