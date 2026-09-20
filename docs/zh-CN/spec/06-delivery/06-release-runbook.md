# 06. 桌面发布手册

> **翻译说明：** 本页是与 [英文源规格](/spec/06-delivery/06-release-runbook) 一一对应的机器辅助翻译。代码、协议字段和标识符保持原文；如翻译与英文源事实有歧义，以英文版本为准。


> 范围：macOS arm64、Intel x64、Windows x64 和 Linux x64 的 D126/D285 标记工件；
> macOS signing/notarization 保留下面的详细资格通道。
> 交叉引用：[里程碑](/zh-CN/spec/06-delivery/01-mvp-milestones) · [进程模型](/zh-CN/spec/03-runtime/07-process-model) · [安全性](/zh-CN/spec/05-security/01-security)

## 1. 构建通道

| 通道 | 命令 | 签名 | 用途 |
|---|---|---|---|
| 开发 | `pnpm dev` | 无 | 日常开发 |
| 本地打包 | `pnpm --filter @pi-desktop/desktop pack` | 未配置证书时未签名 | 打包冒烟测试（`--dir` 输出） |
| 本地 DMG | `pnpm --filter @pi-desktop/desktop dist` | 未配置证书时未签名 | 本地安装测试 |
| 发布 | `scripts/release-macos.sh` | Developer ID + 强制公证 | 可分发产物 |

静态 electron-builder 配置不嵌入证书身份，因此没有证书的贡献者仍可在本地打包。
发布通道需要注入 Developer ID 身份（本地）或 `CSC_LINK` 证书（CI）；签名或公证验证
失败时，发布会在上传前失败。

在 macOS 上，`pnpm dev` 创建并重用带有指纹的品牌 Electron 主机
捆绑在 `.cache/electron-dev/` 下。它的包名称、可执行文件、标识符、
和 ICNS 资源是仅用于开发的 PI-Desktop 值，因此 AppKit 显示
应用程序菜单中的 PI-Desktop 并使用本机中的规范图标
关于面板。运行时还将 `build/icon_1024.png` 应用于 Dock。库存
`node_modules` 下的文件永远不会被修改。 Windows/Linux 不断发展
正常的 electro-vite 可执行文件。尽管如此，Windows Main 还是注册了
之前 NSIS 包使用的相同 `net.aiuo.pi-desktop` AppUserModelID
Electron 准备就绪，防止库存主机身份拥有本机
通知或任务栏组。 Windows 封装另外引脚
`PI-Desktop` 可执行文件和“开始”菜单快捷方式名称。启动器设置
`PI_DESKTOP_DEV=1` 因此运行时打包检查会禁用更新传送
并保留开发人员工作区默认值，尽管有品牌可执行文件名称。
Electron 43+ 上的首次 `pnpm dev` 会按需下载 Electron 二进制文件
（该包不再在 `pnpm install` 期间安装它）。
打包通道在 macOS 上通过 electron-builder 使用 `build/icon.icns`，并在
Windows 可执行文件和原生窗口图标中使用 `build/icon.ico`。渲染器通过
`BrandLogo` 导入相同的 PNG。PNG 是规范来源；`scripts/make-icon.py` 派生
多尺寸 Windows ICO、512px Windows/Linux 包 PNG，以及 iconset/ICNS（当 macOS
`iconutil` 可用时），无需覆盖规范来源。

## 2. 先决条件（发布通道）

1. Apple 开发者帐户，登录钥匙串中具有 **Developer ID Application** 证书。正式证书为 `Developer ID Application: XingYu Liu (DUV63RKYTW)`（Team ID `DUV63RKYTW`）。
2. 本地签名通道的环境变量：
   - `MAC_SIGNING_IDENTITY` — 裸通用名 `XingYu Liu (DUV63RKYTW)`；electron-builder 拒绝保留 `Developer ID Application:` 前缀的名称，脚本会自动去掉该前缀
   - `APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID` — 公证所必需（`APPLE_TEAM_ID` 必须为 `DUV63RKYTW`）
3. 安装 Rust 工具链和 pnpm 工作区。Rust 必须在 macOS 本机运行器上运行：
   Apple Silicon 使用 arm64，Intel 使用 x86_64。

## 3. 构建内容

