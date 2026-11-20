# GitHub Connector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The user signs in to GitHub once from a new Settings → Connectors page, and Electron main can then list their repositories and branches and create pull requests, with the token never leaving the main process.

**Architecture:** A main-process connector service owns the token (in the host-core secret store under a fixed first-party reference), a device-flow driver, and a small REST client pinned to GitHub's hosts. The renderer talks to it over new allowlisted IPC channels and reuses the existing login dialog through an adapter. Nothing here touches remote hosts; a later plan wires the token to them.

**Tech Stack:** TypeScript, Electron main, React 19, typebox-free plain IPC DTOs (as the Jev integration does), `node --test`, vitest (`packages/shared`), i18next catalogs in nine locales.

**Spec:** `docs/superpowers/specs/2026-11-20-remote-github-sessions-design.md` (Part 3, §6). Plan 3 of 7. Plans 4 to 6 consume the "Cross-plan contract" below; do not rename it.

## Global Constraints

- Work in the worktree and branch you were given. Do not push; the coordinator integrates.
- This plan must not import or depend on anything from the host git workspaces plan (`workspaceGit`). The two are implemented in parallel.
- The token is read only in Electron main. It never appears in a renderer payload, an IPC result, a log line, an error message, or a file other than the host-core secret store.
- Every GitHub request goes to `https://api.github.com` or `https://github.com/login/…`, built from constants. No caller-supplied host or URL.
- No SQLite schema change. No new runtime dependency.
- Adding a Settings destination changes all nine locale catalogs; every catalog must keep the same key set as English.
- New logic goes in new modules. `apps/desktop/electron/main/index.ts`, `apps/desktop/src/stores/app-store.ts`, and `packages/shared/src/protocol.ts` gain only wiring.
- New `.ts` and `.tsx` files stay under 800 lines.
- Do not run `pnpm install`.
- Stage files by explicit path. Commit messages: Conventional Commits, English, subject + blank line + body explaining why. No `Co-Authored-By` or `Signed-off-by`.
- Decision id for this plan: **D688**. Decision record slug: `github-connector`.

## Cross-plan contract

**Constants** (`packages/shared/src/github-connector.ts`, exported from the package root):

```ts
export const GITHUB_OAUTH_CLIENT_ID = "";                       // set when the owner registers the OAuth App
export const GITHUB_CONNECTOR_BASE_SCOPES = ["repo", "read:org"] as const;
export const GITHUB_CONNECTOR_WORKFLOW_SCOPE = "workflow";
export const GITHUB_CONNECTOR_LOGIN_ID = "github-connector";    // stands in for a provider id in login events
```

`GITHUB_CONNECTOR_SECRET_REF = "secret:app:github-connector"` goes in `packages/shared/src/secret-refs.ts`.

**Types** (`packages/shared/src/types/github-connector.ts`):

```ts
type GitHubConnectorStatus = {
  connected: boolean;
  deviceLoginAvailable: boolean;                 // GITHUB_OAUTH_CLIENT_ID is not empty
  account?: { login: string; name?: string; avatarUrl?: string };
  scopes?: string[];
  tokenKind?: "oauth" | "pat";
  needsReauthentication?: boolean;               // GitHub answered 401 with the stored token
};
type GitHubRepositorySummary = {
  owner: string; name: string; fullName: string; private: boolean;
  defaultBranch: string; archived: boolean; pushedAt?: string; description?: string;
};
type GitHubBranchSummary = { name: string; protected: boolean };
type GitHubPullRequestSummary = {
  number: number; url: string; title: string; draft: boolean;
  state: "open" | "closed" | "merged"; head: string; base: string;
};
```

**IPC channels** (`IPC.invoke` / `IPC.event` in `packages/shared/src/protocol.ts`):

