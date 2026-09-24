<div align="center">

<img src="docs/image/readme/logo.png" alt="PI-Desktop" width="108" />

# PI-Desktop

### 可拆卸的 AI Agent 桌面工作台

**把项目、Agent、模型、插件和工作流，装进一个长期可用的桌面环境。**

本地优先 · 模型自由 · 插件驱动 · macOS / Windows / Linux

<br />

[![Release](https://img.shields.io/github/v/release/vastsa/PI-Desktop?label=release)](https://github.com/vastsa/PI-Desktop/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/vastsa/PI-Desktop/total?label=downloads)](https://github.com/vastsa/PI-Desktop/releases)
[![Stars](https://img.shields.io/github/stars/vastsa/PI-Desktop?style=flat\&label=stars)](https://github.com/vastsa/PI-Desktop/stargazers)
[![CI](https://github.com/vastsa/PI-Desktop/actions/workflows/ci.yml/badge.svg)](https://github.com/vastsa/PI-Desktop/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/vastsa/PI-Desktop)](LICENSE)
[![Reddit](https://img.shields.io/badge/Reddit-r%2FAIUO-FF4500?logo=reddit\&logoColor=white)](https://www.reddit.com/r/AIUO/)

<br />

**[立即下载](https://github.com/vastsa/PI-Desktop/releases/latest)** ·
[使用文档](https://pi-docs.aiuo.net/) ·
[插件开发](docs/plugin-development.md) ·
[界面预览](docs/guide/screenshots.md) ·
[English](README.md)

<br />

<img src="docs/image/readme/home.webp" alt="PI-Desktop" width="94%" />

<br />

**你的项目留在本地 · 你的模型由你选择 · 你的工作台由你组装**

</div>

---

## 为什么是 PI-Desktop？

终端 Agent 擅长执行，IDE Agent 擅长嵌入编辑器。

PI-Desktop 想做得更进一步：

> **给 AI Agent 一个独立、长期、可扩展的桌面工作空间。**

<table>
<tr>

<td width="25%" valign="top">

### 独立工作台

不依附某个 IDE 或 Terminal。

Project、Session、Review、Preview 与 Agent 都有自己的空间。

</td>

<td width="25%" valign="top">

### 插件驱动

插件扩展的不只是 Agent。

面板、视图、Widget、Tool、MCP、主题与后台服务都可以插件化。

</td>

<td width="25%" valign="top">

### Agent 编排

一个 Agent 不够，就拆开做。

Subagent 与 Worker Session 可以承担独立任务并行工作。

</td>

<td width="25%" valign="top">

### 模型自由

云端、本地、自建网关、Compatible API。

模型随时换，工作流不用换。

</td>

</tr>
</table>

<div align="center">

**它不是某个模型的壳，也不是某个 IDE 的插件。**

### 它是承载 Agent 工作流的桌面平台。

</div>

> [!NOTE]
> **PI-Desktop 目前仍处于 Early Preview。** 已可用于真实开发工作流，部分 API、插件接口与桌面能力仍在持续演进。

> **当前发布线：0.15.x（Early Preview）。**

---

## 插件不是附加功能，而是工作台的一部分

PI-Desktop 的 Core 负责提供稳定底座。

**真正属于你的工作流，由插件组合出来。**

<table>
<tr>

<td width="33%" valign="top">

### Agent

扩展 Agent 能力

**Agent Tools**
**Skills**
**Completion**
**pi Extensions**

</td>

<td width="33%" valign="top">

### Workspace

扩展整个桌面

**Commands**
**Panels**
**Work Panel Views**
**Floating Widgets**
**Themes**

</td>

<td width="33%" valign="top">

### Platform

扩展运行平台

**MCP Servers**
**Resident Services**
**Plugin Message Bus**

</td>

</tr>
</table>

插件不必只是“给 Agent 多加一个 Tool”。

它可以是一整个产品：

```text
Voice Agent
├── Floating Widget
├── Speech Service
├── Agent Tool
└── Commands

GitHub Workspace
├── Work Panel
├── MCP Server
├── Agent Tools
└── Background Service

Session Analytics
├── Dashboard
├── Commands
└── Workspace View
```

### 插件能做什么？

| 能力                  | 用途                  |
| ------------------- | ------------------- |
| **Command**         | 向全局命令系统添加操作         |
| **Panel**           | 创建独立插件界面            |
| **Floating Widget** | 创建语音球、状态窗、计时器等悬浮界面  |
| **Work Panel View** | 向右侧工作区加入新视图         |
| **Agent Tool**      | 注册 Agent 可调用工具      |
| **Completion**      | 调用用户已经配置的模型         |
| **Skill**           | 为 Agent 提供可复用能力与工作流 |
| **Theme**           | 修改工作台视觉             |
| **MCP Server**      | 接入本地或远程 MCP         |
| **Service**         | 运行常驻后台任务            |
| **Message Bus**     | 在插件之间传递消息           |

插件可以通过 `.piplug` 分发，也可以从插件市场安装。

<div align="center">

### [开发一个插件 →](docs/plugin-development.md)

</div>

---

## 一个底座，组装不同的工作流

```text
                         PI-Desktop
                             │
          ┌──────────────────┼──────────────────┐
          │                  │                  │
        Agent            Workspace           Platform
          │                  │                  │
     Agent Tools           Panels              MCP
       Skills             Widgets            Services
     Subagents             Views            Message Bus
   pi Extensions          Themes
          │                  │                  │
          └──────────────────┼──────────────────┘
                             │
                       Your Workflow
```

PI-Desktop 可以只是一个 Coding Agent。

也可以被组装成：

**AI 开发工作台 · Voice Agent · DevOps Console · GitHub Workspace · 数据分析助手 · 多 Agent 调度中心 · 自动化平台**

> **Core 提供底座，插件决定它最终长什么样。**

---

## 三种工作方式

<table>
<tr>

<td width="33%" valign="top">

### Agent

**你给任务，它直接做。**

读代码、改文件、跑命令、测试、持续迭代。

适合日常开发。

</td>

<td width="33%" valign="top">

### Plan

**它先给方案，你确认后再执行。**

先研究项目，再生成实施计划。

适合重构与高风险修改。

</td>

<td width="33%" valign="top">

### Goal

**你定义结果，它决定路径。**

锁定目标与验收条件，其余交给 Agent。

适合复杂与长期任务。

</td>

</tr>
</table>

高权限操作始终经过 PI-Desktop 的 Permission Layer。

---

## 一个 Agent 不够，就拆开做

复杂任务不应该全部挤在一个 Context 里。

PI-Desktop 提供两层任务拆分能力。

### Subagents

把独立工作交给后台 Agent：

**代码调查 · 独立实现 · 测试分析 · Research · Review**

每个 Subagent 拥有独立 Context，完成后将结果返回主 Agent。

### Session Orchestrator

需要更完整、更长期的并行任务时，可以继续拆成多个 Worker Session。

```text
Main Session
│
├── Worker A
│   └── Frontend
│
├── Worker B
│   └── Backend
│
├── Worker C
│   └── Tests
│
└── Worker D
    └── Review
```

Worker 是完整的 PI-Desktop Session：

**独立 Context · 独立运行 · 可直接查看 · 可持续接受任务 · 保留完整 Transcript**

<table>
<tr>

<td width="50%">

<img src="docs/image/readme/session-orchestrator-overview.png" alt="Session Orchestrator" />

<p align="center"><sub>一个 Session 编排多个 Worker</sub></p>

</td>

<td width="50%">

<img src="docs/image/readme/session-orchestrator-worker.png" alt="Worker Session" />

<p align="center"><sub>每个 Worker 都是完整、可查看的 Session</sub></p>

</td>

</tr>
</table>

<div align="center">

**从「一个 Agent 帮我写代码」，走向「多个 Agent 分工完成任务」。**

</div>

---

## 为持续工作而设计

PI-Desktop 围绕：

<div align="center">

### Project → Session → Agent → Work

</div>

而不是围绕一次性聊天窗口设计。

支持：

* 多 Project / 多 Session
* Pin / Archive / Branch / Search
* Agent 运行时继续 Queue Prompt
* 使用 `@` 引用项目文件
* Slash Commands
* Diff Review
* Command Output
* Work Panel
* Streaming Checkpoint
* 异常后尽可能恢复任务现场

**Session 可以跨多次启动持续工作。**

---

## 看见 Agent 在做什么

<table>
<tr>

<td width="50%">

<img src="docs/image/readme/chat_en.png" alt="PI-Desktop Session" />

<p align="center"><sub>长期 Session，而不是一次性对话</sub></p>

</td>

<td width="50%">

<img src="docs/image/readme/model_en.png" alt="PI-Desktop Model" />

<p align="center"><sub>在 Session 中直接切换模型与推理等级</sub></p>

</td>

</tr>

<tr>

<td width="50%">

<img src="docs/image/readme/plugins_en.png" alt="PI-Desktop Plugins" />

<p align="center"><sub>插件市场：扩展 Agent，也扩展整个桌面</sub></p>

</td>

<td width="50%">

<img src="docs/image/readme/addmodel_en.png" alt="PI-Desktop Providers" />

<p align="center"><sub>连接 Provider、Gateway 或本地模型</sub></p>

</td>

</tr>
</table>

<div align="center">

**[查看更多界面 →](docs/guide/screenshots.md)**

</div>

---

## 模型可以换，工作流不用换

PI-Desktop 不把 Agent 工作流绑定到某一家模型厂商。

支持：

**OpenAI · Anthropic · OpenAI Compatible API · 自建 Gateway · Ollama · LM Studio · Local Model**

每个模型都可以独立配置：

**Provider · Model ID · Context Window · 最大输出 · Reasoning / Thinking · Temperature · OAuth · API Key · Endpoint**

不同 Session 可以使用不同模型。

同一个 Session 也可以随时切换。

```text
Planning     → Model A
Coding       → Model B
Review       → Model C
Private Task → Local Model
```

> **模型是可以替换的组件，而不是工作流本身。**

---

## 已经在用其他 Coding Agent？

已有工作不需要从零开始。

PI-Desktop 可以导入本地 Session：

**Claude Code · Codex · OpenCode · Pi**

---

## Local-first

PI-Desktop 不要求你把开发环境搬到我们的云端。

| 数据                   | 默认行为               |
| -------------------- | ------------------ |
| Project              | 本地                 |
| Session              | 本地                 |
| Settings             | 本地                 |
| Logs                 | 本地                 |
| API Credentials      | OS Keychain        |
| PI-Desktop Telemetry | 无                  |
| Model Request        | 直接发送到你配置的 Provider |

**无需 PI-Desktop 账号。**

**无需经过 PI-Desktop 云端 Relay。**

使用远程模型时，请求所需 Context 会直接发送给对应 Provider。

---

## 权限属于你

Agent 可以读取文件、修改代码、运行命令、调用 Tool、使用扩展和委派任务。

高权限操作仍然经过 Permission Layer：

```text
Agent
  ↓
Tool Request
  ↓
Permission Layer
  ↓
Allow / Ask / Deny
  ↓
Execution
```

**你决定每个 Session 拥有多少自主权。**

---

## 开始使用

<table>
<tr>

<td width="25%" valign="top">

### 01

**下载**

安装 PI-Desktop

</td>

<td width="25%" valign="top">

### 02

**连接模型**

配置 Provider

</td>

<td width="25%" valign="top">

### 03

**打开项目**

选择本地 Repository

</td>

<td width="25%" valign="top">

### 04

**开始工作**

Agent / Plan / Goal

</td>

</tr>
</table>

<div align="center">

### [下载 PI-Desktop →](https://github.com/vastsa/PI-Desktop/releases/latest)

**macOS · Windows · Linux**

</div>

### 安装包

| Platform | Architecture  | Package                                 |
| -------- | ------------- | --------------------------------------- |
| macOS    | Apple Silicon | `.dmg` / `.zip`                         |
| macOS    | Intel         | `.dmg` / `.zip`                         |
| Windows  | x64           | 安装程序 / `.zip`                       |
| Linux    | x64           | `.AppImage` / `.deb` / `.rpm` / `.asar` |

macOS Release 使用 Developer ID 签名并经过 Apple Notarization。

<details>
<summary><strong>Linux Compatibility</strong></summary>

<br />

Linux x64 需要 **glibc 2.35+**。

常见支持版本：

* Ubuntu 22.04+
* Debian 12+
* Fedora 36+

检查当前版本：

```bash
ldd --version
```

</details>

---

## Built on Pi

PI-Desktop 构建在 [pi](https://github.com/badlogic/pi-mono) 生态之上。

Agent Runtime 使用：

* `pi-ai`
* `pi-agent-core`

> **Pi 提供 Agent Engine，PI-Desktop 在其上构建 Desktop Workspace、Session、权限、插件与 Agent 编排。**

---

## 开发者

PI-Desktop 也可以作为开发者构建 Agent 产品的宿主平台。

你可以开发：

**Plugin · MCP Server · Skill · Agent Tool · pi Extension · Theme · Panel · Floating Widget · Background Service**

### 插件快速开始

内置模板：

* `panel-basic`
* `agent-tool-basic`
* `skill-pack`
* `full-demo`

创建完成后即可作为 Development Plugin 加载。

**[Plugin Development Guide →](docs/plugin-development.md)**

### 从源码运行

<details>
<summary><strong>Development Setup</strong></summary>

<br />

#### Requirements

* Node.js `>=22.19`
* pnpm `>=10`
* Stable Rust Toolchain

#### Start

```bash
git clone https://github.com/vastsa/PI-Desktop.git
cd PI-Desktop

pnpm install

cargo build -p host-core
pnpm build:js

pnpm dev
```

#### Validate

```bash
pnpm typecheck
pnpm lint
pnpm test
```

</details>

### 文档

[Documentation](https://pi-docs.aiuo.net/) ·
[Architecture](docs/spec/02-architecture/01-architecture.md) ·
[Specification](docs/spec/README.md) ·
[Plugin Development](docs/plugin-development.md) ·
[E2E Test Plan](docs/spec/06-delivery/04-e2e-test-plan.md) ·
[Release Runbook](docs/spec/06-delivery/06-release-runbook.md) ·
[AGENTS.md](AGENTS.md)

---

## Contributing

欢迎：

**Issues · Pull Requests · Plugins · Skills · MCP Integrations · Documentation · Translations**

对于相对独立的新能力，优先考虑一个问题：

> **它是否更适合作为一个 Plugin？**

让 Core 保持克制，让生态持续生长。

**[提交 Issue](https://github.com/vastsa/PI-Desktop/issues/new/choose)** ·
[查看 Issues](https://github.com/vastsa/PI-Desktop/issues) ·
[开发插件](docs/plugin-development.md)

---

## 项目趋势

<div align="center">

<a href="https://trendshift.io/repositories/178787?utm_source=repository-badge&amp;utm_medium=badge&amp;utm_campaign=badge-repository-178787">
<img src="https://trendshift.io/api/badge/repositories/178787" alt="PI-Desktop on Trendshift" width="230" height="51" />
</a>

</div>

---

## 友情链接

[Linux.Do](https://linux.do/) — 新的理想型社区

---

## Model Acknowledgements

> **Not by a lone genius, but by a token-powered construction crew.**

PI-Desktop 的开发过程中使用了来自多个 Provider 的模型。

累计模型使用量已超过 **27 Billion Tokens**。

感谢参与构建 PI-Desktop 的每一位贡献者，以及陪我们一起写下这些代码的模型。

---

## License

PI-Desktop 使用 **GNU Lesser General Public License v3.0**。

详见 [LICENSE](LICENSE)。

---

<div align="center">

<img src="docs/image/readme/logo.png" alt="PI-Desktop" width="72" />

## PI-Desktop

### Build your own Agent workspace.

**你的模型 · 你的 Agent · 你的插件 · 你的工作台**

<br />

**[立即下载](https://github.com/vastsa/PI-Desktop/releases/latest)** ·
[Documentation](https://pi-docs.aiuo.net/) ·
[Build a Plugin](docs/plugin-development.md)

<br /><br />

<sub>Local-first · Model-agnostic · Plugin-powered</sub>

</div>
