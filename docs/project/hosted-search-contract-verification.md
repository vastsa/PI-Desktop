# Hosted-search contract repair and verification

## Outcome

The ten approved acceptance criteria are met for the isolated, offline Desktop/sidecar scope. The original hosted-search tool-continuation failure is reproduced on the task baseline and prevented by formal content contracts, shared replay-aware estimates, semantically stable system reconstruction, and explicit local-error provenance. No fake tool fields, exception-to-zero fallback, history migration, timestamp forgery, or disabled search/Task path is used.

Implementation qualification was completed on the uncommitted `fix/hosted-search-contract` candidate. The user subsequently authorized committing, pushing this task branch and opening a PR on 2026-09-22. The evidence below records the pre-commit candidate; PR delivery does not install, merge or release the application, or qualify a live provider.

## Baseline and dependency identity

- Refreshed `origin/main` and task HEAD: `46d4ee4ee3b608d103c5dacab2fbb754bacd6eca` (2026-09-22 local date).
- Isolated worktree: `$PI_SCRATCH_DIR/hosted-search-worktree`.
- At implementation qualification, the main checkout was clean at `0111e306c120ad5820688d7608cb37bad8fbcc1f`, with no task commit, push or PR. Follow-up PR delivery is separately authorized; no merge, release or application installation is included.
- Node `24.21.0`, pnpm `10.34.5`. Installed `@earendil-works/pi-ai`, `pi-agent-core`, and `pi-coding-agent` are all **0.86.1**. The main checkout's stale 0.85.1 installation was not used for qualification.
- Initial locked install reused 809 packages with zero downloads. Final patch generation and `pnpm install --frozen-lockfile` succeeded; package-patch generation is not a Git commit.
- Parent byte comparison: all **1,093** staged runtime/declaration files match the installed packages (pi-ai 370, core 232, coding 491). Recorded in `hosted-final-dependency-identity.json` under session scratch.

| Artifact | SHA-256 |
| --- | --- |
| pi-ai 0.86.1 patch | `db5e0b64bd62cea3db7dbf9102f3602a9166aa01f49fd4e5123d57dc1a87f3fe` |
| pi-agent-core 0.86.1 patch | `62947f964f4c6270c68576ce7aa748a00bd20bca9c96e0dc49a4c17b0b283be1` |
| pi-coding-agent 0.86.1 patch | `60323335b0bd5cdbd857e5b9cf24bb794766f85bf3682694b9a43694bb435227` |
| pnpm-lock.yaml | `9be9b37e77706661106729449a1347371470e12aea3a9fd3dc7c5557563d57f9` |
| Final sidecar bundle | `6a3f4b96438578bd4a92976f44189bf8416ee81b31fbf9e05454d50ad020f5cd` |

The lock, workspace patch entries, installed dependency links and final patch contents were independently cross-checked in review. Existing OAuth and provider-adapter modifications remain present.

## Root cause and preserved architecture

PR #635 (`23859ea38`) integrated search from #624 (`2e763893f`) and restart replay repair (`003bc0aeb`). Adapter search blocks/events were present without corresponding dependency declarations or estimator branches. The later pi upgrade (`c9db30629`) introduced transcript compatibility setters which refreshed a leading system timestamp during every rebuild. That incorrectly invalidated nonzero usage and exposed an estimator assuming every non-text/non-thinking assistant block was a tool call: `block.name.length` failed on legitimate nameless search results.

The repair retains ADR 0297's adapter ownership, per-model opt-in, display rounds/raw replay separation, stored history shape, model-switch replay policy, and search UI. It does not add a local search implementation or runtime SSE re-parser.

## Dependency delivery decision

| Option | Feasibility and scope | Maintenance / upgrade cost | Decision |
| --- | --- | --- | --- |
| Existing public request/provider hooks | Can transform a context or replace a provider, but cannot register one content type across built-in parser events, declarations, replay, frame consumers and estimators. | Small hook changes would leave unpatched consumers; replacing search data with text/tool placeholders would hide the defect. | Insufficient alone. |
| Desktop-owned adapter/source copies | Could implement the behavior, but duplicate Anthropic, Responses and Azure streaming/auth/replay plus independent compaction consumers. | Large parallel source surface and recurring upstream merge/testing burden. | Reject unnecessary duplication. |
| New permanent upstream source fork | Could own the whole message contract and build all package entrypoints. | New repository, release pipeline, dependency ownership and long-term maintenance; outside the approved boundary. | Not required for this bounded fix. |
| Existing pinned dependency patches | Already deliver the 0.86.1 search/OAuth modifications. The same reproducible channel can cover declarations and each actual Desktop consumer together. | Three pinned patch files must be rebased on upgrades; rerun type, adapter, estimation, frame, compaction and sidecar gates, not only a clean patch application. | Selected. |

