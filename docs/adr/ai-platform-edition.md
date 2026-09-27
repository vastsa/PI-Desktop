# ADR: Fixed AI Aggregation Platform distribution

- Status: Accepted for the local fork
- Date: 2026-09-27

## Context

This fork must offer a native, mandatory `ai.yykkj.com` provider rather than a
preselected custom endpoint. The user also wants the existing independent Skill
image/video scripts and a path to platform payment integration. Upstream source,
license notices, local projects, conversations, tools and permissions remain.

## Decision

Keep the process architecture and SQLite ownership unchanged. Add a product-owned
provider boundary in agent-runtime, backed by shared policy and Electron IPC
validation. All normal session, subagent and one-shot construction passes through
it. Preserve the old adapters in an explicitly upstream module for maintenance;
the product entry point does not export their unrestricted constructors.

Only the platform vendor, fixed HTTPS endpoint and platform API-key authentication
are usable. Support Chat Completions, Responses and Anthropic Messages through
that same platform. Published model metadata cannot change the URL, credential or
wire protocol. Reject OAuth, custom endpoints and extension-owned model streams;
ordinary extension tools and skills are unaffected. Native Pi history stays
readable, but its independent credential chain cannot be opened for continuation;
start a desktop chat with a platform model instead. This is product routing policy,
not a sandbox for arbitrary user-written code or an attempt to restrict forks.

Reuse the existing media CLI rather than introduce a second video protocol or
billing implementation. Package it as resources and execute it behind a typed,
host-authorized `PlatformMedia` tool. Python 3.9+ is an explicit prerequisite;
there are no third-party pip dependencies. The desktop injects its selected
provider's key only into that process. It does not write the key into the Skill,
read Codex authentication, or require a second configuration.

Expose read-only token usage and open the real web wallet for account login and
recharge. API keys do not grant account/payment authority. Native checkout and
order reconciliation need a separate account-authenticated contract and are not
implemented by guessing routes or treating a browser return as successful payment.

## Alternatives

- A UI-only preset cannot enforce routing at subagent/one-shot boundaries.
- A Node reimplementation of the mature CLI would duplicate receipt, recovery,
  multimodal and billing logic and increase parity risk.
- Reusing an API token for wallet operations would conflate two credentials.

## Compatibility and consequences

No schema or database migration; no server changes. Legacy foreign-provider rows
and secrets are retained but hidden from runnable selection and rejected before
use. Users must explicitly configure a platform key; never repurpose a foreign
credential. Existing sessions pinned to foreign providers require a model change.
API styles are explicit; use separate platform rows when different model families
require different wire protocols. Media works independently of `/v1/models`
advertising MiniMax-H3. New tools remain high-risk and unavailable in Plan/Goal.

Tests distinguish preserved upstream adapter behavior from the enforced product
path. Offline HTTP/process fixtures verify contracts, not actual provider output
quality, live billing settlement, Windows process behavior or payment success.

## Addendum: local video presentation

The existing image-only data-URL reader is unsuitable for large videos, and the
workspace-relative Markdown link handler drops absolute session-scratch links.
Keep the existing filesystem ownership and containment boundary, adding three
allowlisted UI IPC operations (acquire/release/save) and a main-process-owned
opaque video capability. Only the trusted main renderer may mint or save one.
The custom scheme streams bounded ranges from open file handles; native Save As
copies an existing file to an explicitly chosen destination. Compared with
base64 IPC this avoids materializing an entire video in renderer memory; compared
with enabling file URLs it does not grant arbitrary local access. Credentials,
agent permissions, database schema and the platform server are unchanged.
