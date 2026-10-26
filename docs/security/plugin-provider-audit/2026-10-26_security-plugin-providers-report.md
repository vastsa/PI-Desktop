# Generic plugin provider security assessment

> Date: 2026-10-26. Status: Assessment, not a security certification or an implemented redesign.
> Scope and authorization: [scope.md](scope.md). Flavor: none; no malware attribution or external penetration testing.
> Reviewed baseline: `c099b6a4cdb4dcdc3bf467432e36af10fde77080` plus the existing uncommitted provider implementation.

## Executive summary

The proposed direction is sound for the plugin-facing data API: narrow typed submissions, no arbitrary updates/deletes of authoritative Host state, and explicitly scoped reads. It is not sufficient by itself for privacy. A read-only plugin can still disclose everything it is allowed to read, and the current plugin utility process executes ordinary Node modules rather than providing an OS security sandbox.

Three local probes reproduced: unknown provider fields are accepted by the SDK validator; raw Node file access remains possible without a Host filesystem grant; and an adapter exception containing a synthetic access token reaches the final Agent error message. The first is a strict-schema gap, the second a documented trusted-plugin limitation, and the third a concrete error-channel privacy weakness. No real credential leakage or new cross-provider credential-access exploit was observed.

Native model editing, generic OAuth, subagents and image generation can retain their user-visible behavior with a stricter design. The necessary distinction is between plugin submissions and Host-authorized state transitions. A literal ban on every modification by every actor would break editing, token refresh, sign-out and uninstall/privacy cleanup.

No runtime changes were made during this assessment. Hard execution isolation and secret-hiding network mediation require an explicit architecture/API decision, not a silent CRUD restriction.

## Current behavior versus the proposed boundary

| Surface | Current implementation | Recommended behavior preserving user-visible features |
| --- | --- | --- |
| Provider registration | Manifest declaration; Host derives `plugin:<owner>:<localId>` and ownership. Reconciliation upserts the owner's existing rows and removes withdrawn declarations. | Typed registration submissions scoped to the installed owner; immutable accepted descriptor revisions where useful. Host selects an accepted revision under one stable logical provider identity. |
| Native preferences | User edits name and model bindings. Host saves sparse overrides; manifest refresh does not overwrite explicit user choices. | Keep native editing as a separate user-authorized Host operation. Plugins cannot submit user preference overrides. |
| Transport changes | Manifest may change endpoint/auth/style; Host clears old credentials rather than forwarding them to the new destination. | Require a reviewed descriptor revision and renewed authorization for security-sensitive destination/scope changes. Preserve credential invalidation. |
| Input fields | Known field types/enums are checked. Adapter and OAuth declaration subobjects reject unknown keys; provider/model containers and several event objects are not universally strict. | Versioned schemas with unknown-key rejection or an explicit, validated extension namespace. Canonicalize accepted fields before storage/forwarding. |
| OAuth | Login/refresh hook returns its own credential. Host encrypts it and serializes refresh. The refresh callback receives that provider's current refresh credential. | Host-owned credential lifecycle; plugin submits typed login/refresh results, never arbitrary secret references or database writes. Do not keep obsolete raw tokens in an append-only log. |
| Custom inference | Explicit registration/inference grants; selected adapter receives the request context and its own access token/headers/routing data. | Scope each call to its authorized session/provider/model/generation. Prefer opaque credential handles and constrained Host network execution where protocol requirements allow. |
| Chat/tool/image results | Versioned events and size/type checks; native Agent executes tools. Images are validated base64 with MIME/signature checks, not output paths/URLs. | Keep typed result submission. A tool request is not authorization to execute it; the native tool/permission system remains authoritative. |
| Reads | Different APIs have separate grants. Model listing can expose model metadata with its grant; inference necessarily receives the selected request context. | Give only scoped public projections and the minimum required request context. Registration alone must not grant general transcript, file, database or credential reads. |
| File/network isolation | Host APIs enforce grants/scopes. Plugin entry code can still use raw Node APIs. Child environment inheritance is restricted to an allowlist. | Enforce the boundary below plugin code with a restricted execution environment or OS sandbox, plus Host-mediated filesystem/network access. API naming and Node `vm` alone are not equivalent to such isolation. |
| Errors/logs | Plugin-supplied strings may cross process boundaries and become Agent error text or plugin audit messages. | Stable public error categories, bounded secret-safe diagnostics, and redaction before UI/log/export/persistence boundaries. No raw request/response/token dumps. |

## Evidence and findings

### Evidence register

Paths below are relative to the request worktree. Line numbers refer to the reviewed source, not a frozen public release.

