# Pi 0.99.1 migration review

The scoped candidate has been reviewed and repaired in `refactor/pi-0991-resume`.
These local checks do not qualify an installed release or a real paid provider request.
Migration scope remains pi-ai and pi-agent-core; pi-coding-agent is retained solely
for the existing compatibility utilities. Tool composition, Codemode and virtual
routing recommendations remain in [the design review](pi-coding-agent-design-review.md).

## Repaired findings

| Impact | Finding and repair | Regression evidence |
| --- | --- | --- |
| Account isolation | An unsigned OAuth row could use an ambient API key. Account Models now explicitly disable environment/file credential lookup. | Actual built-in Anthropic auth resolution rejects the unsigned row even with an environment key. |
| Runtime failure | Three coding-agent compatibility patch additions referenced an undefined `requestModel`. They now use the locally resolved `model`. | An offline public SDK session performs manual compaction with an extension-supplied summary. The original patch raised `ReferenceError`. |
| Lost accounting | Offline aggregate usage reports shared one outbox key. Keys now fingerprint the full snapshot; physical IDs still deduplicate replay. | Offline image aggregates survive durable outbox restart and replay independently. |
| Lost accounting | Session compaction omitted usage, while delegate summaries invented an identity after aggregation. Observe each actual `completeSimple` dispatch, before retries/chunking are collapsed, and remove the extra delegate summary charge. | Summary attempt tests include failed/successful replies, distinct IDs, account/model provenance, preserved headers and replay identity. Runtime/delegate suites pass. |
| Lost accounting | One-shot completions returned only the final retry's usage. Observe each attempt inside the existing retry factory and return their union. | Existing one-shot transport/cancellation tests pass; returned usage carries the physical operation and account/model. |
| Incorrect price | Equal-token replay could replace a known cost with an unknown one. TS and Rust prefer a complete known cost, with reported prices preferred on equal counts. | Both replay orders preserve the reported amount in shared and durable Host ledger tests. |
| Incorrect price | Missing or nonfinite Pi native rates could become a known free operation. Validate native rates before marking estimated cost; malformed or overflowing totals remain unknown. | Native unknown-rate and malformed-price tests preserve the unknown/free distinction. |
| Invalid accounting | External tool usage accepted nonfinite, negative or fractional counts. Validate required and optional counts. Rust validates optional counts and saturates integer ledger totals. | Invalid tool-count cases are ignored; the Host maximum-count case no longer panics. |
| Unsupported capability | Saved overrides re-enabled thinking levels that Pi omitted or explicitly disabled. Known Pi models intersect overrides with native support; saved preferences remain intact. | Native-null/absent effort fixtures and account capability/cache tests pass. |
| Stale model list | Forced refresh still used the live-model TTL. Force now invalidates that cache. Old account loads cannot repopulate another account instance's cache or clear its single-flight entry. | Forced entitlement refresh takes effect immediately; account lifecycle and refresh tests pass. |
| Account lifecycle | Failed cleanup of a newly created OAuth row invalidated a row that Host had failed to delete. Invalidate only after successful Host deletion. | Failed cleanup retains the surviving account instance; failed ordinary deletion retains credentials and catalog. |
| Relay metadata | Route-prefixed model IDs failed exact leaf matching. Compare leaves for metadata lookup while retaining the requested wire ID. | Prefix fixtures match exactly, without borrowing metadata for similarly named models. |
| Release gate drift | Preflight still required the retired bundled models.dev snapshot. Validate display-only operation metadata instead, including rejection of runtime/auth/price fields. | Release documentation preflight passes. |

## Validation and limits

Final counts, build checks and the production sidecar fingerprint are recorded in
[adoption](pi-0991-adoption.md). All three patches were reversed in temporary
package copies, applied cleanly again, and compared byte-for-byte with the installed
files used by tests. The changed tracked diff and untracked deliverables contain
no candidates matching the reviewed high-confidence credential patterns.

Installed Electron, real OAuth/paid APIs, cross-platform packaging and rollback
against the previous release remain unqualified. See [release gaps](pi-0991-gaps.md).
No new coding-agent session integration or Codemode feature was enabled.
