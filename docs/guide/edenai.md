# Eden AI

Eden AI is an AI gateway that fronts many model publishers behind one
OpenAI-compatible API. PI-Desktop offers it as two named services on the
ordinary OpenAI Chat Completions path; no Eden-specific transport is involved.

## Connect the global endpoint

1. Open **Settings → Model configuration → Add AI service**.
2. Select **Eden AI** and paste your Eden AI API key.
3. Wait for the model list, select the models you want, and save.

The preset uses `https://api.edenai.run/v3` with **Chat Completions**. Requests
go to `/v3/chat/completions`; the model list comes from `/v3/models`. The API
format stays editable in Advanced, as for every named service.

## Model ids are routed

Eden AI addresses every model as `provider/model`, for example
`openai/gpt-latest`, `anthropic/claude-sonnet-latest`,
`vertex/gemini-flash-latest`, or `deepinfra/meta-llama/Llama-3.3-70B-Instruct`.
PI-Desktop stores and sends the id exactly as the list spells it, including ids
with more than one `/`. Do not shorten an id to its last segment: Eden AI
rejects a bare Anthropic name such as `claude-opus-4-7` as "Model not found".

The list is long (about 1,100 entries at the time of writing). It is returned
whole, so type in the model search field to narrow it; a routed id you know can
also be typed directly as a custom model.

## What the model list tells the app

Most Eden AI ids do not match a record in the bundled model library, so
PI-Desktop reads two facts from the service's own list for such a row:

- **Context window** from the list's `context_length`. It seeds the model's
  context window and sizes automatic compaction.
- **Tool support** when the list marks the model as accepting function calls.
  It labels the row and ranks the recommended models.

Everything else stays at the conservative defaults until you change it in the
model's **Advanced** settings: the output limit is 8,192 tokens because the
list publishes none, image input is off, and thinking levels are unset. The
list's `supports_reasoning` and `input_modalities` values are shown nowhere
because turning either on changes the request Eden AI receives, and that is
your call per model. A model the library does know (a dated id such as
`anthropic/claude-opus-4-5-20251101`) keeps its published record.

## EU endpoint

**Eden AI (EU endpoint)** is the same service at
`https://api.eu.edenai.run/v3`, selected as a separate row. The same API key
works on both hosts; Eden AI issues no separate EU key.

What Eden AI documents about this host, and what PI-Desktop relies on:

- The EU host's model list is filtered to the providers and models Eden AI
  marks as EU-eligible. On 2026-09-30 the public list held 272 entries from
  Amazon Bedrock, Mistral, Databricks, Google Vertex, Azure, Scaleway,
  OVHcloud, Qwen, IONOS, TensorX, CompactifAI and Infomaniak.
- A request for a model that is not EU-eligible is refused by the gateway
  (HTTP 451, `region_not_allowed`) before any provider is contacted. There is
  no automatic re-route to the global endpoint.
- Caching is region-scoped, and any `fallbacks` you configure must also be
  EU-eligible.

What this does **not** establish: Eden AI states that its own infrastructure
is hosted in European data centers and that each upstream provider "operates
their own data centers", with locations varying per provider and model. EU
eligibility is Eden AI's classification of those providers; PI-Desktop does
not verify where inference runs, what an upstream provider retains, or any
contractual residency commitment. Treat the EU row as "Eden AI's EU host with
EU-eligible routing", not as a data-residency guarantee. If residency matters
to you, confirm it with Eden AI's data-governance documentation and your own
agreement with them.

## Limits and things to verify yourself

- Streaming, tool calls, structured output and reasoning parameters are
  documented by Eden AI for its Chat Completions API. PI-Desktop's own tests
  prove what it sends and how it reads a conforming answer; whether a given
  upstream model streams tool calls correctly through the gateway is a
  per-model question. Try a short tool-using turn before relying on a model.
- Eden AI's model list marks many entries `supports_native_streaming: false`.
  The meaning of that flag is not documented; PI-Desktop ignores it.
- The list publishes no maximum output length, so raise the output limit in
  the model's Advanced settings when a model supports more than 8,192 tokens.
- Eden AI charges the underlying provider's price plus its platform fee; see
  its pricing page for the current terms.

See the [Eden AI documentation](https://www.edenai.co/docs) for the API
reference, the [EU endpoint page](https://www.edenai.co/docs/v3/data-governance/eu-endpoint),
and [Eden AI's own Pi integration notes](https://www.edenai.co/docs/v3/integrations/pi).
