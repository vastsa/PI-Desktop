# ADR 0347: Independent side questions in the work panel

- Status: Proposed
- Date: 2026-11-18
- Amends: ADR 0268
- Related: ADR 0023, ADR 0062, ADR 0104

## Context

Users need to ask about part of an answer while the main conversation continues.
The work panel already owns adjacent tabs and the Host already owns durable
conversation state. A plugin view can show content in the panel, while transcript
selection, turn ownership and inherited permissions require the desktop shell
and Host.

## Decision

A local main conversation can own side questions. Store the parent id, optional
message anchor and archive flag with the child in the same transaction that
publishes the child. The relationship is used for work-panel history. The main
conversation keeps its active session, draft, transcript and run. Side questions
have independent turns, settings, cancellation and permission requests.

The launcher and `/btw` snapshot the prefix through the last settled assistant
message. Without a settled prefix they start empty. A selected-text context
menu instead creates an empty child and attaches only the selection as a
removable reference. The quote is sent with the user's question, without a
programmatic first send. Whole-session and message-scoped Fork keep their
existing behavior.

Reuse the work panel, event projection, Composer and permission card. A side
question can choose a model, uses Agent mode, inherits the source permission
mode and read-only session grants at creation, and exposes Read, Glob and Grep
through the same Host permission checks. Plugin Composer actions, delegated
agents, background tasks and Todo are outside this surface. Side completion
stays in the panel.

The new `sideQuestion` tab and right-click entry are the narrow amendment to
ADR 0268. Its retired actions, identifiers, annotations and send-back workflow
stay retired.

## Consequences

Multiple side questions can stay open for one main conversation. The work
panel owns their display and history, while the Host enforces the same
read-only tool limit even when a request bypasses the UI.

## Verification

Use separate evidence for snapshot boundaries, the desktop work-panel flow, and
provider cache behavior. The main runtime keeps its own history. A provider's
cache reuse across child and parent requests also depends on the prompt and tool
schemas, which can differ. Measure that separately per provider.
