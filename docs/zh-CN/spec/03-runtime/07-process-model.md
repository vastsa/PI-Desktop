# 07. 进程模型

> **翻译说明：** 本页是与 [英文源规格](/spec/03-runtime/07-process-model) 一一对应的机器辅助翻译。代码、协议字段和标识符保持原文；如翻译与英文源事实有歧义，以英文版本为准。


## 1. 流程

MVP 目标拓扑：

```text
PI-Desktop.app
├── Electron Main
│   ├── Renderer (React UI)
│   ├── Rust host-core sidecar
│   └── Node pi agent sidecar
```

## 2. 所有权

| 工艺流程 | 拥有 |
|---|---|
| Electron 主要 | 窗口生命周期、跨平台托盘集成、IPC fan-in/out、子进程监控、固定源应用程序更新生命周期 |
| Renderer | 仅用户界面 |
| Rust host-core | DB、工具、权限、不可变 Plan/Goal artifacts/Electron 执行字段、shell 目录、插件主机服务、机密适配器 |
| Node pi sidecar | pi 代理循环、提供商流、工具调用规划 |

## 3. 启动顺序

启动从单实例锁开始。一个数据目录只允许一个应用进程：host-core 独占
`pi.sqlite`（D002），Electron 主进程拥有其旁边的持久化 outbox 和日志树，托盘、
全局启动器快捷键和更新器也都是运行中桌面应用的单例。没有拿到锁的启动会在创建
窗口、托盘、日志行或子进程之前退出；持有锁的实例通过 `second-instance` 恢复并
聚焦自己的主窗口，若窗口已关闭或隐藏到托盘则重新创建，与托盘的“显示”操作完全
一致。该锁是 Electron 的锁，作用域是 `userData`（由应用名派生，因此应用名在请求
之前设置），而不是数据目录：指向自有 `PI_DESKTOP_DATA_DIR` 的运行（E2E 测试装置、
截图装置、并行 profile）与默认安装不共享数据库、outbox 或日志，在已有实例运行时
仍可启动（D236、ADR 0094）。

1. Electron 主启动
2. 加载英文语言环境默认值
3. 生成 Rust host-core
4. `app.handshake` 与 host-core
5. 生成 Node pi 代理 sidecar
6. 通过 main 将代理 sidecar 工具桥连接到 host-core
7. 创建主窗口/渲染器
8. Renderer 通过 main 执行 `app/getVersion` 健康检查

如果步骤 3-4 失败：使用恢复消息阻止应用程序。在成功主持之前
引导服务 RPC、host-core 以事务方式标记先前的待批准批准
queued/running `plan_approvals` 执行状态已中断并中止它们
跑步轮流。此内部进程纪元栅栏未序列化或发送
协议。

## 4. 崩溃策略

| 崩溃 | 政策 |
|---|---|
| Renderer 崩溃 | 重新加载窗口，保留 host/agent 进程；同一主机重新加载仅恢复实时待处理的 Plan/Goal 批准及其截止日期，而不是终端卡 |
| Rust 主机崩溃 | 将应用程序标记为降级、中断 pending/queued/running 审批工作、将待处理会话保留在其合同模式（Plan 或 Goal）中并将已批准的会话保留在 Agent 中、尝试重新启动主机并关闭活动会话失败 |
| Node 代理崩溃 | 中止活动轮次和实时批准 waiters/queue 条目，在合同模式下保留待处理会话，在 Rust 中保留已批准的 Agent 模式，重新启动 sidecar，并且从不重播执行 |
| Electron 主要崩溃 | 完整的应用程序退出 |

断开的 stdout/stderr（`EPIPE`/`EIO`）不是主进程崩溃。Main 会忽略这些写入，
因此 Linux AppImage 或没有活动 TTY 的 GUI 启动会继续监管 host/sidecar，而不是
弹出 Electron 的未捕获异常对话框。

Linux 打包的 host-core 在 Ubuntu 22.04 上构建，需要 glibc 2.35 或更高版本
（Ubuntu 22.04、Debian 12、Fedora 36+）。更低的 glibc 是致命 host 状态，而不是
重启循环：界面会列出这些发行版，而不是只显示“无法连接本地服务”。Linux 标签
作业不得换用会抬高所需 glibc 的更新 runner。

另有两种启动结果会被明确命名，而不是笼统地当作服务不可用（D380）：

