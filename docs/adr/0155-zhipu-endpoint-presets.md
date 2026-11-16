# ADR 0155: Add Zhipu / Z.AI Named Endpoint Presets

- Status: Accepted
- Date: 2026-09-05
- Deciders: PI-Desktop core
- Updates ADR 0012, ADR 0020, and ADR 0116

## Context

Zhipu AI (智谱) exposes two product modes and two regions:

- Standard API vs GLM Coding Plan
- China (`open.bigmodel.cn`) vs international (`api.z.ai`)

## Decision

Expose four named endpoint presets in the add-provider **Service** select. They
stay on the existing OpenAI-compatible path:

```text
vendorKey              baseUrl
zhipuai                https://open.bigmodel.cn/api/paas/v4
zhipuai-coding-plan    https://open.bigmodel.cn/api/coding/paas/v4
zai                    https://api.z.ai/api/paas/v4
zai-coding-plan        https://api.z.ai/api/coding/paas/v4
```

Selecting a preset fills the name, locks the Base URL, keeps `apiStyle:
"chat_completions"`, and persists the models.dev `vendorKey`. The display name
stays editable.

## Consequences

- China and international Zhipu users can pick API vs Coding Plan without
  copying URLs from external docs.
- Catalog enrichment follows the selected endpoint, not a generic custom row.
- Generic OpenAI-compatible configuration remains the Custom endpoint option.
- OpenCode Go stays an API-style preset; Zhipu does not add four more apiStyle
  values.
