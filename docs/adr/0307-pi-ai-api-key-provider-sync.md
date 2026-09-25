# ADR 0307: Sync the API-key service catalog with pi-ai's built-in providers

- Status: Accepted
- Date: 2026-09-24
- Decision owners: PI-Desktop core
- Related: ADR 0012, ADR 0020, ADR 0116, ADR 0155, D620

## Context

The Model configuration service list has two halves with different sources of
truth. Vendor accounts are derived at runtime from pi-ai
(`models.getProviders().filter(p => p.auth.oauth)`), so a subscriptions vendor
added to the library shows up in the app without a code change. The API-key
half is hand-maintained in `NAMED_ENDPOINT_PRESETS`
(`packages/shared/src/provider-presets.ts`), and it had drifted: pi-ai 0.87.1
ships 41 built-in providers, and fifteen of the ids that take a plain API key
had no named preset of their own — only `minimax` resolved to the China row
by alias, and the rest fell to the custom form.

Users could still reach those hosts through the custom endpoint form, but they
had to know the base URL, the vendor key stayed `custom`, and the models.dev
catalog binding was lost.

## Decision

Add fifteen named endpoint presets so every pi-ai built-in API-key provider is
reachable from the Service select:

```text
id                        baseUrl                                                apiStyle
ant-ling                  https://api.ant-ling.com/v1                            chat_completions
baseten                   https://inference.baseten.co/v1                        chat_completions
cerebras                  https://api.cerebras.ai/v1                             chat_completions
huggingface               https://router.huggingface.co/v1                       chat_completions
meta                      https://api.meta.ai/v1                                 responses
minimax                   https://api.minimax.io/anthropic/v1                    anthropic_messages
moonshotai                https://api.moonshot.ai/v1                             chat_completions
nvidia                    https://integrate.api.nvidia.com/v1                    chat_completions
opencode                  https://opencode.ai/zen/v1                             chat_completions
vercel                    https://ai-gateway.vercel.sh/v1                        chat_completions
alibaba-token-plan        https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1  chat_completions
alibaba-token-plan-cn     https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1     chat_completions
xiaomi-token-plan-cn      https://token-plan-cn.xiaomimimo.com/v1                chat_completions
xiaomi-token-plan-ams     https://token-plan-ams.xiaomimimo.com/v1               chat_completions
xiaomi-token-plan-sgp     https://token-plan-sgp.xiaomimimo.com/v1               chat_completions
```

Rules that follow from the existing preset contract:

- `id` / `vendorKey` use the models.dev provider key when the snapshot has one,
  so the catalog binding and the model list work; the pi-ai provider id is kept
  as an alias when the two differ (`vercel-ai-gateway`, `qwen-token-plan`,
  `qwen-token-plan-individual`, `qwen-token-plan-cn`, `opencode-zen`, `hf`,
  `hugging-face`, `nim`).
- `apiStyle` follows the wire style this app can actually drive with discovery
  and catalog metadata. Vercel AI Gateway and OpenCode Zen publish several
  protocols; both are reachable over the OpenAI-compatible face
  (`chat_completions`), which is also what the models.dev catalog adapter maps
  to. MiniMax (`anthropic_messages`) and Meta (`responses`) follow the
  providers' own single protocol.
- `minimax` (international, `api.minimax.io`) and `minimax-cn`
  (`api.minimaxi.com`) stay separate rows; `moonshotai` and `moonshotai-cn` too.

Eight built-in providers intentionally stay without a preset. The guard
`packages/agent-runtime/src/pi-ai-provider-sync.test.ts` records each reason and
fails when the list goes stale:

- Amazon Bedrock, Azure OpenAI: request signing / per-resource endpoint and
  deployment id rather than a base URL plus API key.
- Cloudflare AI Gateway, Cloudflare Workers AI, Google Vertex AI: the base URL
  embeds an account, gateway, project, or location.
- GitHub Copilot, OpenAI Codex: offered as vendor-account (OAuth) rows here.
- Radius: `pi_messages` is an account-only style in this app and the gateway
  publishes no model list for discovery.

## Consequences

The Service select grows by fifteen API-key rows in the international and
China groups; each row prefills name, base URL, and format, and
`vendorKey` binds it to its models.dev catalog entry. Aliases make existing
rows that stored a pi-ai provider id resolve to the same preset.

The sync guard now fails on a pi-ai upgrade that adds a provider, which turns
silent drift into a build-time signal. Providers that expose several protocols
or no protocol at all still need a human decision, and the guard's exception
list is where that decision is recorded.

No protocol, IPC, storage schema, permission, or default-selection change.

## Alternatives

- **Derive the API-key list from pi-ai at runtime**, as vendor accounts do.
  Rejected for now: pi-ai providers carry no display ordering, some need
  account-scoped URLs, and the app's preset table also carries the
  `apiStyle` and `zhipuCompat` bindings that the library does not express.
- **Custom endpoint only.** Rejected: it hides the services, loses the
  models.dev binding, and leaves the drift invisible.
- **Group providers by library id, ignoring models.dev keys.** Rejected: the
  catalog lookup and the model list are keyed by `vendorKey`.