- **降级安装。** 当数据目录的 SQLite schema 比当前构建支持的更新时，host-core
  会拒绝打开（stderr 输出 `database schema version N is newer than supported
  M`）。Electron 从退出前的最后一段 stderr 解析该行，首次失败即停止重启循环，
  并推送 `message: "DB_SCHEMA_TOO_NEW"` 且带有两个版本号的 `hostStatus`。横幅
  提示用户安装上次打开这些数据的更新版 PI-Desktop。不会向下迁移数据。
- **非原生构建。** 启动时 Electron 比较 `process.arch` 与实际 CPU（macOS 通过
  `sysctl.proc_translated` 判断，仅在 Rosetta 2 下为 `1`；其他平台用
  `os.machine()`）。不匹配时即使启动成功，也会随启动 `hostStatus` 附带
  `archMismatch`，渲染层显示可关闭的提示，说明当前构建（macOS 上为 Intel /
  Apple Silicon）并指向对应下载。arm64 构建在 Intel Mac 上根本无法启动，因此
  只能检测 Intel 构建跑在 Apple Silicon 上这一方向。

Windows 安装包目标为 x64。Windows host-core 使用
`x86_64-pc-windows-msvc` 目标和 `target-feature=+crt-static` 构建，因此 NSIS
安装包无需在启动本地服务前单独安装 Visual C++ Redistributable。Windows 11 ARM64
系统通过操作系统的 x64 模拟运行该 x64 安装包；目前不发布原生 Windows ARM64
工件。

监管参数（在Electron main中实现）：

- 子进程退出立即拒绝该子进程的所有正在进行的 RPC（无 130 秒超时等待）。
- 超过 64 MiB 的 NDJSON 请求行以 `LIMIT_EXCEEDED` 应答，不结束 stdin 读取器（ADR 0216）。Electron 在写入 stdin 前拒绝同样大小的载荷（ADR 0217）。
- Windows Alt+Space 钩子只保留 stdout 发送端的弱引用。stdin EOF 后 serve 丢弃最后一个强引用，host-core 退出；泄漏的发送端不能把关闭卡住超过 5 秒（ADR 0217）。
- 使用指数退避 `0.5s → 1s → 2s` 自动重启（上限 4 秒）。
- 每个孩子最多**每 2 分钟窗口** 3 次重新启动；除此之外，该应用程序
  保持降级并发出 `hostStatus { ok: false, component, fatal: true }`。
- 重新启动监督仅限于每个儿童的单次航班。宿主进程具有独特的
  一代；过时的生成请求和通知之前被拒绝
  他们到达了现在的桥。
- 主机持久性追加缓冲在 Electron 主拥有的发件箱中，同时
  主机不可用，并在新的握手后顺序刷新。
- 主机核心的 stdin/stdout 控制路径每个使用一个专用操作系统线程
  方向而不是 Tokio 的动态阻塞池。瞬态管道资源
  重试错误；控制线程创建失败在启动时出现
  错误，因此操作系统线程压力不会成为未处理的主机恐慌。的
  login-shell PATH 探测是尽最大努力，如果满足以下条件，则回退到继承的 PATH
  无法创建其辅助线程。
- 每次转换时都会通过 `hostStatus` 事件通知 Renderer：
  `{ ok, component?: "host" | "sidecar", restarting?, restarted?, fatal?, message? }`。
- 每一次仅报告已消失的运输的拒绝 - 在它被拒绝之前被拒绝
  已发送，或在运输关闭时在飞行中 — 携带
  `errorCode: HOST_UNAVAILABLE`，因此调用者通过代码对例程拆卸进行分类
  而不是通过匹配消息文本。
- 读取主机拥有的注册表，仅将可选上下文添加到启动或
  面板（MCP 服务器、用户技能、用户子代理）检查传输可用性
  首先，悄悄地丢弃 `HOST_UNAVAILABLE` 拒绝，降格为空。一个
  关机期间或重新启动之间的死传输是例行公事；将其记录在
  `warn` 将其文件与真正无法被删除的注册表位于同一行下
  阅读。
- 由主机拥有的注册表支持的渲染器面板重新加载
`hostStatus { ok: true }`，因此因拆解或失败而输掉比赛的调用
  重新启动不会使面板显示注册表的传输错误
  很好。
- 有意关闭 (quit/dispose) 永远不会触发重新启动。

## 5. 关机命令

1.拒绝新的提示
2. 刷写进行中回复检查点，然后通过 sidecar 中止活动回合，并在 host-core 仍存活时
   有界等待（总计 2 秒）其中止最终行经由持久化发件箱落盘（D299）。
   空闲退出仍等待 outbox。下一次握手在渲染器能够 `session.get` 之前等待残留排空（D327）。
