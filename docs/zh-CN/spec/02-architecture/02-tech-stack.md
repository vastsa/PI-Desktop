# 02. 技术栈

> **翻译说明：** 本页是与 [英文源规格](/spec/02-architecture/02-tech-stack) 一一对应的机器辅助翻译。代码、协议字段和标识符保持原文；如翻译与英文源事实有歧义，以英文版本为准。


## 1. 栈表

| 图层 | 科技 | 基线 | 注释 |
|---|---|---|---|
| 桌面外壳 | Electron | 最新稳定版（pin 位于 impl） | 应用程序外壳 |
| 用户界面 | React 19 + TypeScript | 现代马厩 | 英语优先的 UI |
| 捆绑器 | 电子vite / Vite | 稳定 | 多入口构建 |
| 造型 | Tailwind CSS 4 | 稳定 | 效用第一 |
| 状态 | 祖斯坦 | 稳定 | 用户界面状态 |
| 主机后端 | **Rust** | 稳定的 Rust 工具链 | tools/plugins/permissions/persistence 适配器 |
| Rust 异步 | 东京 | 稳定 | 主机服务 |
| 主机 RPC | stdio JSON-RPC (NDJSON) | 冷冻（D001） | Electron 主 ↔ Rust 主机 |
| Agent 引擎 | `@earendil-works/pi-agent-core` | 0.85.0 | 代理循环 |
| 模型 API | `@earendil-works/pi-ai` | 0.85.0 | 提供商 |
| 模型目录 | `https://models.dev/api.json` | 随发版内置的快照 + 进程内刷新 | 唯一的提供商/模型元数据来源 |

> 当前引脚为 **0.85.0**。Claude Opus 5 目录元数据从 **0.82.1** 起可用
>（`claude-opus-5`，1M 上下文，适应性思维）。
| Node 运行时 | Node.js | `>= 22.19` | 圆周率要求 |
| 数据库 | SQLite | Rust host-core 通过 `rusqlite` | sessions/settings |
| 包装 | 电子制造商 | 稳定 | macOS arm64、Intel x64、Windows x64 和 Linux x64 释放通道 |
| 包管理器 | PNPM | 11.18.x | JS 单一仓库 |
| Lint/test | 样式令牌检查器（`scripts/check-style-tokens.mjs`）+ vitest + 货物测试；一般 JS linter 仍然打开（biome vs oxlint） | 稳定 | 双堆栈质量 |
| 架构 (TS) | 打字机 | 冷冻（D011） | 共享合约 |
| 国际化 | i18next + 反应-i18next | 冷冻 (D012) | 英语源语言环境 |

## 2. 工程中的语言政策

- 产品字符串：英文源
- Specs/ADRs：英语初级
- 代码标识符：英文
- Commits/issues/PRs：英语优先

## 3. 为什么选择 Rust 主机核心

- 更强大的沙箱基础
- 更好的 process/fs 控制
- 长期的本机性能和安全性
- UI 和模型运行时的更清晰的权限分离

## 4. 为什么将 pi 保留在 Node/TS 中

- 成熟的多提供商支持
- 现有代理事件模型
- skills/extensions 生态系统杠杆
- 避免重写代理框架

## 5. 依赖边界

### 允许
- 官方 pi 包
- 主流Electron/React生态系统
- Rust fs/process/sqlite/rpc/serde 的箱子

### 小心
- 重型本机节点插件
- 多个竞争的 RPC 框架
- 大型编辑器堆栈太早（摩纳哥）

### 不在 MVP 中
- 远程网关框架
- 市场后端
- 自定义 LLM 提供商 SDK 替换 pi-ai

### 生产包装边界

- 仅渲染器库是 development/build 依赖项，因为 Vite
  将其运行时代码和惰性资产捆绑到 `out/renderer` 中。
- Electron 主要捆绑纯 JS 工作区包。需要的包
  运行时模块解析或本机 ABI 仍然是生产依赖项；
  当前外部设置仅包括 `electron-updater`。
- `Resources/agent-runtime/sidecar.js`是唯一独立的pi sidecar
  捆绑。完整的 `@pi-desktop/agent-runtime` 包树不能是
  复制到 ASAR 作为第二个运行时。
- 桌面包不再包含交互式 PTY 依赖；Agent Bash 仍是由 agent sidecar
  所有的非交互式运行时能力。
- 依赖源映射、测试、示例和声明是构建输入，
  不释放资产。许可证和通知文件仍然可分发。
- Mermaid、KaTeX 和 Shiki 等惰性渲染器功能仍保留在本地
资产;包大小优化不得引入运行时 CDN 获取。

## 6. 构建矩阵 (MVP)

- JS 工作区构建 (`pnpm`)
- Rust 主机构建 (`cargo`)
- 集成烟雾（`pnpm dev`启动所有层）
