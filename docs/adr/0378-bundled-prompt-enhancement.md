# ADR 0378: Ship Prompt Enhancement With the Application Image

- Status: Accepted
- Date: 2026-11-03
- Supersedes: the default-install clause of ADR 0324

## Context

ADR 0324 moved prompt enhancement out of the host and into the standalone
`vastsa/pi-prompt-enhancement` plugin, and decided the host would neither bundle
nor enable that plugin by default: the action was to appear only after a user
installed the plugin and granted its declared permissions.

That boundary leaves every build that does not sync the marketplace set without
any Composer text action. The bundled set of a build is whatever sits in
`apps/desktop/resources/plugins`, and since ADR 0241 the repository tracks only
the first-party plugins there (`pi.browser`, `pi.file-manager`); the rest is
fetched from the catalog by `scripts/sync-bundled-plugins.mjs` and is never
versioned, because it is 100+ MiB of assets with its own release cadence. An
instance started from a fresh worktree therefore ships no prompt-enhancement
action, and the feature disappears again whenever the user runs a build that did
not sync — which is exactly the intranet case the sync script exists for, where
the catalog's package URL is not reachable from the client.

The enhancement action is part of the shipped product rather than a marketplace
extra: the Composer toolbar is specified with a plugin text action in it, and
its absence changes the product's visible surface.

## Decision

- Track the released `pi.prompt-enhancement` plugin in
  `apps/desktop/resources/plugins/pi.prompt-enhancement` and un-ignore that path
  in `.gitignore`, so every build this repository produces ships it as a bundled
  plugin.
- Keep the vendored copy byte-identical to the marketplace release. Its manifest
  declares `composer.transform`, `agent.complete`, `models.list`, and
  `ui.panel`; its own panel owns the model, reasoning level, and template
  settings.
- Do not change the host contract. `contributes.composerTransforms` with
  `composer.transform`, the draft-only data boundary, the 100,000-character
  limit, the plugin-call timeout, the permission and manifest checks on every
  invocation, the audit trail, and the one-step undo all stand as ADR 0324
  specifies them. The plugin remains the owner of its transform, its settings,
  and its model request.
- Ship it enabled. A bundled plugin takes the permissions its manifest declares,
  so the action is available from first launch without a marketplace download or
  an install step. The user can still disable the plugin, and can update it from
  the marketplace (ADR 0241).

## Consequences

- The Composer enhancement action is present in every build this repository
  produces, including offline intranet installs and fresh development
  worktrees, without depending on the plugin catalog being reachable.
- `pi.prompt-enhancement` is bundled, so it can be disabled but not uninstalled
  (ADR 0241). A user who wants no enhancement action turns it off.
- `composer.transform`, `agent.complete`, `models.list`, and `ui.panel` are
  granted at launch for this plugin instead of through an install-time review.
  The narrower guarantee is unchanged: the transform callback receives only the
  draft text and the optional current model key, every invocation re-checks the
  permission and the manifest declaration, and a disabled plugin contributes
  nothing. This is the price of shipping the action by default and is why the
  plugin stays byte-identical to a reviewed release.
- Updating the action means replacing the vendored release and bumping its
  version, the way the other in-tree plugin (`pi.file-manager`, kept at a
  patched `0.5.3-pi.1`) is maintained. The sync script skips ids the repository
  already tracks.
- The one-time migration of legacy host prompt-enhancement preferences changes
  trigger: it now runs on the first load of the bundled plugin instead of on a
  user install. The marker, the precedence of existing plugin values, and the
  retention of the legacy host values are unchanged.

## Alternatives considered

- Keep the plugin un-bundled and rely on the marketplace or on
  `scripts/sync-bundled-plugins.mjs` per instance: rejected because the shipped
  product then loses a specified Composer action whenever a build does not sync,
  and the intranet catalog URL is not reachable from the client.
- Bundle the whole synced marketplace set so no feature can go missing: rejected
  because it re-commits 100+ MiB with an independent release cadence, which ADR
  0241 and the sync script deliberately keep out of git.
- Ship it bundled but disabled (`enabled_by_default: false`): rejected because
  diverging the vendored manifest from the release costs more than it protects;
  a user who does not want the action disables the plugin.
