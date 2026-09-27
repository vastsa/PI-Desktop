---
title: 运行时核心
description: PI-Desktop 的 IPC、代理循环、工具权限、Rust host 和模型系统。
---

# 运行时核心

这一主题回答“一次请求如何穿过客户端，以及哪些组件可以改变状态”。页面分组与英文 Runtime Core 保持同步。

## 阅读顺序

1. [IPC 协议](/zh-CN/spec/03-runtime/01-ipc-protocol)
2. [Agent 运行时](/zh-CN/spec/03-runtime/02-agent-runtime)
3. [工具与权限](/zh-CN/spec/03-runtime/03-tools-and-permissions)
4. [Rust host core](/zh-CN/spec/03-runtime/05-host-core-rust)
5. [Host RPC 协议](/zh-CN/spec/03-runtime/06-host-rpc-protocol)
6. [Provider 与模型系统](/zh-CN/spec/03-runtime/11-provider-model-system)

## 关注边界

- Renderer 只通过 preload IPC 访问桌面能力。
- pi sidecar 持有代理循环和 provider-facing model work。
- Rust host 独占 SQLite，并负责进程、文件系统、RPC 和错误边界。
- 所有协议或状态变化都应同步更新 E2E 场景。
