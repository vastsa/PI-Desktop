# ADR 0155: Add Zhipu / Z.AI Named Endpoint Presets

- Status: Accepted
- Date: 2026-09-05
- Updates: ADR 0012, ADR 0020, ADR 0116; issue #35

## Context

Zhipu AI offers a Standard API and a GLM Coding Plan in a China and an international
region, so four endpoints. pi-ai already carried transports for the Coding Plan URLs
and models.dev published all four, but the add-provider dialog was a generic
OpenAI-compatible form, so users had to know which URL to paste and a saved row ended
up with `vendorKey: "custom"`.

## Decision

Expose four named endpoint presets in the add-provider **Service** select, all on
the existing OpenAI-compatible path:

```text
vendorKey              baseUrl
zhipuai                https://open.bigmodel.cn/api/paas/v4
zhipuai-coding-plan    https://open.bigmodel.cn/api/coding/paas/v4
zai                    https://api.z.ai/api/paas/v4
zai-coding-plan        https://api.z.ai/api/coding/paas/v4
```

Selecting a preset fills the name, locks the Base URL, keeps
`apiStyle: "chat_completions"`, and persists the models.dev `vendorKey`; the display
name stays editable. Because pi-ai's `zai` transport is the international Coding
Plan while models.dev `zai` is the standard API, the row stores both key and exact
URL so catalog matching cannot confuse them, and `zai-coding-cn` remains an alias of
`zhipuai-coding-plan`. A matching URL or `vendorKey` makes the sidecar Completions
record carry `thinkingFormat: "zai"` and `zaiToolStream: true`, with no new wire
adapter, secret table, or host protocol.

## Consequences

- Users pick API versus Coding Plan without copying URLs, and catalog enrichment
  follows the selected endpoint.
- Generic OpenAI-compatible configuration stays available as Custom, and Zhipu adds
  no new `apiStyle` values.
