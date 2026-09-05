# ADR 0155: Add Zhipu / Z.AI Named Endpoint Presets

- Status: Accepted
- Date: 2026-09-05
- Deciders: PI-Desktop core
- Updates ADR 0012, ADR 0020, and ADR 0116

## Context

Zhipu AI (智谱) exposes two product modes and two regions:

- Standard API vs GLM Coding Plan
- China (`open.bigmodel.cn`) vs international (`api.z.ai`)

pi-ai already ships Completions transports for the two Coding Plan URLs
(`zai`, `zai-coding-cn`) and detects `thinkingFormat: "zai"` from those hosts.
models.dev already publishes all four endpoints. PI-Desktop's add-provider
dialog was a generic OpenAI-compatible form, so users had to know which URL to
paste, and a saved row used `vendorKey: "custom"`.

Issue #35 asked for first-class configuration of API vs Coding Plan and
China vs international, without a new vendor SDK.

## Decision

Expose four named endpoint presets in the add-provider **Service** select.
They stay on the existing OpenAI-compatible path:

```text
vendorKey              baseUrl
zhipuai                https://open.bigmodel.cn/api/paas/v4
zhipuai-coding-plan    https://open.bigmodel.cn/api/coding/paas/v4
zai                    https://api.z.ai/api/paas/v4
zai-coding-plan        https://api.z.ai/api/coding/paas/v4
```

Selecting a preset fills the name, locks the Base URL, keeps `apiStyle:
"chat_completions"`, and persists the models.dev `vendorKey`. The display name
stays editable. Coding Plan shows a one-line API-key hint. This is a compact
select, not a restored vendor-card grid.

pi-ai's `zai` transport is the international Coding Plan, while models.dev
`zai` is the standard API. PI-Desktop stores the models.dev key plus the exact
URL so catalog matching cannot confuse them. `zai-coding-cn` remains an alias
of `zhipuai-coding-plan`.

When the configured URL or `vendorKey` matches a preset, the sidecar Completions
model record receives `thinkingFormat: "zai"` and `zaiToolStream: true`. No new
wire adapter, secret table, or host protocol is introduced.

## Consequences

- China and international Zhipu users can pick API vs Coding Plan without
  copying URLs from external docs.
- Catalog enrichment follows the selected endpoint, not a generic custom row.
- Generic OpenAI-compatible configuration remains the Custom endpoint option.
- OpenCode Go stays an API-style preset; Zhipu does not add four more apiStyle
  values.
