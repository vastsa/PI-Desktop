# Permission Review and Scoped Grants

Status: implementation contract. Related: [tools and permissions](03-tools-and-permissions.md),
[permission UX](../04-ux/03-permission-ux.md), and ADR 0306.

## Ownership and compatibility

Host-core owns permission decisions, pending requests, grant lifetimes, and
execution admission. The shared host runtime coordinates review; agent-runtime
performs an independent, tool-free Pi completion. Electron supplies model/auth
resolution and presentation adapters. Renderer state is never authorization.

Ask, Accept edits, and Auto remain permission modes. The independent reviewer
choice is User or Auto review, with a global default and a session override.
Missing fields retain User; an inherited session follows the global setting.
Auto bypasses review and is labelled accordingly. Plan/Goal hard denials and
sensitive-file restrictions retain priority over all approval sources.

The Pi SDK remains pinned. Native Pi continuation retains `noTools: "all"`,
its canonical JSONL, and lease protections. Review is not a native tool bridge.
No permission control is exposed as a model tool or added to the sidecar's
general reverse-RPC allowlist. Existing public plugin contracts remain intact.

## Scoped manual grants

Manual session grants bind the originating session and caller identity, never
just a tool name. A parent's grant is not a delegate's grant. File grants bind
the canonical target and operation; commands bind the complete command, cwd,
and selected shell; external tools bind identity, configuration, and arguments.
An Edit move must include both source and destination in its authorization.
Directory search does not confer mutation rights. No prefix/wildcard command
grants are introduced in this increment.

The UI displays the exact scope before granting and lists active grants with
individual and all-grants revocation. Grants are memory-only and expire on
restart. Permission-mode or reviewer changes invalidate session grants.
Revocation prevents future admission, not side effects already performed.
Execution rechecks canonical targets and current configuration after waits.

MCP names and server-provided annotations are not automatic low-risk grants.
Under Ask and Accept edits, an ungranted MCP call requires approval. Auto keeps
its existing meaning. Trusted host-local execution tools also require host
admission; pure interaction tools have an explicit exemption classification.

## Automated review

Only a call that already needs approval is eligible. The reviewer receives a
host-bound snapshot of the action and available authorization evidence: actual
user request, approved plan when applicable, tool identity and arguments,
workspace/cwd, permission mode, and execution-isolation capability. Tool text,
model prose, and repository content are evidence to assess, not instructions
or proof of user authorization. Credentials are never supplied. Missing,
redacted, oversized, or incomplete decision-critical input requires a human.

The model binding either follows the session or pins a provider/model pair;
reasoning effort is configured separately. An unavailable pinned model never
silently falls back to another provider. Review uses no tools, skills,
extensions, or main-session context mutation. The built-in reviewer policy is
versioned and cannot be replaced by repository instructions. A local user can
edit the policy in Permissions settings: `autoReview.policyPrompt` replaces the default
policy instead of being appended to a second hidden policy. The custom-policy
input is visible and blank when no override exists. It has a short placeholder
explaining that an empty input uses the built-in policy. Nonempty text is saved
automatically after typing pauses or the field loses focus and replaces the
built-in policy; clearing the input automatically removes the override. There
are no separate Save or Restore controls. Background settings refreshes must
not discard an unsaved draft, and failed saves retain the draft with an error.

The configured policy is separate from the fixed response schema, tool-free
execution constraints, and Host admission rules. Editing it cannot disable
credential filtering, hard denials, invalid/expired request checks, or the
requirement for a validated one-use approval. Empty or oversized policies are
rejected at the Host boundary. The limit is 8,000 Unicode scalar values,
counted consistently by the editor and Host. Model or reasoning changes preserve the policy.
Without a fixed reviewer model, the reasoning selection shows `off` and is
disabled. With a fixed model, `off` and its configured reasoning levels are
selectable; a model change falls back to `off` when the old level is unsupported.
`off` sends no reasoning override to the independent review request.
Policy changes invalidate outstanding review claims and unused authorization;
a late decision cannot execute under a policy different from the claimed one.
The policy used by a review is bound to its Host snapshot and is identifiable
in audit metadata without storing the raw custom text in audit entries.

Validated outcomes are `allow_once`, `deny`, and `needs_user`, with risk,
authorization assessment, and a short reason. Automatic approvals never create
session grants. Ambiguous scope, credential access, destructive bulk changes,
publication, external messaging, or security weakening requires human review;
host hard denials cannot be overridden. Model denial closes the current call.
An explicit human reconsideration is a new current-argument approval, not a
replay of an expired decision.

Each review has a 20-second deadline and no automatic model retry. At most two
reviews run globally, with one per session. Queued and active reviews share the
original 120-second permission deadline; fallback does not reset it. Failure,
timeout, invalid output, missing capability, or uncertain evidence switches to
manual approval without running the tool. Final permission expiry denies.

Manual takeover cancels automated review. Requests bind session, turn, caller,
tool-call identity, argument fingerprint, and policy generation. Only the first
valid decision settles a request. Cancellation, configuration change, end of
turn, process disposal, and restart invalidate late responses. Host-local
execution consumes a host-issued single-use permit immediately before effects.

## Presentation and auditing

Settings expose reviewer choice, model binding, reasoning, and an editable
policy with Save and Restore default. Custom policy is local safety
configuration, excluded from portable configuration import and export.
Composer shows
the effective mode and reviewer, including Auto's bypass state. Inline cards
show pending review, manual fallback and its reason, the relevant scope, and
manual takeover without navigating another session. Tool settlement and
cancellation use the existing transcript result. The permission menu retains
recent automatic approval, denial, and fallback outcomes with their reasons,
reviewer model, and separate usage; missing usage is unknown, not zero.

Enabling review explains that necessary action context is sent to the selected
model and that reviews incur additional usage. Usage is accounted separately
from the parent model response. Audit includes decision source, reviewer model,
policy version, input fingerprint, reason, latency, and usage, with no chain of
thought or raw credentials. Imported configuration must not enable review on a
new device without its local security-configuration approval.

## Explicit limits and subsequent work

Review is not OS sandboxing. Shell and trusted Node extension code still run
with the user's privileges; UI and documentation must state that limit.
Three-platform shell filesystem/network isolation, plugin capability isolation,
and native Pi built-in/extension tool bridging are separate later increments.
The complete roadmap stays in the tracking Issue with unchecked items; a PR
checks only behavior actually implemented and validated by that candidate.

## Acceptance

- User enables review, requests a tool, sees approval or human fallback, and
  observes exactly one execution and its audit outcome.
- User edits and saves the policy, reopens settings to see the saved value,
  changes model without losing it, and restores the built-in default. An
  in-flight old-policy decision is rejected after a policy change.
- MCP Ask, changed target/command/shell/actor/configuration, revoked grants,
  and host-local tools cannot reuse unrelated authorization.
- Failure, malformed model output, prompt injection, oversized context,
  takeover, stale replies, concurrent decisions, cancellation, expiry, and
  restart never execute an unapproved action.
- Existing Auto, Accept edits, Plan/Goal, native Pi no-tools, and SDK
  stop/error/cancellation/usage contracts retain their documented semantics.
- Tests use isolated host state and local model/MCP fixtures, not live user
  profiles, credentials, or paid services.
