<div align="center">

<img src="docs/image/readme/logo.png" alt="PI-Desktop logo" width="120" />

# PI-Desktop

**本地优先的 AI 编程智能体桌面应用。**

自带模型，代码、密钥与会话全部留在你自己的电脑上。

[![Release](https://img.shields.io/github/v/release/vastsa/PI-Desktop?include_prereleases&label=release)](https://github.com/vastsa/PI-Desktop/releases/latest)
[![CI](https://github.com/vastsa/PI-Desktop/actions/workflows/ci.yml/badge.svg)](https://github.com/vastsa/PI-Desktop/actions/workflows/ci.yml)
![Platforms](https://img.shields.io/badge/platform-macOS%20%C2%B7%20Windows%20%C2%B7%20Linux-4c8dd8)

[下载](#下载) · [快速上手](#快速上手) · [功能亮点](#功能亮点) · [界面截图](docs/zh-CN/guide/screenshots.md) · [工作原理](#工作原理) · [参与开发](#参与开发) · [English](README.md)

<br/>

<img src="docs/image/readme/hero.png" alt="PI-Desktop 工作台与智能体协作" width="88%" />

</div>

## PI-Desktop 是什么？

PI-Desktop 把 AI 编程智能体装进原生桌面应用：打开一个项目，说出你想做的事——探索并理解代码、构建新功能、审查代码、修复问题——然后看着它干活。每一次文件修改、每一条 shell 命令都会摆到你面前，由你批准。

不需要注册账号，没有订阅，中间也没有任何云服务：接上你已经在用的模型服务商即可，其余的一切——会话、设置、API 密钥——都保存在本地。

## 功能亮点

- **任意模型，自带密钥。** Anthropic、OpenAI，或任何兼容 OpenAI API 的服务——托管中转站可以，Ollama、LM Studio 这类本地网关也可以。模型 ID 自由填写（没有硬编码白名单），并支持按模型配置上下文窗口、输出上限、温度和推理强度。同一个服务商可配置多个模型并在输入区直接切换，也可以用 OAuth 登录厂商账号，并为同一厂商保留多个账号。
- **智能体、规划与目标三种模式。** 智能体模式可以读写文件、执行命令，把事情做完；规划模式让同一个智能体检查项目并提交不可变实施检查点供你审批；目标模式让智能体先确认目标与验收标准，批准后自主推进直到完成或遇到边界。
- **每一次改动都由你批准。** 文件写入和 shell 命令先询问再执行，支持会话级授权和可配置的默认策略；超时未回应一律拒绝。
- **后台子智能体。** 可拆分的工作——大范围检索、多文件实现、对抗式审查——可以交给内置或自定义子智能体，它们在自己的上下文中运行并回报结果，可按模型委派，并受并发上限约束。
- **智能体之间协作。** 通过本地 Agent2Agent（A2A）协议协调并发子智能体：以 Agent Card 发现运行中的同伴，交换可持久化的任务与类型化消息，并实时接收任务更新。
- **真正的工作台。** 在应用内部的侧边工作面板中查看消息级 diff、谨慎回滚改动、在对话中查看命令输出、用浏览器预览、浏览项目文件，也包括插件贡献的面板视图；面板展开时会占用内部空间并让对话区回流。
- **项目与会话。** 侧边栏按项目组织会话，支持多项目、置顶、归档、排序、分支、通知、历史分页，还有用完即弃、拥有独立临时工作区的临时会话。
- **本地优先，注重隐私。** 会话记录以 JSONL 纯文本存盘并配 SQLite 索引，随时备份、检索或删除；API 密钥存入系统钥匙串；日志只留在本地，没有任何遥测上报。
- **不止插件的智能体能力。** 在“设置 → 智能体”下管理独立 MCP、Skills 与全局 Subagents，并为 Skills 和 MCP 设置项目级覆盖；“扩展”页面只保留已安装插件和市场。插件可添加命令、面板、工作面板视图、智能体工具、技能、主题、MCP、常驻服务和消息总线。`.piplug` 包、本地加载和官方插件市场目前都可用。
- **适合日常工作的快捷流程。** 支持斜杠命令、`@` 文件引用、将剪贴板文件保存到会话临时目录、在当前回合未结束时排队下一条提示、一键优化提示词、Option/Alt+Space 全局搜索，以及手动或周期性任务提示。
- **运行更稳。** 瞬时故障与限流会按有限退避自动重试，被中断的回答可以继续而不用重头开始。
- **用得舒服。** 简体中文与 English 双语界面，浅色/深色/跟随系统及插件主题，全局搜索与命令入口，可选的界面字体（随包内置 OFL 字体），托盘与关窗行为选项，新手引导清单，本地通知，上下文检查点，以及打包版本的应用内更新日志与更新提示。

插件 API 和面板受权限控制并运行在独立进程中，但插件代码仍属于用户信任代码，并非完整的操作系统沙箱；请先检查权限，只安装可信插件。

<table>
  <tr>
    <td width="50%"><img src="docs/image/readme/conversation.zh.webp" alt="右侧带缩略导航条的对话" /></td>
    <td width="50%"><img src="docs/image/readme/marketplace.zh.webp" alt="可安装插件的插件市场" /></td>
  </tr>
  <tr>
    <td align="center"><sub>一条对话承载每一回合，长会话可用右侧缩略导航条定位</sub></td>
    <td align="center"><sub>从官方目录、镜像或你自己配置的地址安装插件</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/image/readme/models.zh.webp" alt="顶栏的模型菜单" /></td>
    <td width="50%"><img src="docs/image/readme/basics.zh.webp" alt="基础设置 — 语言、主题与外观" /></td>
  </tr>
  <tr>
    <td align="center"><sub>按会话切换模型 — 任何已配置的提供方，密钥存在系统钥匙串里</sub></td>
    <td align="center"><sub>语言、主题与外观，包括插件贡献的主题</sub></td>
  </tr>
</table>

<p align="center"><sub><a href="docs/zh-CN/guide/screenshots.md">查看全部界面 →</a></sub></p>

## 下载

前往 [Releases 页面](https://github.com/vastsa/PI-Desktop/releases/latest)获取最新版本。

| 平台 | 安装包 | 状态 |
|---|---|---|
| macOS（Apple Silicon） | `.dmg` / `.zip` | ✅ 随版本发布 |
| macOS（Intel） | `.dmg` / `.zip` | ✅ 随版本发布 |
| Windows（x64） | NSIS 安装程序 | ✅ 随版本发布，支持应用内更新 |
| Linux（x64） | `.AppImage` / `.deb` | ✅ 随版本发布，AppImage 支持应用内更新 |

> **macOS 提示：** 当前构建尚未签名与公证。如果 macOS 拒绝打开应用，请右键点击应用选择**打开**，或清除隔离标记：
>
> ```bash
> xattr -cr /Applications/PI-Desktop.app
> ```

打包版本会检查 GitHub Releases 上的新版本，并在应用内显示更新横幅。

## 快速上手

1. **添加模型提供方。** 打开 **设置 → 模型配置 → 添加服务**：选择 API 风格，填入接口地址和 API 密钥，再选择或输入模型 ID。密钥会存入系统钥匙串，保存后不再显示。
2. **打开项目。** 在侧边栏添加项目文件夹——会话、工具与权限都以项目为边界。
3. **描述任务。** 想直接实施就用智能体模式；希望先检查项目并审批实施方案时切换到规划模式；想审批目标和验收标准再让智能体自主决策时使用目标模式。批准后的工作可在**审阅**面板里核对 diff，再决定是否提交。
4. **按需扩展。** 打开 **设置 → 智能体** 管理 Skills、MCP 和全局 Subagents；打开“扩展”管理已安装插件和市场；在 **设置 → 导入** 中导入 Claude Code、OpenCode、Codex 或 Pi 的本机会话。

## 工作原理

PI-Desktop 保持渲染进程权限最小化，并把智能体循环与桌面 UI 分开：

- **Electron 外壳** — 沙箱化的 React 渲染进程，以及负责面板、浏览器预览、更新和进程监管等桌面服务的主进程 / preload 桥。
- **Rust 宿主核心** — 通过 stdio JSON-RPC 独占管理 SQLite、会话存储、密钥、权限与工作区访问。
- **pi 智能体 sidecar** — 独立 Node 进程，运行 pi 引擎（`pi-ai` + `pi-agent-core`），承载真正的智能体循环。

完整设计见[架构规格](docs/zh-CN/spec/02-architecture/01-architecture.md)。

## 状态与路线图

PI-Desktop 处于活跃开发中的早期预览阶段。当前 0.13.x 已交付：应用外壳、流式智能体运行时、智能体/规划/目标合约、带权限系统的工作区工具、工作台、项目与会话、会话导入、智能体能力管理（MCP/Skills/Subagents）、支持本地 Agent2Agent（A2A）协作的后台子智能体委派、基于自动发现与 models.dev 模型目录的服务商配置、单服务商多模型与 OAuth 账号、扩展（插件）与插件市场、上下文检查点、通知、应用内更新日志，以及带更新分发的跨平台打包。

仍在推进：macOS 签名与公证（受 Apple 开发者凭据阻塞，签名流水线本身已脚本化）、Windows/Linux 安装升级与回滚资格验证、更强的插件沙箱与发布者签名机制，以及完整的 UI 驱动 E2E 覆盖。详见[里程碑](docs/zh-CN/spec/06-delivery/01-mvp-milestones.md)与[项目看板](docs/project/BOARD.md)。

## 参与开发

环境要求：Node.js `>=22.19`（CI 与发布构建使用 Node 24，与 Electron 内置的 Node 对齐）、pnpm `>=10`（仓库锁定 pnpm 11），以及 stable Rust 工具链。

```bash
# 构建 Rust 宿主核心
cargo build -p host-core

# 安装 JS 依赖并构建 packages + 应用
pnpm install
pnpm build:js

# 开发模式
pnpm dev

# 协议级 e2e 冒烟测试
PI_DESKTOP_TEST_API_KEY=... pnpm test:e2e

# 规划模式宿主验收（包含真实的 60 秒默认超时）
PI_DESKTOP_E2E_LONG_TIMEOUT=1 pnpm test:e2e:plan

# 通过 Electron CDP 验收英文与简体中文规划界面
pnpm test:e2e:plan-ui

# 桌面专项探针
pnpm test:e2e:boot
pnpm test:e2e:supervision
pnpm test:e2e:subagents

# CI 运行的检查
pnpm typecheck
pnpm lint
pnpm test            # JS 单元测试 + cargo test -p host-core

# 文档站点（VitePress）
pnpm docs:dev
pnpm docs:check      # 中英文规格对齐检查
```

CI 会为涉及代码的 PR 和推送到 `main` 的提交运行 JS 构建 / 类型检查 / lint / 单元测试及 `cargo test`；纯文档改动会跳过。

发布通过打 tag 完成。提升稳定版本号意味着先更新所有带版本号的位置——双语应用内更新日志、对应的测试清单，以及两个 README 中声明的版本线。`scripts/release.mjs` 会执行该检查，任一处不一致就拒绝打 tag：

```bash
pnpm check:release-docs                    # 校验当前工作树是否一致
node scripts/release.mjs 0.11.2 --tag      # 升版本 + 提交 + 打 v0.11.2 标签
git push origin <branch> v0.11.2           # Release 工作流自动构建并发布
```

完整门禁见[发布操作手册](docs/zh-CN/spec/06-delivery/06-release-runbook.md#4-1-强制发布版本面门禁-d164-d260)。

### 文档

- [插件开发：从零到一](docs/zh-CN/plugin-development.md)
- [界面截图](docs/zh-CN/guide/screenshots.md) — 每个界面，全部取自运行中的应用
- [规格索引](docs/zh-CN/spec/README.md) — 从这里开始
- [产品范围](docs/zh-CN/spec/01-product/01-product-scope.md)
- [基线决策](docs/zh-CN/spec/00-baseline.md)
- [架构](docs/zh-CN/spec/02-architecture/01-architecture.md)
- [UI 信息架构](docs/zh-CN/spec/04-ux/01-ui-ia.md)
- [E2E 测试计划](docs/zh-CN/spec/06-delivery/04-e2e-test-plan.md)
- [发布操作手册](docs/zh-CN/spec/06-delivery/06-release-runbook.md)
- [插件系统](docs/zh-CN/spec/07-plugins/01-plugin-system.md)
- [ADR](docs/zh-CN/adr/) · [里程碑](docs/zh-CN/spec/06-delivery/01-mvp-milestones.md) · [智能体指南](AGENTS.md)

## 开源项目致谢

PI-Desktop 的构建和设计参考了以下开源项目：

- **智能体运行时：** [pi-mono](https://github.com/badlogic/pi-mono)。其中的
  `pi-ai` 和 `pi-agent-core` 提供了智能体循环与模型供应商抽象。
- **桌面与界面基础：** [Electron](https://github.com/electron/electron)、
  [React](https://github.com/facebook/react)、
  [Vite](https://github.com/vitejs/vite)、
  [Tailwind CSS](https://github.com/tailwindlabs/tailwindcss)、
  [Lucide](https://github.com/lucide-icons/lucide)、
  [Shiki](https://github.com/shikijs/shiki)、
  [Mermaid](https://github.com/mermaid-js/mermaid)、
  [KaTeX](https://github.com/KaTeX/KaTeX)、
  [TypeBox](https://github.com/sinclairzx81/typebox) 和
  [i18next](https://github.com/i18next/i18next)。
- **行为与视觉参考：** [OpenAI Codex](https://github.com/openai/codex) 为
  部分外壳和上下文管理交互提供参考。[OpenCode DCP](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning)
  曾作为上下文压缩的行为参考；它不是 PI-Desktop 的依赖，项目也没有复制
  其中的代码。
- **随应用打包的字体：** [Geist](https://github.com/vercel/geist-font)、
  [Inter](https://github.com/rsms/inter)、
  [Noto Sans SC](https://github.com/google/fonts)（Source Han Sans 系列）和
  [LXGW WenKai](https://github.com/lxgw/LxgwWenKai)，后者包含
  [Klee](https://github.com/fontworks-fonts/Klee) 项目的工作。它们的 SIL
  Open Font License 文本位于
  [`apps/desktop/src/assets/fonts/licenses/`](apps/desktop/src/assets/fonts/licenses/)。

## 模型致谢

这个项目是由下面这些模型共同创造的——没有唯一的天才，只有一支由 token 驱动的施工队。

| 厂商 | 模型 | Token 总量 |
| --- | --- | ---: |
| OpenAI | `gpt-5.6-sol` | 4,799,525,785 |
| OpenAI | `gpt-5.4` | 4,213,269,324 |
| OpenAI | `gpt-5.6-luna` | 3,980,161,792 |
| Anthropic | `claude-opus-5` | 3,909,952,653 |
| OpenAI | `gpt-5.5` | 3,800,382,171 |
| xAI | `grok-4.5` | 1,947,736,115 |
| DeepSeek | `deepseek-v4-flash` | 329,790,234 |
| OpenAI | `gpt-5.2-codex` | 320,983,170 |
| OpenAI | `gpt-5.6-terra` | 274,107,085 |
| OpenAI | `gpt-5.3-codex` | 255,366,945 |
| Xiaomi | `mimo-v2.5-pro` | 234,295,998 |
| OpenAI | `gpt-5.1-codex-max` | 220,947,212 |
| OpenAI | `gpt-5.1` | 142,533,699 |
| — | `Unknown model` | 69,801,632 |
| Anthropic | `claude-opus-4.6` | 55,223,768 |
| 智谱 | `stealth/ox-alpha` | 22,954,876 |
| OpenAI | `gpt-5.1-codex-mini` | 12,895,478 |
| Xiaomi | `mimo-v2.5-pro-think` | 11,246,210 |
| 小红书 | `dots-3-note-prev` | 10,166,895 |
| OpenAI | `gpt-5.1-codex` | 3,916,509 |
| Xiaomi | `mimo-v2.5` | 3,785,071 |
| xAI | `grok-4.6` | 3,366,971 |

**所列模型合计：** 24,622,409,593 tokens。
## 社区友链

- [Linux.Do](https://linux.do/) — 技术交流与分享社区。

## 许可证

本项目采用 [GNU Lesser General Public License v3.0 or later](LICENSE) 授权。
