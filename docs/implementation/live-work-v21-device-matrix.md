# Live Work v2.1 Manual Device Acceptance

Status: **NOT RUN**. These cases need isolated real accounts and audio
hardware. No account, paid endpoint, user project, or running Electron
instance was used for the automated work in this candidate. A fixture pass is
not a device pass.

## Provider profile status

| Profile | Required real boundary | Status | Date / platform / device / model |
|---|---|---|---|
| Codex Live | OAuth, WebRTC DataChannel control/receipt round-trip, playback and microphone | NOT RUN | — |
| Gemini Live | WebSocket tool receipt, generation, PCM output drain, microphone | NOT RUN | — |
| Realtime GA | GA adapter events, response exclusion, PCM playback/capture | NOT RUN | — |
| Realtime compat-v1 | Separate compat profile fields/events, response exclusion, audio | NOT RUN | — |

Record only the provider profile, app/build version, OS/platform, device type,
model/profile, date, and observed outcome. Never include account IDs, API keys,
Authorization headers, SDP, full project paths, or user audio recordings.

## Existing M01—M16 journeys

These preserve the v2 matrix and are all `NOT RUN` for this candidate.

| ID | Journey | Expected result | Status |
|---|---|---|---|
| M01 | Complete a voice-only call | Connect, speak, interrupt, mute and end as in v1 | NOT RUN |
| M02 | Explicitly bind a call to a fixture work session | Scope is visible; session model and permission do not change | NOT RUN |
| M03 | Ask for a confirmed code fix and related tests | One voice-origin task appears in the original chat and uses the existing Agent tools | NOT RUN |
| M04 | Discuss a design question during work | Live conversation continues; project facts are delegated without waiting for call end | NOT RUN |
| M05 | Add a constraint to the active task | The exact active turn receives the constraint; no duplicate root task | NOT RUN |
| M06 | Ask to do another task after the current one | Host queue receives independent work; active turn is not steered | NOT RUN |
| M07 | Ask for current progress | Reply reflects actual Host state and creates no second task | NOT RUN |
| M08 | Ask for the prior task result | Exact turn result is used; missing evidence is stated honestly | NOT RUN |
| M09 | Stop the current coding task | Only the captured target is stopped; request and terminal state are distinct | NOT RUN |
| M10 | Stop speaking but continue working | Agent continues; automatic confirmation stops while new user input remains available | NOT RUN |
| M11 | Navigate the sidebar to another session | Work remains bound to the original session; no stale request reaches the new page | NOT RUN |
| M12 | Open or create a similarly named session | Duplicate labels require a choice; defaults remain intact; no implicit rebind | NOT RUN |
| M13 | Trigger a controlled write or command under Ask mode | Existing approval card appears; spoken approval cannot click it | NOT RUN |
| M14 | End Live while Agent work is running | Microphone releases; accepted work continues in Host and remains in its work session | NOT RUN |
| M15 | Recover after network/provider failure | Old operation is not replayed; status and undelivered result remain visible | NOT RUN |
| M16 | Explicitly reconnect to a new work session | New call/scope is created; old context and late results do not cross calls | NOT RUN |

## New LM21-01—LM21-12 journeys

These supplement the original matrix without renumbering it. All are `NOT RUN`.

| ID | Journey | Expected result | Status |
|---|---|---|---|
| LM21-01 | Voice-only call without work binding | Conversation works and creates no Agent turn | NOT RUN |
| LM21-02 | Bind a temporary work session in project A | Work runs in A; one user task appears with its real execution | NOT RUN |
| LM21-03 | Add a constraint while T1 is running | Only T1 receives the addition; earlier voice/text content remains | NOT RUN |
| LM21-04 | Freeze a T1 request, end T1, then start T2 | Old stop/steer is stale; T2 is untouched | NOT RUN |
| LM21-05 | Ask to stop during slow ordinary classification | Control proceeds; prior unaccepted work does not start afterward | NOT RUN |
| LM21-06 | Queue work in idle and busy states | Shared Host queue drains when idle, orders when busy, and cancels exact entries | NOT RUN |
| LM21-07 | Lose the admission ACK after Host acceptance | UI shows unknown then reconciles; actual dispatch count remains one | NOT RUN |
| LM21-08 | Let terminal arrive before admission ACK | Final state stays terminal and result belongs to the correct turn | NOT RUN |
| LM21-09 | Delay final reply persistence after terminal | UI first shows syncing, then the exact result; no other turn is used | NOT RUN |
| LM21-10 | Query a result twice while navigating to session B | Answer stays scoped to A; no task repeats; View/Stop retains A/T | NOT RUN |
| LM21-11 | Trigger approval, Plan/Goal, or AskTool wait | Existing UI owns the decision; spoken “approve” cannot bypass it | NOT RUN |
| LM21-12 | Finish work during Live output, then interrupt, mute and end | Feedback does not barge in; mute does not stop work; accepted work survives hangup | NOT RUN |
