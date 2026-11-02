# 16. 受信任扩展

> **翻译说明：** 本页是与 [英文源规格](/spec/07-plugins/16-trusted-extensions) 一一对应的机器辅助翻译。代码、协议字段和标识符保持原文；如翻译与英文源事实有歧义，以英文版本为准。

> 状态：v1.1 已实现（D387 / D388、ADR 0214 / ADR 0215 / ADR 0244）；实现说明标注为“v1 说明”
> 范围：v1.1。v2 与 v3 事项列于 §12，不构成承诺。

## 1. 目的与术语

插件（[01-plugin-system.md](/zh-CN/spec/07-plugins/01-plugin-system)）是 PI-Desktop
唯一的扩展面。本文规定其中一种插件贡献点 `contributes.agentExtensions`：在 Agent
sidecar 内运行的 TypeScript 或 JavaScript 模块，接收一个 `ExtensionAPI` 对象，直接在
Agent 循环上注册工具、命令和事件处理器。`ExtensionAPI` 的接口形式参照
`@earendil-works/pi-coding-agent`，PI-Desktop 将其与 `pi-ai`、`pi-agent-core`
内核一并引入（ADR 0002）。桌面适配层实现的是明确列出的子集，因此与 pi CLI 的兼容范围
仅限于本文列出的成员。D388 把此前
独立的“受信任扩展”注册表并入了这个贡献点；下文的引擎部分不变。

本契约适用于附加到 Desktop Agent 会话的扩展。桌面适配层实现 §5–§6 明确列出的子集；
上游新增事件不会自动成为桌面端可实际处理的事件。Native Pi 续接使用 coding-agent SDK
自身的扩展生命周期及原生运行时包版本，并遵循 [ADR 0254](/adr/0254-native-pi-session-continuation)
中独立规定的原生会话租约和信任规则。

Provider 声明属于独立的 manifest 能力，不在本契约内：`contributes.providers` 会生成
由 Host 管理的 Provider 记录（[02-plugin-manifest-schema.md](/zh-CN/spec/07-plugins/02-plugin-manifest-schema)
§5.4、ADR 0259），因此它既不是 `ExtensionAPI` 成员，也不属于 §5 支持矩阵中的条目。
`registerProvider`（§5）则仍是扩展侧的会话级对应能力。

| 术语 | 含义 |
|---|---|
| Agent 扩展 | 插件在 `contributes.agentExtensions` 中列出的一个模块，面向 `ExtensionAPI` 编写，以 Agent sidecar 的信任级别运行 |
| 插件 | 带 manifest 的 PI-Desktop 插件，在独立进程中、权限网关之下运行（ADR 0008）；是其 agent 扩展的拥有者、安装者和启用记录 |
| 适配层 | `packages/agent-runtime` 中在桌面运行时之上实现 `ExtensionAPI` 的层 |
| Runner | 绑定到一个桌面会话的一个桌面自有 `TrustedExtensionRunner` 实例（v1 说明：不复用 pi-coding-agent 的 `ExtensionRunner`，因为它绑定终端主题；其 `ExtensionAPI` 类型仅作类型依赖） |

## 2. 定位与信任模型

1. Agent 扩展随其插件一起安装、启用、限定范围、更新和移除。没有第二个列表、存储或
   设置页。
2. Agent 扩展是受信任代码。它在 Agent sidecar 内执行，而 sidecar 已持有 bash、edit
   和 write 工具，因此授予 `agent.extension` 权限授予的正是运行 agent 已经授予的东西。
   [04-plugin-security.md](/zh-CN/spec/07-plugins/04-plugin-security) 的插件沙箱不
   覆盖这些模块，这正是该权限作为独立高风险授权、而非 `agent.tool.register` 隐含
   部分的原因。
3. 没有授权就不运行。声明了 `contributes.agentExtensions` 却没有 `agent.extension` 的
   manifest 校验不通过；记录的授权中缺少该权限的插件照常加载但跳过其模块并记审计
   （`plugin.agentExtensions.skipped`）。D007 继续有效：PI-Desktop 永不自动导入 `~/.pi`。
4. 项目范围就是插件的激活范围。限定到某些项目的插件只向这些项目的会话贡献模块。v1
   说明：没有独立的项目信任状态，插件范围即信任决定，`project_trust` 不触发。
5. v1.1 不开放持有 `agent.extension` 的插件在市场分发：该权限只接受本地导入和开发
   插件。市场上架等签名机制（规格 08）到位后再定。

