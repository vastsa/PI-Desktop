# 16. 受信任扩展

> **翻译说明：** 本页是与 [英文源规格](/spec/07-plugins/16-trusted-extensions) 一一对应的机器辅助翻译。代码、协议字段和标识符保持原文；如翻译与英文源事实有歧义，以英文版本为准。

> 状态：v1.1 已实现（D387 / D388、ADR 0214 / ADR 0215）；实现说明标注为“v1 说明”
> 范围：v1.1。v2 与 v3 事项列于 §12，不构成承诺。

## 1. 目的与术语

插件（[01-plugin-system.md](/zh-CN/spec/07-plugins/01-plugin-system)）是 PI-Desktop
唯一的扩展面。本文规定其中一种插件贡献点 `contributes.agentExtensions`：在 Agent
sidecar 内运行的 TypeScript 或 JavaScript 模块，接收一个 `ExtensionAPI` 对象，直接在
agent 循环上注册工具、命令和事件处理器。`ExtensionAPI` 契约即
`@earendil-works/pi-coding-agent` 定义的契约，PI-Desktop 与 `pi-ai`、`pi-agent-core`
内核（ADR 0002）一起采纳，因此为 pi CLI 写的扩展就是插件贡献的模块。D388 把此前
独立的“受信任扩展”注册表并入了这个贡献点；下文的引擎部分不变。

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

这是显式本地导入，不是 pi CLI 包管理器：不会自动扫描或导入 `~/.pi`，不会读取 CLI
已安装包注册表，也不会执行 npm 生命周期脚本。声明依赖时，有界安装器只接受 registry
版本说明和 registry 来源的 npm lockfile，拒绝不安全的包路径和嵌套依赖 spec，禁用 git
解析，并隔离 npm 的配置/cache 与用户凭据和代理设置。导入包不代表其所有第三方扩展依赖都能执行。

## 4. 加载与运行时

### 4.1 扩展在哪里运行

扩展在 Agent sidecar 进程（`packages/agent-runtime`）内加载，永远不在 Electron
main、渲染层或插件宿主进程中。

### 4.2 Loader

- sidecar 以与 `pi-ai`、`pi-agent-core` 完全相同的锁定版本依赖
  `@earendil-works/pi-coding-agent`，仅作类型依赖。三者版本必须一致；漂移时 CI 失败。
- loader 镜像 `pi-coding-agent` 的发现规则，使用带 `virtualModules` 的
  `jiti/static`，babel 转换被打进包内，运行时不做路径解析。打包步骤由一个在仓库
  之外运行打包产物的契约测试验证（E2E-245）。
- 导入别名：`pi-ai`、`pi-agent-core` 和 `typebox` 解析到 sidecar 自带的副本；
  `@earendil-works/pi-coding-agent` 解析到一个运行时 shim，导出 `defineTool` 和
  工具结果类型守卫。`@earendil-works/pi-tui` 解析到一个桩
  模块，它把每个符号导出为惰性值，使顶层 import 永不失败。调用被桩替代的
  符号时在调用点产生一条诊断。

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
因此只使用受��持成员的扩展即使同时触碰了不支持的成员也能工作。

| 类别 | 成员 |
|---|---|
| 支持 | `registerTool`、`registerCommand`、§6 中每个事件的 `on(...)`、`exec`、`getActiveTools`、`getAllTools`、`setActiveTools`、`getCommands`、`setModel`（v1 说明：返回 `false`，桌面拥有会话的 provider 绑定）、`getThinkingLevel`、`setThinkingLevel`、`setSessionName`、`getSessionName`、`sendUserMessage`（Host 队列，D386）、`getFlag` |
| 上下文上支持 | `ui.notify`、`ui.confirm`、`ui.select`、`ui.input`、`ui.setStatus`、`ui.setWorkingMessage`、`cwd`、`modelRegistry`、`providers`、`isIdle`、`abort`、`hasPendingMessages`、`getContextUsage`、`compact`、`getSystemPrompt`、`waitForIdle`、`newSession`、`fork` |
| 推迟到 v2 | `sendMessage`、`appendEntry`、`setLabel`、`sessionManager` 只读 API、`switchSession`、`registerShortcut`、`registerMarkdownTransformer`、`ui.setEditorText`、`ui.getEditorText`、`ui.addAutocompleteProvider`、`registerFlag` 值编辑 |
| 不支持 | `ui.setWidget`、`ui.setFooter`、`ui.setHeader`、`ui.setTitle`、`ui.custom`、`ui.overlay`、`ui.onTerminalInput`、`ui.setWorkingVisible`、`ui.setWorkingIndicator`、`ui.setHiddenThinkingLabel`、`ui.pasteToEditor`、`ui.editor`、`registerMessageRenderer`、`registerEntryRenderer`、`navigateTree`、`shutdown` |

