# ADR provider-brand-marks: Bundled monochrome provider marks for the model picker

- Status: Accepted
- Date: 2026-09-25
- Related: Issue #1028, spec `13-model-catalog-and-selection.md` §9.2.1

## Context

The conversation Composer model picker identified each row only by text. A user
asked for model context/output length and a model icon, and volunteered their
own hand-drawn icons, reporting them "ugly and inconsistent" — the natural
result of mixing per-row artwork by hand.

Two constraints shape the decision:

- **Selection by name is unsound.** A provider row's display name is user
  editable, and several configured rows can resolve to one catalog vendor. Any
  mark chosen from a name is a guess.
- **Fetching is unsound.** models.dev serves marks at
  `https://models.dev/logos/<key>.svg`. A renderer that loaded them directly
  would need an external origin in `img-src`, would look different offline, and
  would emit an outbound request naming the providers a user configured.

## Decision

1. **Select by catalog key, never by name.** Two keys are involved, and both are
   resolved in Electron Main through mappings that already exist:
   `ProviderPublic` gains an optional `catalogProviderKey`, filled by
   `modelsDevCatalog.providerKeyForRow`, and `ModelInfo` gains an optional
   `catalogVendorKey`, filled by `modelsDevCatalog.vendorProviderKeyForModel`.
   The renderer neither re-derives nor duplicates that mapping, so there is no
   second source of truth and a renamed row cannot show another vendor's mark.
   A row prefers its own vendor key, because one custom endpoint serves several
   vendors: a group of rows shares a `providerId` while each names its owner.
2. **The owner is read off the id's vendor route.** A custom OpenAI-compatible
   row resolves to no catalog provider at all, yet most ids it serves are
   published somewhere under a route such as `openai/gpt-6-astra`.
   `vendorProviderKeyForModel` reads that route across the catalog's own
   candidate index for the id — the same indexed set `findModel` searches — and
   maps the vendor through the existing alias table. It names the owner of the
   weights rather than whichever host published the winning record, and it is
   metadata only: no capability, limit, or wire id changes.
3. **The owner can also be the publisher's own identity.** Some vendors publish
   with no route at all: Xiaomi ships `mimo-v2.6-pro` under its own key, so the
   id alone names nothing. When a publisher's own key is a known vendor, that is
   the vendor describing its own model — the same claim a route makes. This is
   what keeps the rule from being fooled in the other direction too: a reseller
   never qualifies, because its key (`opencode-go`, `nano-gpt`, `requesty`) is
   not in the vendor set, so a gateway's mark cannot reach a row it merely
   republishes. A route always wins over a publisher key, because the id states
   its owner more directly than the host that listed it.
4. **Bundle a curated set of marks.** Sixteen marks covering the catalog's
   common providers are vendored under `apps/desktop/src/assets/models/`, with
3. **Bundle a curated set of marks.** About fifteen marks covering the catalog's
   common providers are vendored under `apps/desktop/src/assets/models/`, with
## Consequences

- Two optional additive fields, one on the public provider type and one on
  `ModelInfo`. No IPC contract change beyond the extra properties, no database
  migration, no persisted-format change, and no Plugin SDK change. A producer
  that omits either keeps working and gets the generic mark.
- No CSP change and no runtime network access: the marks are inline paths, so
  `img-src 'self'` is untouched and `connect-src` gains no logo host. There is
  also no `<img>` element to fail, so no row can render a broken-image glyph.
- `src/lib/provider-marks.tsx` is generated and committed, and a test fails when
  regenerating from the assets does not reproduce it — so a re-vendored mark
  cannot silently ship the old artwork.
- Marks age with upstream branding; the curated set is refreshed deliberately
  (re-vendoring third-party artwork, not a routine bump) and a stale or missing
  mark is a cosmetic fallback, never a functional loss.
- Coverage is limited to the curated vendor list. A vendor outside it — one whose
  models carry no vendor route, or whose artwork was never vendored — uses the
  generic mark until someone adds it, which is the honest outcome: no row claims
  a brand it cannot prove.
- The icons are decorative (`aria-hidden`, no new user-visible strings), so the
  shipped locales are unchanged; the model ID beside the mark remains the row's
  accessible name.
  change, and no Plugin SDK change. A producer that omits the field keeps
  working and gets the generic mark.
- No CSP change and no runtime network access: `img-src 'self'` is untouched and
  `connect-src` does not gain a logo host.
- Marks age with upstream branding; the curated set is refreshed deliberately
  (re-vendoring third-party artwork, not a routine bump) and a stale or missing
  mark is a cosmetic fallback, never a functional loss.
- Coverage is limited to the curated key list. A provider outside it uses the
  generic mark until someone vendors its artwork, which is the honest outcome:

### Rejected: a CSS mask over a bundled asset

The first implementation imported each `.svg` as a URL and set
`mask-image` on a colored element, so the artwork would inherit the text color.
It works for an asset the bundler emits as a file and fails for one it inlines:
Vite inlines anything under `assetsInlineLimit` (4 KB) as a `data:` URL, a CSS
mask cannot paint from that, and the element renders as a solid square of its
own background color. Several of the curated marks are under that threshold, so
the failure was partial and looked like a per-vendor bug.

The alternative fixes are all worse than removing the indirection: raising the
inline limit is a global build change for one feature's benefit, an explicit
`?url` query still leaves the artwork's rendering dependent on a bundler detail,
and rendering an `<img>` loses the monochrome property that keeps the list
consistent. Inline `currentColor` paths have no threshold to depend on, no
`<img>` to fail, and no CSP surface at all.
  no row claims a brand it cannot prove.
- The icons are decorative (`aria-hidden`, no new user-visible strings), so the
  shipped locales are unchanged; the model ID beside the mark remains the row's
  accessible name.

## Alternatives

- **Fetch marks from models.dev at runtime.** Rejected: offline-first behavior,
  one more external origin in the CSP, and a request that discloses which
  providers the user configured.
- **Pick the mark from the display name or vendor key in the renderer.**
  Rejected: duplicates the alias mapping that already exists in Main, so the two
  would drift and a renamed row could show another vendor's mark.
- **Ship the full catalog of marks.** Rejected: hundreds of third-party
  artworks, most of which no user would ever see, for no added capability.
- **Hand-drawn icons.** Rejected: it is the state the request came from. A
  curated set with one mechanism and a guaranteed fallback is what makes the
  list consistent.