## 3. 贡献与导入

### 3.1 Manifest

```json
{
  "id": "acme.git-helper",
  "name": "Git helper",
  "version": "1.0.0",
  "main": "main.js",
  "permissions": ["agent.extension"],
  "contributes": { "agentExtensions": ["src/index.ts"] }
}
```

规则：最多八个条目；每个条目是插件目录内的相对 `.ts`、`.mts`、`.js` 或 `.mjs` 路径；
加载时文件必须存在；列出条目却没有权限的 manifest 无效
（[02-plugin-manifest-schema.md](/zh-CN/spec/07-plugins/02-plugin-manifest-schema) §4 与 §7）。
当插件不贡献其他内容时，`main` 可以是空操作模块。

### 3.2 导入 pi CLI 扩展或技能包

插件页 →“导入 pi 扩展”打开原生选择器（main 拥有路径，D344），由用户明确选择本地
文件或目录。main 把所选源码复制到 `<dataDir>/plugins/imported/<slug>/src/`，生成空操作
CommonJS `main.cjs` 和 id 为 `imported.<slug>` 的 manifest（重复导入时追加唯一后缀），再通过
既有本地插件流程注册。选择器之前的确认仍是信任决定；生成的 manifest 只声明实际贡献
所需的权限。无论源包的 `type` 为何，manifest 的 `main` 都指向 `main.cjs`；
两份复制的包声明保留原有模块语义。加载时若导入插件的 `main` 仍是生成的 CommonJS
`main.js` 空包装器，则就地改写为 `main.cjs` 并更新 manifest；复制的包文件、授权和
激活范围保持不变。只匹配生成的空操作（含最初的注释文本）。自定义过的 `main.js`
不会改动。不删除就重新导入仍会创建带唯一后缀的独立插件，不会从旧副本复制授权或
激活范围。

扩展文件及未声明 `pi.skills` 的包保持既有 `pi-coding-agent` 入口发现规则：先取
`package.json` 的 `pi.extensions`，否则取 `index.ts` / `index.js`，再否则取一层深度内
的松散 `*.ts` / `*.js` 文件。明确声明 `pi.skills` 且没有 `pi.extensions`（或该数组为空）
的包视为仅技能包：包括 `index.js` 在内的附带脚本作为资源复制，不会被提升为可执行的
Agent 扩展。

目录若自带 `package.json`，会（连同其 npm lockfile）一并复制到插件根并剥离 `workspaces` 字段。
若声明了生产或可选依赖，main 会在首次加载前执行有界的两阶段安装：先运行
`npm install --package-lock-only --omit=dev --legacy-peer-deps --no-audit --no-fund
--ignore-scripts` 并校验完整生成的 lockfile，再使用相同安全参数运行 `npm ci`。
`dependencies`、`optionalDependencies`、`devDependencies` 和 `peerDependencies` 中的
直接 spec 都必须来自 registry，因为 npm 可能检查全部四者；git resolver 会被禁用。
不会运行生命周期脚本。安装失败会清理部分依赖/cache、上报渲染层且不阻塞导入。确认对话框
会与技能披露一并说明 npm 安装步骤。

如果 npm 或其 Node.js 运行时不可用，安装器会返回结构化的不可用错误。只有这类错误会打开
由 Main 管理的原生消息框，提供“选择 npm”和“取消”操作；普通的 registry、网络、依赖策略或
安装错误不会触发可执行文件路径选择。消息会说明 npm 必须来自可信的 Node.js 安装，所选路径
将用于后续导入；尚未安装 Node.js 时，应先安装。选择 npm 时会打开启用 `showHiddenFiles`
的原生可执行文件选择器，允许进入 `~/.nvm` 等安装目录。macOS 上的 `noResolveAliases`
会保留所选的 `bin/npm` 符号链接，而不是将其解析为内部 CLI 文件，以便继续找到同目录的
`node`。所选路径不会来自渲染层的文本输入。

Main 在保存路径或安装依赖之前，会通过有时间上限的版本检查验证所选可执行文件及其 Node.js
运行时。检查共享安装操作的时间预算，并受总上限约束，避免在较慢的机器上把可用的 npm
误判为不可用，反复要求用户选择。无效选择（包括 npm 存在但 Node.js 不可用）会显示本地化
原生警告，允许重新选择或取消；提示会引导用户选择与 `node` 位于同一目录的 npm。
只有通过校验的路径才会以原子方式保存到 Main 管理的 `<dataDir>/npm-path.json`，不会保存到
渲染层设置或 Host SQLite。后续导入会重新校验再复用该路径；已失效的路径会重新触发恢复提示。
如果保存失败，原生警告会说明无法记住所选路径，但当前导入仍可使用已通过校验的可执行文件。