中性值：`getFlag` 返回声明的默认值；`registerFlag` 记录声明使 `getFlag` 可用，
但 v1 不暴露 CLI 或 UI；`sessionManager` 访问器返回空结果；UI setter 返回空操作
的 `dispose`。

`modelRegistry` 是由 Electron main 投影、经 `models.list` 门控的、Runner 作用域的
就绪宿主模型快照：已启用且认证完整的 provider 行，用目录元数据补全，携带 `baseUrl`
与能力字段，且不含任何凭据材料。没有该授权时，它只返回会话模型与插件注册的 agent
模型。`getAll` 与 `getAvailable` 投影同一份就绪集合。读取从快照同步进行，
`refresh()` 重新拉取快照。PI 未实现的所有上游成员——`getProvider`、`getError`、
`isUsingOAuth`、`getApiKeyAndHeaders`、`getApiKeyForProvider`、`getProviderAuth`、
`complete`、`stream`、`streamSimple`，以及注册系列——都存在、返回其文档化的中性值，
并按扩展、按成员各产生一条诊断（ADR 0304）。插件自有的 provider 保留其原有答案：
其认证状态报告为已配置且 `source: "runtime"`，其显示名是插件 agent 的名称，
且 `hasConfiguredAuth` 对它返回 true。main 不拥有的会话 id 会在任何目录读取之前被拒绝。

### 5.1 provider 请求面

`ctx.providers.request(input)` 向调用方点名的一条 provider 行发出一次带认证的 HTTP
请求。它刻意不是补全 API：路径由调用方给出，因此同一个成员可以到达
`/chat/completions`、`/images/generations`、`/embeddings`，或该 provider 暴露的
任何其他路径。Host 只贡献三样东西，且不含任何协议特定内容 —— 目标 origin、凭据和
传输策略。它按调用方的要求组装信封，却从不解释它，不知道流式，也不把 provider
响应映射成 PI 类型（ADR 0305）。

| 输入 | 契约 |
|---|---|
| `providerId` | 必填，永不推断。缺少它的调用是 `INVALID_ARGUMENT`；没有默认 provider，也不回退到会话模型 |
| `modelId` | 可选；用于选择模型级的 provider 细节，且必须是该 provider 的模型之一，包括其 `defaultModelId`（否则为 `MODEL_NOT_CONFIGURED`）。它永不注入请求体 |
| `path` | 追加到 provider 行的 `baseUrl` 之后。校验见下文 |
| `method` | `GET`（默认）、`POST`、`PUT`、`PATCH`、`DELETE` |
| `headers` | 在既有 provider 请求头上限之内合并。Host 拒绝 `authorization`、`proxy-authorization`、`cookie`、`set-cookie`、`host`、`content-length`、`content-type`、`connection`、`transfer-encoding`、`upgrade`、`te`、`trailer`、`keep-alive`、`x-api-key`、`api-key`、`chatgpt-account-id` 以及任何 `x-forwarded-*` |
| `body` | 联合类型：`json`（由 Host 序列化）、`text`、`base64` 或 `multipart`。`content-type` 归 Host 所有，multipart 边界由 Host 生成，且永不嗅探内容；`GET` 上的请求体被拒绝 |
| `timeoutMs` | 单次调用预算：默认 60 000，最大 300 000 |
| `signal` | 取消该调用，包括已经在途的调用 |

目的地（规范性）。最终 URL 的 scheme、host 和 port 来自 provider 行的 `baseUrl`，
调用方的路径追加到基础路径之后：只有路径由调用方控制，没有隐式的 `/v1`，查询字符串
属于路径的一部分。调用方字符串若为空、超过 2048 字节、是绝对 URL、是相对 scheme 的
URL，或携带反斜杠、片段、控制字符，或含 `..` 路径段 —— 包括只在路径的百分号解码之后
才出现的那种（解码最多两轮）—— 都是 `INVALID_ARGUMENT`。查询字符串是调用方自己的
数据，原样透传、不做解码，因此其中的 `..` 或 `%` 既不会逃出基础前缀，也不会让调用被
拒绝。规范化之后，最终 origin 必须等于基础 origin，且解码后的最终 pathname 必须以
解码后的基础 pathname 开头；该校验在 Electron main 中执行，永不在 sidecar 或扩展中
执行。