| Key | Channel | Input | Result |
| --- | --- | --- | --- |
| `githubConnectorStatus` | `pi-desktop/github/status` | none | `GitHubConnectorStatus` |
| `githubConnectorLoginStart` | `pi-desktop/github/login/start` | `{ allowWorkflowScope: boolean }` | `{ loginId: string }` |
| `githubConnectorLoginCancel` | `pi-desktop/github/login/cancel` | `loginId: string` | `{ ok: boolean }` |
| `githubConnectorSetToken` | `pi-desktop/github/setToken` | `{ token: string }` | `GitHubConnectorStatus` |
| `githubConnectorDisconnect` | `pi-desktop/github/disconnect` | none | `GitHubConnectorStatus` |
| `githubRepositories` | `pi-desktop/github/repositories` | `{ query?: string; refresh?: boolean }` | `{ repositories: GitHubRepositorySummary[]; truncated: boolean }` |
| `githubBranches` | `pi-desktop/github/branches` | `{ owner: string; name: string }` | `{ branches: GitHubBranchSummary[]; defaultBranch: string; truncated: boolean }` |
| event `githubConnectorLogin` | `pi-desktop/github/event/login` | — | `OAuthLoginEvent` |
| event `githubConnectorChanged` | `pi-desktop/github/event/changed` | — | `GitHubConnectorStatus` |

**Main-process service** (`apps/desktop/electron/main/github/connector.ts`):

```ts
type GitHubConnector = {
  status(): Promise<GitHubConnectorStatus>;
  token(): Promise<string | null>;                                   // main only; never crosses IPC
  onChange(listener: (status: GitHubConnectorStatus) => void): () => void;
  startDeviceLogin(input: { allowWorkflowScope: boolean }): Promise<{ loginId: string }>;
  cancelLogin(loginId: string): Promise<boolean>;
  setToken(token: string): Promise<GitHubConnectorStatus>;
  disconnect(): Promise<GitHubConnectorStatus>;
  listRepositories(input: { query?: string; refresh?: boolean }): Promise<{ repositories: GitHubRepositorySummary[]; truncated: boolean }>;
  listBranches(repository: { owner: string; name: string }): Promise<{ branches: GitHubBranchSummary[]; defaultBranch: string; truncated: boolean }>;
  findPullRequest(repository: { owner: string; name: string }, head: string): Promise<GitHubPullRequestSummary | null>;
  createPullRequest(repository: { owner: string; name: string }, input: { head: string; base: string; title: string; body: string; draft: boolean }): Promise<GitHubPullRequestSummary>;
};
function getActiveGitHubConnector(): GitHubConnector | null;
```

**Error codes** (shared registry, not retriable unless noted): `GITHUB_NOT_CONNECTED`, `GITHUB_AUTH_FAILED`, `GITHUB_FORBIDDEN`, `GITHUB_NOT_FOUND`, `GITHUB_RATE_LIMITED` (retriable), `GITHUB_NETWORK` (retriable), `GITHUB_INVALID_TOKEN`, `GITHUB_DEVICE_FLOW_UNAVAILABLE`, `GITHUB_LOGIN_EXPIRED`, `GITHUB_LOGIN_DENIED`, `GITHUB_VALIDATION_FAILED`.

**Settings destination id:** `connectors`, in the `agent` group, immediately after `mcp`.

## Review Focus

1. The stored token stops working (revoked on GitHub, expired, organization SSO not authorized): listing repositories must fail with a clear typed error and the status must say re-authentication is needed, not show an empty repository list as if the account had none. Pinned in Tasks 3 and 5.
2. The user starts device login, then closes the dialog, starts again, or quits the app mid-poll: no orphaned polling loop keeps running, and an old login can never store its token after a newer one was started or after disconnect. Pinned in Tasks 4 and 5.
3. An account with more repositories or branches than one page: results are complete up to the documented cap and `truncated` says so beyond it; the list is never silently cut at the first page. Pinned in Task 3.
4. GitHub answers with a rate limit (403 or 429 with rate-limit headers), or the network is down: the user gets a typed, retriable error; nothing is cached as an empty result. Pinned in Task 3.
5. A pasted token with surrounding whitespace, a newline, or a token that authenticates but lacks the `repo` scope: whitespace is trimmed, control characters are rejected before any request, and a classic token missing `repo` is stored with its real scopes so the UI can say what is missing. Pinned in Task 5.

---

### Task 1: Shared contract

**Files:**
- Create: `packages/shared/src/github-connector.ts`, `packages/shared/src/github-connector.test.ts`
- Create: `packages/shared/src/types/github-connector.ts`
- Modify: `packages/shared/src/types.ts` (re-export the type file), `packages/shared/src/index.ts`
- Modify: `packages/shared/src/secret-refs.ts`
- Modify: `packages/shared/src/protocol.ts` (seven invoke keys, two event keys)
- Modify: `packages/shared/src/errors.ts` (eleven codes)
- Modify: `apps/desktop/electron/main/mcp-control.ts` (`MCP_CONTROL_BLOCKED_CHANNEL_KEYS`)

