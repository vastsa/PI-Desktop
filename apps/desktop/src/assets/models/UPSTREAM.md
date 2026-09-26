# Provider brand marks

The SVG files in this directory are brand marks for the AI providers
PI-Desktop knows how to talk to. They are **bundled with the app**: no mark is
ever loaded from a network location, so a row's mark appears the same offline
and no outbound request reveals which providers a user has configured.

These files are the source of truth. They are compiled into React components
by `scripts/build-provider-marks.mjs`, which writes
`apps/desktop/src/lib/provider-marks.tsx` — a generated file that is committed
so a build never has to run the generator first. `apps/desktop`'s `build:deps`
runs the generator anyway, and a test fails when regenerating does not
reproduce the committed output, so the two cannot drift.

## Upstream

- Source: <https://models.dev/logos/&lt;key&gt;.svg>, retrieved 2026-09-25.
- Project: [models.dev](https://github.com/sst/models.dev), MIT licensed.
- One file per catalog provider key; the file name is that key verbatim.

Only the monochrome `currentColor` variants are vendored, and the generator
refuses a file that paints with any other fill. That is deliberate: the marks
are inline paths carrying `currentColor`, so every one follows the surrounding
text color in both themes and every row carries one visual weight, instead of a
run of saturated colored logos.

## Refreshing

```bash
for key in openai anthropic google xai meta mistral deepseek alibaba-cn \
           zhipuai moonshotai-cn minimax-cn volcengine openrouter groq \
           togetherai xiaomi; do
  curl -fsSL "https://models.dev/logos/$key.svg" -o "$key.svg"
done
node scripts/build-provider-marks.mjs
```

Review the diff before committing: a mark is third-party artwork, so an
upstream change is a re-vendor, not a routine update.

An unknown key is not an error. The UI falls back to the shared generic mark,
so a provider missing here stays fully usable — no row is ever left without an
identity, and a missing artwork is a cosmetic fallback rather than a broken
list.
