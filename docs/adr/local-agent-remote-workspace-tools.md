# ADR: Local Agent and model requests for remote workspaces

- Status: Accepted for implementation
- Date: 2026-10-11
- Supersedes the new-project execution choice in [Remote home workflow](remote-project-home-workflow.md)
- Related: [Logical project groups](0249-chatgpt-style-logical-project-groups.md)

## Context

The remote MVP ran an Agent on the SSH Host and required remote providers and
Host-owned projects. This made project names and model selection differ from
local work.

## Decision

Keep the Agent runtime, provider resolution, credentials, model requests,
transcripts, project names, project-group instructions, project memory and
sessions on Desktop. Root repository instructions are read from the remote
workspace and merged after local global defaults, without remote HOME defaults
or nested traversal.

After the normal local permission and execution-admission gates, host-core
relays supported workspace tools through Electron Main to the paired Host. RACP
transports the execution identity, workspace path and tool arguments only.

## Alternatives

- Automatically copy local providers to the remote Host: rejected because OAuth,
  local providers and credentials would still depend on a remote model runtime.
- Add a model gateway through reverse SSH: keeps credentials local but still
  leaves session and Agent ownership remote, adding model transport exposure.
- Mirror remote paths into local folders: rejected because tools would act on a
  different filesystem and make containment and data consistency ambiguous.

## Consequences

The project group's `remote` binding stores `{hostKey, path}` while its primary
root and session `projectPath` use `remote-project:<groupId>`.

The pure remote runner admits only Read, Glob, Grep, Write, Edit and Bash.
