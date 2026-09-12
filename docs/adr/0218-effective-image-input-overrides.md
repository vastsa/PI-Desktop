# ADR 0218: Effective Image-Input Overrides Across Composer and Transport

- Status: Accepted
- Date: 2026-09-11
- Deciders: PI-Desktop runtime and desktop UI maintainers
- Amends: ADR 0101, D243

## Context

Advanced model settings allow a provider binding to override whether an endpoint
accepts image input. The override is intentionally three-state: `null` means
follow the published model record, while `true` and `false` explicitly enable or
disable image input. Composer model rows still derived their vision badge only
from the published catalog, so a configured text-only model could transport an
image while appearing text-only, or a configured vision model could advertise a
capability that the endpoint had been disabled from using.

## Decision

1. Resolve the effective image-input capability for the exact provider/model
   binding. An explicit `supportsImages` value wins; `null` or an absent value
   follows the published model capability.
2. Use that same effective result for the Composer model-row badge, attachment
   status, and main-process image transport. Do not mutate the shared published
   `ModelInfo` record.
3. Keep unknown or custom model ids conservative when no explicit binding
   override exists. Discovery or cache metadata alone cannot promote them to
   image transport.
4. Preserve the existing attachment boundary: eligible images within the
   decimal 10 MB app limit use transient image blocks; disabled, unknown, or
   oversized images use the safe `@path` fallback.

## Consequences

- A provider binding can accurately describe a custom or proxied endpoint in
  both the model picker and the request path.
- Resetting an override to `null` restores the published catalog behavior.
- Published catalog metadata remains immutable and authoritative when no local
  endpoint-specific override is configured.
- The Composer's vision badge and transport decision cannot drift apart.

## Alternatives considered

- **Keep the badge catalog-only:** rejected because it misrepresents configured
  endpoints and diverges from the transport decision.
- **Mutate the published model record:** rejected because it would leak
  endpoint-local settings into shared catalog state and other bindings.
- **Trust discovery for unknown models:** rejected because discovery is not a
  sufficient serialization or safety guarantee for image transport.