**Interfaces:**
- Produces: everything under "Cross-plan contract" except the main-process service, plus `githubConnectorScopes(allowWorkflowScope: boolean): string[]` and `isGitHubTokenShape(value: string): boolean` (1 to 4096 characters, no whitespace or control characters).

- [ ] **Step 1: Write the failing tests** in `github-connector.test.ts`: `githubConnectorScopes(false)` is `["repo", "read:org"]`; with `true` it appends `"workflow"`; `isGitHubTokenShape` accepts `"gho_abc123"` and rejects `""`, `"a b"`, `"a\nb"`, and a 4097-character string. In the existing protocol test file, assert the nine channel strings from the table and that `IPC_WHITELIST` contains each.

Find the test that pins the local MCP control plane's channel classification (search `apps/desktop/test` for `MCP_CONTROL_BLOCKED_CHANNEL_KEYS`) and extend its expectation: `githubConnectorSetToken`, `githubConnectorLoginStart`, `githubConnectorLoginCancel`, and `githubConnectorDisconnect` are blocked. If that suite requires every invoke channel to be classified, classify `githubConnectorStatus`, `githubRepositories`, and `githubBranches` as blocked too: a local control client has no business enumerating the user's private repositories.

- [ ] **Step 2: Run and see them fail** — `pnpm --filter @pi-desktop/shared exec vitest run src/github-connector.test.ts src/protocol.test.ts`.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run** — `pnpm --filter @pi-desktop/shared build && pnpm --filter @pi-desktop/shared test`, then the MCP control test file with `node --test` from `apps/desktop`. Expected: PASS.

- [ ] **Step 5: Commit** — `feat(shared): add the GitHub connector contract`

---

### Task 2: Token store

**Files:**
- Create: `apps/desktop/electron/main/github/connector-store.ts`
- Create: `apps/desktop/test/github-connector-store.test.mjs`

**Interfaces:**
- Consumes: `GITHUB_CONNECTOR_SECRET_REF`; the host RPC methods `secrets.set`, `secrets.getForRuntime`, `secrets.delete`.
- Produces:

```ts
type StoredGitHubCredential = {
  version: 1; token: string; kind: "oauth" | "pat";
  login: string; name?: string; avatarUrl?: string;
  scopes: string[]; savedAt: string;
};
type HostCall = <T = unknown>(method: string, params?: unknown) => Promise<T>;
function createGitHubConnectorStore(call: HostCall): {
  read(): Promise<StoredGitHubCredential | null>;
  write(credential: StoredGitHubCredential): Promise<void>;
  clear(): Promise<void>;
};
```

The value is one JSON string under the fixed reference, following the `StoredMcpOAuthToken` precedent in `mcp-oauth.ts`. Account metadata is stored beside the token so the connected state can be shown offline.

- [ ] **Step 1: Write the failing tests** with a fake `call`: write then read round-trips; `read` returns null for a missing secret, for non-JSON, for a wrong `version`, and for a record whose `token` fails `isGitHubTokenShape`; `clear` calls `secrets.delete` with the fixed reference; a host error from `read` propagates.

- [ ] **Step 2: Run and see them fail** — `cd apps/desktop && node --test test/github-connector-store.test.mjs`.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run** — same command. Expected: PASS.

- [ ] **Step 5: Commit** — `feat(desktop): store the GitHub connector credential in the secret store`

---

### Task 3: REST client

**Files:**
- Create: `apps/desktop/electron/main/github/github-api.ts`
- Create: `apps/desktop/test/github-api.test.mjs`

**Interfaces:**
- Produces:

```ts
type GitHubApi = {
  viewer(token: string): Promise<{ login: string; name?: string; avatarUrl?: string; scopes: string[] }>;
  listRepositories(token: string): Promise<{ repositories: GitHubRepositorySummary[]; truncated: boolean }>;
  listBranches(token: string, repository: { owner: string; name: string }): Promise<{ branches: GitHubBranchSummary[]; defaultBranch: string; truncated: boolean }>;
  findPullRequest(token: string, repository: { owner: string; name: string }, head: string): Promise<GitHubPullRequestSummary | null>;
  createPullRequest(token: string, repository: { owner: string; name: string }, input: { head: string; base: string; title: string; body: string; draft: boolean }): Promise<GitHubPullRequestSummary>;
};
function createGitHubApi(options?: { fetchImpl?: typeof fetch; timeoutMs?: number }): GitHubApi;
class GitHubApiError extends Error { errorCode: string; retriable: boolean; status?: number; resetAt?: string }
```