macOS/Linux 未配置 npm 路径时，校验与安装会在继承的 `PATH` 后追加已存在的常见用户二进制
目录，包括 Homebrew 和 `~/.local/bin`，以便图形界面导入能够找到现有的 Node.js/npm，
而无需执行 shell 启动脚本。显式配置可执行文件时，其所在目录始终优先，不使用这些回退目录。
只改变安装子进程的环境，不修改应用的 `PATH`；禁止探测 shell 启动配置或修改全局环境。
版本检查与安装都使用不继承凭据的最小环境。仅允许 registry 的代理、隔离的 npm 配置、
有界的两阶段安装、禁用 git 解析及生命周期脚本等约束保持不变。Windows 上显式配置的
`.cmd` / `.bat` 启动器会直接使用相邻的 `node.exe` 和 `node_modules/npm/bin/npm-cli.js`，
不经过 shell 插值；缺少该目录布局的非标准启动器会被拒绝，并给出恢复指引。
恢复流程在已生成的插件目录内重试依赖安装，不会重新复制源文件或分配另一个插件 ID。
恢复成功、被取消（包括关闭选择器）或以依赖错误结束后，生成的插件都只加载并注册一次；
依赖错误保持可见，但不阻止注册。

所有原生恢复界面文案均使用当前语言的扁平键 `plugins.npmMissingTitle`、`npmMissingBody`、
`npmChoose`、`npmPickerTitle`、`npmInvalidTitle`、`npmInvalidBody`、`npmSaveFailedTitle`、
`npmSaveFailedBody`，以及已有的 `common.cancel`。正文是无需插值占位符的独立本地化文本；
Main 会将动态诊断信息另起一行追加。

| 来源 | 结果 |
|---|---|
| 一个 pi 扩展目录或文件 | `plugins/imported` 下的本地插件，id 为 `imported.<slug>` |
| 声明了 `contributes.agentExtensions` 的插件包 | 像其他插件一样安装；安装时询问该授权 |
| 带 `pi.extensions` 的 `package.json` | `src/` 下的入口，通过 `contributes.agentExtensions` 贡献，需 `agent.extension` |
| 带 `pi.skills` 的 `package.json` | `src/` 下的 Markdown 文档，通过 `contributes.skills` 贡献，需 `agent.prompt.inject` |
| 仅技能包 | 持有 `agent.prompt.inject` 的空操作插件，不授予 `agent.extension` |

`pi.skills` 是最多含 32 条非空路径的数组，每条路径相对于包目录，指向 Markdown 文件
或目录。明确指定的 `.md` 文件直接作为技能。对于目录，优先使用其自身的 `SKILL.md`；
若不存在，则纳入该目录直接包含的 `.md` 文件，并在子目录中查找 `SKILL.md`。
嵌套技能目录找到自身的 `SKILL.md` 后停止向下扫描，避免把支持文档变成额外技能。
扫描跳过点号开头的条目和 `node_modules`，对文档去重，目录扫描预算为 256。
发现超过 32 个技能、声明的路径不存在或路径类型不受支持时，导入失败，不会静默生成
不完整目录。每项贡献都按包内相对路径生成明确、稳定的插件内 ID，不同目录下同名的
`SKILL.md` 保持独立。既有插件技能正文解析、大小限制、权限与卸载行为保持不变。

复制时按所选包的相对路径判断排除项。包的祖先路径含 `node_modules` 不影响复制，
只排除包自身依赖目录中的 `node_modules` 路径段。引用文档、素材、辅助脚本及其他
普通源码文件保留在 `src/` 下，使技能的相对资源引用仍然成立。凭据文件（`.env*`、
`.npmrc`、`.netrc`、`.pypirc`、私钥和证书文件）及仓库元数据目录不会被复制。所选
根目录先解析为真实路径；贡献路径必须位于根目录内，不能包含 `..` 穿越，也不能指向
包内依赖目录。绝对 `pi.skills` 路径与后代符号链接会被拒绝；复制保留资源时也拒绝
符号链接，复制失败会清理部分生成的目录。生成目标以原子方式创建，不能位于所选源目录内。