3. 中断 pending/queued/running Plan 和 Goal 工作并拒绝迟到的响应
4.卸载插件
5. 停止 Node 代理 sidecar
6. Flush/close Rust 主机数据库
7. 停止 Rust 主机
8. 处理更新轮询
9. 关闭窗口/退出

用尽预算的退出会记录 `quit before streaming replies settled` 并继续；下一次主机
启动会提升残留的检查点。sidecar 意外退出立即走同一条恢复路径：刷写每个运行中会话
的最后一个检查点，并要求 `session.endTurn` 执行 `recoverInflight`，这样已流式的
文本成为该回合的 `aborted` 行，而不是随进程一起消失。

最小化主窗口是驻留 shell 操作，而不是应用程序
shutdown: Electron Main 隐藏窗口并使进程保持活动状态
跨平台托盘。托盘拥有 restore/focus 和显式退出
行动。从托盘、现有关闭路径或更新安装中退出
进入上面的正常关机顺序；破坏托盘发生在
`before-quit` 因此关闭不能被过时的 shell 功能拦截。

`updates/install` 仅在更新后调用 Electron 的退出并安装路径
达到 `downloaded`。 Electron 仍然发出 `before-quit`，所以正常
sidecar/host 关闭序列在更新程序替换应用程序之前运行。

## 6. 开发与发布

### 开发
- Electron 通过 electronics-vite
- Rust 通过 `cargo run` 二进制路径
- Node 通过系统 Node (`>= 22.19`)
- `desktop` `predev` 按拓扑顺序重建每个工作区依赖关系
  （`shared`、`i18n`、`plugin-sdk` 和 `agent-runtime`）在 host-core 之前和
  Electron 启动； Electron 绝不能编译或忽略加载过时的内容
  来自早期源版本的软件包工件
- Electron 43+ 不再在 `pnpm install` 期间安装其二进制文件；
  `scripts/dev-electron.mjs` 通过 `electron` 包入口解析开发主机，
  该入口在首次开发启动时按需下载并解压二进制文件

### 发布
- Electron 应用程序包
- 在资源中发送 Rust 主机二进制文件 (`Resources/bin/pi-desktop-host-core`)
- 代理 sidecar 在 Electron 上运行捆绑的 `agent-runtime/sidecar.js`
  二进制文件本身与 `ELECTRON_RUN_AS_NODE=1` — 没有单独的 Node 运行时
  已发货（解决 **D008**）
- `Resources/agent-runtime/sidecar.js` 是 sidecar 唯一独立的
  释放条目。 ASAR 不携带第二个完整的
  `@pi-desktop/agent-runtime` 包树； Electron 主要可能内联
  它调用的纯 JS 助手无需更改进程或协议所有权
- 渲染器依赖项通过 Vite 输出传送，而不是重复原始数据
  包树；桌面包不再携带交互式 PTY 原生模块
- 打包版本使用 Main 拥有的更新控制器。 macOS、非 AppImage
  Linux 和 Windows 便携版运行为手动交付模式； Windows NSIS 和
  Linux AppImage 使用 D126 标签发布的应用内提要

## 7. 远程目标拓扑（MVP 后）

远程控制不会给 Rust host-core 或当前 renderer IPC 表面增加公共监听器。目标 Agent
Host 是无头模块（`packages/agent-host`），拥有会话与回合准入、回合队列、审批代理和
事件日志，与 Node pi sidecar、Rust host-core 一起受监督，其上是已认证的 RACP 服务
（D374）。首个远程部署（D375）把该模块作为无头 `pi-host` 运行在远端机器上，只绑定
loopback，桌面经 SSH 端口转发连接。未排期的 Gateway 拓扑会增加出站 Host link；
Gateway 负责路由已认证客户，但不拥有工作区状态。

详细拓扑、所有权和迁移边界见
[`02-architecture/05-remote-agent-control.md`](/zh-CN/spec/02-architecture/05-remote-agent-control)。
在 MVP 后的实现里程碑明确修订本节之前，当前四进程本地拓扑和关闭顺序保持不变。

## 8. 验收

1.干净启动路径记录并可编写脚本
2. 主机崩溃不会默默地继续工具执行
3. Agent 崩溃不会损坏 SQLite
4. 主机崩溃不会造成持久性错误风暴或重播已完成的任务
   留言两次。
5. Host/sidecar 崩溃永远不会将待处理的 Plan 或 Goal 批准转变为 Agent
   执行；
   重新启动恢复会使其中断，并且持久会话会保留在其状态中
   合约模式
6. 已批准的 queued/running 执行被中断，无需
   重播及其持久会话仍然是 Agent
7. Bash timeout/abort 关闭完整的子进程树