| Evidence | Source reference | Reproduction or inspection | Content identity |
| --- | --- | --- | --- |
| E1 | [Audit probes](probes.mjs) | `node --test docs/security/plugin-provider-audit/probes.mjs` | SHA-256 `c45ce5871aa168e25d356f251616c895a22d951f03136e0ccc3f6d1b87e7bba4` |
| E2 | [Plugin module loader](../../../apps/desktop/electron/main/plugin-host-process.mjs), lines 505-539 | Read `loadPluginModule` and `handleInit`; E1 filesystem probe uses the real loader in a local child process. | Covered by reviewed-source fingerprint below. |
| E3 | [Inference error conversion](../../../packages/agent-runtime/src/plugin-provider-inference.ts), lines 119-122; [plugin responses](../../../apps/desktop/electron/main/plugin-host-process.mjs), lines 760-771 | E1 exception probe traverses real plugin child, Host broker and Agent stream result. | Covered by reviewed-source fingerprint. |
| E4 | [SDK provider validation](../../../packages/plugin-sdk/src/index.ts), lines 1981-2128; Host projection `crates/host-core/src/plugins/providers.rs`, lines 113-230 | E1 unknown-field probe; manually verify Host derives identity and selects recognized fields. | Covered by reviewed-source fingerprint. |
| E5 | Host reconciliation `crates/host-core/src/plugins/providers.rs`, lines 302-469; preference update `crates/host-core/src/providers/repository.rs`, lines 316-424 | `cargo test -p host-core --locked providers::` | 71 tests passed. |
| E6 | [OAuth credential resolver](../../../apps/desktop/electron/main/oauth.ts), lines 753-782; [production broker wiring](../../../apps/desktop/electron/main/runtime/sidecar.ts), lines 193-202 | OAuth/inference and lifecycle tests listed below; direct inspection of current wiring. | No confirmed cross-provider or refresh-token inference exposure in this review. |

Reviewed-source aggregate fingerprint: `a1e9a54d44f2b49169074a73d636ce3d1a8f37d6362d26ddf748ca5bcb240b19`.
It hashes the sorted compact JSON mapping of SHA-256 values for these source files: Electron `plugin-runtime.ts`, `plugin-host-process.mjs`, `plugin-provider-inference.ts`, `oauth.ts`, `runtime/sidecar.ts`; SDK `index.ts`, `provider-adapter.ts`, `provider-inference-host.ts`; Agent `plugin-provider-inference.ts`; Host runtime `agent-sidecar.ts`; Rust `plugins/providers.rs`, `plugins/provider_operations.rs`, `providers/repository.rs`. The mapping and source-pattern index were retained as session-local audit artifacts, not as product telemetry.

### F1 — Host API permissions do not sandbox raw Node code

- Severity: High-impact architectural limitation **if installed plugins are treated as untrusted**; not a newly discovered undocumented permission bypass.
- Evidence: E1, E2. Confidence: High. Status: Verified, unchanged.
- Location: `apps/desktop/electron/main/plugin-host-process.mjs:505` and `apps/desktop/electron/main/plugin-runtime.ts:1357`.
- Preconditions: The user installs/loads executable plugin code. The plugin executes with the process's OS privileges.
- Reproduction: The no-grants probe calls `pi.fs.readText` on a synthetic marker and receives a permission refusal, then reads that same marker and writes a second scratch file with `require('node:fs')`.
- Result: Restricting registration/update methods cannot enforce filesystem privacy against this code. Raw networking is likewise outside the Host network API's policy, although no raw-network exfiltration test was performed.
- Path forward: Separate declarative-only provider contributions from executable adapters. For an untrusted-adapter tier, enforce file/process/network restrictions below JavaScript and review native-module compatibility. Keep the existing trusted-code risk explicit until then; do not claim that an API-only change provides containment.

### F2 — Exception text can expose a scoped access token

- Severity: Medium privacy weakness; exact impact depends on what an adapter or upstream SDK includes in an exception.
- Evidence: E1, E3. Confidence: High. Status: Verified, unfixed in this assessment.
- Location: `apps/desktop/electron/main/plugin-host-process.mjs:770`, `apps/desktop/electron/main/plugin-runtime.ts:2734`, `packages/agent-runtime/src/plugin-provider-inference.ts:121`.
- Preconditions: An authorized adapter has its own request credential and throws an exception containing it. This can be accidental SDK/request-debug output; no foreign credential access is needed.
- Reproduction: The fixture throws `new Error('upstream exception: ' + context.credential.apiKey)` using a fake token. The real Agent stream's final `errorMessage` contains that token.
- Proven impact: A scoped secret can enter the Agent error payload. This probe did not assert actual renderer display, database persistence, remote transmission or a real user's token exposure.
- Path forward: Map external adapter errors to safe public codes/messages and sanitize any retained diagnostics before logging/export/storage. Test chat, image and OAuth failure channels separately. Redaction helps accidental disclosure but cannot make an intentionally malicious adapter unable to encode a secret into ordinary output.

