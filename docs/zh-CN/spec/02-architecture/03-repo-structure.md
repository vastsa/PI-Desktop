# 03. 仓库结构

> **翻译说明：** 本页是与 [英文源规格](/spec/02-architecture/03-repo-structure) 一一对应的机器辅助翻译。代码、协议字段和标识符保持原文；如翻译与英文源事实有歧义，以英文版本为准。


## 1. 工作区布局

一个仓库里有两个工作区：pnpm 管理全部 JavaScript 包（`apps/*`、`packages/*`、`docs`），Cargo 管理 Rust crate。根目录 `package.json` 的脚本同时驱动两者。

```text
PI-Desktop/
├── apps/
│ └── desktop/                # Electron 产品外壳
│   ├── electron/
│   │ ├── main/               # 主进程，每个关注点一个模块
│   │ ├── preload/            # 渲染器与插件面板的 preload
│   │ └── shared/             # main 与 preload 共用的代码
│   ├── src/                  # React 渲染器
│   │ ├── components/         # UI；含 settings/、workpanel/、plugins/、extensions/
│   │ ├── hooks/              # React hooks
│   │ ├── lib/                # 与框架无关的渲染器逻辑和 IPC 客户端
│   │ ├── pages/              # 路由目的页
│   │ ├── stores/             # zustand 应用 store
│   │ ├── styles/             # 按界面拆分的 CSS；tokens.css 是设计系统
│   │ └── assets/             # 字体与品牌素材
│   ├── test/                 # node --test 套件（*.test.mjs）与 helpers/
│   ├── resources/            # 打包 extraResources：skills/、plugins/、models.dev/
│   ├── build/                # electron-builder 用的图标与 macOS entitlements
│   ├── index.html
│   ├── electron.vite.config.ts
│   └── package.json          # 同时承载 electron-builder 配置
├── crates/
│ └── host-core/              # Rust 特权宿主（二进制 pi-desktop-host-core）
│   ├── Cargo.toml
│   └── src/                  # rpc/、tools/，其余每个领域一个模块
├── packages/
│ ├── shared/                 # IPC/协议契约、错误码、更新日志
│ ├── i18n/                   # en 与 zh-CN 目录及 locale 辅助函数
│ ├── agent-runtime/          # pi sidecar 与运行时包装（打包进应用）
│ ├── plugin-sdk/             # 插件作者类型与校验器
│ └── plugin-devkit/          # pi-plugin CLI：scaffold、check、pack、publish
├── examples/
│ ├── plugins/                # hello 与 roundtable 示例插件
│ └── fixtures/sample-project # E2E 场景使用的工作区 fixture
├── docs/                     # VitePress 站点与英文源事实
│ ├── spec/                   # 编号的规格领域（见 spec/README.md）
│ ├── adr/                    # 架构决策记录
│ ├── project/                # 看板、审计、实施计划
│ ├── guide/                  # 面向用户的快速指南
│ ├── zh-CN/                  # spec/ 与 guide/ 的逐路径中文镜像
│ ├── image/                  # 仓库 README 内嵌的图片
│ ├── public/                 # 文档站提供的静态资源
│ ├── scripts/                # 仅文档使用的检查（check-locales.mjs）
│ └── .vitepress/             # 站点配置与主题
├── scripts/                  # 仓库自动化（见 scripts/README.md）
├── .github/                  # CI 与发布工作流、issue 模板
├── AGENTS.md                 # AI 编码代理的强制规则
├── package.json              # 根脚本、pnpm 工作区
├── pnpm-workspace.yaml
├── Cargo.toml                # Rust 工作区
└── README.md · README.zh-CN.md
```

## 2. 包职责

### `apps/desktop`
产品入口：
- Electron 生命周期、窗口、托盘、应用菜单
- 渲染器与主进程之间的 IPC 面
- host-core 与 sidecar 进程监管
- 插件运行时、面板与视图
- 打包配置

### `crates/host-core`
Rust 宿主服务：
- 工具执行
- 权限网关
- 插件宿主服务
- 持久化（SQLite、转录、工件、密钥）
- 审计日志

### `packages/agent-runtime`
Node 对 pi 的包装：
- 模型引导
- 代理回合控制
- 事件标准化
- 宿主工具桥客户端

### `packages/shared`
跨边界契约：
- IPC 通道名称
- DTO 类型
- 错误码
- 协议版本
- 应用内展示的更新日志条目

### `packages/i18n`
- 英文源目录与 zh-CN 目录
- locale 解析辅助函数
- 消息 ID 约定

### `packages/plugin-sdk`
- 清单类型
- 宿主 API 类型
- 校验器

### `packages/plugin-devkit`
- 插件作者与市场发布流程使用的 `pi-plugin` CLI
- 模板脚手架、清单检查、打包、发布

## 3. 运行时数据（不在 git 中）

`PI_DESKTOP_DATA_DIR` 可覆盖默认位置。

```text
~/.pi-desktop/
 ├── pi.sqlite               # single DB, host-core owned (03-runtime/04, D086)
 ├── sessions/               # per-session transcript files (D119)
 ├── artifacts/              # plan and goal checkpoint artifacts
 ├── attachments/            # content-addressed prompt attachment blobs (main)
 ├── scratch/<sessionId>/    # session-scoped temporary files
 ├── secrets/
 ├── logs/
 │    ├── app/<category>.log
 │    ├── host/<category>.log
 │    └── agent/<category>.log
 ├── cache/
 ├── plugins/
 │    ├── installed/
 │    ├── data/
 │    ├── logs/
 │    ├── cache/
 │    ├── market/             # catalog and downloaded packages
 │    └── registry.json
 ├── window-state.json       # last main-window bounds (main)
 └── close-behavior.json     # persisted close-to-tray choice (main)
```

## 4. 命名约定

| 对象 | 约定 |
|---|---|
| JS 包 | `@pi-desktop/*` |
| Rust crate | `pi-desktop-host-core`（或 `host-core`） |
| IPC 通道 | `pi-desktop/<domain>/<action>` |
| i18n 键 | `domain.section.key` |
| 插件 ID | 反向域名风格 |
| 主进程模块 | `electron/main/` 下每个关注点一个文件；`index.ts` 负责接线 |
| 渲染器测试 | `apps/desktop/test/<subject>.test.mjs`，不放在源码旁 |