The package archives contain distributed JavaScript/declarations, not an upstream TypeScript source workspace. The bounded repair maintains both in the existing patch channel and tests the actual installed modules. `pnpm-workspace.yaml`, the three patch files and `pnpm-lock.yaml` reconstruct the installation; no direct installed-node_modules edit is required. pi-coding-agent needs its own patch because Desktop's native-session library has an independent compaction implementation.

## Implementation invariants

1. `HostedSearchContent` is a discriminated union for Anthropic `server_tool_use`, result/error results, and Responses `web_search_call`; stream events and runtime validation use the same formal capability. Legitimate result/activity blocks need no `name` or `arguments`.
2. Shared normalization and replay projection drive requests, request-preflight estimates, output budgets, main/native compaction estimates and summary serialization. Display rounds/parser scratch are not billed twice. A known target model applies the existing adapter replay boundary; callers without target identity remain conservative.
3. Valid usage covers its prefix once. Zero, error/aborted or genuinely invalidated usage falls back to complete estimation. Missing/non-finite timestamps are explicitly invalid, never replaced with an invented old time.
4. Unchanged system reconstruction preserves semantic timestamps, system sections and effective tool additions/removals. Real instruction/tool changes invalidate prior usage. Restore remains conservative where persisted data cannot establish the former configuration.
5. Search frames preserve identity, content indices, deep snapshots and optional fields; Mistral no longer treats search as an implicit function call. Both frame consumers are tested against the same encoder.
6. Explicit `LOCAL_REQUEST_ERROR` plus a recognized phase preserves local provenance. Local validation, estimation and preparation failures are terminal `INTERNAL`, with safe details and no provider retry/fetch. Ordinary transport `TypeError`, HTTP transient retries and cancellation retain separate behavior. Wrapped cancellation produces an aborted main/subagent result.
7. Old nameless search history remains readable without migration. Invalid restored data is rejected before a provider request or persistence write, with safe RPC metadata and a healthy process. In-memory input immutability is checked by source replay tests; the artifact boundary verifies no persistence Host RPC.
8. Compaction strategy is unchanged: search projections are included in the summary request; the compacted prefix becomes generated text, not a lossless raw replay archive. The retained tail continues under the existing replay policy.

## Red-to-green evidence

All logs and fixture artifacts below are retained under `$PI_SCRATCH_DIR`, not committed as user/session data.

| Regression | Observed red evidence | Final protection |
| --- | --- | --- |
| Real request preflight | Baseline dependency tests: 14/18 failed, including `streamSimple -> buildBaseOptions -> estimateMessageTokens` `.name.length`; `dependency-hosted-search-red.log`. | Installed contract/estimation tests in the green runtime suite. |
| Output budget growth | Baseline 12 passed / 2 failed; +10,000 search characters added zero rather than 2,500 tokens, CJK correction zero rather than 750; `hosted-output-cap-red.log`. | Search projection and existing CJK policy both tested. |
| System reconstruction | Unchanged rebuild invalidated usage and lost sections/tool deltas; `system-transcript-red-assertions.log`. | Helper and runtime restore/compaction/update regressions. |
| Full continuation | Pure baseline bundle: 2/5 passed; Read, real instruction-change and Task failed with original `.length`; `hosted-search-e2e-e08Uj8/result.json`. Baseline bundle SHA `962446d15398de870b434b37620eb7c8c80dc9cf4f81b8f5ab48ee7ab3ae3495`. | Fresh final sidecar: 7/7 passed. |
| Frames/model switching | Consumer baseline 17/21 failed; `dependency-consumers-red.log`. | 23 installed consumer tests pass, including both reducers. |
| Native/main compaction | Final tests before installation: 18 failed / 4 passed; `compaction-test-preinstall-red.log`; staged 22/22 pass. | The same 22 tests pass without a loader against installed packages. |
| Local error/cancellation provenance | Reverting provenance/cancellation changes makes four tests fail; `negcheck-summary.txt`. The new subagent un-aborted-signal cancellation case also fails on pre-fix code. | Error/retry/subagent tests pass, including ordinary 429/503 retry-before-fallback. |
| Invalid restore RPC | Earlier repaired bundle passed five success cases but failed two new provenance checks; `hosted-search-e2e-J6J42v/result.json`. | Two real sender cases plus three real Host decoder tests. |
| Anthropic citation shape | New test rejects non-URL/document citations on the old adapter; `hosted-citation-red.log`. | Valid raw URL citations preserved; final 3/3 error-result/citation tests pass. |

