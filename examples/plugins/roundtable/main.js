/**
 * Roundtable Discussion plugin entry point.
 * Registers an agent tool that returns orchestration instructions for running
 * a multi-agent roundtable discussion via peer messaging.
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
    `Follow these steps exactly to run the roundtable:`,
    ``,
    `### Step 1 — Create subagent definitions`,
    ``,
    `For each role listed below, create a temporary subagent definition (or reuse`,
    `an existing one that already declares PeerSend, PeerInbox, and PeerWait).`,
    `Each definition must include the tools: PeerSend, PeerInbox, PeerWait.`,
    ``,
    `Roles:`,
    peerList,
    ``,
    `Each subagent's system brief must contain:`,
    `- Its assigned role name.`,
    `- The discussion topic: "${topic}"`,
    `- The list of all other participants so it knows who to address.`,
    `- The number of discussion rounds: ${numRounds}.`,
    `- The discussion protocol (below).`,
    ``,
    `### Step 2 — Write each subagent's brief`,
    ``,
    `Include the following protocol in every subagent brief:`,
    ``,
    `> **Discussion protocol**`,
    `>`,
    `> 1. **Opening round** — State your initial position on the topic from your`,
    `>    role's perspective. PeerSend your opening statement to all other`,
    `>    participants.`,
    `> 2. **Discussion rounds (${numRounds} total)** — At the start of each round:`,
    `>    a. Call PeerInbox to read messages from other participants.`,
    `>    b. Respond to specific points raised by others. PeerSend to a specific`,
    `>       peer when replying directly; broadcast for general observations.`,
    `>    c. Challenge assumptions, refine your position, and look for areas of`,
    `>       agreement.`,
    `>    d. Keep messages focused and substantive — no narration or filler.`,
    `> 3. **Closing round** — Write a final position summary and list any`,
    `>    unresolved concerns. PeerSend your summary to all peers, then return`,
    `>    your final report as your task result.`,
    ``,
    `### Step 3 — Start all subagents concurrently`,
    ``,
    `Use Task to start every subagent at the same time. Give each one a task`,
    `description that says:`,
    ``,
    `  "Participate in a roundtable discussion on: ${topic}.`,
    `   Your role is <role>. Other participants: <other roles>.`,
    `   Follow the discussion protocol in your brief for ${numRounds} rounds,`,
    `   then return your final position summary."`,
    ``,
    `### Step 4 — Wait for completion`,
    ``,
    `Call TaskWait to wait for all subagent tasks to finish. Collect their final`,
    `reports.`,
    ``,
    `### Step 5 — Synthesize`,
    ``,
    `After all reports are collected:`,
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
