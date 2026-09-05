# Roundtable Discussion Plugin

A PI-Desktop plugin that helps the parent agent run a structured multi-agent
roundtable. Each role is an independent `Task`; the parent collects reports
and synthesizes them. Delegates do not message each other.

## What it provides

- **Skill** (`local.roundtable/roundtable`): When to use a roundtable, how to
  pick roles, and how to run sequential rounds through `Task` / `TaskWait`.
- **Agent tool** (`roundtable_start`): Returns an orchestration plan the
  parent follows using Task and TaskWait.

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
3. Start one `Task` per role concurrently.
4. Wait with TaskWait and collect independent reports.
5. Optionally start a later round whose briefs include the first-round
   reports.
6. Synthesize a recommendation for the user.

### Custom roles and options

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
