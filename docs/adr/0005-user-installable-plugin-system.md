# ADR 0005: User-installable plugin system

- Status: Accepted
- Date: 2026-07-25
- Updated: 2026-07-25

## Context

Built-in features alone are not enough. Users need to install and develop
plugins that extend:

- commands
- panels
- agent tools
- skills

## Decision

Adopt a first-party **plugin system**:

- directory-based plugin packages
- `manifest.json` contribution + permission declarations
- command palette integration
- agent tool registration support
- local install / enable / disable / uninstall
- default-deny permissions with explicit grants

## Rationale

1. Enables user customization without forking the app
2. Safer than arbitrary Electron main-script loading
3. Serves both UI extension and agent extension
4. Leaves room for a later marketplace protocol

## Consequences

### Positive
- Extensible product surface
- Clear contribution model
- Aligns with skills/tools ecosystems

### Negative
- Extra architecture and security complexity
- Needs management UI, validation, and auditing

## Scope control

- MVP prioritizes local plugin loading, not marketplace
- First contributions: commands / panel / agentTools / skills
- Plugins are isolated and permissioned by default
