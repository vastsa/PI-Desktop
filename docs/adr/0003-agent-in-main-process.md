# ADR 0003: Hybrid runtime — Rust host core + Node pi agent sidecar

- Status: Superseded in part by ADR 0010 / ADR 0011
- Date: 2026-07-25

## Context

An all-in-main agent loop gave no strong systems backend, no isolated native
capability, and no privilege boundary around host work.

## Decision

A Rust host core owns host services, the tool sandbox, persistence adapters, and
privileged operations; a Node `pi-ai` + `pi-agent-core` sidecar stays the agent
loop; Electron main is a thin orchestrator between renderer IPC and both.

## Consequences

- Stronger native foundation and privilege boundary; the pi ecosystem stays.
- More integration complexity and a stable local RPC across three processes.
