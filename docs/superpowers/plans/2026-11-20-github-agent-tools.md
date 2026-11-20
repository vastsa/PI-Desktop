# GitHub Tools for the Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the GitHub connector is signed in, the Agent can read and write issues and pull requests through GitHub's hosted MCP server, with no MCP record for the user to create and no token written to disk.

**Architecture:** Electron main merges one built-in HTTP MCP server into the list host-core reports as active, and answers that server's token requests from the connector through the existing MCP OAuth token hook. Everything downstream is the existing MCP path: main-process execution, medium-risk approval, deferred activation.

**Tech Stack:** TypeScript (Electron main, React 19), `node --test`, vitest (`packages/shared`), i18next catalogs in nine locales.

**Spec:** `docs/superpowers/specs/2026-11-20-remote-github-sessions-design.md` (Part 6). Plan 6 of 7. It consumes the "Cross-plan contract" of `2026-11-20-github-connector.md` only; it has no dependency on remote hosts.

## Global Constraints

- Work in the worktree and branch you were given. Do not push; the coordinator integrates.
- The token is supplied to the MCP client in memory through the OAuth token hook. It is never written to an MCP record, to `~/.agents`, to a log, or to the renderer.
- No file is written for the built-in server. It exists only in the main process's merged list.
- A user-created MCP record with id `github` wins: the built-in server is then not injected, in that project scope or globally as the existing shadowing rules decide.
- Every existing MCP rule applies unchanged: tools named `mcp_github_<tool>`, medium risk with approval, deferred behind ToolSearch, the cap on active servers.
- The built-in server's URL is a constant. Tests may override it only through a constructor argument of the new module, never through settings, environment, or IPC.
- No test contacts GitHub.
- New logic goes in a new module; `apps/desktop/electron/main/runtime/session-launch.ts` and `apps/desktop/electron/main/services/plugin-services.ts` gain only wiring.
- All nine locale catalogs keep the English key set, with real translations.
- Do not run `pnpm install`. Stage files by explicit path. Conventional Commits, English, subject + blank line + body explaining why. No `Co-Authored-By` or `Signed-off-by`.
- Decision id for this plan: **D691**. Decision record slug: `github-agent-tools`.

## Cross-plan contract

- `AppSettings.githubAgentTools?: boolean` — absent means enabled.
- `GITHUB_BUILTIN_MCP_SERVER_ID = "github"`, `GITHUB_BUILTIN_MCP_URL = "https://api.githubcopilot.com/mcp/"`, `GITHUB_BUILTIN_MCP_TOOLSETS = "issues,pull_requests"` (sent as the `X-MCP-Toolsets` header), exported from `packages/shared/src/github-connector.ts`.
- `GitHubConnectorStatus` gains `agentTools?: "active" | "disabled" | "shadowed"` (only when connected): `shadowed` means a user MCP record with id `github` exists.

## Review Focus

1. The user already installed the catalog's `github` MCP entry (which stores a personal token in a header): their server keeps working exactly as before, the built-in one does not appear beside it, and the Connectors page says why. Pinned in Task 2.
2. The connector is disconnected, or its token is replaced, while a session is open: the built-in server's tools stop being offered at the next turn, and a new token is used without restarting the app. Pinned in Tasks 2 and 3.
3. GitHub's server rejects the token, is unreachable, or is slow: the session still starts and its other tools work; the failure is a normal MCP connection failure, not a blocked launch. Pinned in Task 3.
4. The setting is off: no request is made to GitHub's MCP endpoint at all. Pinned in Task 2.
5. A stored MCP OAuth token exists for some other server id: the connector's token is never returned for it, and the connector is never asked about it. Pinned in Task 2.

---

### Task 1: Setting and constants

**Files:** `packages/shared/src/github-connector.ts` and its test; `packages/shared/src/types/settings.ts`; `packages/shared/src/types/github-connector.ts`; `apps/desktop/electron/main/ipc/settings-ipc.ts` (validate the new boolean the way `jevEnabled` is validated); the settings validation test that covers `jevEnabled`.

