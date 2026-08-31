# Roundtable Discussion Plugin

A PI-Desktop plugin that enables structured multi-agent roundtable discussions.
Multiple subagents, each playing a distinct expert role, debate a topic through
peer messaging and converge on a well-reasoned conclusion.

## What it provides

- **Skill** (`local.roundtable/roundtable`): Teaches the agent how to
  orchestrate a roundtable — role selection, the three-phase discussion
  protocol, peer messaging patterns, and synthesis.
- **Agent tool** (`roundtable_start`): Returns a detailed orchestration plan
  that the parent agent follows to set up and run the discussion using Task,
  PeerSend/PeerInbox/PeerWait, and TaskWait.

## Install (dev-load)

1. Open PI-Desktop.
2. Go to **Plugins**.
3. Open the header overflow menu and choose **Load development plugin**.
4. Select the `examples/plugins/roundtable` directory.

The plugin activates on startup and the skill and tool are available
immediately.

## Usage

Ask the agent to run a roundtable. For example:

> Run a roundtable on whether we should use GraphQL or REST for the API.

The agent will:

1. Call `roundtable_start` with the topic.
2. Receive a step-by-step orchestration plan.
3. Create subagent definitions for each role (default: architect, security
   reviewer, UX designer).
4. Start all subagents concurrently with Task.
5. Wait for them to finish their multi-round discussion.
6. Synthesize the results into a final recommendation.

### Custom roles and options

You can specify roles, round count, and a goal:

> Run a roundtable on our authentication strategy with roles: security-engineer,
> backend-developer, mobile-developer, devops-engineer. Use 4 rounds and
> produce a concrete implementation plan.

## Tool parameters

| Parameter | Type     | Required | Description                                |
|-----------|----------|----------|--------------------------------------------|
| `topic`   | string   | yes      | The discussion topic or question           |
| `agents`  | string[] | no       | Roles to include (default: architect, security-reviewer, ux-designer) |
| `rounds`  | integer  | no       | Number of rounds, 1–5 (default: 3)         |
| `goal`    | string   | no       | What the discussion should produce         |

## Permissions

- `agent.prompt.inject` — injects the roundtable skill into the agent context.
- `agent.tool.register` — registers the `roundtable_start` tool.

## License

Part of PI-Desktop examples. See the repository root for license terms.
