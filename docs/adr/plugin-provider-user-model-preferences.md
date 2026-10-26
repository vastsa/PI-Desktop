# ADR: Plugin provider user model preferences

- Status: Accepted
- Date: 2026-10-25
- Amends: [ADR 0259](0259-plugin-declared-providers.md)
- Related: [Provider configuration](../spec/03-runtime/12-provider-config-schema.md), [Plugin manifest](../spec/07-plugins/02-plugin-manifest-schema.md)

## Context

Plugin declarations already materialize ordinary Host-owned provider rows. The
runtime can use those rows, but Settings refuses their model edits and manifest
reconciliation replaces model bindings on every load. Consequently users cannot
persist aliases, model budgets, thinking choices or delegation opt-ins through
the native model controls. Merely removing the Settings guard would silently
lose those edits on the next plugin load.

## Decision

Keep the existing provider identity and single-writer persistence boundary.
`providers.update` accepts user model preferences, display name and enablement
for plugin-owned rows. Sparse explicit values in the existing
`config_json.pluginUserOverrides` extension distinguish an untouched default
from a saved name, enablement or whole model list, including an empty list.
The effective model list is projected into `config_json.models`, so ordinary
resolution uses the same bindings. Aliases never change wire identity.

Reconciliation uses the manifest for transport identity and unmodified defaults;
it keeps explicitly overridden user preferences. The model-list override is a
whole-list selection rather than a second catalog merged by heuristic. Removing
a plugin default therefore cannot silently remove a user-selected binding.
The Host preserves headers and OAuth metadata only for unchanged transport.

Plugin disable forces effective enablement off without changing the remembered
user choice. Re-enabling restores that choice, not unconditional enablement.
A user cannot re-enable a provider while its owning plugin is disabled.
The internal `config_json.pluginEnabled` marker is written only by Host
lifecycle reconciliation, independently of the user override.
Deleting the provider still requires its plugin lifecycle. Declaration removal
or uninstall removes the row, its overrides, and both credential references.

Vendor, provider type, protocol, endpoint, authentication kind and API style
remain plugin-owned. A changed value submitted by an ordinary edit is rejected
before secret writes; an equal value remains compatible with older clients.
A manifest endpoint/API-style/protocol/authentication change invalidates old
credentials, custom headers, OAuth metadata and discovery data rather than
silently signing requests to a changed service.

Settings uses the shared native model picker for API-key, no-auth and OAuth
plugin rows. The model editor submits only identity, name and selected bindings;
it does not expose transport or credentials. Opening the editor reads cached
metadata, while a user-requested refresh follows ordinary provider discovery.
Image-use preferences remain in the existing application settings rather than
being confused with image-input support. Neither user selection nor this change
adds an inference transport or grants local tool-execution permissions.

## Consequences

- Existing declarations without user overrides keep their refresh semantics.
- Existing databases remain readable without a schema migration. Older versions
  ignore override values and can overwrite preferences if downgraded.
- Sessions, delegation and image generation continue to resolve the same Host
  provider identity; custom inference protocols require their own transport
  integration, not a plugin-private provider registry.
- Credentials must be entered again after a plugin changes its declared
  transport destination. This is deliberate credential isolation.

## Alternatives

Making the manifest permanently authoritative was rejected because it prevents
user model configuration. Unconditionally keeping every existing model list
was rejected because untouched declarations would never receive plugin updates.
A parallel plugin settings/catalog database was rejected because consumers
would gain competing identities and persistence authorities.
