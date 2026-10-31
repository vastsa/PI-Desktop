# 11. asktool Question Card

The asktool card is an inline composer approval surface, not a permission
dialog. It is mounted in the same dock area as the Plan and Goal approval card,
immediately above the composer input, so a paused question stays available at
the active decision point instead of moving into transcript history.

It rides the composer plate — `--ds-bg-composer` with `--ds-shadow-composer`,
like the Plan and Goal approval bar — rather than the in-flow `--ds-tile` wash,
and its option rows and custom input are inlaid `--ds-tile-deep` fills on that
plate (D297, D435). The message width, typography, and button tokens still come
from the conversation so a paused question remains part of it. The card shell
stays slim — 14 px × 16 px padding, matching the permission card's compact
footprint, with no accent rail (D297). The question text uses the compact card
body size (`--text-md`, 13 px) at medium weight — the same scale as the
permission card's title and prompt in the same dock area — so it reads as the
card's primary focal point without competing with the surrounding transcript.
Options and the custom input use the same compact size, keeping the card's
content in one coordinated tier.

The header identifies the prompt and shows progress. Small clickable indicators
encode answered, unanswered, skipped, and current state without competing with
the question text. Choice controls use radio semantics for single-select and
checkbox semantics for multi-select. Every question includes a visible custom
input choice. The action row contains Skip and Next/Submit, with Decline all as
a quiet secondary action in the header.

The card has no countdown or expiration copy. On narrow screens options remain
full-width and actions may share the row; question text and custom input may
wrap naturally without clipping.

Question text is limited to 300 Unicode characters before a card is opened.
Overlong questions return a tool validation error and do not create a card.

## Rich-text content

Question text and selectable option text may use CommonMark/GFM formatting,
including emphasis, inline code, paragraphs, and lists. The card renders this
content inline with its existing compact typography. In option buttons links are
non-interactive text, images render as alt text, and raw HTML is ignored; this
avoids nested interactive controls and external image loading. Plain strings
remain supported, and `{ label, description? }` options render the label as
Markdown while keeping the optional description as plain supporting text.
Selecting an option returns its normalized source label unchanged; formatting
is display-only. The custom-answer option is not
Markdown-interpreted.

## Typography hierarchy

The card uses a compact two-tier type scale — quiet labels, then content at
the card body size — so the question and options stay coordinated:

| Element              | Token              | Size    | Weight     | Notes                       |
|----------------------|--------------------|---------|------------|-----------------------------|
| Card title           | `--text-xs`        | 11 px   | medium     | Uppercase, wide tracking    |
| Question number      | `--text-xs`        | 11 px   | medium     | Wide tracking, eyebrow role |
| Progress             | `--text-2xs`       | 10.5 px | —          | Faint, most subtle          |
| Question text        | `--text-md`        | 13 px   | medium     | Primary focal point, compact|
| Option text          | `--text-md`        | 13 px   | —          | Matches question scale      |
| Option mark          | `--text-xs`        | 11 px   | —          | 15 px box, proportional     |
| Custom input text    | `--text-md`        | 13 px   | —          | Matches option text         |
| Decline button       | `--text-xs`        | 11 px   | —          | Quiet secondary action      |

## Control density

The card shell is a slim rail: 14 px × 16 px padding with a 2 px accent rail,
the same footprint family as the permission and turn-outcome cards.

The internal rhythm stays airy rather than packed: the status indicators keep
12 px above and 14 px below breathing room, the question renders at
`--leading-normal` (1.4) with 8 px under the eyebrow label, and each content
section (indicators → question → options → custom input → actions) is
separated by 12 px.

The option rows follow the app's global menu-row density instead of card-scale
blocks: 30 px min-height, 4 px × 8 px padding, 8 px row gaps, and the same
15 px radio/checkbox mark used by the sidebar checkboxes. The Skip / Next /
Submit buttons use the app's compact button size (4 px × 10 px padding,
12 px text); Decline remains a quiet text link in the header.

When a question has enough options to exceed the available dock height, the
option list becomes the scroll container instead of allowing the composer dock
to grow beyond the viewport. The list uses a dynamic viewport cap of
`min(320px, 36dvh)` (with a `vh` fallback), keeps a stable scrollbar gutter,
contains scroll chaining, and preserves keyboard scroll padding. The question
header, custom-answer input, and Skip / Next / Submit actions remain visible
while the user scrolls through the options. A long question prompt scrolls
inside the question body instead of growing the dock: the body uses
`min(208px, 24dvh)` with a `24vh` fallback, wraps unbroken tokens, hides
horizontal overflow, and contains scroll chaining. The body is keyboard
focusable with a visible focus ring. Next, Skip, and the step indicators open
each question at the top of that scroller. Decline, Skip, and Next/Submit stay
in the card header, outside that scroller, so they remain reachable. Short
prompts do not reserve a scrollbar gutter. This behavior also
applies on narrow screens; the card does not rely on page-level scrolling.

## Request transitions

The question index and draft answers belong to the request, not to the mounted
card instance. They live in the app store keyed by `requestId`, so switching
chats and returning to the same pending ask restores the open question and every
answer the user had already entered (see
[ADR asktool-draft-survives-session-switch](../../adr/asktool-draft-survives-session-switch.md)).
A request with no stored draft opens at question one with empty answers and
enabled actions.

Drafts never leak between requests: they are keyed by `requestId` and dropped
when the ask is resolved or dismissed, when its tool call completes, and when the
session's pending asks are cleared. Submission state stays local to the mounted
card. Drafts are renderer memory, like the pending ask itself, and do not survive
an application restart.