Rules:

- Base `https://api.github.com`. Headers `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`, `Authorization: Bearer <token>`, `User-Agent: pi-desktop`. `redirect: "error"`. Default timeout 20 seconds per request.
- Owner, repository, and branch values are validated with the same character rules the host git plan uses (owner: 1 to 39 of `[A-Za-z0-9-]`; repository: 1 to 100 of `[A-Za-z0-9._-]`, not `.` or `..`) before a URL is built, and are URL-encoded per path segment.
- `viewer`: `GET /user`; scopes from the `X-OAuth-Scopes` response header, split on commas and trimmed; an absent header yields `[]`.
- `listRepositories`: `GET /user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member`, following `page` up to 10 pages; `truncated` is true when the tenth page was full.
- `listBranches`: `GET /repos/{owner}/{repo}` for `default_branch`, then `GET /repos/{owner}/{repo}/branches?per_page=100` up to 5 pages.
- `findPullRequest`: `GET /repos/{owner}/{repo}/pulls?state=all&head={owner}:{head}&per_page=5`; prefer an open one, else the most recent; a merged pull request reports `state: "merged"`.
- `createPullRequest`: `POST /repos/{owner}/{repo}/pulls`.
- Error mapping: 401 → `GITHUB_AUTH_FAILED`; 403 or 429 with `x-ratelimit-remaining: 0` or a `retry-after` header → `GITHUB_RATE_LIMITED` with `resetAt`; other 403 → `GITHUB_FORBIDDEN` carrying GitHub's `message`; 404 → `GITHUB_NOT_FOUND`; 422 → `GITHUB_VALIDATION_FAILED` carrying the first error message; a thrown fetch or a timeout → `GITHUB_NETWORK`. No error message or log includes the token.

- [ ] **Step 1: Write the failing tests** with a scripted `fetchImpl` that records requests: header set and URL for each call; two full pages then a short page yields 250 repositories and `truncated: false`; ten full pages yields 1000 and `truncated: true`; a rate-limited second page rejects with `GITHUB_RATE_LIMITED` and returns no partial list; 401 → `GITHUB_AUTH_FAILED`; SSO-style 403 → `GITHUB_FORBIDDEN` with GitHub's message; a repository name of `..` rejects before any request; `findPullRequest` prefers open over closed and maps `merged_at` to `merged`; `createPullRequest` sends the JSON body and maps 422; a rejected fetch → `GITHUB_NETWORK`; the token never appears in any thrown message.

- [ ] **Step 2: Run and see them fail** — `cd apps/desktop && node --test test/github-api.test.mjs`.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run** — same command. Expected: PASS.

- [ ] **Step 5: Commit** — `feat(desktop): add a GitHub REST client pinned to GitHub's API host`

---

### Task 4: Device-flow driver

**Files:**
- Create: `apps/desktop/electron/main/github/device-flow.ts`
- Create: `apps/desktop/test/github-device-flow.test.mjs`

**Interfaces:**
- Produces:

```ts
type DeviceFlowEvent =
  | { kind: "deviceCode"; userCode: string; verificationUri: string; intervalSeconds: number; expiresInSeconds: number }
  | { kind: "progress"; message: string };
function runGitHubDeviceFlow(options: {
  clientId: string; scopes: string[];
  onEvent: (event: DeviceFlowEvent) => void;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}): Promise<{ token: string }>;
```

Rules: `POST https://github.com/login/device/code` then poll `POST https://github.com/login/oauth/access_token` with `grant_type=urn:ietf:params:oauth:grant-type:device_code`, both with `Accept: application/json`. Wait `interval` seconds between polls. `authorization_pending` keeps polling; `slow_down` uses the interval the response returns, or adds 5 seconds when it returns none; `expired_token` rejects `GITHUB_LOGIN_EXPIRED`; `access_denied` rejects `GITHUB_LOGIN_DENIED`; `device_flow_disabled` and an empty `clientId` reject `GITHUB_DEVICE_FLOW_UNAVAILABLE`; any other error rejects `GITHUB_AUTH_FAILED`. Polling stops at the device code's expiry even if GitHub never says so. An aborted signal rejects with an abort error and makes no further request.

