---
name: Roundtable Discussion
description: Orchestrate a structured multi-agent roundtable where subagents debate a topic through peer messaging and converge on a conclusion.
---

# Roundtable Discussion

A roundtable discussion is a structured collaboration pattern in which multiple
subagents, each assigned a distinct role or perspective, debate a topic through
peer messaging. The goal is to surface diverse viewpoints, challenge
assumptions, and converge on a well-reasoned conclusion that no single
perspective would reach alone.

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

**Peer messaging.** Subagents communicate exclusively through the PeerSend,
PeerInbox, and PeerWait tools. PeerSend delivers a message to a named peer or
broadcasts it to all peers. PeerInbox retrieves messages that other peers have
sent. PeerWait blocks until at least one new message arrives, which is useful
when a subagent finishes its turn early and needs to wait for others.

**Rounds.** The discussion proceeds in a fixed number of rounds, typically three.
Each round has a clear purpose: opening positions, iterative debate, and closing
summaries. The round count is communicated to every subagent in its brief so
that each participant knows when to wrap up.

**Convergence.** The discussion is not a free-form chat. Each round should move
the group closer to agreement or at least to a clear articulation of the
remaining disagreements. Subagents should actively acknowledge points they agree
with, concede when another perspective is stronger, and flag genuine unresolved
tensions rather than repeating their opening position.

## The discussion protocol

Every subagent follows the same three-phase protocol.

### Phase 1 — Opening round

Each subagent states its initial position on the topic from its role's
perspective. The opening statement should be concise and substantive: what does
this role care about, what risks does it see, and what outcome does it favor?
After composing the statement, the subagent uses PeerSend to broadcast it to
all other participants. Then it calls PeerWait or PeerInbox to see the opening
statements from others before proceeding to the discussion phase.

### Phase 2 — Discussion rounds

For each discussion round (the total number is specified in the brief):

1. Call PeerInbox to read all new messages from other participants.
2. Identify the most important points, challenges, or questions directed at
   this role.
3. Respond to those points substantively. Use PeerSend addressed to a specific
   peer when responding directly to that peer's argument. Use a broadcast
   PeerSend for observations relevant to the whole group.
4. Refine the role's position based on what was learned. If another
   participant's argument is convincing, say so explicitly and adjust.
5. Avoid filler, narration, or restating points that have already been
   acknowledged. Every message should advance the discussion.

Subagents should check PeerInbox at the start of every thinking cycle, not
only at the formal round boundary. If a subagent finishes composing a response
before others have sent theirs, it should call PeerWait to avoid busy-looping.

### Phase 3 — Closing round

Each subagent composes a final position summary that includes:

- The role's final recommendation or position.
- Key points from other participants that influenced this position.
- Any unresolved concerns or risks the group did not fully address.

The subagent broadcasts its closing summary via PeerSend, then returns its
final report as the task result. The report is what the parent agent collects
after calling TaskWait.

## How the parent agent orchestrates

The parent agent (you, when the user asks for a roundtable) is the conductor.
You do not participate in the discussion itself. Your responsibilities are:

1. **Define the roles.** Pick three to five roles relevant to the topic. If
   the user specifies roles, use those. Otherwise, choose roles that will
   produce constructive friction.

2. **Create subagent definitions.** For each role, create a temporary subagent
   definition that includes PeerSend, PeerInbox, and PeerWait in its tool
   list. The definition's system brief must contain:
   - The assigned role name.
   - The discussion topic.
   - The list of all other participants (by role name).
   - The number of discussion rounds.
   - The full discussion protocol described above.

3. **Start all subagents concurrently.** Use Task to launch every subagent at
   the same time. The task description for each should read: "Participate in a
   roundtable discussion on: <topic>. Your role is <role>. Other participants:
   <other roles>. Follow the discussion protocol in your brief for N rounds,
   then return your final position summary."

4. **Wait for completion.** Call TaskWait to collect all final reports. If a
   subagent times out or fails, note its absence in the synthesis.

5. **Synthesize.** After collecting all reports, produce a synthesis for the
   user that includes:
   - A summary of each role's final position.
   - Points of agreement across roles.
   - Points of disagreement and the arguments on each side.
   - Unresolved concerns.
   - A final recommendation or decision, if the group converged on one.
   - An assessment of whether the stated goal was achieved.

## Practical tips

- **Keep messages focused.** A good peer message is two to four sentences that
  make a concrete point. Avoid long monologues; they slow down the round and
  make it harder for peers to respond to specific arguments.

- **Check PeerInbox early and often.** A subagent that composes a long response
  without reading incoming messages may address points that were already
  conceded or miss a critical question.

- **Claim resources before modifying them.** If the roundtable involves
  subagents that might touch shared resources (files, state), each subagent
  should declare what it intends to modify in its opening statement so others
  can coordinate. In practice, most roundtables are purely advisory and
  subagents only exchange text.

- **Use the goal to steer synthesis.** When the user provides a goal (for
  example, "decide between GraphQL and REST"), evaluate the discussion
  outcome against that goal explicitly. If the roundtable did not produce a
  clear answer, say so honestly and explain what additional information would
  resolve the remaining disagreement.

- **Respect the round limit.** The fixed round count prevents the discussion
  from running indefinitely. If the topic is not resolved within the allotted
  rounds, the closing summaries should capture the state of the debate rather
  than trying to force premature agreement.

- **Default roles when none are specified.** If the user does not name specific
  roles, a good default set for software topics is: architect, security
  reviewer, and UX designer. For non-software topics, pick three domain
  experts whose perspectives are most likely to conflict productively.

## Invoking the roundtable

Use the `roundtable_start` tool to generate the full orchestration plan. Pass
the topic, optional role list, optional round count, and optional goal. The
tool returns a detailed step-by-step instruction that you should follow to
set up and run the roundtable. The tool does not start subagents itself; it
gives you the plan and you execute it using Task, PeerSend, PeerInbox,
PeerWait, and TaskWait.