这是显式本地导入，不是 pi CLI 包管理器：不会自动导入 `~/.pi`，不会读取 CLI
已安装包注册表，也不会执行 npm 生命周期脚本。“技能”页面会另外发现全局 npm 技能候选项。
声明依赖时，有界安装器只接受 registry
版本说明和 registry 来源的 npm lockfile，拒绝不安全的包路径和嵌套依赖 spec，禁用 git
解析，并隔离 npm 的配置/cache 与用户凭据和代理设置。导入包不代表其所有第三方扩展依赖都能执行。

## 4. 加载与运行时

### 4.1 扩展在哪里运行

扩展在 Agent sidecar 进程（`packages/agent-runtime`）内加载，永远不在 Electron
main、渲染层或插件宿主进程中。

### 4.2 Loader

- sidecar 将 `@earendil-works/pi-agent-core`、`pi-ai` 和 `pi-coding-agent` 锁定在完全相同的
  发布版本。Native Pi 会话在进程内运行 coding-agent 会话管理器，因此这些包是运行时依赖，
  并非仅用于类型契约。
- loader 镜像 `pi-coding-agent` 的发现规则，使用带 `virtualModules` 的
  `jiti/static`，babel 转换被打进包内，运行时不做路径解析。打包步骤由一个在仓库
  之外运行打包产物的契约测试验证（E2E-245）。
- 打包时设置 `--define:PI_BUNDLED_NODE=true`。在编译后的二进制、打包的 Node 发行版及其
  自身的 TypeScript 源码运行时中，`pi-coding-agent` 扩展加载器会内嵌内核模块和 `typebox`；
  其他 Node 构建则从导入文件所在位置解析它们，而打包安装目录（`resources/agent-runtime/`）
  无法满足这种解析方式。在进程内打包 pi 会话或扩展加载器的入口也必须设置同一编译常量。
- 导入别名：`pi-ai`、`pi-agent-core` 和 `typebox` 解析到 sidecar 自带的副本；
  `@earendil-works/pi-coding-agent` 解析到一个运行时 shim，导出 `defineTool` 和
  工具结果类型守卫。`@earendil-works/pi-tui` 解析到一个桩
  模块，它把每个符号导出为无实际作用的占位值，使顶层 import 永不失败。调用被桩替代的
  符号时在调用点产生一条诊断。
- 可信扩展的 coding-agent shim 仅公开文档列出的受支持助手。导入或访问其他根导出会
  产生 `unsupported_api` 诊断；该导出仍不可用，loader 不会加载完整 coding-agent
  运行时作为回退。
  `TRUSTED_EXTENSION_KERNEL_VERSION` 仍是该兼容层通过 `VERSION` 暴露的历史兼容标记，
  表示参照 0.87.1 API 的兼容子集，有意与实际安装包的发布版本区分。

### 4.3 每会话一个 Runner

- 每个桌面会话拥有自己的 Runner。Runner 随会话运行时创建，随其丢弃而销毁。
- 由于 jiti 缓存模块，模块实例在 Runner 之间共享。因此模块级状态在会话之间
  共享，这与扩展作者在 pi 单进程运行多会话时看到的一致。v1 记录这一点而不
  绕开它。
- 启用、禁用或重新扫描会使所有 Runner 失效；受影响的会话在下一个回合边界重新
  加载扩展。进行中的回合永不被重新加载打断。

### 4.4 加载失败

加载错误永不导致会话失败。该扩展在诊断中标记为 `error` 并附消息和堆栈，其余
扩展继续加载，回合照常进行。当某个已启用扩展在当前会话加载失败时，composer
显示一行提示。

## 5. API 支持矩阵（v1）

每个 `ExtensionAPI` 成员恰好落入一个类别。不支持的成员仍存在于对象上，不做
任何事，返回文档规定的中性值，并按扩展、按成员各产生一条诊断。它们永不抛出，
因此只使用受支持成员的扩展即使同时触碰了不支持的成员也能工作。

