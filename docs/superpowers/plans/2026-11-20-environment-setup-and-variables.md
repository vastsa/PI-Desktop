# Environment Setup Script and Variables Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The user can give each environment a setup script and environment variables, edit them from the composer's target row and from Settings, and see them take effect in every new repository session on that environment.

**Architecture:** Storage, transport, and execution already exist after the earlier plans: environments carry `setupScript` and `variables`, the session workspace orchestrator sends them with the prepare request, and the remote host runs the script and injects the variables into tools. This plan adds the editor, the Settings section, the surfaces that show a script's outcome, and the end-to-end proof.

**Tech Stack:** TypeScript (React 19), `node --test`, i18next catalogs in nine locales.

**Spec:** `docs/superpowers/specs/2026-11-20-remote-github-sessions-design.md` (Part 7, §6). Plan 7 of 7. It consumes the "Cross-plan contract" of `2026-11-20-environments-and-session-targets.md` (environment channels, `RemoteEnvironment`, `SessionRemoteRepository.setup`) and the variable-name rule from `2026-11-20-host-git-workspaces.md` (`isEnvironmentVariableName` in `@pi-desktop/shared`).

## Global Constraints

- Work in the worktree and branch you were given. Do not push; the coordinator integrates.
- Renderer-only, plus one end-to-end script and docs. No new IPC channel, no host-core change, no RACP change. If something appears to need one, stop and report it.
- Environment variables are plain configuration: stored unencrypted on the desktop and on the host. The editor must say so wherever a value is entered, and must not present itself as a place for secrets.
- The setup script is the user's own code and runs on the remote host without a permission prompt. The editor must say where and when it runs.
- Changes apply to sessions created afterwards; the editor says so.
- The default environment of a host can be edited but not deleted or moved to another host.
- New `.tsx` files stay under 800 lines. Design tokens only (`pnpm lint` rejects hardcoded style values). All nine locale catalogs keep the English key set, with real translations.
- Do not run `pnpm install`. Stage files by explicit path. Conventional Commits, English, subject + blank line + body explaining why. No `Co-Authored-By` or `Signed-off-by`.
- Decision id for this plan: **D692**. Decision record slug: `environment-setup-and-variables`.

## Review Focus

1. A variable name the host would refuse (`PATH`, `GIT_DIR`, a name with a dash, a duplicate): the editor rejects it inline, names the reason, and never sends it. Pinned in Task 1.
2. A setup script that fails or runs for minutes: the session becomes usable when the worktree exists, the user can see that setup is still running or failed, and the log tail is readable. Pinned in Tasks 3 and 4.
3. An environment is edited or deleted while a session that used it is open: the open session is unaffected, and the target row falls back to the host's default environment when its selected environment is deleted. Pinned in Task 2.
4. A script or value containing quotes, newlines, dollar signs, or non-ASCII text reaches the host byte for byte. Pinned in Task 4.
5. Sixty-four variables, an 8192-character value, and a 65536-character script are accepted; one more is refused with a clear message before saving. Pinned in Task 1.

---

### Task 1: Environment editor

**Files:** create under `apps/desktop/src/features/environments/`: `EnvironmentEditorDialog.tsx`, `EnvironmentVariablesTable.tsx`, `environment-form.ts` (pure validation and form model), `environments.css`; modify the nine locale catalogs; create `apps/desktop/test/environment-form.test.mjs` and `apps/desktop/test/environment-editor-user-path.test.mjs`.

**Interfaces:**
- `validateEnvironmentForm(form: EnvironmentForm): { ok: true; input: RemoteEnvironmentInput } | { ok: false; errors: EnvironmentFormErrors }` where `EnvironmentForm` is `{ id?: string; name: string; hostKey: string; setupScript: string; variables: { name: string; value: string }[]; isDefault: boolean }` and errors are keyed by field and by variable row index.
- `<EnvironmentEditorDialog environment={RemoteEnvironment | null} hosts={RemoteHostSummary[]} onSaved(environment) onClose() />` — null means create.

Rules: name 1 to 80 characters after trimming; host required and, for a default environment, fixed; variable names pass `isEnvironmentVariableName` and are unique; at most 64 variables; value at most 8192 characters; script at most 65536 characters; rows with an empty name and an empty value are dropped silently, a row with a value and no name is an error. The script field is a monospace multi-line editor that preserves the text exactly. Save calls `api.upsertEnvironment`. A default environment's name field is editable; its host is not.

