# ADR 0010: Use Rust as backend host core

- Status: Accepted
- Date: 2026-07-25

## Context

PI-Desktop needs a local backend for filesystem tools, command execution, plugin
isolation, secure storage, and long-running host services. A TypeScript backend
inside Electron main is workable but weak for systems work and isolation.

## Decision

Use **Rust as the backend host core**. Rendering stays in React, windows and
lifecycle stay in Electron main, providers and the agent loop stay with pi in Node,
and Rust owns tools, the permission gateway, plugin host services, persistence
adapters, and privileged operations. The renderer reaches Rust through IPC plus a
local RPC or FFI; the MVP uses a Rust sidecar over local RPC for the clearest
isolation. Rewriting pi or the UI in Rust is out of scope.

## Consequences

- Tools and plugins get a real security boundary instead of Electron main.
- A second binary must be built and shipped.
