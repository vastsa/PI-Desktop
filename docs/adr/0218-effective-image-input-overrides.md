# ADR 0218: Effective Image-Input Overrides Across Composer and Transport

- Status: Accepted
- Date: 2026-09-11
- Amends: ADR 0101, D243

## Context

A provider binding can override whether an endpoint accepts image input with a
three-state `supportsImages`: `null` follows the published model record while
`true` and `false` enable or disable it. Composer model rows read the vision
badge from the published catalog alone, so the badge and the transport decision
could disagree.

## Decision

Resolve one effective image-input capability per provider/model binding, where an
explicit `supportsImages` wins and `null` or absence follows the published model
capability, and use that result for the Composer badge, attachment status, and
main-process image transport without mutating the shared `ModelInfo` record.
Unknown or custom model ids stay conservative when no binding override exists,
because discovery or cache metadata alone cannot promote them to image
transport. The attachment boundary is unchanged: eligible images within the app
limit become transient image blocks, and disabled, unknown, or oversized images
fall back to `@path`.

## Consequences

- A binding describes a custom or proxied endpoint the same way in the picker
  and in the request path.
- Resetting an override to `null` restores published catalog behavior.
- Published catalog metadata stays immutable and authoritative.

## Alternatives

- Keep the badge catalog-only: rejected, it misreports configured endpoints.
- Mutate the published model record: rejected, it leaks endpoint-local settings
  into shared catalog state.
