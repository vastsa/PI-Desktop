# ADR 0010: Use Rust as backend host core

- Status: Accepted
- Date: 2026-07-25

## Context

PI-Desktop needs a robust local backend for:

- filesystem tools
- process/command execution
- plugin isolation boundary
- secure storage adapters

## Decision

Use **Rust as the backend host core**.

### Responsibility split

| Layer | Tech | Owns |
|---|---|---|
| UI | React + TypeScript | rendering, UX state |
| Electron shell | TypeScript | windows, preload bridge, app lifecycle |
| Host core | **Rust** | tools, permissions gateway, plugin host services, persistence adapters, privileged ops |
| Agent engine | Node/TypeScript (pi) | model providers, agent loop, tool-calling orchestration |

### Communication

```text
Renderer
 → Electron preload/main IPC
 → Rust host core (local RPC / FFI / sidecar protocol)
 ↔ Node pi agent runtime (sidecar)
```

Implementation choice for Electron↔Rust transport may be:

1. Rust sidecar process over stdio/JSON-RPC or protobuf, or
2. native Node/Electron addon bindings

MVP target: **Rust sidecar + local RPC** for clearer isolation.

## Non-goals

- Rewrite pi itself in Rust
- Replace pi agent loop in MVP
- Move UI into Rust

## Consequences

### Positive
- Strong systems backend
- Better isolation and performance headroom
- Cleaner security boundary for tools/plugins

### Negative
- More moving parts than pure TS main
- Requires packaging Rust binary with Electron app
