---
title: 快速开始
description: PI-Desktop 产品和文档结构的中文导览。
---

# 快速开始

PI-Desktop 是一个本地优先的 AI 编程代理桌面客户端。它让工作区、宿主进程、代理运行时和模型配置保持可见、可检查，同时让日常编码保持直接。

## 从哪里开始

| 你想了解… | 从这里开始 |
|---|---|
| 应用界面长什么样 | [界面截图](/zh-CN/guide/screenshots) |
| 当前交付了什么 | [产品范围](/zh-CN/spec/01-product/01-product-scope) |
| 系统如何协作 | [系统架构](/zh-CN/spec/02-architecture/01-architecture) |
| 协议和存储边界 | [运行时规格](/zh-CN/spec/03-runtime/01-ipc-protocol) |
| 如何开发插件 | [插件开发](/zh-CN/plugin-development) |
| 为什么做出某个决策 | [ADR 索引](/zh-CN/adr/) |
| 如何验证行为变化 | [E2E 测试计划](/zh-CN/spec/06-delivery/04-e2e-test-plan) |

这张表与英文快速开始页保持相同顺序；如果你需要完整英文技术正文，
可以直接打开 [English guide](/guide/)。

## 系统心智模型

```text
Renderer UI  →  Electron orchestration  →  Rust host core
      ↓                    ↓                       ↓
  transcript          pi Node sidecar          SQLite + processes
```

Renderer 负责呈现，Electron 协调桌面能力，pi sidecar 负责代理循环和模型工作，
Rust host 负责特权进程、文件系统、RPC 与持久化边界。

## 文档语言说明

中文入口提供与英文一致的产品导览、主题地图和完整规格正文。每个中文规格页都
保留英文源页面链接；代码、协议字段和标识符不翻译。英文仍是最终源事实，但你
不需要为了阅读完整内容不断跳回英文站点。

切换到 [English](/guide/) 查看完整的英文快速开始文档，或使用顶部搜索直接查找协议方法、错误码和决策编号。