The first final installed full-suite run exposed one real frame optional-field mismatch and two old retry fixtures lacking the required user timestamp (`hosted-runtime-final.log`: 913 passed / 3 failed). The core reducer now preserves an absent `isError` exactly like the encoder. The retry fixture is a typed `Message` with a legitimate timestamp; retry count/fallback assertions were not weakened. The subsequent full suite is 916/916 green (`hosted-runtime-final2.log`). Earlier green bundles and failed/intermediate build logs remain evidence, not substitutes for final qualification.

## Final commands and observed results

Run from the task worktree. Tests use synthetic/in-process or loopback external boundaries only; no real model/search service is called.

| Command / check | Final observed result | Evidence under session scratch |
| --- | --- | --- |
| Three `pnpm patch-commit` operations, then `pnpm install --frozen-lockfile` | PASS; latest core optional-field correction regenerated and reinstalled successfully | `hosted-patch-*-final*.log`, `hosted-patched-install-final2.log` |
| Installed package byte/version/hash comparison | PASS; 1,093 files, all three versions 0.86.1 | `hosted-final-dependency-identity.json` |
| `pnpm --filter @pi-desktop/agent-runtime test` | PASS; **58 files / 916 tests** | `hosted-runtime-final2.log` |
| Native-session coverage within runtime suite | PASS; **36 tests** (also independently run, not additional to 916) | `native-pi-session.json` |
| `pnpm --filter @pi-desktop/shared test` | PASS; 80 files / 928 collected tests, including compiled mirrors | `hosted-shared-final.log` |
| `pnpm --filter @pi-desktop/shared exec vitest run src` | PASS; **40 source files / 464 tests**; use this non-duplicated source count | `hosted-shared-source-final.log` |
| `pnpm --filter @pi-desktop/host-runtime test` | PASS; **7 files / 38 tests**, including three new real stdio decoder cases | `hosted-host-runtime-final.log` |
| `node --test apps/desktop/test/error-code-registry.test.mjs apps/desktop/test/rpc-lifecycle-contract.test.mjs apps/desktop/test/runtime-build-contract.test.mjs` | PASS; **20 tests** | `hosted-cross-process-final.log` |
| `pnpm build:js` | PASS; all **11** recursive build projects, no downstream failures | `hosted-build-js-final2.log` |
| `pnpm -r --if-present typecheck` | PASS; all **10** packages with that script; docs has no typecheck script | `hosted-typecheck-all-final2.log` |
| `pnpm test:e2e:hosted-search` | PASS; fresh shared build + sidecar bundle, **7/7** cases; stricter no-write whitelist rerun also green | `hosted-e2e-final4.log`, `hosted-search-e2e-CS9uZW/result.json` |
| `pnpm lint` | PASS; repository-configured coverage, not an invented runtime lint gate | `hosted-lint-final.log` |
| `pnpm docs:check` | PASS; EN/ZH parity and documentation checks | `hosted-docs-check-final.log` |
| `pnpm check:agent-policy`, `pnpm check:pr-base` | PASS | `hosted-check-agent-policy-final.log`, `hosted-check-pr-base-final.log` |
| `git diff --check`, final Git state | PASS for the original 45-file unstaged implementation delta; the later PR preparation also checks staged files (see below) | `hosted-final-git-state.log`, `hosted-final-file-manifest.txt` |

The root `test` / Rust build, `verify:ui:*`, application installation, real provider calls and manual application clicking were **not run**. No Rust source or method/storage schema changed. The additive error metadata travels through the existing RPC `error.data` field; shared, Host decoder, desktop registry/lifecycle and real sidecar sender tests cover that boundary.

### Final artifact scenarios