- [ ] **Step 1: Write the failing tests:** the three constants' values; a non-boolean `githubAgentTools` is rejected by the settings validation with `INVALID_ARGUMENT`; `true`, `false`, and absent are accepted.
- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — `pnpm --filter @pi-desktop/shared build && pnpm --filter @pi-desktop/shared test`, the settings test, typecheck.
- [ ] **Step 5: Commit** — `feat(shared): add the GitHub agent tools setting`

---

### Task 2: Built-in server module

**Files:** create `apps/desktop/electron/main/github/builtin-mcp.ts` and `apps/desktop/test/github-builtin-mcp.test.mjs`.

**Interfaces:**

```ts
type BuiltinGitHubMcp = {
  /** The records host-core reported, plus the built-in server when it applies. */
  merge(records: McpServerRecord[]): Promise<McpServerRecord[]>;
  /** Wraps the MCP OAuth handler so the built-in server's token comes from the connector. */
  oauth(inner: UserMcpOAuthHandler): UserMcpOAuthHandler;
  state(records: McpServerRecord[]): Promise<"active" | "disabled" | "shadowed" | "disconnected">;
};
function createBuiltinGitHubMcp(deps: {
  connector: Pick<GitHubConnector, "status" | "token">;
  enabled(): Promise<boolean>;                  // reads AppSettings.githubAgentTools, absent = true
  url?: string;                                 // tests only
}): BuiltinGitHubMcp;
```

Rules:

- `merge` appends the built-in record only when the connector is connected, does not need re-authentication, the setting is enabled, and no record in `records` has id `github`. The record is `{ id: "github", label: "GitHub", transport: "http", url, headers: { "X-MCP-Toolsets": "issues,pull_requests" }, enabled: true, level: "global", timeoutSeconds: 60 }` plus whatever other fields `McpServerRecord` requires, with stable timestamps.
- `oauth(inner)`: `getValidAccessToken("github")` returns the connector's token only when the built-in server is currently the one in effect (the last `merge` appended it); otherwise, and for every other id, it delegates to `inner`. `hasOAuth` follows the same rule.
- `state` reports `shadowed` when a `github` record exists in `records`, `disabled` when the setting is off, `disconnected` when there is no usable credential.

- [ ] **Step 1: Write the failing tests:** merge in each of the four states; the record's exact URL and header; a user `github` record is returned untouched and nothing is appended; after a shadowed merge, `getValidAccessToken("github")` delegates to `inner` and the connector's `token` is not called; after an active merge it returns the connector token; any other server id always delegates; with the setting off, `merge` calls neither `connector.token` nor anything else that could reach the network; `needsReauthentication` suppresses the server.
- [ ] **Step 2: Run and see them fail** — `cd apps/desktop && node --test test/github-builtin-mcp.test.mjs`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — same command plus typecheck.
- [ ] **Step 5: Commit** — `feat(desktop): offer GitHub's MCP server through the connector`

---

### Task 3: Wiring

**Files:** modify `apps/desktop/electron/main/services/plugin-services.ts` (wrap the `oauth` option passed to `UserMcpRuntime`; construct the module), `apps/desktop/electron/main/runtime/session-launch.ts` (`refreshUserMcp`: pass host-core's list through `merge` before `userMcp.setRecords`, and return the merged list), `apps/desktop/electron/main/github/connector.ts` (fill `agentTools` in `status()`; on a credential change, ask the session-launch runtime to refresh MCP for the active workspace so the transport rotates), the MCP settings IPC that lists servers for the Settings page only if it shares `refreshUserMcp` (it must keep listing host-core's records only: the built-in server is not editable there); create `apps/desktop/test/github-builtin-mcp-wiring.test.mjs`.