### F3 — Field validation is not universally closed

- Severity: Low hardening gap relative to the proposed strict-submission contract; no mass-assignment exploit demonstrated.
- Evidence: E1, E4. Confidence: High. Status: Verified, unchanged.
- Location: `packages/plugin-sdk/src/index.ts:1981`.
- Reproduction: A valid provider declaration containing extra `ownerPluginId`, `secretRef` and `unknownField` keys passes SDK validation; an unsupported `authKind` is rejected.
- Boundary retained: Acceptance of those keys is not authority to assign ownership or a secret reference. The Host derives owner/id and projects recognized fields; the row ownership guard remains in place.
- Path forward: Use versioned closed DTOs at all sensitive submission boundaries, with explicit extension schemas where generic services need additional metadata. Validate in both SDK and authoritative Host. Do not describe arbitrary bounded `requestData` JSON as a per-field privacy allowlist.

## Verified protections and limitations

- Plugin-callable Host API allowlist contains OAuth prompt/notify, not generic `providers.update`, `providers.delete`, SQL execution or a secret-store getter.
- Existing owner collisions are refused. Explicit user preference overrides survive reconciliation. Plugin disable cannot be bypassed through ordinary provider enablement; destination/auth changes clear credentials.
- The native plugin editor sends `id`, `name` and `models`, not transport or credential fields (`PluginProviderSettingsDialog.tsx:75`). Broader trusted Host provider-update operations still support credential/header changes; the renderer's narrow payload is not the only security boundary.
- Inference authorization binds session, provider, model and runtime generation. Lifecycle and reverse-RPC regression tests passed. An independent review's suspected `requestData` wiring omission was rejected after checking the current `sidecar.ts:199`, which uses the inference-specific resolver; it is not an outstanding finding.
- OAuth routing metadata is encrypted with credentials and excluded from ordinary `resolveAuth`. The custom adapter receives it deliberately. Refresh tokens remain on the login/refresh callback path, not the inference context; they are not hidden from the plugin's own OAuth callback.
- Child environment inheritance uses a minimal allowlist, not the complete Host environment. This does not remove raw OS file access.
- Conversations, tool-result text and input images needed by the selected model are intentionally visible to its adapter. Read-only access still exposes those contents. Private values included by the user/tool results may therefore be part of the outbound request.
- No new cross-provider/session credential-read exploit or refresh-token inference exposure was confirmed. Passing tests and bounded review do not prove absence of all such defects.

## Function-preserving interpretation of the user's proposal

### Recommended ownership model

1. **Plugin submission plane:** Accept only versioned, size-limited DTOs for provider/model declarations, OAuth results, inference events and image results. Derive identity/ownership from the caller; never accept raw SQL, secret references, arbitrary config patches, Host paths or authoritative user preferences. Validate unknown keys, nested fields, quotas and duplicate submissions.
2. **Host state plane:** The Host alone persists accepted data and owns enablement, selected revision, account lifecycle and credentials. A provider revision may replace an older accepted descriptor under a stable logical identity only through the declared authorization policy. Literal append-only raw credentials/history are not a privacy feature.
3. **User preference plane:** Users retain the existing native model editor. Their changes are separate Host-owned preferences, not plugin modifications. Login/refresh, cancellation, sign-out and uninstall remain controlled operations. Revoked credentials must be deleted or replaced, not retained forever as historical revisions.
4. **Read plane:** Return only caller-owned public metadata/status and request-scoped inference inputs. Do not expose the provider registry's secret fields, arbitrary transcripts/files or other accounts merely because a plugin can register a model.
5. **Execution/privacy plane:** Restrict raw I/O and egress in the runtime, mediate required networking, keep credentials as opaque capabilities where possible, and use secret-safe error/log handling. An unrestricted Node adapter cannot be made safe merely by changing its Host API to read-only.