- Electron 应用程序具有强化的运行时 + 权利
  (`build/entitlements.mac.plist`: JIT + 无符号可执行内存 +
  库验证禁用 — 标准 Electron 设置），并在 Info.plist 中通过
  `apps/desktop/package.json` → `mac.extendInfo` 追加
  `NSLocalNetworkUsageDescription`，使 macOS 15+ 弹出本地网络授权，同时授予
  Chromium 主进程与 `ELECTRON_RUN_AS_NODE` 的 agent sidecar；否则主进程的
  Test Provider 能过，但 sidecar 走局域网请求会以 `EHOSTUNREACH` 失败
  （issue #573）。
- `Resources/bin/pi-desktop-host-core` — Rust 主机二进制文件（发布版本）。
- Windows NSIS 构建包含静态链接 MSVC CRT 的 x64
  `pi-desktop-host-core.exe`，因此全新的 Windows x64 或 Windows 11 ARM64
  （x64 模拟）安装无需在本地服务启动前单独安装 Visual C++ Redistributable。
- `Resources/agent-runtime/` — 捆绑的 sidecar，执行
  `ELECTRON_RUN_AS_NODE=1`（未发货单独的 Node）。
- `Resources/licenses/` — 通知必须在以下情况下保持可分发：
  相应依赖项的仅构建源树被修剪。
- `Resources/app.asar` — Electron Main、preload、渲染器输出以及仅
  运行时解析的生产模块。 Renderer 库已存在
  在 Vite 输出中，并且不会再次复制为原始包树。
- Chromium 语言环境包适用于英语、简体中文、繁体中文和土耳其语。产品目录
  保持捆绑状态，独立于 Chromium 区域设置。
- 应用程序图标 `build/icon.icns` 和 `build/icon.ico`（源自规范
  `build/icon_1024.png`，由 `scripts/make-icon.py` 生成）。

## 4. 发布步骤

### 4.1 强制发布版本面门禁 (D164 + D260)

**每个提升稳定应用版本并打标签的产品发布，都必须先更新所有带版本号的位置：
双语应用内产品更新日志，以及项目文档中声明的版本号。** 如果任一位置仍在描述
旧版本就打稳定标签，属于**发布过程失败**：打包版本在没有网络请求时无法显示
“新增内容”，README 会宣传过期的版本线，而 GitHub 自动生成的发布正文
**不是**替代品（扩展 D120 / ADR 0022）。

门禁覆盖的位置：

| 位置 | 要求 |
|---|---|
| `apps/desktop/resources/models.dev/api.json` | 打标签前从 https://models.dev/api.json 刷新；发布工作流按该快照原样打包 |
| `packages/shared/src/changelog.ts` | 英文、zh-CN、zh-TW 条目按最新优先排列，亮点条数一致 |
| `packages/shared/src/changelog-de.ts`、`changelog-es.ts`、`changelog-fr.ts`、`changelog-ko.ts`、`changelog-tr.ts` | 版本集合与亮点条数与英文一致 |
| `packages/shared/src/changelog.test.ts` | 该版本加入最新优先清单的首位 |
| `package.json`、`apps/*/package.json`、`packages/*/package.json`、`docs/package.json` | 版本号一致（`docs` 是第三个工作区根，不在 `apps`/`packages` 之下） |
| `Cargo.toml` 的 `[workspace.package]`、`Cargo.lock` 的 `host-core` | 版本号一致 |
| `packages/shared/src/protocol.ts` 的 `APP_VERSION` | 版本号一致 |
| `README.md`、`README.zh-CN.md` | 状态章节声明当前 `<major>.<minor>.x` 版本线；工具链、命令与路线图描述仍然成立 |

阻塞步骤：

1. 打标签**之前**刷新 `apps/desktop/resources/models.dev/api.json`。
   `scripts/release.mjs` 默认对每次升版本都会刷新，包括预发布。无变化的刷新
   （已经是最新）仍然算通过：被打标签的树里的快照才是产物会带上的内容。
   不要把单行压缩 JSON 的 diff 当成“文件不存在”。
2. 在 `node scripts/release.mjs <version>` / `git tag` **之前**编辑
   `packages/shared/src/changelog.ts`：
   - 在 `en` 和每个已发货产品语言下各添加**最新优先**的条目（本文件中的
     `zh-CN` / `zh-TW`；`packages/shared/src/changelog-*.ts` 中的
     `de` / `es` / `fr` / `ko` / `tr`）。
   - 稳定版使用相同的 `version` 字符串（semver，**不带**前导 `v`，与
     `apps/desktop` / `APP_VERSION` 一致）。
   - 可选的 ISO `date`（`YYYY-MM-DD`）。
   - 亮点条数一致；英文是唯一事实来源（ADR 0009）。
   - 每条只表达一个面向用户的要点（不是原始 PR 标题）。
3. **不要**把预发布标识（`x.y.z-rc.*`、`x.y.z-beta.*`）本身写进应用内更新日志。
   当该预发布是下一稳定版的预览时，应添加那个**稳定版本**（`x.y.z`）的条目，
   让测试者无需联网就能看到“新增内容”。仅当产品明确不为这次构建提供说明时
   才省略目录。
4. 同步 `packages/shared/src/changelog.test.ts` 中的最新优先版本清单
   （把新的稳定版本加到首位），然后运行
   `pnpm --filter @pi-desktop/shared test`，确认目录对齐（版本集合与亮点
   条数）仍然通过。
5. 版本线发生变化（`0.10.x` → `0.11.x`）时更新 `README.md` 与
   `README.zh-CN.md`；当本次发布交付了用户可见行为，使亮点、下载、快速上手、
   状态或参与开发章节的描述不再准确时同样要更新。两个语言版本保持结构一致，
   英文是事实来源，中文版链接 `docs/zh-CN/` 镜像。
6. 运行预检并修复所有报告的位置：
   `pnpm check:release-docs [version]`（即 `node scripts/check-release-docs.mjs`）。
   对预发布，请对正在预览的**稳定版本**运行
   （`pnpm check:release-docs x.y.z`），这样即使 `scripts/release.mjs` 对
   `x.y.z-beta.*` / `x.y.z-rc.*` 跳过该预检，更新日志和 README 仍会对齐。
   预检会在临时目录编译 TypeScript 更新日志，因此不要求先构建整个工作区。
   `scripts/release.mjs` 仍会为预发布刷新 models.dev；`--skip-docs-check`
   仅用于明确的非发布性升版本。
7. 提交文档更新，使被打标签的提交同时包含该版本的说明与准确的版本描述
   （单独提交或与升版本提交相邻）。
8. GitHub Release 正文仍可对网页使用 `generate_release_notes: true`；它们
   仅限网页，**不是**应用内说明的来源。

打标签前清单：

- [ ] `apps/desktop/resources/models.dev/api.json` 已刷新，或已确认打标签的树中为最新
- [ ] `packages/shared/src/changelog.ts` 含有正在发布或预览的稳定版本的英文 /
      zh-CN / zh-TW 条目
- [ ] `packages/shared/src/changelog-de.ts` 及其他语言目录与英文版本集合、
      亮点条数一致
- [ ] 各语言的亮点条数一致
- [ ] 共享更新日志测试通过
- [ ] `README.md` 与 `README.zh-CN.md` 声明当前版本线，且没有被本次发布
      推翻的描述
- [ ] `node scripts/check-release-docs.mjs` 在发布提交上通过
      （预览预发布时传入稳定版本）
- [ ] `release.mjs` / 打标签仅在文档提交进入发布分支后执行

### 4.2 构建/打包

```bash
export MAC_SIGNING_IDENTITY="XingYu Liu (DUV63RKYTW)"
export APPLE_ID=...
export APPLE_APP_SPECIFIC_PASSWORD=...
export APPLE_TEAM_ID=...
scripts/release-macos.sh
```

工件落在 `apps/desktop/release/`（DMG + ZIP + 块图）中。

`scripts/release-macos.sh` 默认使用主机架构，也接受 `MAC_ARCH=arm64` 或
`MAC_ARCH=x64`，但该值必须与主机匹配，以保持 Rust 本机主机和 Electron
软件包的架构一致。

### 4.3 GitHub 标签和手动工作流程

GitHub Release 工作流程启动所有本机平台运行程序，无需
单独的验证作业障碍。每个运行器都会验证推送的标签
结账后、打包前立即匹配 `apps/desktop/package.json`
输入已准备好。

在每个平台上，发布准备步骤都会启动锁定的 Rust 主机
与 pnpm 安装和本机依赖项重建并行构建。它
然后仅构建由选择的工作区依赖项
`@pi-desktop/desktop^...`，如果该依赖项选择意外则失败
空的。平台 `dist:*` 命令仍然负责捆绑代理
运行时，验证主机构建，构建一次桌面应用程序，以及
调用电子构建器。这避免了多余的桌面构建，而无需
更改包脚本或发布工件。

**macOS 默认发布策略：** GitHub tag 发布会在上传前对 macOS DMG/ZIP 做 Developer ID 签名、公证、装订和 Gatekeeper 校验（D450 / ADR 0289）。缺少签名或公证密钥则作业失败。`workflow_dispatch` 仅可把 `sign_macos: false` 用于未签名调试产物，不得用于 GitHub Release 标签。本地 `scripts/release-macos.sh` 仍是明确的本地签名通道；未配置证书时 `pnpm dist:mac` 保持未签名（D078）。

macOS 矩阵使用 arm64 的 `macos-15` 和 Intel x64 的
`macos-15-intel`。每个作业验证 `uname -m`，向 electron-builder 传入匹配
的 `--arm64` 或 `--x64`，并在同一本机运行器上构建
`pi-desktop-host-core`。每个架构的 `latest-mac.yml` 会在上传前重命名，
发布作业下载两个工件后再合并为一个更新源。

共享的 electron-builder 配置在 macOS 平台级别为 ZIP 应用带架构后缀的命名模板，
并在 DMG 目标级别覆盖该模板。两个公开架构都会明确可见：arm64 通道发布
`PI-Desktop-<version>-arm64.dmg` 和 `PI-Desktop-<version>-arm64-mac.zip`，
Intel x64 通道发布 `PI-Desktop-<version>-x64.dmg` 和
`PI-Desktop-<version>-x64-mac.zip`。这同时适用于未签名、已签名和本地 macOS
通道，并确保每个按架构生成的更新源都会引用带架构后缀的工件名及其匹配校验和。
上传前，每个 macOS 运行器必须恰好生成一个带架构后缀的 DMG 和 ZIP（包括
blockmap），任何无后缀或架构错误的 macOS 工件都会使发布失败。

DMG 使用带有品牌视觉的 720×440 背景，只展示拖入 Applications 的双图标安装手势。
窗口里只有应用和 Applications 链接；打开说明和可执行 command 助手都不放入 DMG。

macOS ZIP 在安装包根目录包含 `PI-Desktop-macOS-opening-help.txt` 和可执行的
`PI-Desktop-macOS-open.command`。将 `PI-Desktop.app` 移动到 `/Applications` 或
`~/Applications` 后，ZIP 用户可以双击该助手。它只搜索这两个固定位置，在存在时递归
删除唯一的 `com.apple.quarantine` 属性，然后打开 PI-Desktop。在执行前它会校验
`CFBundleIdentifier=net.aiuo.pi-desktop`。它不会使用 `sudo`，也不接受任意应用路径。
标准系统位置的终端备用命令为：

```sh
xattr -r -d com.apple.quarantine /Applications/PI-Desktop.app
```

该助手仅适用于可信来源的未签名工件在 macOS 上提示应用已损坏的场景；已签名并公证
的版本无需执行它。

标签构建和 `sign_macos: true`（手动运行的默认值）仅从 GitHub Actions 密钥接收 `CSC_LINK`、`CSC_KEY_PASSWORD`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD` 和 `APPLE_TEAM_ID`，通过 `CSC_NAME=XingYu Liu (DUV63RKYTW)`（裸通用名——electron-builder 拒绝 `Developer ID Application:` 前缀）固定证书，强制代码签名与 `notarytool` 公证 `PI-Desktop.app`。随后 DMG 会由 `scripts/notarize-and-staple-macos-release-dmg.sh` 单独提交到同一个服务，只有返回 `Accepted` 才允许装订票据。之后验证身份、代码签名完整性（含 `pi-desktop-host-core`）、Gatekeeper `Notarized Developer ID` 以及两份已装订票据，再进行任何工件上传。

DMG、ZIP、NSIS、AppImage、deb、rpm、块图和更新程序提要输出已
压缩或压缩不敏感。因此，工作流程会上传它们的
发布作业之前压缩级别为零的临时操作工件
组装 GitHub 版本。

### 4.4 CNB 镜像触发

`softprops/action-gh-release` 发布或更新 GitHub Release 之后，
`.github/workflows/mirror-to-cnb.yml` 会启动 `aixk/Pi-Desktop` 上的 CNB
流水线。GitHub Release 仍是权威产物源；CNB 只是同一标签的副本，供从
https://cnb.cool/aixk/Pi-Desktop 拉取的用户使用。

该作业：

- 仅在 `vastsa/PI-Desktop` 上运行
- 在 `release` 的 `published` / `edited` 时触发，也可通过
  `workflow_dispatch` 传入明确标签（例如 `v0.14.6`）
- 发送事件 `api_trigger_mirror`，并把 `MIRROR_TAGS` 设为该标签
- 使用仓库密钥 `CNB_MIRROR_TOKEN`（已配置）；密钥为空时失败退出
- 用 `jq` 构造 JSON，避免手动运行时标签缺失导致空的 `MIRROR_TAGS`

若 CNB 流水线幂等，对同一标签重跑是安全的。它不会重新构建桌面产物，
也不会改写 electron-updater 更新源。

### 4.5 GitHub Actions 中的 macOS 签名密钥

在 GitHub → 仓库 `vastsa/PI-Desktop` → Settings → Secrets and variables →
Actions 中创建下列密钥。不要把 p12、密码、Apple ID 或应用专用密码提交进仓库。
不要在 CI 中 `echo` 这些值。

| Secret | Value |
|---|---|
| `CSC_LINK` | 导出的 Developer ID Application `.p12`（证书+私钥）的 Base64。electron-builder 也接受文件路径，但 CI 使用 Secret 正文。 |
| `CSC_KEY_PASSWORD` | 导出该 `.p12` 时设置的密码 |
| `APPLE_ID` | 属于团队 `DUV63RKYTW` 的 Apple ID 邮箱 |
| `APPLE_APP_SPECIFIC_PASSWORD` | 来自 https://appleid.apple.com → Sign-In and Security → App-Specific Passwords 的应用专用密码 |
| `APPLE_TEAM_ID` | `DUV63RKYTW` |

在本地把 p12 编成 base64（不要把输出贴到聊天或仓库）：

```bash
base64 -i developer-id-application.p12 | pbcopy
```

Linux 使用 `base64 -w0 developer-id-application.p12`。绝不能进入 git 的文件：
`*.p12`、`*.cer`、`*.p8`、`*.mobileprovision`。

### 4.6 macOS 签名可观测性与超时

`electron-builder` 在开始签名前只打印一行 —— `signing
file=release/mac-arm64/PI-Desktop.app platform=darwin type=distribution
identityName=...` —— 之后直到该阶段结束都没有任何输出。这段时间里隐藏了三种机制，
现在 macOS 通道把它们全部暴露出来：

| 阶段位置 | 发生什么 | 现在如何可见 |
|---|---|---|
| 遍历 | `@electron/osx-sign` 遍历 `PI-Desktop.app/Contents`，收集所有 Mach-O 文件以及嵌套的 `.app` 与 `.framework` 包 | `DEBUG=electron-osx-sign*` 打印 `Walking... <dir>`；`scripts/macos-bundle-inventory.mjs` 在打包结束后打印同一个包的数量 |
| 逐文件签名 | `codesign --force --sign <identity> --timestamp --entitlements ... <file>` 串行执行，最深的文件优先，应用包最后签 | `DEBUG=electron-osx-sign*` 打印 `Signing... <file>` 与 `Executing... <file> codesign ...`；codesign shim 记录每次调用的耗时。若钥匙串拒绝把私钥交给被包裹的 `codesign`，可设置 `PI_SIGNING_NO_CODESIGN_SHIM=1` 在不使用 shim 的情况下运行该阶段 |
| 静默重试 | 一轮签名失败后最多再重试三次，退避 5s/10s/15s，且没有任何日志行 | 看门狗汇总中的 `codesign-calls` 与 `failures` 行会暴露重复的整轮签名 |
| 应用公证 | `@electron/notarize` 打包 zip、上传并等待 Apple 队列（`mac.notarize=true`） | `DEBUG=electron-notarize*` 打印 `zipping application to`、`attempting to upload file to Apple`、`notarization success`，随后 electron-builder 打印 `notarization successful` |
| DMG 公证 | DMG 有自己的签名，因此下一步会用 `xcrun notarytool submit --wait` 再提交一次 | 同一个看门狗让该等待过程可见并且有上限 |

`scripts/macos-signing-watchdog.mjs` 包裹这两个长时间阶段。它给子进程的每一行加上
`[sign] ` 前缀后转发，并保留子进程退出码，因此通道的失败语义不变；stdout 与 stderr 作为
两条独立流转发，二者相对顺序可能与直接运行不同，子进程也不会获得 stdin。子进程静默时它打印心跳
（已用时间、阶段、最后处理的文件、当前活动的 codesign 目标）；当阶段在
`PI_SIGNING_STALL_SECONDS` 内既无输出也无 codesign 活动时，它输出一次诊断（最后处理的
文件、签名相关进程的 `ps` 状态、codesign 日志尾部）；并在 `[sign] summary` 块中给出逐文件
codesign 耗时 —— 调用次数、总耗时、p50、p95、最大值以及最慢的几个文件。可调项：

| 设置 | 默认值 | 作用 |
|---|---|---|
| `PI_SIGNING_TIMEOUT_SECONDS` | 2400（CI：打包 1800，DMG 1200） | 被包裹阶段的硬上限：输出诊断、杀掉进程组，并以 124 退出而不是继续挂起 |
| `PI_SIGNING_STALL_SECONDS` | 300 | 无 codesign 活动的静默持续这么长时间就触发一次诊断输出；阶段继续运行，因为等待 Apple 公证队列是合法等待 |
| `PI_SIGNING_HEARTBEAT_SECONDS` | 60 | 子进程无输出时的心跳间隔 |
| `DEBUG` | `electron-osx-sign*,electron-notarize*` | 暴露遍历、逐文件签名与公证进度的命名空间 |

`DEBUG` 只列出两个会自行清洗命令行的命名空间，因为 `electron-builder` 的命名空间在这里
并不安全：builder-util 打印每条外部命令时所用的敏感词表并不覆盖
`security set-key-partition-list -k <p12 密码>`。在此之上，看门狗会把
`CSC_KEY_PASSWORD`、`APPLE_APP_SPECIFIC_PASSWORD` 的取值（不限长度）、`CSC_LINK` 与
`APPLE_ID` 的取值，以及任何 `--password` 或 `-k` 参数替换为 `[redacted]` —— 包括诊断
输出（进程视图只打印 `comm`，绝不打印 `argv`）与汇总（只有计数与已脱敏的目标路径）。
GitHub 本身也会屏蔽所有来自 secret 的值。

在维护者机器上实测：一个 macOS arm64 包需要 93 次 `codesign` 调用（91 次签名、
1 次校验、1 次 entitlement 显示），`codesign` 墙钟时间约 49s；其中只有 16 个文件是 Mach-O
代码、5 个是嵌套包。`@electron/osx-sign` 还会给二进制资源签名 —— 33 个 `.pak`，以及
`.nib`、`.dat`、`.bin`、`.png`、`.icns`、`app.asar` —— 因为它的遍历会选中所有"看起来是
二进制"的文件，而不只是 Mach-O。用 `mac.signIgnore` 精确排除这些数据文件可以去掉约四分之三
的调用，但这会改变发布工件所携带的内容，且需要一次真实公证发布来验证，因此这里有意不启用。

`scripts/macos-signing-diagnostics.sh` 在证书导入之前记录 runner 基线：系统版本、
`codesign --version`、钥匙串身份/列表/默认钥匙串、`xcrun --find notarytool`，以及
`http://timestamp.apple.com/ts01` 的可达性与延迟。此时 Developer ID 身份理应不存在，
因为 electron-builder 在打包过程中才从 `CSC_LINK` 导入；只有 `--require-identity`
才会在缺少身份时判定失败。

签名器现状：`@electron/osx-sign@1.3.3` 由 `app-builder-lib@26.15.3` 精确锁定，且没有任何
override 作用于它。它的 `signApplication()` 对每个文件 `await` 一次 `codesign`；没有批量或
并行路径，也没有任何选项或环境变量可以开启并发。因此更快的签名器只能通过 `mac.sign`
替换钩子实现，那是重写而不是配置开关；所以该通道继续使用锁定的签名器并保留上述诊断。

## 5. 验证门

未签名调试产物（`workflow_dispatch` 且 `sign_macos: false`）不视为通过 Gatekeeper。标签发布必须通过以下签名、公证和装订检查，否则工作流失败。

存在两次独立的公证提交，因为 Apple 每次公证一个工件，而 electron-builder 只覆盖应用：

| 工件 | 提交方 | 票据 |
|---|---|---|
| `PI-Desktop.app`（ZIP 内） | electron-builder `-c.mac.notarize=true` | 由 electron-builder 装订 |
| `PI-Desktop-<version>-<arch>.dmg` | `scripts/notarize-and-staple-macos-release-dmg.sh`（`notarytool submit --wait`） | 同一脚本在 `status: Accepted` 后装订 |

从未提交过的 DMG 没有票据，因此装订会失败并报 `Could not find base64 encoded ticket ... Error 65`。只有在 Apple 返回 `Accepted` 之后才允许重试装订。

每次已签名发布后运行：

```bash
for APP in apps/desktop/release/mac-*/PI-Desktop.app; do
  codesign -dv --verbose=4 "$APP"
  codesign --verify --deep --strict --verbose=2 "$APP"
  spctl --assess --type execute --verbose=4 "$APP"
  xcrun stapler validate "$APP"
done
xcrun stapler validate apps/desktop/release/*.dmg

当提交未被接受时，Release 工作流会自动打印 Apple 公证日志；手动查看方式：

```bash
xcrun notarytool log <submission-id> \
  --apple-id "$APPLE_ID" \
  --password "$APPLE_APP_SPECIFIC_PASSWORD" \
  --team-id "$APPLE_TEAM_ID"
```
```

### 5.1 安装包体积门禁

在发布之前检查每个本机运行程序包并记录所有内容
压缩工件格式、解压应用程序、ASAR、Electron
framework/runtime、区域设置和未打包的本机大小。将它们与
之前的稳定版本；原因不明的增加超过 15% 阻止发表
直至审核。

包裹库存必须确认：

- 正好一个 `Resources/agent-runtime/sidecar.js` 和一个目标本机 Rust
  主机二进制文件
- 没有原始渲染器包，例如 Mermaid、Shiki、React、KaTeX 或 Lucide
  封装后的 `node_modules`
- 无依赖性 `*.map`、测试、示例、声明或第二个代理运行时
ASAR 中的树
- 所需的第三方许可和通知文件保留在 ASAR 中或
  `Resources/licenses` 当其非运行时包树被修剪时
- 仅配置的英语、简体中文、繁体中文和土耳其语 Chromium 语言环境包

第一个经过审核的优化包建立了平台基线。保留
针对每个平台进行测量，而不是将一项预算应用于不同的平台
Electron 目标布局。

第一个 macOS arm64 基线于 2026 年 7 月 30 日从未签名的
`electron-builder --dir` 包。大小低于常规文件字节总和，因此它们
跨文件系统保持可比性；压缩的工件不是
适用于此仅目录验证构建。

| 库存 | 字节 | 米布 |
|---|---:|---:|
| 解压后的应用程序 | 251,724,810 | 240.1 |
| `Contents/Frameworks` | 218,567,792 | 208.4 |
| `Contents/Resources` | 33,102,807 | 31.6 |
| `Resources/app.asar` | 20,944,962 | 20.0 |
| `Resources/app.asar.unpacked` 本机负载 | 137,336 | 0.1 |
| 历史英语和简体中文 Chromium 语言环境包基线 | 1,033,673 | 1.0 |
| Agent sidecar | 3,258,983 | 3.1 |
| Rust 主机 | 7,160,000 | 6.8 |

优化前解压的常规文件总数为 559,355,716 字节
(533.4 MiB)。审计后的包小了 307,630,906 字节，减少了 55.0%
减少。其策划的渲染器输出为 14.1 MiB，低于 20.5 MiB。

#### 渲染器产物预算

渲染器包有三项长期控制。其中任意一项回退，都会在上面的表格中表现为渲染器
体积增长，并且必须在发布前给出解释：

- **压缩是显式开启的。** `electron-vite` 对渲染器预设硬性默认
  `minify: false`（与原生 Vite 不同），因此
  `apps/desktop/electron.vite.config.ts` 设置了 `minify: "esbuild"`。移除它会
  让产出的 JS 体积悄然翻倍。
- **旧字体格式被剔除。** `pi-drop-legacy-font-fallbacks` 插件会在 Vite 把
  `woff` 与 `truetype` 的 `src` 条目注册为资源之前移除它们。随包的 Chromium
  普遍支持 `woff2`，这些字形只会被产出而永远不会被使用。
- **品牌标识按渲染器尺寸提供。** `src/assets/brand/logo-{light,dark}.png` 是
  渲染器资源；`build/icon_1024.png` 与 `build/logo_dark.png` 是
  electron-builder 的安装包图标，渲染器不得引用。

应用这三项控制后于 2026-08-26 测得的渲染器产物，对照同一棵树在 `v0.10.8`
的状态：

| 渲染器分组 | 之前 | 之后 |
|---|---:|---:|
| JavaScript（120 个 chunk） | 12.53 MiB | 7.72 MiB |
| `woff2` | 15.71 MiB | 15.71 MiB |
| `woff` + `ttf` 旧格式回退（40 个文件） | 0.78 MiB | 0 |
| PNG 品牌资源 | 1.23 MiB | 0.27 MiB |
| CSS | 0.42 MiB | 0.35 MiB |
| **`out/renderer` 合计** | **31 MiB** | **24 MiB** |

渲染器不再产出任何应用字体面。D598 / ADR 0298 移除了四款内置字体（Geist、
Inter、Noto Sans SC、LXGW WenKai），因此 `out/renderer` 中只剩 KaTeX 的数学
字形 `woff2`。以下为本机实测，两次均在干净的 `pnpm install --frozen-lockfile`
之后构建：

| 渲染器分组 | 含内置字体 | 移除后（D598） |
|---|---:|---:|
| JavaScript（121 个 chunk） | 9.04 MiB | 9.04 MiB |
| `woff2`（23 → 19 个文件） | 15.71 MiB | 0.24 MiB |
| CSS（1 个文件） | 0.48 MiB | 0.48 MiB |
| PNG 品牌资源（4 个文件） | 0.08 MiB | 0.08 MiB |
| GIF（2 个文件） | 0.05 MiB | 0.05 MiB |
| **`out/renderer` 合计**（152 → 148 个文件） | **25.36 MiB** | **9.89 MiB** |

差异完全来自被删除的四个字体面，以下为构建报告的实际大小：
`lxgw-wenkai.woff2` 8,016.75 kB、`noto-sans-sc.woff2` 7,782.07 kB、
`inter.woff2` 352.24 kB、`geist.woff2` 69.65 kB，合计 16,220.71 kB，
即合计体积下降的全部 15.47 MiB。中文现在由系统字体层
（`PingFang SC`、`Hiragino Sans GB`、`Microsoft YaHei`）渲染，因此不存在因
子集化而丢失字形的问题：根本不再随包发布字体面。
开启，旧 `woff`/`truetype` 剔除仍然保留，因为 KaTeX 仍会声明这些来源。

上表是三控件的 `v0.10.8` 记录，早于本次移除，其 `woff2` 行已不再反映现状。

在干净的轮廓上手动烟雾 (`PI_DESKTOP_DATA_DIR=$(mktemp -d)`)：

1. `pnpm dev` 与 `PI-Desktop` 一起在 macOS 应用程序菜单中启动，
   Dock 和本机“关于”面板中的规范图标；没有 Electron 品牌
   可见。
2. 应用程序从 DMG 安装启动，出现窗口，然后出现应用程序菜单，
   关于面板和 Dock 品牌与开发路线相匹配。
3. 空首页和 expanded/collapsed 侧边栏显示规范的 PI-Desktop
   标志；输入框提示行没有领先的品牌图标；新任务和
project/Temporary 使用消息加会话图标创建控件。
4. 出现新手引导清单；配置提供商；一轮流式聊天。
5. 一种授权工具调用（写入）允许 + 拒绝路径。
6. Quit/relaunch → 恢复会话历史记录，恢复窗口边界。
7. `~/.pi-desktop/logs/` 包含 `app/`、`host/` 和 `agent/` 下分类的 NDJSON；
   关键的生命周期、工具、provider、plugin 和错误记录可用，不再创建独立的计时文件。
8. 禁用网络访问后，shell 仍然启动； English/Chinese
   切换、语法高亮、shell 高亮、KaTeX、Mermaid fallback/rendering、
   主机运行状况和 sidecar 运行状况继续使用打包的本地资产。

## 6. 本机运行器发布包

该存储库为每个发布目标公开本机运行器构建命令。
每个打包命令首先运行 `build:host-release`，然后捆绑代理
运行时和 Electron 应用程序。D126/D285 标签工作流程发布这些输出及其
电子更新程序清单。在该目标操作系统上运行目标命令：

```text
macOS Apple Silicon: pnpm --filter @pi-desktop/desktop run dist:mac -- --arm64
macOS Intel:         pnpm --filter @pi-desktop/desktop run dist:mac -- --x64
Windows: pnpm --filter @pi-desktop/desktop dist:win
Linux:   pnpm --filter @pi-desktop/desktop dist:linux
```

macOS 软件包包括按本机架构构建的 `bin/pi-desktop-host-core`；Windows
软件包包括 `bin/pi-desktop-host-core.exe`；Linux 包括
`bin/pi-desktop-host-core`。签名、回滚和安装程序升级资质仍保持发布
硬化工作；发布本身已在 D126/D285 下启用。

Native-runner 输出矩阵：

- macOS arm64：`PI-Desktop-<version>-arm64.dmg` 和
  `PI-Desktop-<version>-arm64-mac.zip`
- macOS Intel x64：`PI-Desktop-<version>-x64.dmg` 和
  `PI-Desktop-<version>-x64-mac.zip`
- Windows x64：NSIS 安装程序 `PI-Desktop-Setup-<version>.exe` 和便携版
  exe `PI-Desktop-Portable-<version>.exe`
- Linux x64：AppImage、deb 和 rpm
- Linux x64 系统 Electron 产物：`PI-Desktop-<version>-linux-x64.asar`

便携版 Windows 目标不会写入 `latest.yml`。已打包的便携版运行使用通知加链接
交付（`PORTABLE_EXECUTABLE_FILE`）；NSIS 仍走应用内下载并在退出时安装。
数据仍在现有应用数据目录。便携版请求 user 执行级别，因此启动不需要管理员权限。

RPM 目标会向 FPM 传入 `_build_id_links none`。捆绑的 Electron 二进制文件位于
`/opt/PI-Desktop` 下；省略全局 `/usr/lib/.build-id` 链接，可以避免与其他捆绑相同
Electron 二进制文件的应用发生冲突。

该 ASAR 产物包含的是 Electron 应用归档，而不是完整的 Linux 发行包。
若要重新打包，请把它作为应用归档放入目标 Electron 的 resources 布局中，
与目标软件包内的本机主机及其他资源放在一起，然后用以下命令启动：

```bash
electron PI-Desktop-<version>-linux-x64.asar
```

每个本机运行器上的外壳冒烟测试：

1. 确认窗口中没有出现 File/Edit/View/Window/Help 菜单。
2. 验证 F10 和 Shift+F10 对焦点内容仍然可用。
3. 从焦点编辑器执行应用程序和编辑快捷方式。
4. 最小化、最大化、恢复和关闭自定义控件。
5. 使用 `PI_DESKTOP_START_MAXIMIZED=1` 重新启动；确认初始
   maximize/restore 字形与查询的本机状态匹配。
6. 验证未知的 menu/window IPC 操作在窗口打开和关闭时失败。

## 7. 已知限制

- Linux deb/rpm 和 Windows 便携版 exe 仍保持通知和链接更新模式。打包的 macOS、Windows NSIS 和 Linux AppImage 使用应用内 `electron-updater`。
- Linux x64 包在 Ubuntu 22.04 上构建，因此 host-core 需要 glibc 2.35 或更高版本（Ubuntu 22.04、Debian 12、Fedora 36+）。标签作业运行 `scripts/check-linux-host-glibc.mjs`，拒绝需要更新 glibc 的二进制文件。
- 回滚、分阶段部署和预发布渠道政策仍是开放的发布工作。现有未签名 macOS 安装可能需要先手动安装一次已签名 DMG，之后应用内更新才能成功。
