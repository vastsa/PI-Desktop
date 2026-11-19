# ADR 0067: ChatGPT-inspired empty-home starter guidance

- Status: Superseded by D206
- Date: 2026-08-07
- Related: ADR 0066, D204, D205, D206

## Context

The direct bottom composer introduced by D204 fixed the empty-home layout but
left the conversation surface sparse, so new users had to invent a prompt.

## Decision

Add a four-card starter grid between the hero and the onboarding checklist, whose
cards stay compact, monochrome, localized, and developer-specific, and whose
activation only prefills and focuses the composer.

## Consequences

Superseded by D206, which removed the grid after review and restored the hero,
the optional checklist, and the direct composer. The cards were renderer-local
presentation and copy, with no IPC, storage, or protocol change.
