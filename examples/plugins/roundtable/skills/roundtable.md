---
name: Roundtable Discussion
description: Orchestrate a structured multi-agent roundtable where each role reports independently through Task and the parent synthesizes the outcome.
---

# Roundtable Discussion

A roundtable discussion is a structured collaboration pattern in which multiple
subagents, each assigned a distinct role or perspective, examine a topic and
return independent reports. The parent agent collects those reports and
synthesizes a conclusion. Delegates do not message each other.

## When to use a roundtable

Use a roundtable when the user's request benefits from multiple expert
perspectives examined in tension with each other. Common scenarios include
architecture decisions, technology selection, design trade-offs, risk
assessments, code review from multiple angles, and policy evaluations. A
roundtable is not the right tool for straightforward implementation tasks or
factual lookups.

## Core concepts

**Roles.** Each subagent plays a single role for the entire discussion. A role
is a professional perspective such as "architect", "security-reviewer",
"ux-designer", "performance-engineer", or "product-manager". Choose roles that
will naturally produce productive disagreement. Three to five roles work well;
more than five tends to produce noise without proportionally deeper insight.

**Independent reports.** Subagents do not talk to each other. Each `Task`
returns a self-contained report. The parent is the only integration point:
it starts concurrent Tasks, waits with TaskWait, and may start a later round
whose brief includes earlier reports.

**Rounds.** The discussion proceeds in a fixed number of rounds, typically three.
Round 1 is opening positions. Later rounds receive the previous reports in
the brief so each role can respond, concede, or hold. The round count is
communicated to every subagent so each knows when to wrap up.

**Convergence.** Each round should move the group closer to agreement or at
least to a clear articulation of remaining disagreements. Reports should
acknowledge points they agree with, concede when another perspective is
stronger, and flag genuine unresolved tensions.

## The discussion protocol

Every subagent follows the same protocol for the round it is in.

### Opening round

State the initial position from this role's perspective: what this role cares
about, what risks it sees, and what outcome it favors. Keep it concise. Return
that position as the task result.

### Later rounds

The brief includes the other roles' previous reports. Identify the most
important challenges directed at this role, respond substantively, and refine
the position. If another argument is convincing, say so and adjust. Return a
self-contained updated position — do not assume the parent still has the
opening report in context.

### Closing round

Return a final position that includes:

- The role's final recommendation.
- Key points from other reports that influenced this position.
- Any unresolved concerns the group did not fully address.

## How the parent agent orchestrates

The parent agent (you, when the user asks for a roundtable) is the conductor.
You do not participate as a role. Your responsibilities are:

1. **Define the roles.** Pick three to five roles relevant to the topic. If
   the user specifies roles, use those.

2. **Start all roles concurrently.** Use Task to launch every role at the
   same time. Each brief must contain the assigned role, the topic, the list
   of other participants, the round number, and the protocol above.

3. **Wait for completion.** Call TaskWait to collect reports. If a subagent
   times out or fails, note its absence in the synthesis.

4. **Later rounds.** For each remaining round, start a new concurrent batch
   whose briefs include the previous reports (attributed by role). Do not ask
   delegates to message each other.

5. **Synthesize.** After the last round, produce a synthesis for the user
   that includes each role's final position, agreement, disagreement,
   unresolved concerns, and a recommendation if the group converged.

## Practical tips

- **Keep reports focused.** Two to four short paragraphs that make concrete
  points. Avoid long monologues.

- **Default roles when none are specified.** For software topics: architect,
  security reviewer, and UX designer.

- **Respect the round limit.** If the topic is not resolved, closing reports
  should capture the state of the debate rather than force agreement.

## Invoking the roundtable

Use the `roundtable_start` tool to generate the full orchestration plan. Pass
the topic, optional role list, optional round count, and optional goal. The
tool does not start subagents itself; it gives you the plan and you execute
it using Task and TaskWait.