凭据与传输。凭据经 `providers.get` 与 `providers.getSecret` 解析，其请求头由 Host
**最后**设置，因此调用方无法覆盖或伪造它。不存在或已被禁用的行是
`PROVIDER_NOT_FOUND`；需要密钥却没有存储的行是 `PROVIDER_AUTH_MISSING`；
`authKind: "oauth"` 在 v1 是 `PROVIDER_AUTH_UNSUPPORTED`，因为厂商账户的线上端点是
模型相关的，其令牌也是短时的。重定向**不**跟随：3xx 连同其 `location` 作为结果返回，
因此凭据永不会被重发给 provider 行没有点名的 host。这条路径上没有自动重试；
`Retry-After` 请求头会以 `retryAfterMs` 浮现，供调用方自行控制节奏。

响应。HTTP 响应 —— 包括 4xx 与 5xx —— 是**结果**，不是 Host 错误：它携带 `status`、
`statusText`、`ok`、`contentType`、请求头，以及按形态解码的响应体（媒体类型为 JSON
且解析成功时为 `json`，文本类型为 `text`，否则为 `base64`）及其字节长度。返回的请求头
中会剥掉 `set-cookie` 与凭据请求头。超过 4 MiB 的响应体是 `RESPONSE_TOO_LARGE`，
而不是被截断。

授权。`ctx.providers.request` 需要 `provider.request` 授权（高风险，安装时确认）。
它带着用户的凭据触达整个 provider API 面 —— 任意路径、任意方法 —— 包括花钱的端点，
因此没有任何现有权限覆盖它，且每次调用都记审计。主体从 main 拥有的状态解析：main 在
启动时填充的会话→项目映射，加上已加载插件注册表。线上载荷携带会话 id、*声称的*
`extensionId` 和一个 `callId`；不在该会话已加载扩展集合内的 id 会被拒绝，声称的 id
只用于审计归属。没有授权时该调用是 `PERMISSION_DENIED` 并记一条审计。向同一个会话
贡献扩展的两个插件在运行时无法区分（它们的模块共享一个进程），因此门控是两者授权的
并集 —— 这是已记录的残余限制，不是隔离。

刹车。请求与插件宿主共享 `agent.complete` 计数器（每个插件每滚动 60 秒 8 次），
每个插件最多 4 个在途，且各自有独立预算，预算从 main 接受该调用的那一刻起算，因此
provider 解析和上传读取都无法跑到它之外。在离开 Host 之前就被拒绝的调用 —— 参数被
拒、provider 不可用、在途上限 —— 不消耗配额；刹车在请求即将派发时才计费。审计行记录
扩展 id、刹车计费到的插件、会话中贡献扩展的插件、provider 与 model id、方法、去掉
查询字符串的最终路径、状态、耗时、文件数，以及请求与响应字节大小 —— 永不含查询字符串、
请求头值、字段值或凭据。

上传。`multipart.files` 条目只从会话拥有的根读取 —— 会话项目根、其 scratch 目录和
附件库 —— 解析时考虑符号链接，并在读取过程中受限：最多 8 个文件、单文件 32 MiB、
每个载荷 64 MiB。Host 内部路径不能通过这种方式读取。

| 失败 | 代码 |
|---|---|
| 缺少授权，或 `extensionId` 不在该会话已加载集合内 | `PERMISSION_DENIED` |
| 被拒绝的路径、缺失或为空的 `providerId`、非法方法或请求体形态、超限的请求体或请求头、multipart 分片中的控制字符或路径分隔符、未知的 `timeoutMs`、Host 无法读取的 `multipart.files` 条目，或不是 Host 所记录目录的会话 scratch 根 | `INVALID_ARGUMENT` |
| 没有该 provider 行，或它已被禁用 | `PROVIDER_NOT_FOUND` |
| `modelId` 不是该 provider 的绑定 | `MODEL_NOT_CONFIGURED` |
| 该行需要密钥且没有存储 | `PROVIDER_AUTH_MISSING` |
| v1 中 `authKind === "oauth"` | `PROVIDER_AUTH_UNSUPPORTED` |
| 传输失败、DNS、TLS、连接被拒 | `NETWORK_ERROR` |
| `providers.get` 或 `providers.getSecret` 往返失败且没有自己的代码（宿主不可达） | `HOST_UNAVAILABLE` |
| 不带自身代码的意外 Host 失败 | `INTERNAL` |
| 单次调用预算耗尽 | `TIMEOUT` |
| 调用方、运行时或会话拆除取消了该调用 | `ABORTED` |
| 响应超过 4 MiB（携带 `status` 与 `bytes`） | `RESPONSE_TOO_LARGE` |
| 每插件刹车或在途上限 | `RATE_LIMITED` |
| 该宿主没有传输层（无头的 `pi-host`） | `UNSUPPORTED` |
| `multipart.files` 路径不存在或不是普通文件 | `FILE_NOT_FOUND` |
| `multipart.files` 路径解析到项目、scratch 和附件根之外 | `FILE_OUTSIDE_ALLOWED_ROOTS` |
| 单个上传文件超过其单文件上限 | `FILE_TOO_LARGE` |
| multipart 载荷超过其总上限 | `UPLOAD_TOO_LARGE` |