| 类别 | 成员 |
|---|---|
| 支持 | `registerTool`、`registerCommand`、`registerAgent`、`registerProvider`（插件自有的兼容别名，接口与 `registerAgent` 相同）、`unregisterAgent`、`unregisterProvider`、§6 中每个事件的 `on(...)`、`exec`、`getActiveTools`、`getAllTools`、`setActiveTools`、`getCommands`、`setModel`（支持已配置模型和插件 Agent；仅限空闲时调用；持久化当前会话绑定）、`getThinkingLevel`、`setThinkingLevel`、`setSessionName`、`getSessionName`、`sendUserMessage`（Host 队列，D386）、`getFlag` |
| 上下文上支持 | `ui.notify`、`ui.confirm`、`ui.select`、`ui.input`、`ui.setStatus`、`ui.setWorkingMessage`、`cwd`、`modelRegistry`、`isIdle`、`abort`、`hasPendingMessages`、`getContextUsage`、`compact`、`getSystemPrompt`、`waitForIdle`、`newSession`、`fork` |
| 推迟到 v2 | `sendMessage`、`appendEntry`、`setLabel`、`sessionManager` 只读 API、`switchSession`、`registerShortcut`、`registerMarkdownTransformer`、`ui.setEditorText`、`ui.getEditorText`、`ui.addAutocompleteProvider`、`registerFlag` 值编辑 |
| 不支持 | `ui.setWidget`、`ui.setFooter`、`ui.setHeader`、`ui.setTitle`、`ui.custom`、`ui.overlay`、`ui.onTerminalInput`、`ui.setWorkingVisible`、`ui.setWorkingIndicator`、`ui.setHiddenThinkingLabel`、`ui.pasteToEditor`、`ui.editor`、`registerMessageRenderer`、`registerEntryRenderer`、`navigateTree`、`shutdown` |

`getActiveTools` 描述的是向模型公开的工具声明，不代表执行授权。Plan/Goal 可以保留禁止执行的
Write/Edit 和已配置的 Task 系列工具声明；运行时会先执行模式门控，再调用扩展的工具调用 Hook
或处理器。插件不能仅凭名称出现在此列表中就推断自己具备执行权限。

`registerAgent({ id, name?, models, stream? | complete? })` 注册由插件实现的会话级 LLM 集成。
每个模型声明受限的公开元数据（`id`、显示名称、API 标签、模态、推理能力及限制）。插件回调
接收 pi-ai 的模型、上下文和选项，自行管理端点、认证、请求序列化与响应转换；必须遵循
`options.signal` 处理取消。`complete` 会被适配为仅产生一个结果的流。

宿主以 `extension-agent:<encoded-agent-key>` 分配 Provider ID。空闲时成功调用 `setModel`
后，Provider/模型组合通过 `session.configure` 持久化；下一回合会重新加载受信任扩展并恢复
Agent 实现。`modelRegistry` 只公开模型和认证是否可用，绝不暴露 Host API 密钥、密钥引用、
OAuth 令牌、任意 Host 请求头或 Host Provider 内部信息。`registerProvider` 及其注销接口是
兼容别名，接受同样的插件自有实现：提供 `stream` 或 `complete`，既支持上游的 `(id, config)`
形式，也支持对象形式。Host 忽略上游配置中的 Provider 凭据，且不会持久化这些凭据。

中性值：`getFlag` 返回声明的默认值；`registerFlag` 记录声明使 `getFlag` 可用，
但 v1 不暴露 CLI 或 UI；`sessionManager` 访问器返回空结果；UI setter 返回空操作
的 `dispose`。

## 6. 事件映射

事件从桌面运行时现有的 hook 点触发。凡事件类型定义了返回结果的，处理器结果
均被采纳。

| 事件 | 桌面 hook 点 | 是否采纳结果 |
|---|---|---|
| `session_start`、`session_shutdown` | Runner 创建与销毁 | 否 |
| `session_info_changed` | 经 `setSessionName` 的会话改名 | 否 |
| `project_trust` | v1 说明：不触发；按项目启用即信任决定 | 否 |
| `resources_discover` | v1 说明：不触发；skills 与提示发现留在 Electron main | 不适用 |
| `before_agent_start` | 回合内首个 provider 请求之前 | 是，返回的系统提示词按处理器顺序链式替换 |
| `context` | `transformContext`，在一次运行的每个 provider 请求之前触发（包括第一个） | 是，替换消息列表，只作用于该次请求；运行上下文和 transcript 保留原消息 |
| `before_provider_request`、`before_provider_headers`、`after_provider_response` | provider 调用包装 | 请求采纳返回值；头部原地修改 payload |
| `agent_start`、`agent_end`、`agent_settled` | Agent 循环边界 | 否 |
| `turn_start`、`turn_end` | 回合边界 | 否 |
| `message_start`、`message_update`、`message_end` | Agent 消息事件 | v1 说明：否，pi-agent-core 不提供事后替换 |
| `tool_call` | `beforeToolCall` | 是，可带理由阻止 |
| `tool_execution_start`、`tool_execution_update`、`tool_execution_end` | 工具执行流 | 否 |
| `tool_result` | `afterToolCall` | 是，替换结果 |
| `model_select`、`thinking_level_select` | v1 说明：不触发；绑定变更会使当前运行时退役 | 否 |
| `session_before_compact`、`session_compact`、`session_compact_failed` | 压缩流水线 | `session_before_compact` 为是 |
| `session_before_fork` | v1 说明：不触发；fork 在 Electron main 执行 | 不适用 |
| `input` | v1 说明：不触发；Host 队列准入尚未接入 | 不适用 |
| `user_bash`、`session_before_switch`、`session_before_tree`、`session_tree`、`ui_prompt_start`、`ui_prompt_end` | v1 不触发 | 不适用 |

