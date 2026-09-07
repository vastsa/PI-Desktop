/**
 * Roundtable Discussion plugin entry point.
 * Registers an agent tool that returns orchestration instructions for running
 * a multi-agent roundtable through independent Task reports.
 *
 * Host injects global `pi`.
 */

const DEFAULT_AGENTS = ["architect", "security-reviewer", "ux-designer"];
const DEFAULT_ROUNDS = 3;

/**
 * Build the step-by-step orchestration instruction the parent agent should
 * follow to run the roundtable.
 */
function buildInstruction({ topic, agents, rounds, goal }) {
  const roles = agents && agents.length > 0 ? agents : DEFAULT_AGENTS;
  const numRounds = typeof rounds === "number" ? Math.max(1, Math.min(5, rounds)) : DEFAULT_ROUNDS;
  const goalLine = goal ? `The discussion goal is: ${goal}` : "The discussion should converge on a clear, actionable conclusion.";
  const roleList = roles.map((r) => `"${r}"`).join(", ");
  const peerList = roles.map((r) => `  - ${r}`).join("\n");

  return [
    `## Roundtable orchestration plan`,
    ``,
    `**Topic:** ${topic}`,
    `**Participants:** ${roleList}`,
    `**Rounds:** ${numRounds}`,
    `${goalLine}`,
    ``,
    `Follow these steps exactly to run the roundtable. Delegates do not message`,
    `each other; you collect independent reports with TaskWait.`,
    ``,
    `### Step 1 — Roles`,
    ``,
    `Roles:`,
    peerList,
    ``,
    `Each Task brief must contain:`,
    `- Its assigned role name.`,
    `- The discussion topic: "${topic}"`,
    `- The list of all other participants.`,
    `- The current round number and total rounds (${numRounds}).`,
    `- The discussion protocol (below).`,
    ``,
    `### Step 2 — Protocol to include in every brief`,
    ``,
    `> **Discussion protocol**`,
    `>`,
    `> 1. **Opening round** — State your initial position from your role's`,
    `>    perspective. Return it as the task result.`,
    `> 2. **Later rounds** — The brief includes other roles' previous reports.`,
    `>    Respond to the strongest challenges, refine your position, and return a`,
    `>    self-contained update.`,
    `> 3. **Closing round** — Return a final recommendation, what changed your`,
    `>    mind, and any unresolved concerns.`,
    ``,
    `### Step 3 — Start all roles concurrently`,
    ``,
    `Use Task to start every role at the same time. Give each one a task`,
    `description that says:`,
    ``,
    `  "Participate in a roundtable on: ${topic}.`,
    `   Your role is <role>. Other participants: <other roles>.`,
    `   This is round 1 of ${numRounds}. Follow the protocol in your brief,`,
    `   then return your position summary."`,
    ``,
    `### Step 4 — Wait and iterate`,
    ``,
    `Call TaskWait to collect reports. For each remaining round, start a new`,
    `concurrent Task batch whose briefs include the previous reports attributed`,
    `by role. Then TaskWait again.`,
    ``,
    `### Step 5 — Synthesize`,
    ``,
    `After the last round:`,
    `1. Summarize the key positions from each role.`,
    `2. Identify points of agreement and disagreement.`,
    `3. Highlight unresolved concerns.`,
    `4. Produce a final recommendation or conclusion based on the discussion.`,
    `${goal ? `5. Evaluate whether the goal was achieved: "${goal}"` : ""}`,
    ``,
    `Present the synthesis to the user as the roundtable outcome.`,
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

async function onLoad() {
  await pi.agent.registerTool({
    name: "roundtable_start",
    description: "Launch a multi-agent roundtable discussion on a given topic",
    risk: "low",
    schema: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          description: "The discussion topic or question",
        },
        agents: {
          type: "array",
          items: { type: "string" },
          description:
            "Agent roles/perspectives to include, e.g. ['architect', 'security-reviewer', 'ux-designer']",
        },
        rounds: {
          type: "integer",
          minimum: 1,
          maximum: 5,
          description: "Number of discussion rounds (default 3)",
        },
        goal: {
          type: "string",
          description:
            "What the discussion should produce, e.g. 'a consensus architecture decision'",
        },
      },
      required: ["topic"],
    },
    execute: async (args) => {
      const topic = String(args?.topic ?? "");
      if (!topic) {
        return { ok: false, error: "topic is required" };
      }
      const instruction = buildInstruction({
        topic,
        agents: args?.agents,
        rounds: args?.rounds,
        goal: args?.goal,
      });
      return {
        ok: true,
        instruction,
        pluginId: pi.plugin.getId(),
      };
    },
  });
}

async function onUnload() {
  await pi.agent.unregisterTool("roundtable_start");
}

module.exports = {
  onLoad,
  onUnload,
};