English copy (keys under `environments`): `editTitle` "Edit environment"; `createTitle` "New environment"; `name` "Name"; `host` "Remote host"; `setupScript` "Setup script"; `setupScriptHelp` "Runs once in each new session's checkout on {{host}}, as your user there, before the agent starts. It runs without asking."; `variables` "Environment variables"; `variablesHelp` "Available to the setup script and to every command the agent runs. Stored as plain text on this computer and on the host. Do not put passwords or tokens here."; `variableName` "Name"; `variableValue` "Value"; `addVariable` "Add variable"; `removeVariable` "Remove"; `appliesLater` "Changes apply to sessions you start from now on."; `save` "Save"; `cancel` "Cancel"; errors `nameRequired` "Enter a name"; `nameTooLong` "Use 80 characters or fewer"; `variableNameInvalid` "Use letters, digits, and underscores, starting with a letter or underscore"; `variableNameReserved` "{{name}} is reserved and cannot be set here"; `variableNameDuplicate` "{{name}} is already defined"; `variableNameMissing` "Give this value a name"; `tooManyVariables` "Use 64 variables or fewer"; `valueTooLong` "Use 8192 characters or fewer"; `scriptTooLong` "Use 65536 characters or fewer"; `saveFailed` "Could not save: {{message}}".

- [ ] **Step 1: Write the failing tests.** Form: each rule with its error key; the three limits accepted at the bound and refused one past it; empty rows dropped; reserved names (`PATH`, `GIT_DIR`, `PI_PORT`, `LD_PRELOAD`) report `variableNameReserved`, malformed ones (`1A`, `A-B`) report `variableNameInvalid`; a script with quotes, `$`, newlines, tabs, and non-ASCII text round-trips unchanged into `input`. Dialog (mocked `api`): create and edit prefill; inline errors block save and nothing is sent; a successful save calls `upsertEnvironment` with the validated input and `onSaved`; a default environment's host is disabled; a rejected save shows `saveFailed` and keeps the form.
- [ ] **Step 2: Run and see them fail** — `cd apps/desktop && node --test test/environment-form.test.mjs test/environment-editor-user-path.test.mjs`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — the two files, `pnpm --filter @pi-desktop/i18n test`, typecheck, `pnpm lint`.
- [ ] **Step 5: Commit** — `feat(environments): add the environment editor`

---

### Task 2: Target row integration

