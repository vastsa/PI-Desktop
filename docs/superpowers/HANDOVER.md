# Handover: remote GitHub sessions on paired hosts

The original design and seven implementation plans are in
[`specs/`](specs/2026-11-20-remote-github-sessions-design.md) and
[`plans/`](plans/). The implementation follows these contracts.

| Part | Implementation |
| --- | --- |
| 1. Fork release pipeline | Unsigned macOS arm64 Desktop artifacts and Linux x64/arm64 Host bundles. The updater uses the fork's Releases page for unsigned builds. |
| 2. Host Git workspaces | Worktree recovery preserves existing branches and refuses unknown files. Non-forced removal checks for local commits even if the checkout disappeared. Tool Git uses the registry-backed proxy scope and fails closed without credentials. Job conflicts return the active job id. |
| 3. GitHub connector | Personal access tokens and configured device authorization. Navigation or renderer teardown stops device polling, and repeated unreadable client errors end the attempt. |
| 4. Environments and session targets | Home composer target selection, repository projects, scoped bindings, resumable preparation, and durable prompt admission. |
| 5. Git operations and cleanup | Push, idempotent PR creation, deletion preflight, deferred cleanup, and manual removal of leftover worktrees. |
| 6. GitHub tools for the Agent | A built-in issues and pull requests MCP record with connector credentials and user-configured server precedence. |
| 7. Setup scripts and variables | Per-environment configuration, worktree setup, tool environment injection, and failure logs. |

For implementation details, see the [decisions log](../spec/08-meta/decisions-log.md)
and the [remote end-to-end scenarios](../spec/06-delivery/e2e/live-and-remote.md).

## Release acceptance

- The fork needs a GitHub OAuth App with device flow enabled before a signed-in
  user can authorize with a code. Put the App's public client ID in
  `GITHUB_OAUTH_CLIENT_ID`. A personal access token is already supported.
- Use `scripts/probe-github-mcp.mjs` with a token obtained from the fork's OAuth
  App to verify hosted MCP compatibility for that token type.
- Verify an unsigned macOS arm64 package on a Mac, including manual update
  routing. Cut a versioned fork release when ready so paired Hosts can install
  matching bundles. See the [release runbook](../spec/06-delivery/06-release-runbook.md).

General network policy for host commands and proxy-based GitHub upstream access
remain outside this design. The planned host connects directly to GitHub.
