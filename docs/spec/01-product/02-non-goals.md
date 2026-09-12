# 02. Non-Goals

## 1. MVP will not include

1. Remote Gateway / WebUI remote control (the local loopback MCP control plane
   is an opt-in desktop-side exception, not a remote gateway)
2. Cloud accounts and multi-device sync
3. Full IDE (LSP, debugger, multi-file editor workspace)
4. A from-scratch agent loop replacing pi
5. Full plugin marketplace at day one
6. Mobile clients
7. Multi-user auth systems
8. Billing/subscription modules
9. Computer Use browser takeover
10. Unconfirmed full-disk high privilege mode
11. Non-English as the primary source language
12. A second planner Agent, planner service, planner model, or separate
    permission profile for Plan
13. Treating Plan as a strict read-only security sandbox or auto-approving a
    scheduled Plan run

## 2. Not optimized yet

- Minimal package size extremes
- Complex animation systems
- Complete multi-locale coverage at launch
- Pixel-perfect multi-platform polish
- Massive history search performance

## 3. Not success criteria

- Clone every ChatGPT Desktop feature
- Clone WorkBuddy enterprise integrations
- Clone LiveAgent gateway stack

## 4. Architecture options deferred/rejected for MVP

| Option | Why |
|---|---|
| Tauri shell | Electron route is frozen |
| Renderer-side agent loop | Security and lifecycle risk |
| Remote-first design | Conflicts with local-first MVP |
| Marketplace before local plugin runtime | Premature expansion |
| Rewrite pi agent engine in Rust immediately | Too costly; keep pi engine |