- [ ] **Step 1: Write the failing tests** with a scripted `fetchImpl` and a recording `sleep`: the happy path emits one `deviceCode` event and resolves the token; the sleeps are 5 s, then 10 s after a `slow_down` with no interval; each terminal error maps to its code; abort during a sleep makes no further request; an empty client id makes no request at all.

- [ ] **Step 2: Run and see them fail** — `cd apps/desktop && node --test test/github-device-flow.test.mjs`.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run** — same command. Expected: PASS.

- [ ] **Step 5: Commit** — `feat(desktop): drive the GitHub device authorization flow`

---

### Task 5: Connector service and IPC

**Files:**
- Create: `apps/desktop/electron/main/github/connector.ts`
- Create: `apps/desktop/electron/main/ipc/github-connector-ipc.ts`
- Modify: `apps/desktop/electron/main/ipc/register.ts` (construct the connector once; register the module next to `registerJevIpc`)
- Create: `apps/desktop/test/github-connector.test.mjs`, `apps/desktop/test/github-connector-ipc.test.mjs`

**Interfaces:**
- Consumes: Tasks 1 to 4.
- Produces: `createGitHubConnector(deps: { store; api; runDeviceFlow; emit(channel: string, payload: unknown): void; clientId: string; openExternal(url: string): Promise<void>; now(): Date; log })`, `setActiveGitHubConnector`, `getActiveGitHubConnector`, and `registerGitHubConnectorIpc({ registrar, connector })`.

Rules:

- `startDeviceLogin` aborts any login in progress, mints a new `loginId`, and returns at once. The flow runs in the background and emits `OAuthLoginEvent`-shaped events on `githubConnectorLogin`: `deviceCode`, then `done` with `providerId: GITHUB_CONNECTOR_LOGIN_ID` and `accountLabel` set to the login, or `error`, or `cancelled`. On the `deviceCode` event it opens the verification page through the existing safe external-open helper.
- A login stores its token only if it is still the current login when it finishes. `disconnect` and a newer `startDeviceLogin` both invalidate it.
- After a token is obtained by either path, the service calls `api.viewer`, stores the credential with the account and scopes, and emits `githubConnectorChanged`.
- `setToken` trims the input, rejects one that fails `isGitHubTokenShape` with `GITHUB_INVALID_TOKEN` before any request, validates it with `api.viewer` (a 401 becomes `GITHUB_INVALID_TOKEN`), and stores it with kind `pat`.
- Repository and branch calls with no stored credential reject `GITHUB_NOT_CONNECTED`. A `GITHUB_AUTH_FAILED` from the API sets `needsReauthentication` in the status, emits `githubConnectorChanged`, and rethrows; the stored credential is kept so the user sees which account needs attention.
- Repositories are cached in memory for 5 minutes, keyed to the stored token; `refresh: true`, a new token, or disconnect drops the cache. `query` filters by case-insensitive substring of `fullName` in the main process. A failed fetch is never cached.
- `disconnect` aborts any login, clears the store and the cache, and emits the change. It does not revoke the token on GitHub; that needs the OAuth App's secret, which the app does not have.
- `dispose()` (called on shutdown) aborts any login.
- IPC handlers validate input shapes (`allowWorkflowScope` boolean, `token` string, `owner` and `name` strings) and return only the DTOs in the contract. No handler returns the token.

- [ ] **Step 1: Write the failing tests** with fakes for store, API, device flow, and emit:
  - device login stores the credential, emits `deviceCode`, `done`, and one change;
  - a second `startDeviceLogin` while the first is pending aborts the first, and when the first's promise later resolves nothing is stored for it;
  - `disconnect` during a pending login leaves the store empty after the login resolves;
  - `cancelLogin` with the current id returns true and emits `cancelled`; with a stale id returns false;
  - `setToken("  gho_x\n")` stores `gho_x`; a token containing an inner newline rejects before any API call; a classic token whose scopes lack `repo` is stored with its actual scopes;
  - repository listing with no credential rejects `GITHUB_NOT_CONNECTED`;
  - a 401 from the API sets `needsReauthentication`, emits a change, and the next `status()` reports it;
  - cache hit within 5 minutes, miss after `refresh`, miss after a new token; a failed listing followed by a successful one returns the successful data;
  - `status()` with an empty `clientId` reports `deviceLoginAvailable: false` and `startDeviceLogin` rejects `GITHUB_DEVICE_FLOW_UNAVAILABLE`;
  - no emitted payload, returned value, or log argument contains the token (search the serialized values).
  - IPC: each channel calls the matching service method; malformed input rejects with `INVALID_ARGUMENT` without calling the service.

