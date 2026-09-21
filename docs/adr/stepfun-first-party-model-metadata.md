# ADR: First-party StepFun metadata for a newly released model

- Status: Accepted
- Date: 2026-09-21
- Amends: ADR 0134
- Related: issue #738

## Context

StepFun serves `step-5-preview` through its authenticated model-list API, but
models.dev has no record for that model under the first-party StepFun provider.
Its aggregator records disagree on reasoning, tool support and output limits.
Falling across providers can therefore misconfigure a real, runnable model.
The StepFun API publishes a 1,024,000-token input window and low/medium/high
reasoning; its official model guide documents vision, tools and 64k output.

## Decision

Keep models.dev as the general catalog. Introduce one reviewed, source-labelled
supplement for exactly `step-5-preview` at `https://api.stepfun.com/v1`
and the official Step Plan endpoint `https://api.stepfun.com/step_plan/v1`.
The supplement lives in a separate pure module in Electron main. A first-party
models.dev record for the same endpoint/model takes precedence as soon as it
exists; otherwise the supplement precedes cross-provider matches. It is also
available when the bundled catalog cannot load. No network fetch is added to
runtime startup or model lookup.

Metadata carries `provider` provenance, never falsely `models.dev`. The existing
optional model-info catalog-source field and internal runtime source union
accept this additive value. Existing consumers and stored bindings need no
migration. Lookup still goes through the same settings/session/subagent path;
explicit binding overrides remain authoritative.

Only exact HTTPS origin and version path matches qualify. Custom gateways,
lookalike hosts and other model IDs retain their
existing behavior. Live discovery remains the authority on availability: the
supplement does not insert a model into an endpoint's response or claim that
an API key has access. Video capability metadata does not add video attachment
transport to the desktop app.

## Alternatives

- Wait for models.dev: leaves a publicly available model misconfigured.
- Copy a reseller record: repeats inaccurate limits and capabilities.
- Modify the bundled models.dev document: falsely attributes vendor data to
  models.dev and loses the change on catalog refresh.
- Introduce a broad parallel model catalog: unnecessary scope and maintenance.

## Consequences

The exception is narrow and removable once first-party catalog coverage is
stable. Its source must be rechecked when StepFun changes the model. The 64k
output ceiling is conservatively represented as 64,000 tokens; no unverified
pricing is supplied. Existing source values, protocols, persistence and secret
ownership remain unchanged.

## References

- [Step 5 Preview guide](https://platform.stepfun.com/docs/zh/guides/models/step-5-preview)
- `GET https://api.stepfun.com/v1/models` (verified 2026-09-21; no credentials
  or account data are retained in repository fixtures)
- `apps/desktop/test/stepfun-model.test.mjs`
