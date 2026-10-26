# ADR: Plugin templates create independent native provider accounts

- Status: Accepted
- Date: 2026-10-26
- Supersedes: ADR 0322's singleton-only directory rule for new templates
- Amends: ADR 0259 (legacy declarations remain compatible)

## Context

A manifest-owned singleton is not an account factory. Hiding its directory tile
after key entry prevents independent accounts, and overloading its fixed ID for
OAuth reauthentication risks replacing another account's credentials. Official
services already use native account rows; plugins should extend integration
choices, not introduce another account UI or agent executor.

## Decision

Introduce the closed, versioned `contributes.providerTemplates` data contract.
The template identity is `(pluginId, templateId)`; Rust Host generates each
account UUID and persists its validated source binding. Installing a template
creates only a reusable chooser entry. The chooser key is not a provider ID.

Native setup, names, model preferences, enablement and account deletion operate
on the generated account. New OAuth login creates a disabled pending account;
reauthentication targets an existing account ID. Pending failure/cancellation
removes that account, with observable cleanup failures and startup recovery.
Schema 26 adds a binding table without adopting or renaming existing accounts.
Main's schema 25 discovery migration remains ordered before it. The v25→v26
transaction also repairs development v25 databases that have template bindings
but lack discovery state, retaining existing bindings and publication state.

Host executes compatible API-key/no-auth transports and declarative public-client
PKCE/device OAuth. Custom OAuth and inference remain separate high-risk grants.
A custom adapter receives only the authorized request/account credential, never
another account or a refresh token through inference. A Node utility process is
trusted code, **not an OS sandbox**. Host-controlled errors replace raw adapter
exceptions and explicit stream error messages.

Account/template/runtime/session/model checks and cancellation reject stale
results. Disable/revoke and template removal retain account data while stopping
use; uninstall removes owned accounts/secrets/discovery but not conversations.
Sensitive destination/auth/protocol changes invalidate credentials; display
updates preserve preferences. Native chat, subagent and image executors remain
owners of authorization, scheduling and persistence. No paid probe, fallback or
custom retry is introduced. Unsupported connection checks report unsupported.

## Consequences

- Official services and legacy `contributes.providers` keep their identities,
  permissions and behavior; no forced manifest migration is required.
- A template can create multiple independently editable/removable accounts.
- The Host must reconcile stored definitions and recover abandoned logins.
- Declarative configuration supports bounded standard protocols, not arbitrary
  expressions, client secrets, vendor JWT inference or proprietary protocols.
- Framework and synthetic fixture support is not evidence of Antigravity or
  any real vendor's interoperability or entitlement.

## Alternatives

Keeping singleton entries cannot represent independent credentials. Letting
plugins own account UI/storage duplicates native logic and weakens ownership.
Migrating official providers is unnecessary and increases compatibility risk.

## References

- [Template contract and lifecycle](../spec/07-plugins/17-provider-template-accounts.md)
- [Original chooser decision](0322-plugin-providers-in-add-service.md)
- [Inference transport decision](global-plugin-provider-inference.md)
