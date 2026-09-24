# Native search provider audit

Checked 2026-09-24 against the configured endpoint presets and public vendor
documentation. No paid inference or live search request was made. This is an
implementation audit, not a claim that every model offered by a vendor supports
every tool. An enabled checkbox still requires a model accepting that tool.

| Connection | Finding | Application behavior in this change |
| --- | --- | --- |
| DeepSeek official Chat Completions | Official Harness uses the same key and `/anthropic/v1/messages` with `web_search_20250305`. | One existing entry; search opt-in routes this model's request internally. Search off keeps Completions. |
| xAI official Chat Completions | Official search documentation specifies Responses and `web_search`. | Same opt-in routing to same-origin Responses; no second preset. |
| OpenAI official legacy Chat Completions | The existing application supports search through Responses; the current OpenAI preset already uses it. | Legacy Completions entries can opt in without replacing their saved configuration. Current Responses and Codex accounts stay unchanged. |
| Anthropic / existing Responses connections | Existing adapters attach tools and preserve search blocks and citations. | Existing behavior retained; protocol compatibility alone does not prove model or gateway support. |
| Google Gemini | Google documents a Google Search tool and grounding/search-suggestion results. The current Google adapter has no `webSearch` request/response handling. | Still not integrated for this format; the hint says so rather than claiming the vendor lacks search. Requires a distinct adapter contract. |
| Qwen / DashScope | Completions uses `enable_search`; newer models also have Responses or Anthropic paths, with model and workspace constraints. | No blind route switch for all configured models; those formats require model-specific capability and result handling. |
| Zhipu / Z.AI | Zhipu documents its own `web_search` object and a separate search API. | No substitution of OpenAI/Anthropic tool schemas; format-specific integration remains outstanding. |
| Moonshot / Kimi | `$web_search` is a `builtin_function` with a tool-call/result loop. | Not treated as a provider-hosted Anthropic/Responses block; needs its own tool lifecycle integration. |
| Groq | Compound models were deprecated on September 21; current docs point to browser search for particular GPT OSS models. | No blanket capability inferred from the Groq preset or old Compound documentation. |
| MiniMax / Kimi Coding Anthropic routes | The preset already selects Anthropic Messages. Support for the exact hosted tool is not established by the protocol alone. | Existing manual opt-in retained; not newly certified by this audit. |
| Mistral, Xiaomi, Together, Fireworks, SiliconFlow, Volcengine | This audit did not establish a drop-in compatible hosted-search contract for the configured endpoints. Mistral's attempted page returned 404; Xiaomi docs transport failed. | No inferred support or automatic credential rerouting. Further vendor-specific integration remains open. |

## Sources

- [DeepSeek official Harness search provider](https://github.com/deepseek-ai/deepseek-harness/blob/46a7f68b0922371ce7144b668b90e377d8e799f4/packages/web/web-search-deepseek/src/provider.ts)
- [xAI web search](https://docs.x.ai/developers/tools/web-search)
- [Google Search grounding](https://ai.google.dev/gemini-api/docs/google-search)
- [Model Studio web search](https://www.alibabacloud.com/help/en/model-studio/web-search)
- [Zhipu web search](https://docs.bigmodel.cn/cn/guide/tools/web-search)
- [Kimi built-in web search](https://platform.moonshot.cn/docs/guide/use-web-search)
- [Groq Compound status](https://console.groq.com/docs/compound)
- Existing application contracts: `packages/shared/src/native-web-search.ts`,
  `packages/agent-runtime/src/provider-binding.ts`, and the pinned pi-ai adapters.

Exact first-party origins and paths are required for request routing. Vendor
names and model labels are not authority to send a relay key to an official
service. Unknown connections retain their configured destination. No new
discovery probes, hidden inference charges, or persistent transport migrations
are introduced. Full protocol probing from issue #907 remains separate work.