- [ ] **Step 2: Run and see them fail** — `cd apps/desktop && node --test test/github-connector.test.mjs test/github-connector-ipc.test.mjs`.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run** — same command, then `pnpm --filter @pi-desktop/desktop typecheck`. Expected: PASS.

- [ ] **Step 5: Commit** — `feat(desktop): add the GitHub connector service and its IPC channels`

---

### Task 6: Connectors settings page

**Files:**
- Modify: `apps/desktop/src/lib/api.ts` (nine methods mirroring the channels: `githubConnectorStatus`, `startGithubLogin`, `cancelGithubLogin`, `setGithubToken`, `disconnectGithub`, `listGithubRepositories`, `listGithubBranches`, `onGithubLogin`, `onGithubConnectorChanged`)
- Modify: `apps/desktop/src/lib/settings-search.ts` (`SettingsTabId`, one `SETTINGS_NAV` entry after `mcp`)
- Modify: `apps/desktop/src/features/settings/SettingsPage.tsx` (icon map), `apps/desktop/src/features/settings/SettingsDestinationContent.tsx` (render branch)
- Create: `apps/desktop/src/features/settings/pages/ConnectorsSettings.tsx`
- Create: `apps/desktop/src/features/settings/connectors/GitHubConnectorCard.tsx`
- Create: `apps/desktop/src/features/settings/connectors/github-login-session.ts` (adapter to `OAuthLoginApi`)
- Create: `apps/desktop/src/features/settings/connectors/use-github-connector.ts`
- Modify: `packages/i18n/src/locales/{de,en,es,fr,ko,pt-BR,tr,zh-CN,zh-TW}/index.ts`
- Create: `apps/desktop/test/github-connector-settings-user-path.test.mjs`
- Test: `packages/i18n/test/catalogs.test.mjs`, `apps/desktop/test/settings-general.test.mjs`, `apps/desktop/test/settings-developer-only-destinations.test.mjs`

**Interfaces:**
- Consumes: the IPC channels.
- Produces: `useGitHubConnector(): { status: GitHubConnectorStatus | null; loading: boolean; error: string | null; refresh(): Promise<void> }` — subscribes to `onGithubConnectorChanged`. Later plans reuse this hook from the composer.

English copy (other locales translate; keys under `settings.connectors`):

| Key | English |
| --- | --- |
| `settings.nav.connectors` | Connectors |
| `settings.connectors.title` | Connectors |
| `settings.connectors.subtitle` | Accounts PI-Desktop can use on your behalf. |
| `settings.connectors.github.name` | GitHub |
| `settings.connectors.github.description` | Pick repositories and branches for remote sessions, push branches, and open pull requests. |
| `settings.connectors.github.connect` | Connect GitHub |
| `settings.connectors.github.connectedAs` | Connected as {{login}} |
| `settings.connectors.github.disconnect` | Disconnect |
| `settings.connectors.github.disconnectNote` | Disconnecting removes the token from this computer. To revoke it, remove the app in your GitHub settings. |
| `settings.connectors.github.allowWorkflow` | Allow changes to GitHub Actions workflow files |
| `settings.connectors.github.allowWorkflowHelp` | Adds the workflow scope. Leave off unless the agent needs to edit files under .github/workflows. |
| `settings.connectors.github.useToken` | Use a personal access token instead |
| `settings.connectors.github.tokenLabel` | Personal access token |
| `settings.connectors.github.tokenSave` | Save token |
| `settings.connectors.github.scopes` | Scopes: {{scopes}} |
| `settings.connectors.github.missingRepoScope` | This token lacks the repo scope, so private repositories and pushes will not work. |
| `settings.connectors.github.needsReauth` | GitHub rejected the saved token. Connect again. |
| `settings.connectors.github.deviceUnavailable` | Sign-in with a code is not configured in this build. Use a personal access token. |

