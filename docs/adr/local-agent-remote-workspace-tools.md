# ADR: Local Agent and model requests for remote workspaces

- Status: Accepted for implementation
- Date: 2026-10-11
- Supersedes the new-project execution choice in [Remote home workflow](remote-project-home-workflow.md)
- Related: [Logical project groups](0249-chatgpt-style-logical-project-groups.md)

## Context

The remote MVP ran the Agent on the SSH host and required remote providers and
host-owned projects, so project names and model selection diverged from local
work, while the user requires model requests and credentials to stay on Desktop
with the remote machine executing tools only.

## Decision

Keep the Agent runtime, provider resolution, credentials, model requests,
transcripts, project names, group instructions, memory, and sessions on Desktop,
reading root repository instructions from the remote workspace and merging them
after local global defaults. The Rust-owned logical project-group KV boundary
gains a remote workspace binding, where an opaque project identity selects the
group and the remote path is never interpreted as a local path. After the normal
permission and execution-admission gates, host-core relays supported workspace
tools through Electron Main to the paired Host, and RACP carries only the
execution identity, workspace path, and tool arguments — never model
configuration, credentials, or a model request. The Host validates its canonical
browse boundary and executes, and failed, disconnected, cancelled, timed-out, or
unsupported calls fail closed without falling back to local execution or
replaying side effects. New projects use the ordinary name, switcher, sidebar,
archive, and session controls, with remote directory selection in a separate
accessible dialog and no Host project or provider synchronization.

## Consequences

- The group's `remote` binding stores `{hostKey, path}` while its primary root
  and session `projectPath` use `remote-project:<groupId>`, and unknown opaque
  identities are rejected before any workspace or session mutation.
- The remote runner admits only Read, Glob, Grep, Write, Edit, and Bash, creates
  no remote project or session records, and preserves workspace containment;
  a lost mutation reply is `REMOTE_MUTATION_OUTCOME_UNKNOWN` and non-retriable.
- Storage stays Rust-owned and backward compatible through additive KV
  metadata, existing remote histories stay readable, and older Hosts report an
  explicit unsupported operation; permission approval stays on Desktop.

## Alternatives

- Copy local providers to the remote Host: rejected, OAuth and local credentials
  would still depend on a remote model runtime.
- Mirror remote paths into local folders: rejected, tools would act on a
  different filesystem and containment would become ambiguous.
