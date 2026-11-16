# ADR 0003: Hybrid runtime — Rust host core + Node pi agent sidecar

- Status: Superseded in part by ADR 0010 / ADR 0011
- Date: 2026-07-25
- Updated: 2026-07-25

## Context

The original MVP placed the full agent loop in Electron main process for
simplicity.

1. Prefer a stronger systems backend
2. Keep pi Agent Harness as the model/agent engine
3. Improve long-term isolation and native capability quality

## Original Decision

MVP agent loop in Electron main process.

## Revised Direction

Adopt a hybrid model:

- **Rust backend host core** owns desktop host services, tools sandbox, plugin
  host boundary, persistence adapters, and privileged operations
- **Node/TypeScript pi runtime** remains the agent loop engine (`pi-ai` +
  `pi-agent-core`) and runs as a controlled sidecar/utility process
- **Electron main** becomes a thin orchestrator between renderer IPC and
  Rust/Node services

## Consequences

### Positive
- Better native/host capability foundation
- Clearer privilege boundary
- Keeps pi ecosystem leverage

### Negative
- Higher integration complexity than pure Node main
- Requires stable local RPC between Electron/Rust/Node
