# ADR 0283: Ship the DOCX editor as a bundled plugin

## Context

DOCX editing needs a substantial browser renderer, but the host should retain
ownership of work-panel routing, plugin lifecycle, and file safety.

## Decision

Ship the renderer as the bundled `pi.office` plugin. Keep file reads, saves,
conflict checks, recovery copies, and path validation in the plugin process
behind the public plugin bridge. Route DOCX references through the existing
work-panel plugin-view mechanism.

The first migration slice deliberately omits selection-to-chat and annotation
integration so Office editing can land without changing the Composer contract.

## Consequences

The editor remains isolated from Electron and network access, and non-DOCX
file behavior is unchanged. The application carries the generated editor
bundle and fonts, and the host must provide the `ui.openWorkPanelFile` bridge
and DOCX work-panel routing. The editor exposes 25%–200% zoom, and the host
re-attaches the native view only after plugin view creation completes so hot
reloads do not strand a stale surface over the work panel.
