# ADR 0168: Main-owned http(s)/mailto allowlist for `openExternal`

- Status: Accepted
- Date: 2026-09-06
- Related: ADR 0109, D330, GitHub pull request #45

## Context

Chat markdown, plugin panels, the launcher, OAuth login, and the embedded preview
all reach `shell.openExternal`, and the window-open handlers forwarded raw URLs,
so a prompt-injected `file:`, `javascript:`, `ms-msdt:`, or custom scheme could
reach an OS protocol handler after one click. Preview and plugin-view handlers
used a `/^https?:/i` prefix check, which is weaker than parsing.

## Decision

Electron Main owns one parser, `parseAllowedExternalUrl`: a URL reaches
`shell.openExternal` only when `new URL` yields `http:`, `https:` with a hostname
and a written `//`, or `mailto:` with an address, and control characters fail
closed. Disallowed URLs throw, so window-open handlers catch and ignore, OAuth
reports "browser did not open", and plugins keep `INVALID_ARGUMENT`.

## Consequences

- Custom URI schemes cannot launch OS handlers, while `mailto:` stays supported
  and `https:alert(1)`-style scheme filling is rejected.

## Alternatives considered

- Block `mailto:`: rejected; it breaks the documented plugin API and ADR 0109.
- Keep the prefix regex: rejected; it matches `https:payload` without a host.