对于 `before_agent_start`，每个处理器收到独立的载荷副本，其中包含上一个成功返回的字符串
`systemPrompt`。桌面端按扩展 ID 排序提供扩展，同一扩展内的处理器按注册顺序执行。
返回 `event.systemPrompt + suffix` 会保留此前追加的内容；返回不同的字符串（包括空字符串）
则会明确替换当前提示词。提示词字段缺失或不是字符串、处理器异常、超时，以及未通过返回值
提交的输入修改，都不会覆盖上一个已接受的提示词。取消的派发不返回结果，迟到的完成不能
改变该结果。用户发起的运行载荷还携带 `messageType: "user"` 和 `prompt`，与 Pi 1.3 的判别字段
一致。这是对历史兼容层的增量补充，不会启用 `sendMessage` 或自定义消息运行。
Native Pi 会话继续使用上游 SDK 的事件联合类型和生命周期。

每一回合都从新组合的基础提示词开始执行该处理链，不会跨回合累积追加内容。同样的有序处理器、
基础提示词和返回字符串会产生完全相同的提示词字节；这不保证 Provider 缓存命中，也不会让插件
自己生成的内容变得稳定。此处没有引入追加字段或新插件 API，其他事件保持现有归并规则。
参见 [ADR 0214](/adr/0214-trusted-extensions)。

Desktop 事件能力由 `packages/agent-runtime/src/extensions/event-capabilities.ts`
维护，分为返回值、原地修改、通知和未接通。未接通事件仍可注册，但会在现有插件诊断中
显示 `unsupported_api`，不妨碍其他已支持的处理器加载。

所有事件处理器（包括启动、关闭和通知）均有每个处理器 30 秒的等待上限。模块加载和
工厂初始化分别有 30 秒上限，失败归入加载或工厂诊断。处理器异常或超时记诊断并视为
返回 `undefined`，后续处理器按注册顺序继续。既有结果归并和失败继续策略保持不变，
不能将其作为强制安全检查。多个挂起处理器可能分别耗尽各自的时间预算。

中止会使等待中的事件派发失效。销毁先拒绝新派发并取消已有等待，再执行关闭处理器；
并发销毁只关闭一次。旧派发不返回结果、不再执行剩余处理器，迟到的完成或异常不会覆盖
结果或增加诊断。销毁后完成的工厂不能发布工具和命令。Runtime 在等待扩展关闭前先停止
Agent 工作。在请求前 hook 等待期间停止，不会继续请求模型，并保留用户消息；之后可正常
发送下一条消息。

每次调用拥有独立的 `ctx.signal`，完成、超时、Stop 或销毁后失效。旧回调再调用 SDK
会被拒绝，包括等待空闲、创建会话、fork 和发送消息的后续步骤。已提交给 Host 的事务
不回滚，但迟到返回不再触发队列优先级更新或修改 Runtime 模型状态。命令与工具不套用
事件的 30 秒上限，可运行至完成、传入信号取消、Stop 或销毁；迟到的工具进度和结果被丢弃。
已采纳的工具进度和结果会先复制再发布，扩展之后的原地修改不能改写它们。`pi.exec`
创建的进程树随作用域退出或显式超时终止，销毁等待已登记进程清理并报告失败。
主动逃离进程组或通过 Node API 直接创建的进程不在此所有权范围。

带返回值的 Hook 输入输出使用独立副本，头部修改仅在处理器及时成功后提交。
迟到的原地修改不会影响宿主或下一处理器。

