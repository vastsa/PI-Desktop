# ADR 0005: User-installable plugin system

- Status: Accepted
- Date: 2026-07-25
- Updated: 2026-07-25

## Context

Built-in features are not enough: users must install plugins that extend
commands, panels, agent tools, and skills without the app loading arbitrary
Electron main scripts.

## Decision

Adopt a first-party plugin system of directory packages whose `manifest.json`
declares contributions and permissions, with local install, enable, disable,
and uninstall and default-deny permissions with explicit grants.

## Consequences

- Users extend the product without forking it, across UI and agent surfaces.
- The host owns validation, auditing, and a management UI.
- The marketplace stays out of scope for now.
