# ADR 0144: Allow User-Configured Thinking-Level Overrides

- Status: Accepted
- Date: 2026-09-01
- Updates ADR 0114 and ADR 0134

## Context

Electron main applied a persisted `ModelBinding` before returning `ModelInfo` to
Settings, so a binding with no enabled thinking levels made a models.dev reasoning
record look non-reasoning. The same intersection blocked a compatible proxy or
newly released model whose endpoint supported a level the catalog snapshot did not
publish.

## Decision

`ModelInfo` stays the raw published models.dev record; stored binding values no
longer rewrite its published reasoning fields or capability tags, and effective
capability is resolved separately from the exact binding of the selected model.

The Settings picker always renders the seven canonical levels — `off`, `minimal`,
`low`, `medium`, `high`, `xhigh`, `max` — seeded from the published levels for a
newly added known model and shown unselected with a manual-override hint for a
non-reasoning or unknown model. Explicit selections are saved unchanged, an empty
binding or one holding only `off` disables thinking, and Composer resolves the
selected model's exact binding before rendering its reasoning menu.

## Consequences

- Correct catalog reasoning metadata stays visible in Settings even with an older
  or manually cleared binding.
- Proxies and new models can opt into thinking without a catalog update, and the
  desktop does not claim the upstream endpoint accepts the chosen level.
- No IPC, storage schema, or host protocol change is required.

## Alternatives considered

- Treat models.dev as an absolute thinking gate: it broke valid proxy
  configurations and hid published reasoning metadata.
- Add a per-model "Enable thinking" boolean: `thinkingLevels` already expresses
  both enabled levels and the deterministic default.
