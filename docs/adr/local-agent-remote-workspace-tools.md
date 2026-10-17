# ADR: Local Agent and model requests for remote workspaces

- Status: Accepted for implementation
- Date: 2026-10-11
- Supersedes the new-project execution choice in [Remote home workflow](remote-project-home-workflow.md)
- Related: [Logical project groups](0249-chatgpt-style-logical-project-groups.md)

## Context

The remote MVP ran an Agent on the SSH Host and required remote providers and
Host-owned projects. This made project names and model selection differ from
local work. The user explicitly requires model requests and credentials to stay
on Desktop, with the remote machine executing tools only.

## Decision

Keep the Agent runtime, provider resolution, credentials, model requests,
transcripts, project names, project-group instructions, project memory and
sessions on Desktop. Root repository instructions are read from the remote
workspace and merged after local global defaults, without remote HOME defaults
or nested traversal. Extend the existing Rust-owned logical project-group KV
boundary with a remote workspace binding. An opaque project identity selects
the group; the actual remote path is never interpreted as a local filesystem path.

After the normal local permission and execution-admission gates, host-core
relays supported workspace tools through Electron Main to the paired Host.
RACP transports the execution identity, workspace path and tool arguments only.
It does not carry model configuration, model credentials, or a model request.
The Host validates its canonical browse boundary and executes the tool. Failed,
disconnected, cancelled, timed-out or unsupported remote calls fail closed;
they never fall back to local execution or automatically replay side effects.

New projects use the ordinary project name, switcher, sidebar, archive and
session controls. Remote directory selection is a separate accessible dialog
with path entry, parent navigation, loading/error feedback and explicit selection.
The Host project catalog and provider synchronization are not part of creation.
Existing remote Agent histories remain reachable as historical data.

## Alternatives

- Automatically copy local providers to the remote Host: rejected because OAuth,
  local providers and credentials would still depend on a remote model runtime.
- Add a model gateway through reverse SSH: keeps credentials local but still
  leaves session and Agent ownership remote, adding model transport exposure.
- Mirror remote paths into local folders: rejected because tools would act on a
  different filesystem and make containment and data consistency ambiguous.

## Consequences

The project group's `remote` binding stores `{hostKey, path}` while its primary
root and session `projectPath` use `remote-project:<groupId>`. Unknown opaque
identities are rejected before workspace or session mutation. The synthetic
project row stores local metadata only; registration never probes or creates the
remote directory on Desktop. Plan checkpoints use the local session scratch
rather than resolving the opaque identity as a filesystem directory.

The pure remote runner admits only Read, Glob, Grep, Write, Edit and Bash. It
creates no remote project or session records, preserves workspace containment,
and checks Bash's expected shell identity and dialect before execution. Local
permission waits and remote dispatches both honor cancellation, including an
abort arriving before dispatch. Missing replies fail closed and are never
replaced with a local tool invocation.

Project storage remains Rust-owned and backward compatible through additive KV
metadata. Existing local groups and existing remote histories remain readable.
New remote workspace sessions have the same local model and session contracts.
The remote Host must support the additive workspace-tool endpoints; older Hosts
report an explicit unsupported operation instead of using a remote model.

Local project/workspace consumers must distinguish the opaque remote identity
from a local directory before filesystem access. Execution has cancellation and
cleanup owners on both sides, and permission approval stays on Desktop.
Validation must include a local model fixture and a real remote tool boundary,
plus project rename/restart isolation and cancelled/disconnected calls.

[ADR 0326](0326-verified-ssh-host-installation.md) defines verified install and
separate daily startup. The additive `workspace/files` instructions operation
returns root repository entries only. A lost mutation reply is explicitly
`REMOTE_MUTATION_OUTCOME_UNKNOWN`, non-retriable; it requires inspection, not
automatic re-execution. Real Linux SSH and matching new release publication
remain independent qualification gates.
