# ADR 0345: One settings destination owns one subject

- Status: Accepted
- Date: 2026-11-05
- Decision: D684
- Deciders: PI-Desktop core
- Related: [ADR 0161](0161-searchable-theme-picker.md) ·
  [04-ux/06-settings-ia](../spec/04-ux/06-settings-ia.md) ·
  [04-ux/01-ui-ia](../spec/04-ux/01-ui-ia.md) ·
  [00-baseline §40](../spec/00-baseline.md)

## Context

The Settings directory grew one destination at a time. D133 shipped five, D166
split out AI and Shortcuts to make seven, and later decisions added
Instructions, the three capability pages, Projects, Voice, Cloud sync and Remote
Hosts. Each addition was locally reasonable. Two destinations, however, were
never given a subject — they were given whatever did not have a page yet:

- **General** carried the Appearance card (theme, language, font, font size,
  translucency, startup animation) next to the Sidebar switches, the radial
  menu, the outbound proxy, the application data directory and its cold
  maintenance, two sleep blockers, the scheduled-tasks master switch, and the
  window's close behavior. Eight cards, three unrelated subjects.
- **AI** carried Permissions as a one-row card, then a **Defaults** card that
  had reached thirteen rows: the default operating mode, the command shell, the
  link open destination, show thinking, auto-fold thinking, transcript display,
  auto-fold settled groups, the context ring's leading figure, Enter-to-send,
  infinite provider retry, smooth streaming, inline visualizations, and the
  large-paste threshold. "Defaults" is not a subject; it is the absence of one.

This is a findability problem before it is an aesthetic one. Since D601, a row's
explanation lives behind a question mark rather than on a permanent second line,
which keeps a card scannable — but it also means a reader who cannot predict
which page owns a setting has to hover a whole page to find out. Two pages that
each own two or three subjects turn that into hovering the product.

Settings search already indexes every row, so the index was not the gap. The
gap was that the structure the rail presents did not match any model a user
could hold.

## Decision

**A settings destination owns exactly one subject.** A subject that belongs to
no destination is a missing destination, not an extra card on an unrelated page.

Applied to the two unowned pages, that yields four destinations where there were
two:

| Destination | Subject | Cards |
|---|---|---|
| Appearance | How the product looks | Interface · Sidebar · Radial context menu · Startup |
| Conversation | How a transcript reads and the composer takes input | Display · Input & links |
| Behavior | What a run starts with and may do | Session defaults · Execution · Computer use |
| System | This installation | Network · Storage · Power · Close behavior (Windows/Linux) |

The directory is fifteen destinations in the four existing clusters
(Preferences, Agent, Workspace, System); the full order and glyph per
destination is in [04-ux/06-settings-ia](../spec/04-ux/06-settings-ia.md) §1.
Subagents takes the `Sparkles` glyph the retired AI destination released, so no
two rows share an icon.

Three consequences are worth stating because they are judgement calls, not
mechanics:

1. **Permission mode is not its own card.** It joins the default operating mode
   and the command shell in **Session defaults**, because all three answer one
   question — what a new conversation starts with. A one-row card for a
   security-adjacent setting reads as prominence, but a page made of one-row
   cards is exactly the pile this ADR exists to remove. The setting keeps its
   explanation and its own row; it does not lose weight by sharing a heading.
2. **Scheduled tasks is agent behavior, not chrome.** It withholds scheduled
   Agent tools and blocks new runs at the Host; the footer clock is a
   consequence, not the subject.
3. **The retired ids stay resolvable.** `general` → Appearance and `ai` →
   Behavior, through `resolveSettingsTab`. A persisted selection, a native menu
   item, a capture scene and an older deep link all arrive as plain strings, and
   a retired id must open a real page rather than leave the content pane blank.
   Neither id is in the directory or in search results.

Two presentation rules are added, because the IA alone does not make a page
legible:

- A destination may declare **one subtitle line** under its title, and each page
  repeats its rail glyph at page scale on an accent-tinted fill. Destinations
  whose content already opens with a description — the capability, model and
  project workbenches — declare no subtitle, so no page states its purpose
  twice.
- A card may carry **one visible caption line** under its heading. This is the
  first always-visible explanatory copy since D601, and it is scoped: a caption
  orients a whole group ("presentation only — nothing here changes what the
  model does"), a row's explanation stays behind its question mark, and copy
  that needs a second sentence stays there too.

The selected rail row takes an accent-tinted pill with an accent glyph. Both
tints are fills rather than strokes, so they stay inside the in-flow surface
rule (D297).

## Consequences

- **No data or protocol change.** Every `AppSettings` field keeps its name,
  type and default; no IPC message, host protocol version or storage schema
  version moves. A profile written before the split reads back identically.
  What changed is which page renders which row — this is an IA and presentation
  decision, and it is deliberately not an opportunity to also adjust defaults.
- **Deep links and search stay correct by construction.** The destination index
  (`lib/settings-search.ts`) remains the single source for the rail, the ⌘K
  dialog, and the keyword index; new rows are added there, and the retired-id
  table lives beside it.
- **The renderer shell becomes a router.** Each destination is a module under
  `features/settings/pages/`, so `SettingsPage.tsx` does not acquire a fifth
  subject of its own. The settings source contract is unaffected: it reads the
  facade plus everything under `features/settings`.
- **Copy that named a destination had to move too.** The proxy and
  network-policy messages in all nine catalogs said "Settings → General →
  Network"; they now say System. Prose that routes a user to a page is part of
  the IA.
- **Cost.** Fifteen rail rows instead of twelve, and users who had learned
  "General" must learn two names. The clusters, the search field, and the
  retired-id resolution absorb that; the alternative — keeping two pages that
  own three subjects each — is the cost that prompted this.
- **What this does not do.** It does not touch the Models, capability, Projects,
  Cloud sync, Remote Hosts, Voice or Info destinations beyond their position in
  the order, does not change the full-page shell, the rail metrics, the row
  primitives, or the D297 surface language, and does not add a second
  navigation level under a cluster heading.

## Alternatives considered

- **Reorder the cards inside General and AI.** Cheapest, and it was the first
  thing tried on paper. It cannot work: ordering changes which card is first,
  not what the page is about, and the "Defaults" heading would still be the
  place rows go when nobody decided where they belong.
- **Split the cards but keep the two destination names.** Keeps every deep link
  and every piece of copy valid. Rejected because "General" and "AI" are the
  names that invited the pile; a page called General will accumulate again.
- **Collapse the rail into two levels (cluster → destination).** Would hold more
  destinations, but the clusters are visual landmarks over a flat searchable
  index (§1), and a second interactive level adds a navigation step to every
  setting to solve a problem fifteen rows do not have.
- **Make every row's explanation permanently visible.** Addresses the same
  findability complaint from the other end. Rejected: it reverses D601 and makes
  each page several screens taller, which is a worse version of the problem. One
  caption per card is the smallest thing that answers "what is this group for".
