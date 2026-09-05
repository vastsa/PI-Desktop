---
name: A2A cross-conversation
description: Use when the user asks about other conversations, other sessions, a sidebar chat, a session UUID, whether you can see another chat, or wants two conversations to collaborate. Load this before saying sessions are isolated.
---

Other live Agent conversations on this host are reachable with the `A2A` tool. Do not answer that you cannot see them until you have called `A2A(action="discover")`.

## Address book

`discover` lists **parent** peers, not session UUIDs:

```
- parent-2: Parent agent for "hi" (other session)
```

- `to` is the **peer name** (`parent`, `parent-2`, …).
- The sidebar UUID is `contextId` on the card. It is not a send address.
- Titles in the description are how you match "the hi session" or "你好".

If `discover` is empty, the other chat has no live Agent runtime this app launch. Ask the user to send one message there, then discover again.

## Protocol

1. `A2A(action="discover")` — other parent agents on this host.
2. `A2A(action="send", to="<peer name>", text="...")` — create or continue a task.
3. `A2A(action="wait")` only while this turn is blocked on a reply.
4. `A2A(action="get", taskId="...")` / `complete` / `cancel` as needed.

An idle conversation does not auto-start a model turn. Your note lands on **their next user message**. Tell the user that.

Never `send` to a subagent, including your own. Delegation stays on `Task` / `TaskWait` / `TaskList` / `TaskStop`.

When the user names a session id, discover first, match `contextId`, then send to that card's `name`.