这些是协作式生命周期约束，不是强制执行隔离：可信代码仍可同步阻塞 JS 或直接使用
Node API 产生外部副作用。Native Pi 会话由上游 SDK 管理，不属于本次 Desktop 变更。
参见 ADR `trusted-extension-operation-ownership`。
事件处理器等待 UI 提示时也受 30 秒限制，
UI broker 自身的提示超时不会延长该预算。

## 7. 工具

1. 注册的工具以其声明名称加入会话工具目录。与核心工具、插件工具或用户 MCP
   工具同名的注册被拒绝并记诊断；先注册者胜出。
2. 扩展工具是非核心工具：与插件工具遵循相同的模式门控和 ToolSearch 延迟。它们
   在 Agent 模式可用，其他模式遵循现有的按模式白名单。
3. 执行在 sidecar 内按 `ExtensionAPI` 的 `execute` 签名进行。不弹出宿主权限提示；信任决定已
   在启用时做出。`onUpdate` 流映射到工具执行更新事件。
4. 每次执行写一条审计记录，含扩展 id、工具名和耗时。不记录参数。
5. `exec` 在 sidecar 内以会话工作目录、会话代理和环境设置运行。该目录（也是
   `ctx.cwd`）是项目根；临时会话使用它自己的 scratch 目录（D114），运行时在加载
   扩展前创建，不会退回 sidecar 的进程目录。

## 8. 命令

1. `registerCommand` 条目出现在全局搜索的 Commands 区（见
   [09-plugin-command-palette.md](/zh-CN/spec/07-plugins/09-plugin-command-palette)），
   形式为 `/<name>`，来源显示扩展标签，排在内置和插件命令之后。
2. 命令在 sidecar 内运行，扩展命令上下文绑定到当前会话。它需要一个在本次应用
   运行中已加载扩展的活动会话；否则 composer 提示需先开始对话。
3. composer 中输入的 `/<name>` 按此顺序解析：内置、提示模板、插件、扩展。冲突
   记为诊断。
4. 运行中的命令与插件命令一样阻止 composer 提交，可从状态栏取消。

## 9. UI 桥接

交互式上下文调用经 sidecar → Electron main → 渲染层往返。

| 调用 | 渲染层界面 | 超时 | 中止时 |
|---|---|---|---|
| `ui.notify` | Toast | 无 | 丢弃 |
| `ui.confirm` | 双动作模态框 | 5 分钟 | 解析为 `false` |
| `ui.select` | 模态列表 | 5 分钟 | 解析为 `undefined` |
| `ui.input` | 模态文本框 | 5 分钟 | 解析为 `undefined` |
| `ui.setStatus`、`ui.setWorkingMessage` | 当前会话的浮动状态行（v1 说明：不在 composer 内） | 无 | 清空 |

规则：

- 每会话同一时刻只有一个待处理交互提示。第二个调用排在第一个之后。
- 中止回合时以上述中止值取消待处理提示。
- 每个新建的 sidecar UI 请求都有归属于当前调用的请求 ID。取消操作按该 ID 以及会话和扩展
  身份定位请求：丢弃排队中的请求，并向渲染层发送针对当前可见提示的精确退役通知。
  旧请求的取消不会关闭后续请求。不带 ID 的历史请求仍按会话整体取消。已完成的队列尾链会被释放。
- 远程控制（MVP 后）下提示立即以 `UNSUPPORTED` 失败，直到远程协议路由它；该
  路由属于 v3。
- 提示显示扩展标签和来源路径，让用户知道是谁在询问。

## 10. 协议与 IPC 新增

v1 不改任何 host-core RPC 方法、协议版本或 SQLite schema。

### 10.1 sidecar → main（host.proxy 白名单）

| 方法 | 用途 |
|---|---|
| `extensions.commands.publish` | 替换会话已注册的命令列表 |
| `extensions.ui.request` | §9 中的一次交互或状态调用 |
| `extensions.diagnostics.publish` | 替换会话的诊断列表 |
| `extensions.model.configure` | 校验插件自有的 provider/模型绑定，经 `session.configure` 持久化，然后广播 `session:modelChanged` |
| `session.rename`、`session.create`、`session.fork`、`session.queuePush`、`session.queuePrioritize` | 已有方法，现可从适配层到达 |

### 10.2 main ↔ 渲染层（Electron IPC）

