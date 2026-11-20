# ADR: Built-in GitHub connector

- Status: Accepted
- Date: 2026-11-20
- Related: D688, ADR 0098 (vendor-account login), ADR 0283 (MCP OAuth),
  ADR fork-release-coordinates

## Context

Remote GitHub sessions need the desktop to act as the user on GitHub: list the
repositories and branches they can reach, and later push a work branch and
open a pull request. Until now PI-Desktop had no GitHub credential of its own.
A user could add a GitHub MCP server with a token in a header, or sign in to
GitHub Copilot as a model vendor, but neither gives Electron main a token it
may spend on the REST API.

The credential is sensitive. A `repo`-scoped token reads and writes every
private repository the user can reach, so where it lives, who can read it, and
which hosts it is sent to are security boundaries, not implementation details.

## Decision

1. **One built-in connector, owned by Electron main.** A main-process service
   holds the credential, signs the user in, and makes every GitHub REST call.
   The renderer reaches it over seven IPC channels and two event channels
   (`pi-desktop/github/*`) and receives an account, its scopes, and a
   connection state. Other main-process modules get the token through
   `getActiveGitHubConnector().token()`; nothing returns it over IPC.

2. **Sign-in is an OAuth App with device flow; a pasted token is the
   fallback.** The build ships only the OAuth App's public client id
   (`GITHUB_OAUTH_CLIENT_ID`). Device flow needs no client secret, so there is
   none to protect. While the client id is empty, and whenever the user
   prefers, a personal access token can be pasted instead; main validates it
   against `GET /user` before storing it.

3. **Scopes are `repo` and `read:org`; `workflow` is opt-in.** A checkbox at
   sign-in adds `workflow`, which GitHub requires to push changes under
   `.github/workflows`. It is off by default. A pasted token is stored with
   the scopes GitHub reports for it, so Settings can say when `repo` is
   missing; a fine-grained token reports none and gets no warning.

4. **The token and the account are one secret under a fixed reference.** The
   value under `secret:app:github-connector` in the host-core secret store is
   one JSON record: token, kind (`oauth` or `pat`), login, display name,
   avatar URL, scopes, and when it was saved. Keeping the account beside the
   token lets Settings show who is connected without a network call. A record
   that is missing, damaged, from another version, or holding a token that
   could not be sent in a header reads as "not connected".

5. **Pinned hosts.** REST calls go to `https://api.github.com`; the device
   flow talks to `https://github.com/login/device/code` and
   `https://github.com/login/oauth/access_token`. All three are constants, no
   caller supplies a host or a URL, a redirect is never followed, and owner,
   repository, and branch names are validated before they become a path
   segment or a query value. The page the user is sent to for the device code
   is always `https://github.com/login/device`, whatever the response names.

6. **One login at a time, and only the current one may store.** Starting
   another login, pasting a token, disconnecting, and quitting each abort the
   login in progress, and a login re-checks that it is still current after
   every wait. A login that outlives its dialog can neither keep polling nor
   write a token over a newer decision.

7. **A failed GitHub call is a failure.** Errors are typed
   (`GITHUB_*`, [08-error-codes](../spec/03-runtime/08-error-codes.md) §3.11)
   and never cached. A 401 marks the stored token as rejected: the status
   reports `needsReauthentication`, the repository cache is dropped, and the
   credential is kept so the user can see which account needs attention.

8. **The connector is blocked on the local MCP control plane and limited to
   the main window.** All seven invoke channels are in
   `MCP_CONTROL_BLOCKED_CHANNEL_KEYS`, and the handlers are registered with
   their sender, which keeps them out of the internal invoke map the control
   plane and the remote-host router dispatch through.

9. **Disconnect removes the token locally and does not revoke it.** Revoking
   an OAuth token through the API needs the OAuth App's client secret, which
   the app deliberately does not have. Settings tells the user to remove the
   app in their GitHub settings if they want the token revoked.

## Consequences

- The desktop holds a long-lived, broadly scoped GitHub credential. It is
  encrypted at rest by the host-core secret store, read only by Electron main,
  and sent only to GitHub's own hosts. A compromise of the main process or of
  the data directory's encryption key exposes it; a compromised renderer or a
  local MCP control client does not.
- OAuth App tokens do not expire, so there is no refresh path to maintain and
  no silent re-authentication. A token that stops working (revoked, or an
  organization that now requires SSO authorization) is reported, and the user
  connects again.
- `repo` is broader than the feature needs for a single repository. GitHub's
  OAuth scopes cannot be narrowed per repository; the narrower alternative is
  a GitHub App (see below) or a fine-grained personal access token, which the
  pasted-token path accepts.
- Until the owner registers the OAuth App and sets the client id, sign-in is
  by pasted token only, and Settings says so.
- Owner, repository, and branch names follow the rules the host git
  capability uses, and those accept every name GitHub can list: owners may
  contain `_` (Enterprise Managed User logins), and branch names follow git's
  reference-name rules. A name outside them is refused before any request.
- Because a redirect is never followed, a repository that was renamed or
  transferred reads as not found until the user picks it again.
- GitHub can answer a listing with 200 while leaving out an organization
  whose SAML SSO has not authorized the token. Listings carry `ssoPartial`
  in that case so a short list is not presented as the whole account.
- Main writes its messages in English; the renderer shows the catalog's
  sentence for each `GITHUB_*` code.
- No SQLite schema change, no host-core protocol change, and no new runtime
  dependency: the connector uses the existing `secrets.*` host methods and the
  process `fetch`, which main already routes through the configured proxy.
- Settings gains a sixteenth destination, **Connectors**, in the Agent
  cluster after MCP ([06-settings-ia](../spec/04-ux/06-settings-ia.md)).

## Alternatives

- **A GitHub App instead of an OAuth App.** Its permissions are per
  repository and its user tokens are short-lived, which is a better security
  posture. It also has to be installed on every account or organization
  before a repository becomes reachable, and its tokens need a refresh path
  with a stored refresh token. That is a second onboarding step in front of
  the first session and more credential machinery than this version needs.
  It remains the likely successor if per-repository scoping becomes a
  requirement.
- **Reuse the pi-ai GitHub Copilot login.** The app already signs in to
  GitHub for Copilot through the vendor-account flow, but that flow yields a
  Copilot credential for model requests, not a token for the REST API or for
  git over HTTPS.
- **Store the token as a header on a GitHub MCP server.** MCP server records
  are plain text under `~/.agents`, outside the host-core secret store. A
  credential that can push to private repositories does not belong in a
  configuration file.
- **Revoke on disconnect.** It would need the OAuth App's client secret in
  the build, which would stop being a secret the moment it shipped.