取消是双向的：sidecar 铸造 `callId`，随请求发送，并在调用方的 signal 触发或其自身
截止时间到达时针对该 id 发送 `extensions.providers.abort`。main 在接受该调用的那一刻
—— 早于 provider 解析和任何上传读取 —— 就以 `(sessionId, callId)` 为键注册该调用的
`AbortController`，因此在预检期间到达的中止会被遵守而不是被抢先跑完；调用落定时清除
该条目，并在 sidecar 退出或运行时被销毁时中止所有尚未完成的调用，因此活得比其 Runner
更久的调用会被丢弃，而不是投递给被替换的 Runner。main 不拥有的会话 id 无法触达一个
存活的调用。

HTTP 状态是结果，不是错误码；被拒绝的文件路径、上限或分片形态则抛出异常，因为该请求
从未离开 Host。

## 6. 事件映射

事件从桌面运行时现有的 hook 点触发。凡事件类型定义了返回结果的，处理器结果
均被采纳。

| 事件 | 桌面 hook 点 | 是否采纳结果 |
|---|---|---|
| `session_start`、`session_shutdown` | Runner 创建与销毁 | 否 |
| `session_info_changed` | 经 `setSessionName` 的会话改名 | 否 |
| `project_trust` | v1 说明：不触发；按项目启用即信任决定 | 否 |
| `resources_discover` | v1 说明：不触发；skills 与提示发现留在 Electron main | 不适用 |
| `before_agent_start` | 回合内首个 provider 请求之前 | 是，仅替换系统提示词 |
| `context` | `prepareNextTurn` | 是，替换消息列表 |
| `before_provider_request`、`before_provider_headers`、`after_provider_response` | provider 调用包装 | 请求采纳返回值；头部原地修改 payload |
| `agent_start`、`agent_end`、`agent_settled` | Agent 循环边界 | 否 |
| `turn_start`、`turn_end` | 回合边界 | 否 |
| `message_start`、`message_update`、`message_end` | Agent 消息事件 | v1 说明：否，pi-agent-core 不提供事后替换 |
| `tool_call` | `beforeToolCall` | 是，可带理由阻止 |
| `tool_execution_start`、`tool_execution_update`、`tool_execution_end` | 工具执行流 | 否 |
| `tool_result` | `afterToolCall` | 是，替换结果 |
| `model_select`、`thinking_level_select` | v1 说明：不触发；绑定变更会重建运行时 | 否 |
| `session_before_compact`、`session_compact`、`session_compact_failed` | 压缩流水线 | `session_before_compact` 为是 |
| `session_before_fork` | v1 说明：不触发；fork 在 Electron main 执行 | 不适用 |
| `input` | v1 说明：不触发；Host 队列准入尚未接入 | 不适用 |
| `user_bash`、`session_before_switch`、`session_before_tree`、`session_tree`、`ui_prompt_start`、`ui_prompt_end` | v1 不触发 | 不适用 |

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
迟到的原地修改不会影响宿主或下一处理器。UI 请求按请求 ID、会话和扩展身份取消，
排队请求被丢弃，已显示的弹窗向渲染层发送精确退役通知；旧取消不会关闭新请求。

这些是协作式生命周期约束，不是强制执行隔离：可信代码仍可同步阻塞 JS 或直接使用
Node API 产生外部副作用。Native Pi 会话由上游 SDK 管理，不属于本次 Desktop 变更。
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
5. `exec` 在 sidecar 内以会话工作目录、会话代理和环境设置运行。

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
| `extensions.providers.list` | 把就绪宿主模型目录投影给会话的扩展，由 `models.list` 门控（ADR 0304） |
| `extensions.providers.request` | 一次带认证的 provider 请求，由 `provider.request` 把关；以 HTTP 结果或带错误码的失败作答（ADR 0305） |
| `extensions.providers.abort` | 按 `(sessionId, callId)` 取消在途请求；由传输层作答，不作为请求记入审计 |