| 通道 | 方向 | 用途 |
|---|---|---|
| `plugin/importExtension` | 请求 | 原生选择器、生成插件、注册为开发插件 |
| `extensions/commands/run` | 请求 | 在当前会话运行已注册命令 |
| `extensions/ui/respond` | 请求 | 回答一个待处理提示 |
| `extensions/ui/prompt` | 事件 | 有提示待处理 |
| `extensions/event/status` | 事件 | `ui.setStatus` / `ui.setWorkingMessage` 文本变化 |
| `plugin/list` | 请求 | 插件行携带 `agentExtension` 状态、工具、命令、自定义 Agent 名称和诊断 |
| `event/pluginChanged` | 事件 | 会话发布命令、诊断或模型绑定变化时同样触发 |

所有通道像其他插件通道一样做 sender 校验。MCP 控制面暴露 `extensions/commands/run`
（写）和 `extensions/ui/respond`（危险，需 confirm）；导入是原生选择器，保持本地。
main 在 `logs/app/plugin.log` 审计每个提示 id。

## 11. 插件行界面

插件页在所属插件的行上展示 agent 扩展：

- `agentExtension` 能力标记和 `agent.extension` 权限标记（高风险），与其他能力和权限
  并列。
- 详情区含状态标记（`enabled` 直到本次应用运行中有会话加载模块、`loaded`、`error`）、
  已注册的工具、斜杠命令与自定义 Agent 名称，以及诊断：加载错误、带计数的不支持 API 调用、被拒绝的
  注册、处理器超时。
- 页面溢出菜单中的“导入 pi 扩展”，前置一个说明授权含义的确认。

## 12. 分阶段

| 阶段 | 内容 | 承诺 |
|---|---|---|
| v1 | loader、每会话 Runner、支持矩阵、事件、工具、命令、UI 桥接 | 已交付（D387） |
| v1.1 | 模块成为带 `agent.extension` 授权的 `contributes.agentExtensions`；把 pi CLI 扩展导入为开发插件；独立注册表和设置标签移除 | 已交付（D388） |
| v1.1 修订 | 通过 `registerAgent` 注册插件自有的自定义 Agent、Provider 兼容别名、脱敏模型注册表、仅限空闲时切换的会话绑定，以及通过 `extension-agent:` ID 恢复绑定 | 已实现（D426 / ADR 0258） |
| v2 | 自定义会话条目（`sendMessage`、`appendEntry`）含 schema 升版和通用渲染、`sessionManager` 只读 shim、`switchSession`、编辑器读写、补全 provider、`registerShortcut`、markdown 转换器 | 已规划，需先决定条目持久化与压缩 |
| v3 | 只读地将 pi CLI 的 `settings.json` 用作发现线索、统一技能与提示词发现、远程控制下的提示路由、市场上架 | 尚未排期 |

显式本地包导入（包括 `pi.extensions` / `pi.skills` 和有界、仅限 registry 的依赖准备）已在
§3.2 实现。这不代表承诺提供通用 pi 包管理器或自动发现设置的能力。

v1 交付顺序：打包 spike（E2E-245）、shared 协议类型，然后运行时、main、渲染层
三条线并行。

## 13. 版本策略

- 升级 sidecar 内核时，`pi-agent-core`、`pi-ai` 和 `pi-coding-agent` 必须一并升级到同一精确版本；
  依赖检查会验证这些直接依赖的锁定版本。Desktop 的 `pi-ai` 与 `pi-mcp` 开发依赖跟随同一版本。
- 扩展兼容层的 `VERSION` 字段使用共享的 `TRUSTED_EXTENSION_KERNEL_VERSION` 标记，而不是包的
  发布版本。只有经过明确的兼容性审查，并配套兼容层契约测试后，才能修改该标记。
- 一组覆盖每个受支持成员的样例扩展在每次升级时作为契约测试运行。
- 新增的 `ExtensionAPI` 成员先落入“不支持”类别并产生诊断，直到后续决策
  移动它们。
- 对外文档只承诺 §5 中“支持”和“上下文上支持”两个类别。

## 14. 待决事项

| 问题 | 决定前的默认 |
|---|---|
| v2 自定义条目是否持久化到 host-core 并参与压缩？ | 持久化；不进入压缩摘要 |
| v3 是否把 pi CLI `settings.json` 的启用路径作为发现提示读取？ | 只读提示，永不写入 |
| 扩展工具是否像插件工具一样按项目可选？ | §2 第 4 项所述的插件激活范围是唯一门控 |
