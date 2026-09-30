# ADR 0313: Eden AI as named endpoint presets, with publisher-balanced discovery

- Status: Accepted for implementation
- Date: 2026-09-30
- Deciders: PI-Desktop core
- Updates ADR 0012, ADR 0155, ADR 0156 and ADR 0307
- Related: `03-runtime/12-provider-config-schema.md` §3,
  `03-runtime/13-model-catalog-and-selection.md` §2, `guide/edenai.md`

## Context

Eden AI is an AI gateway whose current API (V3) is OpenAI Chat Completions at
`https://api.edenai.run/v3`, with an EU host at `https://api.eu.edenai.run/v3`
that accepts the same key. Models are addressed as `provider/model`
(`openai/gpt-latest`, `deepinfra/meta-llama/Llama-3.3-70B-Instruct`); Eden AI's
own Pi integration page registers the service as `api: "openai-completions"`
at that base URL. pi-ai 0.99.1 has no Eden AI provider and its adapter
detects nothing about the host, so a Chat Completions row already reaches it
with the adapter's default compatibility flags.

Two facts about the service did not fit the existing discovery path. Its
public `/v3/models` list held 1,132 chat endpoints, while `normalizeModelList`
sorted ids alphabetically and kept the first 500: with Eden AI's distribution
(`amazon/`, `azure/`, `databricks/`, `deepinfra/` alone exceed 500), every
`openai/`, `vertex/`, `xai/` and `mistral/` id was dropped from the picker. And
most Eden AI ids match no published record, so a row that the list described
with a `context_length` and capability flags landed on the generic
128k / 8k text-only seed.

## Decision

1. **Two named endpoint presets on the OpenAI-compatible path.** `edenai`
   (`Eden AI`, `https://api.edenai.run/v3`) and `edenai-eu`
   (`Eden AI (EU endpoint)`, `https://api.eu.edenai.run/v3`), both
   `apiStyle: "chat_completions"` and both persisting `vendorKey: "edenai"`.
   No new `apiStyle`, IPC method, host RPC, schema version, dependency or
   pi-ai patch. `matchNamedPreset` resolves a saved row by exact host first,
   so the EU row never reads as the global one. Model ids are stored and sent
   verbatim, including ids with several `/` segments.
2. **EU wording is neutral.** Eden AI documents that the EU host lists only
   EU-eligible providers and refuses other ids with HTTP 451 instead of
   re-routing, that its own infrastructure is in European data centers, and
   that upstream providers run their own data centers. The preset and the guide
   describe exactly that and make no data-residency guarantee.
3. **Discovery returns a served list whole, under a safety bound.** The bound
   becomes `MAX_DISCOVERED_MODELS = 2_000`; no service behind a shipped preset
   approaches it. Beyond the bound, `balancedSelection` keeps rows round-robin
   per publisher segment (the id before its first `/`; ids without a route form
   one group), one per publisher per pass in publisher order, then re-sorts, so
   a bounded list reads like an unbounded one and no publisher is lost because
   its ids sort late. The rule reads only the id's shape. The settings dialog
   keeps filtering client-side; the durable cache stores the whole answer.
4. **A served row's own statement fills the generic shape, narrowly.**
   `servedModelMetadata` reads the two OpenAI-compatible list shapes in use
   (a `capabilities` object with `input_modalities`, plus `context_length`;
   `architecture.input_modalities` plus `supported_parameters`, plus
   `context_length`; `context_window` as a second spelling of the window). Only
   positive statements count. When no published record resolves, the context
   window seeds the binding with `contextWindowSource: "catalog"` and tool
   support labels the row and ranks recommendations; both travel through the
   existing `DiscoveredModelInput` cache fields. Image-input and reasoning flags
   are parsed but not promoted, because each changes the request shape and is
   gated by the binding's explicit user choice. A published record always
   outranks the list.

## Consequences

- Eden AI is pick + paste + choose models, like every other named service, and
  its EU host is one more row rather than a second implementation.
- Large gateway lists no longer lose whole publishers; the cost is a longer
  list in the dialog, which the existing client-side search narrows.
- A gateway model the library cannot place runs with the window the service
  published instead of a guessed 128k, which sizes compaction correctly.
- The runtime, host-core and pi-ai are untouched. The agent-runtime test
  `openai-compatible-gateway-flow.test.ts` proves the request shape and a
  streamed tool-call round trip against a fixture; it does not prove Eden AI's
  own behavior, which stays a credential-gated live check.
- Deferred: promoting served image-input or reasoning flags; reading Eden AI's
  pricing into cost display; an output limit, which the list does not publish.

## Alternatives considered

- **Custom endpoint only.** Rejected: the service would be hidden, the row
  would carry `vendorKey: "custom"`, and the EU host would be undiscoverable.
- **A dedicated `apiStyle` or pi-ai provider.** Rejected: OpenCode Go earned an
  API style because it needs a session header pi-ai does not send; Eden AI
  needs no header, auth or request shape the adapter lacks.
- **A plugin through `contributes.providers`.** Rejected: the declaration is a
  static list of at most 64 models, read-only for the user and gated behind a
  high-risk permission, against a catalog of 1,100 ids that changes weekly.
- **Raise the cap alone.** Rejected: an alphabetical head still drops
  publishers once any list crosses the new number, and the failure is silent.
- **Render a bounded window in the dialog.** Deferred: 1,100 simple rows are
  within what the dialog already renders for other services' full lists, and
  a render window changes the meaning of "select all visible".
