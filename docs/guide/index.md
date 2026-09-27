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

The renderer owns presentation. Electron coordinates desktop capabilities. The
Rust host owns privileged process, filesystem, RPC, and persistence boundaries.
The pi sidecar owns the agent loop and provider-facing model work.

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
