# 11. asktool Question Card

The asktool card is an inline composer approval surface, not a permission
dialog. It is mounted in the same dock area as the Plan and Goal approval card,
immediately above the composer input, so a paused question stays available at
the active decision point instead of moving into transcript history.

It uses the existing message width, border, background, and button tokens so
that a paused question remains visually part of the conversation. The card
shell stays slim — 14 px × 16 px padding and a 2 px accent rail, matching the
permission card's compact footprint. The question text uses the compact card
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
header, question text, custom-answer input, and Skip / Next / Submit actions
remain visible while the user scrolls through the options. This behavior also
applies on narrow screens; the card does not rely on page-level scrolling.
