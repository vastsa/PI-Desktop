# ADR: File Manager line references

- Status: Implemented candidate
- Date: 2026-11-06

## Context

The File Manager knows the source file and CodeMirror selection range.
The Composer owns draft mutation and the Host owns file access. A text-only
clipboard cannot carry the source identity independently from the selection.

## Decision

The source view places plain text and path/range metadata in the clipboard.
The explicit context-menu action uses a panel invocation gated to the visible,
enabled File Manager view, its existing view and read grants, the active
project, and the selected session. The registered File Manager can be bundled
or installed. Both paths create the same draft reference. Composer events
confer no file permission.

The view capability advertises bridge support from the loaded instance and
its grants. Registration is authorized on invocation, with a bounded Host
query, so a Host restart cannot delay opening the view or freeze a transient
registry failure into its preload capability.

The selected text is never used as the model payload for a reference. Main
validates the reference path against the Session project folders. At prompt
execution, the Agent runtime invokes the existing Read tool with the inclusive
range converted to its zero-based offset and line count. The Host continues
to authorize the tool call and enforce its output limits. A successful result
is included as file context. A blocked or failed read is reported separately
in the provider prompt. Prefetches do not create assistant tool history.

## Consequences

References are initially available for local project source views with one
selection. Rendered and remote previews retain their clipboard behavior.
