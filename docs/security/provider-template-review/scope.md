# Provider template account review scope

- Date: 2026-10-26 (UTC+08:00).
- Authorization: The user requested a vulnerability review of the implemented plugin provider templates and native accounts. This authorizes read-only source review and isolated synthetic probes, not remediation or live-service testing.
- Target: `worktrees/plugin-model-providers`, branch `feat/plugin-model-providers`, HEAD `541471d55648df021b232b5d01f0e1dd14cbb033` plus its uncommitted implementation.
- Implementation fingerprint: `450e4ec441c861734253e6b16ef69d25b5dafe05e49a9936afafa10aec9e563d`, SHA-256 of compact JSON sorted `[path, file SHA-256]` pairs for the 99 modified/untracked files under `apps/`, `packages/`, `crates/`, `scripts/`, and `pnpm-lock.yaml`. Documentation is excluded.
- In scope: Rust account ownership, closed template RPC DTOs, secret references, reconciliation/uninstall, Main OAuth/token handling, custom inference authorization, child/Agent boundaries, image output, and lifecycle cancellation.
- Threat boundaries: Untrusted declarations and adapter results enter Host-owned account/credential operations. Renderer/internal RPC is trusted; plugin Host APIs and Agent reverse RPC have separate allowlists. Installed Node plugins are trusted executable code, not OS-sandboxed adversaries.
- High-value assets: OAuth grants, API keys, peer-account isolation, conversation data and the user's revocation intent.
- Network profile: Synthetic HTTPS transport responses and local loopback callbacks only. No external OAuth, paid inference, real credentials, production profiles, or attachment to the running Desktop.
- Fault injection: A directory replaces an unused API-key blob path in a disposable profile to make deletion fail deterministically. This establishes error-path behavior, not an unauthenticated means of causing a filesystem fault.
- Out of scope: Dependency/CVE certification, OS exploit research, whole-window Electron testing, live vendor compatibility and fixing prior full-suite failures.
- Tools: Local source/AST search, Git, Node tests, Cargo tests and one bounded independent Rust review. Semgrep and CodeQL are not available on PATH; no tool installation was attempted.
- Deliverables: This scope, synthetic probes and a new report. Product code and the earlier `plugin-provider-audit` report remain unchanged.