Final evidence directory: `$PI_SCRATCH_DIR/hosted-search-e2e-CS9uZW`. The bundle is copied to immutable `sidecar.mjs`. `result.json` records Node/pnpm, installed versions, baseline, lock hash, bundle hash and source fingerprints. The 251-file source scope fingerprint is `34ee5bac7d9dd0af5d7a828624d92a0439fe63fda7daca3c6e53ee7a54aa9b15` before and after; the original bundle hash also remains unchanged. Source identity unavailable/changed or bundle rewrite makes qualification fail.

| Scenario | Result | Provider requests |
| --- | --- | --- |
| `search-next-prompt` | PASS | 2 |
| `search-read` | PASS; ordinary real Read tool | 2 |
| `search-read-instruction-change` | PASS; real changed prefix after nonzero usage (1,000 input / 1,030 total tokens) | 2 |
| `search-task-delegation` | PASS; real Task/TaskWait and parent continuation | 4 |
| `search-persist-restore` | PASS; disk JSON boundary and a new sidecar process | 2 |
| `invalid-search-container` | PASS; safe local validation error, no persistence call/runtime leak | 0 |
| `invalid-search-phase` | PASS; the turn continued without the stored replay and the unreplayable block never reached the provider (behavior changed after this run — see the note below) | 1 |

Each invalid-history case subsequently completes a clean session in the same process using a separate loopback fixture provider (one request). Those recovery requests are recorded separately and are not hidden in the malformed-history zero-request count. The changed-prefix artifact verifies changed request instructions; direct usage-anchor invalidation is asserted by the companion estimator/system tests rather than inferred solely from the RPC boundary.
Behavior changed after this qualification: a stored record this app itself writes
when a gateway drops ids (a display-only block with no replay id) used to reject
the turn with a local context-validation error. It now degrades to "no replay"
for that message, because rejecting it failed every later turn of that
conversation. `invalid-search-container` still rejects: a container that is not a
block list is a corrupt record, not an old readable one. The table above records
the pre-fix run; `scripts/e2e/hosted-search-scenarios.mjs` holds the current
expectations.

## Independent review and disposition

The complete change was partitioned for independent read-only review; failed model-quota review attempts are not counted as completed reviews. A local receipt summary is retained in `hosted-independent-review-summary.md`; the full reports are in this conversation's Task results.

- Runtime source/system/budget/history/error/subagent partition: reviewer `e29420d1...`; cancellation and both RPC halves re-reviewed by `5f8dfc53...` — accepted, no blocker. The initial producer-test gap was corrected after reading the real bundled sender tests.
- Dependency types/adapters/estimators/frames/compaction and final patch/lock/install partition: reviewer `a4695593...`, final `74371a0b...` — no blocker. Final review explicitly includes the latest core `isError` optional-field fix and hash `62947f96...`; prior OAuth/provider modifications confirmed retained.
- Artifact harness/documentation partition: original reviewer `240c6e4a...`, final reviewer `9ad1cbf7...` — no blocker after fixes. Replaced the vacuous parent-object immutability assertion with no-persistence RPC checks, verified no registered-runtime leak and successful recovery, made source/provenance failures fail qualification, and clarified summary-request versus retained-tail semantics in EN/ZH specs and ADR 0297. The final whitelist was further narrowed to only `session.get`; final artifact rerun passed.
- All substantive gaps were addressed: model threading, unknown-role zero fallback, citation shape, subagent cancel classification, frame snapshot consistency and evidence qualification. Existing duplicate budget computation is a non-blocking performance observation, not a changed result. A suggested stale retry-marker scenario was not demonstrated on the serial production path: `retryPendingProviderFailure` clears the marker before continuing the next request.

## Acceptance criteria