### 10.2 main ↔ 渲染层（Electron IPC）

| 通道 | 方向 | 用途 |
|---|---|---|
| `plugin/importExtension` | 请求 | 原生选择器、生成插件、注册为开发插件 |
| `extensions/commands/run` | 请求 | 在当前会话运行已注册命令 |
| `extensions/ui/respond` | 请求 | 回答一个待处理提示 |
| `extensions/ui/prompt` | 事件 | 有提示待处理 |
| `extensions/event/status` | 事件 | `ui.setStatus` / `ui.setWorkingMessage` 文本变化 |
| `plugin/list` | 请求 | 插件行携带 `agentExtension` 状态、工具与命令名和诊断 |
| `event/pluginChanged` | 事件 | 会话发布命令或诊断时同样触发 |

所有通道像其他插件通道一样做 sender 校验。MCP 控制面暴露 `extensions/commands/run`
（写）和 `extensions/ui/respond`（危险，需 confirm）；导入是原生选择器，保持本地。
main 在 `logs/app/plugin.log` 审计每个提示 id。

## 11. 插件行界面

插件页在所属插件的行上展示 agent 扩展：

- `agentExtension` 能力标记和 `agent.extension` 权限标记（高风险），与其他能力和权限
  并列。
- 详情区含状态标记（`enabled` 直到本次应用运行中有会话加载模块、`loaded`、`error`）、
  已注册的工具与斜杠命令名，以及诊断：加载错误、带计数的不支持 API 调用、被拒绝的
  注册、处理器超时。
- 页面溢出菜单中的“导入 pi 扩展”，前置一个说明授权含义的确认。

## 12. 分阶段

| 阶段 | 内容 | 承诺 |
|---|---|---|
| v1 | loader、每会话 Runner、支持矩阵、事件、工具、命令、UI 桥接 | 已交付（D387） |
| v1.1 | 模块成为带 `agent.extension` 授权的 `contributes.agentExtensions`；把 pi CLI 扩展导入为开发插件；独立注册表和设置标签移除 | 已交付（D388） |
| v1.1 修订 | 受信任扩展的 provider 访问：由 `models.list` 门控的就绪模型投影，以及面向具名 provider 行发出一次带认证请求的 `provider.request` 面 | 已实现（ADR 0304 / ADR 0305） |
| v2 | 自定义会话条目（`sendMessage`、`appendEntry`）含 schema 升版和通用渲染、`sessionManager` 只读 shim、`switchSession`、编辑器读写、补全 provider、`registerShortcut`、markdown 转换器 | 已规划，需先决定条目持久化与压缩 |
| v2 | 自定义会话条目（`sendMessage`、`appendEntry`）与一次 schema 升级及通用渲染层、`sessionManager` 只读 shim、`switchSession`、编辑器读写、自动补全 provider、`registerShortcut`、markdown 转换器 | 计划中，需要就条目持久化与压缩作出决定 |
| v3 | `pi` 包 manifest 与安装、pi CLI `settings.json` 的只读提示、统一 skill 与提示发现、提示的远程控制路由、市场列出 | 未排期 |

v1 交付顺序：打包 spike（E2E-245）、shared 协议类型，然后运行时、main、渲染层
三条线并行。

## 13. 版本策略

- 升级任一 pi 包即同时升级三个包。
- 一组覆盖每个受支持成员的样例扩展在每次升级时作为契约测试运行。
- 新增的 `ExtensionAPI` 成员先落入“不支持”类别并产生诊断，直到后续决策
  移动它们。成员只在记录该决策的同一次变更中转为受支持：`modelRegistry` 及其目录
  投影由 ADR 0304 移动，`provider.request` 执行面及其 `provider.request` 授权由
  ADR 0305 移动。
- 对外文档只承诺 §5 中“支持”和“上下文上支持”两个类别。

## 14. 待决事项

| 问题 | 决定前的默认 |
|---|---|
| v2 自定义条目是否持久化到 host-core 并参与压缩？ | 持久化；不进入压缩摘要 |
| v3 是否把 pi CLI `settings.json` 的启用路径作为发现提示读取？ | 只读提示，永不写入 |
| 扩展工具是否像插件工具一样按项目可选？ | §3.2 的范围是唯一门控 |