Behavior: not connected shows the workflow checkbox, the Connect button (hidden when `deviceLoginAvailable` is false, replaced by the `deviceUnavailable` note), and the token form behind a disclosure. Connect opens the existing `OAuthLoginDialog` through the adapter with a synthetic vendor `{ vendorId: GITHUB_CONNECTOR_LOGIN_ID, name: "GitHub", isSubscription: false, accounts: [] }`. Connected shows avatar, login, scopes, the missing-scope warning when `tokenKind` is `pat` or `oauth` and `scopes` is non-empty without `repo`, the re-authentication banner when flagged, and Disconnect. The token input is `type="password"`, is cleared after a save attempt, and its value is never placed in component state that outlives the form.

- [ ] **Step 1: Write the failing tests.** Update the three pinned-navigation tests for the new id, its position after `mcp`, and its English label. Write `github-connector-settings-user-path.test.mjs` in the style of `jev-settings-user-path.test.mjs`: render the page with a mocked `api`; not-connected state; clicking Connect calls `startGithubLogin` with the checkbox value; a `done` login event followed by a change event shows "Connected as octocat"; the token path calls `setGithubToken` and clears the field; `deviceLoginAvailable: false` hides Connect and shows the note; a `needsReauthentication` status shows the banner; Disconnect calls `disconnectGithub`.

- [ ] **Step 2: Run and see them fail** — `cd apps/desktop && node --test test/github-connector-settings-user-path.test.mjs test/settings-general.test.mjs test/settings-developer-only-destinations.test.mjs` and `pnpm --filter @pi-desktop/i18n test`.

- [ ] **Step 3: Implement.** Use the existing settings primitives (`features/settings/primitives.tsx`, `components/ui.tsx`) and design tokens; `pnpm lint` fails on hardcoded style values.

- [ ] **Step 4: Run** — the commands from Step 2, then `pnpm --filter @pi-desktop/desktop typecheck && pnpm lint`. Expected: PASS.

- [ ] **Step 5: Commit** — `feat(settings): add the Connectors page with GitHub sign-in`

---

### Task 7: Decision record, specs, and docs

**Files:**
- Create: `docs/adr/github-connector.md`
- Modify: `docs/adr/README.md` (one row, appended)
- Modify: `docs/spec/08-meta/decisions-log.md` (row D688; dated narrative at the end)
- Modify: `docs/spec/04-ux/06-settings-ia.md` (§1 destination list and count: sixteen destinations; a §2 section for Connectors; acceptance entries)
- Modify: `docs/spec/00-baseline.md` (frozen decision 40: add Connectors after MCP)
- Modify: `docs/spec/03-runtime/14-secrets-storage.md` (the fixed reference and what the value holds)
- Modify: `docs/spec/05-security/01-security.md` (token boundary: main only; pinned hosts; blocked on the local control plane)
- Modify: `docs/spec/03-runtime/08-error-codes.md` (eleven codes)
- Modify: `docs/spec/03-runtime/01-ipc-protocol.md` (the nine channels)
- Modify: `docs/spec/06-delivery/e2e/ui-shell.md` and `docs/spec/06-delivery/04-e2e-test-plan.md` (scenario `E2E-CONNECTOR-device-login-stores-no-renderer-secret`, automated by the Task 5 and Task 6 tests)

- [ ] **Step 1: Write the decision record** (`# ADR: Built-in GitHub connector`; Status Accepted; Context, Decision, Consequences, Alternatives). State: an OAuth App with device flow and a public client id, with pasted tokens as the fallback; `repo` and `read:org` by default and `workflow` opt-in; the token and account metadata in one secret under a fixed reference; main-only access and pinned hosts; no revocation on disconnect and why. Alternatives: a GitHub App (needs installation per repository and token refresh); reusing the pi-ai GitHub Copilot login (it yields a Copilot credential, not an API token); storing the token as an MCP server header (plaintext under `~/.agents`).

- [ ] **Step 2: Update the specs listed above.** Reference the record in the decisions-log row in the log's usual form, by its id `github-connector`.

- [ ] **Step 3: Verify** — `pnpm docs:check && pnpm check:agent-policy && git diff --check`. Expected: exit 0.

- [ ] **Step 4: Commit** — `docs(connector): record the built-in GitHub connector`

---

### Final gate for this plan

```bash
pnpm build:js
pnpm --filter @pi-desktop/desktop typecheck
pnpm lint
pnpm --filter @pi-desktop/shared --filter @pi-desktop/i18n test
cd apps/desktop && node --test test/github-*.test.mjs test/settings-*.test.mjs test/mcp-control*.test.mjs
node ../../scripts/check-architecture.mjs
```

Report any failure with its output; do not skip or edit an unrelated test to make it pass.
