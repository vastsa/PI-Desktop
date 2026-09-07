# ADR 0168: Main-owned http(s)/mailto allowlist for `openExternal`

- Status: Accepted
- Date: 2026-09-06
- Deciders: PI-Desktop core
- Related: D330, ADR 0109, GitHub pull request #45

## Context

Chat markdown, plugin panels, the plugin launcher, OAuth login, and the
embedded preview all eventually call Electron `shell.openExternal`. The main
window and launcher `setWindowOpenHandler` previously forwarded the raw URL.
A prompt-injected `file:`, `javascript:`, `ms-msdt:`, or custom URI scheme
would reach the operating-system protocol handler after a user click.

Plugin `pi.shell.openExternal` already documented HTTP(S) and `mailto:` (ADR
0109). Preview and plugin-view handlers used a `/^https?:/i` prefix check,
which is weaker than a parsed URL and did not cover the app shell.

## Decision

1. Electron Main owns one parser (`parseAllowedExternalUrl`). A URL reaches
   `shell.openExternal` only when `new URL` yields `http:`, `https:` with a
   hostname and a written `//`, or `mailto:` with an address. The opener
   receives the normalized href. Control characters fail closed.
2. Disallowed URLs throw. Callers that cannot surface the error (window-open
   handlers) catch and ignore. OAuth treats a rejection as "browser did not
   open". Plugins keep `INVALID_ARGUMENT`.
3. Workspace files stay on `shell.openPath` after the existing path gate.
   Preview "open in browser" uses the allowlist for http(s)/mailto and
   `openPath` for an in-root `file:` page.
4. Main-constructed URLs (GitHub feedback, releases) still pass the parser.

## Consequences

- Custom URI schemes from chat, plugins, or `window.open` cannot launch OS
  handlers.
- `mailto:` remains a supported plugin and link target.
- `https:alert(1)`-style special-scheme filling is rejected.

## Alternatives considered

### http/https only, blocking mailto

Rejected: it would break the documented plugin API and ADR 0109.

### Prefix regex `/^https?:/i`

Rejected: it matches `https:payload` without a host and diverges from the
plugin runtime's `://` check.

### Returning `false` instead of throwing

Rejected: OAuth already maps a rejected `openExternal` promise to
`opened: false`. A silent `false` return reports success.