| # | Criterion | Status | Observed evidence |
| --- | --- | --- | --- |
| 1 | Reproducible baseline/dependencies | MET | Refreshed baseline, unchanged task HEAD/clean main, exact patch/lock identities and 1,093 installed file comparisons. |
| 2 | Maintainable dependency decision | MET | Alternatives/cost table, three reproducible pinned patches, frozen installation and preserved existing modifications. |
| 3 | Search as a formal message capability | MET | Declared discriminated phases/events/citations, explicit validation, nameless/error results and consumer/frame tests; full consuming TypeScript checks pass. |
| 4 | Estimation agrees with replay | MET | Shared projection; request/output/main/native budgets; valid/zero/stale usage, growth/CJK, no duplicate usage count, original content regressions; installed tests pass. |
| 5 | Correct system reconstruction | MET | Stable unchanged prefix, actual instruction/tool changes invalidate usage, sections/tool deltas retained, restore/compaction runtime tests and changed-prefix artifact pass. |
| 6 | History and request compatibility | MET | Nameless legacy replay without migration, real disk/process restore, Responses/Azure/Anthropic request contracts, no internal fields in payloads, preserved model/opt-in policy. |
| 7 | Correct errors and retry | MET | Three local phases terminal with safe provenance and no invalid model request; stale 429, transient HTTP/TypeError retry, main/subagent cancellation and both RPC halves covered. |
| 8 | Complete user paths | MET | Baseline Read/Task/changed-prefix red; final fresh sidecar next-prompt/Read/Task+TaskWait/changed-prefix/restore green using real internal request preparation. |
| 9 | Built artifact qualification | MET | 916 runtime, 464 shared-source, 38 Host and 20 desktop contract tests; 11-package JS build, 10-package typecheck, applicable lint and fresh 7-case sidecar pass. |
| 10 | Review and documentation | MET | Independent full partitioned review, substantive findings resolved, EN/ZH specs/ADR/release note and this command/hash/manifest report synchronized. |

## Remaining limits and process disclosure

- Offline synthetic qualification only. No installed desktop UI, real search/provider service, billing behavior, or Rust build was tested or claimed.
- Estimates are heuristics, not exact billing. No-target cut-point/manual-harness callers remain conservative instead of inventing model identity; prefix/tail retention algorithms are unchanged.
- Non-finite/missing timestamps and unsupported message roles now fail explicitly. This does not migrate or delete old data. Legitimate nameless search records are supported; corrupt metadata is not silently repaired.
- The patch covers Desktop's library imports (`native-pi-session.ts` uses `createAgentSession` from the main package entry). The dependency's separately prebundled standalone pi CLI/RPC entry and upstream source maps are not rebuilt/qualified here; existing source-map limitations remain.
- The existing frame protocol saves the final full message separately. It is not extended to preserve `hostedSearchCitations` in every interrupted partial-frame reconstruction; normal full-message persistence and hosted-search content snapshots are covered. Existing unrelated tool-frame delta differences were not rewritten.
- **Process deviation:** the harness fixer reported prohibited `rm -rf` use targeting two not-yet-existing scratch negative-fixture paths. It reported no existing files deleted and no access to main/user data by that command. This violated the no-`rm` instruction despite the empty targets; it was disclosed immediately and is not represented as compliant. No further such deletion was used.

## PR preparation follow-up

The user subsequently authorized committing, pushing and creating a PR. The
45-file implementation candidate remains production-code-identical to the
qualified bundle. PR preparation updates this report and adds one metadata
file, `.gitattributes` (46 final changed files).

Staging the previously untracked pi-coding-agent patch exposed a Git whitespace
warning that the earlier unstaged `git diff --check` did not inspect: a blank
unified-diff context line is encoded as one significant space. The generated
patch is not hand-edited. `patches/*.patch whitespace=-blank-at-eol` disables
only that format-inapplicable diagnostic for patch artifacts; other whitespace
diagnostics and all source-file checks remain enabled. Patch bytes in the
index equal their working-tree bytes and locked hashes. The PR preparation
runs `git diff --cached --check` and frozen installation with this rule.

The refreshed remote base is unchanged. Runtime (916), shared source (464) and
Host-runtime (38) tests were rerun successfully before committing. The PR's
commit metadata records the final revision; earlier artifact evidence remains
explicitly tied to the uncommitted implementation candidate.

## Changed-file manifest (46 files)

All paths below are relative to the isolated task worktree. Generated builds, installed dependencies and scratch evidence are excluded.