**Files:** modify `apps/desktop/src/features/chat/session-target/EnvironmentPicker.tsx` (an edit action on each environment row; "New environment…" opens the full editor), delete `apps/desktop/src/features/chat/session-target/NewEnvironmentDialog.tsx` and its references (the editor replaces it), modify `apps/desktop/src/features/chat/session-target/session-target-store.ts` (on `environmentsChanged`, when the selected environment is gone, select its host's default environment; when the host is gone too, select `"local"`); extend `apps/desktop/test/session-target-row-user-path.test.mjs` and `apps/desktop/test/session-target-store.test.mjs`.

- [ ] **Step 1: Write the failing tests:** the edit action opens the editor with that environment; creating from the picker selects the new environment; deleting the selected environment falls back to the host's default; removing the host falls back to `"local"`; the keys that named the old dialog's fields are removed from all nine catalogs if nothing else uses them.
- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — the two files, the i18n tests, typecheck, `pnpm lint`.
- [ ] **Step 5: Commit** — `feat(composer): edit environments from the target row`

---

### Task 3: Settings section and setup outcome

**Files:** create `apps/desktop/src/components/settings/EnvironmentsSection.tsx`; modify `apps/desktop/src/components/settings/RemoteHostsPage.tsx` (mount the section inside each host card), `apps/desktop/src/lib/settings-search.ts` (keywords), `apps/desktop/src/features/chat/session-target/WorkspacePreparationStatus.tsx` (while a ready session's setup status is `running`, show a quiet "Setup is still running" line; the failed state already exists), the nine catalogs; create `apps/desktop/test/environments-section-user-path.test.mjs`; extend `apps/desktop/test/workspace-preparation-status-user-path.test.mjs`.

Behavior: under each host, the section lists its environments (default first) with a one-line summary ("3 variables · setup script" or "No setup"), an Edit action, and a Delete action for non-default environments behind a confirmation. "New environment" creates one preselected to that host.

English copy (keys under `settings.remoteHosts.environments`): `title` "Environments"; `description` "Named setups for sessions on this host: a setup script and environment variables."; `new` "New environment"; `default` "Default"; `summaryNone` "No setup"; `summaryScript` "setup script"; `summaryVariables_one` "{{count}} variable"; `summaryVariables_other` "{{count}} variables"; `edit` "Edit"; `delete` "Delete"; `deleteConfirm` "Delete the environment {{name}}? Sessions already started keep working."; and under `sessionTarget.preparation`: `setupRunning` "Setup is still running…".

- [ ] **Step 1: Write the failing tests:** the list and summaries; default has no Delete; Delete confirms then calls `removeEnvironment`; New preselects the host; the status line for `setup.status === "running"` on a ready session and its disappearance on `ok`.
- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — the files, existing settings tests, i18n tests, typecheck, `pnpm lint`.
- [ ] **Step 5: Commit** — `feat(settings): manage environments under each remote host`

---

### Task 4: End-to-end acceptance

**Files:** create `scripts/e2e-remote-environment-setup.mjs`; modify `package.json` (`test:e2e:remote-environment-setup`), `scripts/README.md`.

Compose as `scripts/e2e-remote-repo-session.mjs` does. Scenario `E2E-REMOTE-environment-setup-and-variables-reach-the-session`:

1. Save an environment with variables `GREETING` = a value containing a double quote, a single quote, `$HOME`, and non-ASCII text, and `EMPTY_OK` = an empty string; and a setup script that writes `"$GREETING"` to `setup-marker.txt` and the working directory to `setup-cwd.txt`.
2. Start a session on it; wait for `ready` with setup status `ok`.
3. Through the tool relay, read `setup-marker.txt`: it equals the variable's value byte for byte. `setup-cwd.txt` is the worktree path.
4. Run Bash `printf %s "$GREETING"`: the same value. `$PI_WORKTREE_ROOT` is the worktree path.
5. Edit the environment's variable; the running session still sees the old value; a new session sees the new one.
6. Save an environment whose script exits 3 after printing a line; start a session: it becomes `ready`, setup status `failed`, and the log tail contains the printed line and the exit code.
7. Attempt to save a variable named `GIT_DIR` through the environments service: refused, nothing stored.

- [ ] **Step 1: Write the script.**
- [ ] **Step 2: Run** — `PI_HOST_CORE_BINARY="$PWD/target/debug/pi-desktop-host-core" pnpm test:e2e:remote-environment-setup`. Expected: every step `ok`.
- [ ] **Step 3: Commit** — `test(e2e): cover environment setup scripts and variables`

---

### Task 5: Decision record, specs, and docs

**Files:** create `docs/adr/environment-setup-and-variables.md`; modify `docs/adr/README.md`, `docs/spec/08-meta/decisions-log.md` (D692), `docs/spec/04-ux/06-settings-ia.md` (environments under Remote hosts), `docs/spec/04-ux/08-component-spec.md` (the editor), `docs/spec/05-security/02-remote-control-security.md` (setup script as owner-authored code without a prompt; variables as plain text on both machines; the reserved-name rule), `docs/spec/06-delivery/e2e/live-and-remote.md`, `docs/spec/06-delivery/04-e2e-test-plan.md`, `docs/guide/` (a short section on environments in the user guide page that covers remote hosts, if one exists).

- [ ] **Step 1: Write the decision record** (`# ADR: Environment setup scripts and variables`): what an environment configures; when the script runs and as whom; why it needs no permission prompt and how that differs from Agent commands; plain-text variables and the reserved names; changes apply to new sessions only; a failed script does not block the session. Alternatives: a per-repository setup file in the repository (kept as a possible later addition); encrypted variables (deferred until there is a secret channel to the host that does not write to its disk).
- [ ] **Step 2: Update the specs.**
- [ ] **Step 3: Verify** — `pnpm docs:check && pnpm check:agent-policy && git diff --check`.
- [ ] **Step 4: Commit** — `docs(remote): record environment setup scripts and variables`

---

### Final gate for this plan

```bash
pnpm build:js && pnpm --filter @pi-desktop/desktop typecheck && pnpm lint
pnpm --filter @pi-desktop/i18n test
cd apps/desktop && node --test test/environment-*.test.mjs test/environments-*.test.mjs test/session-target-*.test.mjs test/workspace-preparation-*.test.mjs test/settings-*.test.mjs
PI_HOST_CORE_BINARY="$PWD/../../target/debug/pi-desktop-host-core" pnpm -C ../.. test:e2e:remote-environment-setup
PI_HOST_CORE_BINARY="$PWD/../../target/debug/pi-desktop-host-core" pnpm -C ../.. test:e2e:remote-repo-session
```

Report any failure with its output.
