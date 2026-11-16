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

The Settings directory grew one destination at a time (D133, D166, then
Instructions, the capability pages, Projects, Voice, Cloud sync, and Remote
Hosts). Two destinations were never given a subject — they took whatever had no
page yet. **General** carried the Appearance card beside the Sidebar switches, the
radial menu, the outbound proxy, the application data directory, two sleep
blockers, the scheduled-tasks switch, and window close behavior: eight cards,
three unrelated subjects. **AI** carried Permissions as a one-row card beside a
**Defaults** card of thirteen rows. "Defaults" is not a subject; it is the absence
of one.

This is findability before aesthetics. Since D601 a row's explanation lives behind
a question mark, so a reader who cannot predict which page owns a setting must
hover a whole page to find out, and two pages owning three subjects each turns that
into hovering the product. Search already indexed every row; the gap was that the
rail's structure matched no model a user could hold.

## Decision

**A settings destination owns exactly one subject.** A subject that belongs to no
destination is a missing destination, not an extra card on an unrelated page.
Applied to the two unowned pages, that yields four destinations where there were
two:

| Destination | Subject | Cards |
|---|---|---|
| Appearance | How the product looks | Interface · Sidebar · Radial context menu · Startup |
| Conversation | How a transcript reads and the composer takes input | Display · Input & links |
| Behavior | What a run starts with and may do | Session defaults · Execution · Computer use |
| System | This installation | Network · Storage · Power · Close behavior (Windows/Linux) |

The directory is fifteen destinations in the four existing clusters; the order and
glyph per destination are in [04-ux/06-settings-ia](../spec/04-ux/06-settings-ia.md)
§1. Subagents takes the `Sparkles` glyph the retired AI destination released.

Three judgement calls are worth stating:

1. **Permission mode is not its own card.** It joins the default operating mode and
   command shell in **Session defaults**, because all three answer what a new
   conversation starts with; a page made of one-row cards is the pile this ADR
   removes.
2. **Scheduled tasks is agent behavior, not chrome.** It withholds scheduled Agent
   tools and blocks new runs at the Host; the footer clock is a consequence.
3. **The retired ids stay resolvable.** `general` → Appearance and `ai` → Behavior
   through `resolveSettingsTab`, so a persisted selection, native menu item,
   capture scene, or older deep link opens a real page. Neither id appears in the
   directory or in search results.

Two presentation rules accompany the IA:

- A destination may declare **one subtitle line** under its title, and each page
  repeats its rail glyph at page scale on an accent-tinted fill; destinations whose
  content already opens with a description declare no subtitle.
- A card may carry **one visible caption line** under its heading, the first
  always-visible explanatory copy since D601: a caption orients a group, a row's
  explanation stays behind its question mark, and a second sentence still belongs
  there.

The selected rail row takes an accent-tinted pill with an accent glyph; both tints
are fills rather than strokes, inside the in-flow surface rule (D297).

## Consequences

- **No data or protocol change.** Every `AppSettings` field keeps its name, type,
  and default, and no IPC message, host protocol version, or storage schema version
  moves; only which page renders which row changes.
- **Deep links and search stay correct by construction**: the destination index
  (`lib/settings-search.ts`) remains the single source for the rail, the ⌘K
  dialog, and the keyword index, with the retired-id table beside it.
- **The renderer shell becomes a router**: each destination is a module under
  `features/settings/pages/`, so `SettingsPage.tsx` does not acquire a fifth
  subject of its own.
- **Copy naming a destination moved too**: proxy and network-policy messages in
  every catalog now say System instead of "Settings → General → Network".
- **Cost**: fifteen rail rows instead of twelve, and users who learned "General"
  must learn two new names.
- **Scope**: this does not touch other destinations beyond their order, the
  full-page shell, rail metrics, row primitives, or add a navigation level under a
  cluster heading.

## Alternatives

- Reorder the cards inside General and AI: rejected, ordering changes which card is
  first, not what the page is about, and "Defaults" would still be where undecided
  rows land.
- Split the cards but keep the two names: rejected, "General" and "AI" are the
  names that invited the pile.
- Collapse the rail into two levels: rejected, clusters are visual landmarks over a
  flat searchable index and a second level taxes every setting.
- Make every row's explanation permanently visible: rejected, it reverses D601 and
  makes each page several screens taller.