```text
.gitattributes
docs/adr/0297-provider-hosted-web-search-adapter-capability.md
docs/project/hosted-search-contract-verification.md
docs/project/unreleased.md
docs/spec/03-runtime/08-error-codes.md
docs/spec/03-runtime/11-provider-model-system.md
docs/spec/06-delivery/04-e2e-test-plan.md
docs/zh-CN/spec/03-runtime/08-error-codes.md
docs/zh-CN/spec/03-runtime/11-provider-model-system.md
docs/zh-CN/spec/06-delivery/04-e2e-test-plan.md
package.json
packages/agent-runtime/src/agent-errors.test.ts
packages/agent-runtime/src/agent-errors.ts
packages/agent-runtime/src/context-budget.test.ts
packages/agent-runtime/src/context-budget.ts
packages/agent-runtime/src/hosted-search-compaction.test.ts
packages/agent-runtime/src/hosted-search-consumers.test.ts
packages/agent-runtime/src/hosted-search-error-results.test.ts
packages/agent-runtime/src/hosted-search-estimation.test.ts
packages/agent-runtime/src/hosted-search-replay.test.ts
packages/agent-runtime/src/hosted-search-replay.ts
packages/agent-runtime/src/local-request-errors.ts
packages/agent-runtime/src/output-cap.test.ts
packages/agent-runtime/src/output-cap.ts
packages/agent-runtime/src/provider-retry.test.ts
packages/agent-runtime/src/provider-retry.ts
packages/agent-runtime/src/reasoning-replay.ts
packages/agent-runtime/src/runtime.test.ts
packages/agent-runtime/src/runtime.ts
packages/agent-runtime/src/sidecar.ts
packages/agent-runtime/src/subagent-context.test.ts
packages/agent-runtime/src/subagent-context.ts
packages/agent-runtime/src/subagent.test.ts
packages/agent-runtime/src/subagent.ts
packages/agent-runtime/src/system-transcript.test.ts
packages/agent-runtime/src/system-transcript.ts
packages/host-runtime/src/sidecar-local-error.test.ts
patches/@earendil-works__pi-agent-core@0.86.1.patch
patches/@earendil-works__pi-ai@0.86.1.patch
patches/@earendil-works__pi-coding-agent@0.86.1.patch
pnpm-lock.yaml
pnpm-workspace.yaml
scripts/e2e-hosted-search.mjs
scripts/e2e/hosted-search-provider.mjs
scripts/e2e/hosted-search-scenarios.mjs
scripts/e2e/hosted-search-sidecar.mjs
```

## OpenAI Codex OAuth hosted-search follow-up (2026-09-23)

The official [OpenAI web-search guide](https://developers.openai.com/api/docs/guides/tools-web-search)
documents `tools: [{ type: "web_search" }]` for the public Responses API, but
does not specify the private ChatGPT Codex subscription endpoint. The pi upstream
issue [#8556](https://github.com/earendil-works/pi/issues/8556) reports a
successful verification of the classic Codex Responses top-level `tools` shape
and `response.web_search_call.*` events. This implementation therefore opts in
only for `openai-codex-responses`, keeps the feature off by default, and surfaces
backend rejection normally. No OAuth token or live API request was used.

### Task-candidate verification

- Branch: `fix/openai-codex-native-search`.
- Base: `origin/main` at `ea5890b94`; it is an ancestor of the task candidate.
- pi-ai: `0.87.1`; patch SHA-256 and `pnpm-lock.yaml` patch hash both
  `6cf3998c09e8bba22cd63ceebe74a33332d9fd0c9ef3d5046941cb53513973f8`.
- `pnpm --filter @pi-desktop/shared test`: PASS, 84 files / 1,012 tests.
- `pnpm --filter @pi-desktop/agent-runtime test`: PASS, 68 files / 1,029 tests.
- `pnpm build:js`, `pnpm -r --if-present typecheck`, `pnpm lint`, and
  `pnpm docs:check`: PASS.
- `pnpm test:e2e:hosted-search`: PASS, 7/7 offline sidecar scenarios; bundle
  SHA-256 `633fc6e9ffafca718a53a2b9949d28259b90584b332d7a9a30e5f5763c64caae`.
- Codex adapter contract uses a synthetic JWT, captures the body at
  `onPayload`, then aborts before fetch. It verifies opt-in body fields and
  opt-out omission without contacting a provider.
- `TMPDIR=$PI_SCRATCH_DIR pnpm test:e2e:provider-api-style`: PASS; the
  production `VendorAccountDialog` checkbox starts off, can be enabled for a
  synthetic Codex OAuth account, and saves `nativeWebSearch` in both locales.
  Discovery is stubbed; no Host persistence or live provider is exercised.

`pnpm patch-commit` needed installation metadata for the new worktree. It
resolved packages from the cache with zero downloads, materialized the ignored
worktree `node_modules`, and ran Electron postinstall. No live OAuth account or
paid service was used. This is task-candidate evidence, not live Codex account
certification.