- [ ] **Step 1: Write the failing tests** using a fake MCP client factory (the pattern in the existing `user-mcp` tests): with a connected connector, a session's tool list includes `mcp_github_<tool>` from the fake server and the client was created with an `Authorization: Bearer <token>` header and the toolsets header; after disconnect and refresh the tools are gone; after a token change the next connection uses the new token; a client that fails to connect leaves the session's other tools intact and the launch succeeds; the Settings MCP list does not contain the built-in server.
- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — the new test, the existing `test/user-mcp*.test.mjs` and `test/mcp-*.test.mjs` files, typecheck.
- [ ] **Step 5: Commit** — `feat(desktop): load the built-in GitHub MCP server into sessions`

---

### Task 4: Connectors page switch

**Files:** modify `apps/desktop/src/features/settings/connectors/GitHubConnectorCard.tsx`, the nine locale catalogs; extend `apps/desktop/test/github-connector-settings-user-path.test.mjs`.

Behavior: when connected, the card shows a switch bound to `githubAgentTools`. For `shadowed` the switch is replaced by a note. The note under the switch explains what the tools can do and that each call asks for approval.

English copy (keys under `settings.connectors.github`): `agentTools` "GitHub tools for the agent"; `agentToolsHelp` "Lets the agent read and write issues, pull requests, and comments. Each call asks for approval."; `agentToolsShadowed` "You have your own MCP server named github. It is used instead of the built-in one."

- [ ] **Step 1: Write the failing tests:** the switch reflects the setting and saves it; `shadowed` shows the note and no switch; not connected shows neither.
- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — the test, `pnpm --filter @pi-desktop/i18n test`, typecheck, `pnpm lint`.
- [ ] **Step 5: Commit** — `feat(settings): add the GitHub agent tools switch`

---

### Task 5: Acceptance probe, decision record, and docs

**Files:** create `scripts/probe-github-mcp.mjs` and `docs/adr/github-agent-tools.md`; modify `scripts/README.md`, `docs/adr/README.md`, `docs/spec/08-meta/decisions-log.md` (D691), `docs/spec/07-plugins/` or the spec section that documents user MCP servers (the built-in server and the shadowing rule), `docs/spec/05-security/01-security.md` (token path for the built-in server), `docs/spec/04-ux/06-settings-ia.md` (the switch), `docs/spec/06-delivery/e2e/plugins-and-extensions.md` and `docs/spec/06-delivery/04-e2e-test-plan.md` (scenario `E2E-CONNECTOR-github-tools-use-connector-token`, automated by Task 3's test).

`probe-github-mcp.mjs` is a manual acceptance tool, not part of any automated suite. It reads a token from the `GITHUB_TOKEN` environment variable, sends an MCP `initialize` and `tools/list` to the hosted endpoint with the toolsets header, and prints the HTTP status and the tool names. It prints nothing derived from the token. The design's open point is whether the hosted endpoint accepts a token minted by a third-party OAuth App through device flow; GitHub's documentation implies it and does not state it. The owner runs the probe once with a device-flow token after registering the OAuth App. The decision record states this as an open acceptance item and records the fallback: a small set of main-dispatched tools over the REST API, to be planned only if the probe fails.

- [ ] **Step 1: Write the probe and the decision record** (`# ADR: GitHub tools for the Agent through the hosted MCP server`): built-in injected server with no record; token through the OAuth hook; user record precedence; toolset restriction; the open acceptance item and the fallback. Alternatives: writing a real MCP record (plaintext token); a native tool set first (more code to own for the same result).
- [ ] **Step 2: Update the specs and docs.**
- [ ] **Step 3: Verify** — `node --check scripts/probe-github-mcp.mjs && pnpm docs:check && pnpm check:agent-policy && git diff --check`.
- [ ] **Step 4: Commit** — `docs(connector): record GitHub tools for the agent`

---

### Final gate for this plan

```bash
pnpm build:js && pnpm --filter @pi-desktop/desktop typecheck && pnpm lint
pnpm --filter @pi-desktop/shared --filter @pi-desktop/i18n test
cd apps/desktop && node --test test/github-*.test.mjs test/user-mcp*.test.mjs test/mcp-*.test.mjs test/settings-*.test.mjs
```

Report any failure with its output. State plainly in the report that the hosted endpoint's acceptance of a device-flow token was not verified by this plan.
