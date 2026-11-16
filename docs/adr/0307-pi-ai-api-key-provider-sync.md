# ADR 0307: Sync the API-key service catalog with pi-ai's built-in providers

- Status: Accepted
- Date: 2026-09-24
- Related: D620, ADR 0012, ADR 0020, ADR 0116, ADR 0155

## Context

The Model configuration service list derives vendor accounts from pi-ai at runtime, so
a subscription vendor needs no code change, but the API-key half is hand-maintained in
`NAMED_ENDPOINT_PRESETS` and had drifted: fifteen ids that take a plain API key had no
preset, so users had to know the base URL, the vendor key stayed `custom`, and the
models.dev binding was lost.

## Decision

Add one named endpoint preset per pi-ai built-in API-key provider: `ant-ling`,
`baseten`, `cerebras`, `huggingface`, `meta`, `minimax`, `moonshotai`, `nvidia`,
`opencode`, `vercel`, `alibaba-token-plan`, `alibaba-token-plan-cn`,
`xiaomi-token-plan-cn`, `xiaomi-token-plan-ams`, and `xiaomi-token-plan-sgp`. Each
carries its base URL and an `apiStyle` the app can drive with discovery and catalog
metadata: `chat_completions` for the OpenAI-compatible face, including Vercel AI Gateway
and OpenCode Zen, `anthropic_messages` for `minimax`, and `responses` for `meta`. `id`
and `vendorKey` use the models.dev provider key when the snapshot has one, so the
catalog binding and model list work, with the pi-ai id left as an alias when they differ
(`vercel-ai-gateway`, `qwen-token-plan`, `qwen-token-plan-individual`,
`qwen-token-plan-cn`, `opencode-zen`, `hf`, `hugging-face`, `nim`), and `minimax` /
`minimax-cn` and `moonshotai` / `moonshotai-cn` stay separate rows. Eight built-in
providers intentionally stay without a preset and are recorded in the
`pi-ai-provider-sync` guard, which fails when the list goes stale: Bedrock and Azure
OpenAI need request signing or a per-resource endpoint, Cloudflare AI Gateway, Cloudflare
Workers AI, and Vertex AI embed an account or location in the base URL, GitHub Copilot
and OpenAI Codex are OAuth vendor rows, and Radius uses the account-only `pi_messages`
style.

## Consequences

- The Service select gains fifteen API-key rows with prefilled name, base URL, and
  format, and aliases map rows storing a pi-ai id to the same preset.
- A pi-ai upgrade that adds a provider becomes a build-time signal, while
  multi-protocol providers still need a human decision recorded in the guard.
- No protocol, IPC, storage schema, permission, or default-selection change.

## Alternatives

- Derive the API-key list at runtime: pi-ai providers carry no display ordering, some
  need account-scoped URLs, and the table also carries `apiStyle` and `zhipuCompat`.
- Custom endpoint only: hides the services and leaves the drift invisible.