| Required feature | Compatible with the revised model? | Required exception to a literal no-modification rule |
| --- | --- | --- |
| Native model editing | Yes | User-authorized Host preference updates remain allowed. |
| Generic OAuth | Yes in principle | Host must store/replace/revoke credentials; plugin-specific authorization/refresh protocols still need controlled execution. |
| Main chat and subagents | Yes | Host accepts typed outputs and native tool requests under existing permissions; selected request content remains necessary. |
| Image generation/editing | Yes | Host writes validated image bytes to its scratch output; plugin need not receive arbitrary output paths or filesystem write authority. |
| New service revisions | Yes | Accept new validated revisions rather than giving plugins unrestricted in-place writes; retain stable provider identity and explicit preference semantics. |

Opaque-token network execution is a recommended redesign, not a drop-in implementation already present. Host-owned HTTP/OAuth plans can inject credentials without exposing them to the adapter. Arbitrary custom signing, native SDKs, token-dependent transforms and multi-step OAuth flows may require additional narrow broker operations or adaptation. User-visible functionality can be preserved, but universal compatibility with arbitrary existing Node adapter code cannot honestly be guaranteed without a migration/API design and tests.

Priorities: address accidental secret-bearing errors first; close sensitive DTO schemas next; define a constrained execution/egress tier before making an untrusted-plugin privacy guarantee. Preserve the existing trusted tier's disclosure rather than silently falling back from a restricted adapter to unrestricted execution.

## Verification and reproduction

Prerequisite: existing compatible workspace dependencies and built SDK/Agent JS outputs. The previous implementation build was already available; this assessment did not reinstall dependencies, package a release or perform a new full build.

From the request worktree root:

```bash
# Audit probes: passing REPRODUCES the limitations/findings, not remediation.
node --test docs/security/plugin-provider-audit/probes.mjs

# Product regressions exercised during this assessment.
node --test apps/desktop/test/plugin-provider-inference.test.mjs apps/desktop/test/plugin-provider-oauth-inference.test.mjs apps/desktop/test/plugin-provider-oauth.test.mjs apps/desktop/test/vendor-oauth-login.test.mjs apps/desktop/test/plugin-child-env.test.mjs apps/desktop/test/plugin-permission-review.test.mjs apps/desktop/test/plugin-runtime-risk.test.mjs apps/desktop/test/plugin-fetch-redirect.test.mjs
cargo test -p host-core --locked providers::
pnpm --filter @pi-desktop/plugin-sdk exec vitest run src/provider-adapter.test.ts src/net-policy.test.ts src/fs-policy.test.ts
pnpm --filter @pi-desktop/host-runtime exec vitest run src/provider-inference.test.ts
```

Results: 3 audit probes reproduced their expected current behaviors; 114 Desktop, 71 Rust provider, 54 SDK and 3 Host-runtime regression tests passed (242 product regression tests). Fake marker contents and tokens only; fixture files cleaned up. A source-pattern scan indexed 147 locations across nine scoped implementation files for targeted manual navigation; it was not a full SAST proof and not every indexed location was exhaustively reviewed.

Semgrep/CodeQL commands were unavailable; no scanner was installed and no full SAST or dependency audit is claimed. Real-service interoperability, actual Electron utility-process OS containment, renderer persistence of the error example, full-application acceptance and full Host-suite green status were not established. The three process probes use the supported Node child-process transport with the real plugin host module, not the user's running Desktop.

## Evidence paths and timeline

- **P1, callflow:** No-grants manifest → normal plugin module loader (E2) → Host file API refusal → raw `node:fs` access to synthetic scratch marker → F1.
- **P2, callflow:** Authorized fake credential → adapter throws credential-bearing exception → child error response → Host pending-call rejection → Agent `errorMessage` (E3) → F2.
- **P3, callflow:** Declaration with unknown keys → SDK accepts → Host derives identity and projects known fields (E4) → F3 without demonstrated ownership reassignment.
- **P4, proposed callflow:** Plugin typed submission → Host schema/owner/policy checks → accepted record or request output → scoped public projection; user preferences and credential lifecycle remain Host-owned. Execution isolation is a separate prerequisite, not implied by this flow.

Timeline, 2026-10-26: inspected the uncommitted source and API/storage boundaries; ran existing security regressions; reproduced unknown-field acceptance and raw Node access using synthetic fixtures; independently checked current credential wiring and rejected a stale suspected omission; reproduced secret-bearing error propagation; archived and reran the probes; recorded findings and a non-implemented, functionality-preserving design.

## Archive maintenance

During PR preparation the probe file was renamed from `probes.test.mjs` to `probes.mjs`, with identical bytes and the hash above unchanged. This keeps historical defect assertions out of automatic product-test discovery. Explicit reproduction commands above use the new name; historical findings and results remain unchanged and are not current remediation acceptance.
