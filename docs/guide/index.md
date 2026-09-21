---
title: Start here
description: A short orientation to the PI-Desktop product and its documentation.
---

# Start here

PI-Desktop is a local-first AI coding agent desktop client. The app keeps the
workspace, host process, agent runtime, and provider configuration visible and
inspectable while still making everyday coding work feel direct.

## Choose a path

| If you want to… | Start with |
|---|---|
| See what the app looks like | [Screens](/guide/screenshots) |
| Run recurring local tasks | [Scheduled tasks](/guide/automations) |
| Understand what is shipped | [Product scope](/spec/01-product/01-product-scope) |
| Learn how the system fits together | [Architecture](/spec/02-architecture/01-architecture) |
| Trace a protocol or storage boundary | [Runtime specs](/spec/03-runtime/01-ipc-protocol) |
| Build an extension | [Plugin development](/plugin-development) |
| Understand why a decision exists | [ADR index](/adr/README) |
| Validate a user-visible change | [E2E test plan](/spec/06-delivery/04-e2e-test-plan) |

The Chinese entry follows this same path: [open the bilingual guide](/zh-CN/guide/)
to read the localized orientation and jump into the matching topic map.

## The mental model

```text
Renderer UI  →  Electron orchestration  →  Rust host core
      ↓                    ↓                       ↓
  transcript          pi Node sidecar          SQLite + processes
```

The renderer owns presentation. Electron main coordinates desktop capabilities:
window lifecycle, IPC routing, process supervision, the update client, and the
plugin, MCP-bridge, and optional loopback MCP-control services. The Rust host
owns tool execution and the workspace sandbox, the permission gateway, plugin
host services, RPC, and persistence. The pi sidecar owns the agent loop and
provider-facing model work.

## Working with the docs

The documentation is English-first at the source-of-truth level. The [中文入口](/zh-CN/)
provides the same information architecture and a complete translated companion
for every specification. Each Chinese page links back to its English source;
technical identifiers remain unchanged so search and cross-reference paths stay
stable. Use global search when you know a term, protocol method, or decision
number; use the sidebar when you are exploring a domain.

## Before you change a boundary

1. Read the relevant spec.
2. Check the linked ADRs and the decisions log.
3. Update the E2E scenario when behavior is user-visible or protocol-visible.
4. Run the narrowest useful validation, then record the result in the change.

See the [AI development workflow](/spec/06-delivery/03-ai-development-workflow)
and [change checklist](/spec/06-delivery/05-change-checklist) for the complete
repository rules.


## Ask for changes from a review

Open the right-side **Review** panel and expand a recorded change. Hover beside a code line and click **+** to comment, or hold and drag it
across several lines in the same block. Release to focus the inline editor.
Shift-click remains available as an alternative.
Enter your feedback below the selected code and choose **Save comment**.
The saved comment stays directly below its selected code in Review. You can
remove it there. A collapsed change shows a comment marker. In the main chat,
use **Review** at the bottom right inside an expanded change to reveal it in the review panel,
or **Open** to view the current file. Choose **Send** in the chat input to send it with your next message; saving
a comment does not execute it. No comment card appears above the chat input.

One comment can be pending per conversation. Send or remove it before adding
another. Switching conversations hides the attachment until you return to its
original workspace and conversation. An unsent comment is a memory-only draft
and does not survive an application restart.

Line numbers refer to the original change snapshot. The agent receives the
quoted code and your comment with an instruction to read the current file
before making changes. Review feedback does not automatically validate or
apply an old patch. Existing permissions and rollback conflict checks still
apply.

Review/Open actions are visible only inside an expanded transcript diff,
right-aligned below its code in the same row as the existing rollback action.
Collapsing the change hides the action row.

Gutter plus buttons support single-click and pointer-drag comments with
release-to-edit focus. No permanent selection hint is rendered. Shift-click
remains optional; pointer cancellation and focus loss abort tentative drags.
