# 扩展 provider 与模型访问

> **翻译说明：** 本页是与 [英文源方案](/project/extension-model-registry-plan) 一一对应的机器辅助翻译。代码、协议字段和标识符保持原文；如翻译与英文源事实有歧义，以英文版本为准。

一份针对受信任 agent 扩展面上两项能力的方案：

- **A. 信息。** 扩展可以看到用户已配置的 provider 和模型，以及它们的认证可用性。
- **B. 请求。** 扩展可以针对选定的 `(providerId, modelId)` 发起请求，调用方提供
  的路径会追加到该 provider 的 `baseUrl` 之后，请求体可以是 JSON、文本或
  `multipart/form-data`，由宿主提供凭据。

- 状态：Proposed（设计评审；本次变更集不含实现）
- 基线：`main` @ `43a373735`（v0.15.2；宿主协议 11，schema 16）
- 分支：`feat/plugin-model-registry-api`
- 宿主协议：不变。Host-core RPC：不变。数据库 schema：不变。
- 相关：规格 `07-plugins/16-trusted-extensions.md`（§5 支持矩阵、§10.1 代理允许列表、
  §12 分阶段、§13 版本管理）、
  `07-plugins/12-plugin-ipc-and-host-services.md`（§5 命名、§6.1 声明与审计规则、
  §8 预算）、`07-plugins/03-plugin-api.md`（§4 错误模型、§5 调用审计、§8 版本管理）、
  `07-plugins/13-plugin-permissions-matrix.md`、
  `07-plugins/02-plugin-manifest-schema.md` §5、`07-plugins/04-plugin-security.md`、
  `03-runtime/11-provider-model-system.md`、`03-runtime/14-secrets-storage.md`；
  ADR 0002、0134、0174（D336）、0206、0258（D426）、0259
- 意图：这是一项 API 扩展，而不是产品功能。宿主增加两个成员并保持协议无关；灵活性
  留在插件侧，而下面每一条护栏都是关于同意、包含性与审计——而不是关于插件讲哪种协议。
- 取代本文件更早的一份草案，那份草案规定了一个图像生成 API、对 `tools.execute`
  授权的复用，以及对 `modelRegistry.complete` 的支持。这些现在都在范围之外：下面的
  请求 API 与协议无关，因此图像插件自己访问 `/images/generations` 与 `/images/edits`，
  而不是让宿主为每种协议增加一个端点。

## 1. 问题

一个 agent 扩展运行在 Agent sidecar（`packages/agent-runtime`）内，并在那里接收 pi 的
`ExtensionAPI` 对象。它需要的两样东西都还缺失。

**信息。** `ExtensionAPIContext.modelRegistry` 在文档中标为受支持（spec 16 §5，
"Supported on context"），但适配层几乎什么都没暴露：

- `packages/agent-runtime/src/runtime.ts:2434-2453`（`extensionModelRegistry()`）
  只在 `[this.model, ...extensionRunner.getAgentModels()]` 之上构建 `getAll`、
  `getAvailable`、`find`、`getProviderDisplayName`、`getProviderAuthStatus` 和
  `hasConfiguredAuth` —— 也就是会话当前模型，加上在同一会话中由 `registerAgent`
  注册的模型。`find(providerId, modelId)` 只在这份两来源列表中搜索，因此任何宿主
  provider 模型都永远找不到。认证状态是从同样这些 id 推导出的硬编码
  `{configured, source: "plugin"}`。
- 上游 `ModelRegistry` 的其他所有成员在这个对象上都不存在，因此
  `ctx.modelRegistry.getProvider(...)` 和凭据访问器会抛出
  `TypeError: not a function`。spec 16 §5 要求：不受支持的成员也必须存在、什么都不做、
  返回文档化的中性值、每个扩展每个成员只发出一条诊断，并且永不抛出
  （`runner.ts:727` 直接把 `bridge.modelRegistry ?? {}` 透传过去，没有惰性包装）。

**请求。** 完全没有执行路径。上游契约
（`@earendil-works/pi-coding-agent` 0.86.1，即 `packages/agent-runtime/package.json:28` 锁定的版本；`dist/core/model-registry.d.ts:20-48`）
声明了 `complete(model, context, options)`，而适配层没有实现它；扩展面上的任何东西也
不能直接调用 provider 端点。

插件作者报告的后果是：在一个会话内，扩展只能看到并使用该会话已经在运行的模型。
它无法发现 `image2`，无法为第二个端点解析 `(providerId, modelId)`，也无法向它发出
请求。

沙箱插件面在这里走在前面：插件通过
`apps/desktop/electron/main/services/plugin-services.ts:286-411` 获得
`pi.models.list()`（`models.list`）和 `pi.agent.complete()`（`agent.complete`），
遵循 D336 / ADR 0174 的规则——凭据永不离开 Electron main。扩展面没有对应能力，而
`agent.complete` 只处理文本并与会话的聊天协议绑定，因此它无法访问
`/images/generations` 这样的非聊天端点。

## 2. 目标与非目标

目标：

- **G1** `modelRegistry.getAvailable()` / `getAll()` 返回用户就绪的宿主模型，而不只是
  会话模型。
- **G2** `modelRegistry.find(providerId, modelId)` 能解析任何就绪的宿主模型，包括配置
  在第二个端点上的模型。
- **G3** 注册表中的认证可用性是真实的，且不携带任何形式的凭据材料。
- **G4** 扩展可以向选定的 provider 和模型发起请求，路径由调用方提供并**追加到该
  provider 的 `baseUrl` 之后**，请求体可以是 JSON、文本或 multipart，且可以包含它被
  允许读取的本地文件，由宿主施加凭据。
- **G5** 调用方不能改变目标 origin、不能逃出 provider 的基础路径、不能覆盖凭据请求
  头，也不能读取凭据。
- **G6** 既有行为保持不变：插件的 `models.list` / `agent.complete` 不变，既有扩展继续
  工作，host-core、协议与 schema 均无变化。
- **G7** 每个不受支持的 `ModelRegistry` 成员都存在且惰性，并带一条诊断，使该对象最终
  与 spec 16 §5 一致。

非目标：

- **N1** 图像生成 API、图像能力标志，或任何其他被固化进宿主的协议专属端点。请求 API
  是通用的（G4），插件在它之上自行组合自己的协议。
- **N2** `modelRegistry.complete` / `stream`。对想要聊天调用的调用方来说，请求 API 已
  涵盖该能力；后续可选项见 §10。
- **N3** 让扩展持有凭据，或访问宿主未选择的 provider origin。
- **N4** 流式或分块请求体，以及流式响应。请求体一律缓冲且有上限；宿主绝不代理无界流。
  本地文件的 multipart 上传在范围内（D3）。
- **N5** 在 v1 中把 OAuth 支撑的 provider 行作为请求目标（见 D5）。
- **N6** `sessionManager` 读写、自定义会话条目、编辑器访问，以及 spec 16 §12 中的其他
  v2/v3 事项。
- **N7** `agent.extension` 插件的市场分发（spec 16 §2.5 保持关闭）。
- **N8** 新增 host-core 列、RPC，或 `tools.execute` 参数。
- **N9** 沙箱插件面。本方案针对受信任扩展面；给插件一个请求 API 意味着新增一条
  `HOST_API_ALLOWLIST` 条目、一个 `PluginHostServices` 成员、一个 `buildApi()` 代理，
  以及 spec 12 §6.1 的各项义务——那是另一次变更（§13）。

## 3. 当前状态与目标状态

"今天"描述的是 `runtime.ts:2434-2453` 加上 `runner.ts:727`。*缺失*表示该成员根本不在
对象上，因此调用它会抛出。

| 成员 | 今天 | 目标 |
|---|---|---|
| `getAll` / `getAvailable` | 会话模型 + 插件注册的 agent 模型 | 就绪的宿主目录 + 插件注册的 agent 模型，按 `provider/id` 去重（D1、D2） |
| `find(providerId, modelId)` | 同样的两来源列表 | 同一份目录 |
| `getProviderDisplayName` | 插件 agent 名称，否则会话 provider 名称，否则原始 `providerId` | 目录事实；原始 id 兜底保留 |
| `getProviderAuthStatus` | 硬编码的 `{configured, source: "plugin"}` | 上游 `AuthStatus`，由目录填充 |
| `hasConfiguredAuth(model)` | 同样的硬编码判断 | 目录事实，采用 host-core 的 `has_secret` 语义（D9） |
| `refresh(options?)` | 缺失；抛出 | 受支持：重新预置目录快照 |
| `getProvider` | 缺失；抛出 | 保持惰性（`undefined` + 诊断） |
| `isUsingOAuth` | 缺失；抛出 | 保持惰性（`false` + 诊断） |
| `getError` | 缺失；抛出 | 保持惰性（`undefined` + 诊断） |
| `getApiKeyAndHeaders`、`getApiKeyForProvider`、`getProviderAuth` | 缺失；抛出 | 惰性，返回文档化的中性值，各带一条诊断（G5） |
| `complete` | 缺失；抛出 | 在本次范围内保持惰性（N2、§10） |
| `stream`、`streamSimple` | 缺失；抛出 | 在本次范围内保持惰性（N2、§10） |
| `pi` 上的 `registerProvider` / `unregisterProvider` | 插件自有的、基于 `registerAgent` 的别名（`extensions/runner.ts:853-915`） | 不变 |
| `modelRegistry` 上的 `registerProvider`、`unregisterProvider`、`getRegistered*` | 缺失；抛出 | 惰性，返回文档化的中性值，各带一条诊断（D9） |
| `ctx.providers.request(...)` | n/a —— 不存在 | 新的 PI 专有成员（D3） |

`getProvider` 与 `isUsingOAuth` 有意保持惰性：G1-G7 中没有任何一项需要 provider 对象
或 OAuth 内省，而两者都会在没有消费者的情况下扩大表面。

## 4. 设计决策

### D1. 信息面保持上游形态

`modelRegistry` 保持 pi `ModelRegistry` 的成员集合，因为为 pi CLI 写的扩展必须仍然是
插件贡献的那个模块（spec 16 §1、ADR 0002）。

上游 `Model<TApi>` 要求 `id`、`name`、`api`、`provider`、`baseUrl`、`reasoning`、
`input`、`cost`、`contextWindow`、`maxTokens`
（`@earendil-works/pi-ai`，`dist/types.d.ts:716-745`）。省略 `baseUrl` 的描述符不是
`Model<Api>`，而声明为 `getAll(): Model<Api>[]` 就只能靠类型断言满足，这是根
`AGENTS.md` §11 禁止的。因此目录投影的是真实的 `Model<Api>` 值：

- 包含 `baseUrl`。它不是秘密：渲染器已经在从 `ProviderPublic.baseUrl` 渲染它，而
  spec 16 §5 的排除清单列举的是键、secret 引用、OAuth token、任意宿主请求头和宿主
  provider 内部——`baseUrl` 不在其中。把它称为规格要求会夸大其词；这是本文记录的一项
  PI 决策。
- `apiKey` 与 `headers` 缺席。这就是安全边界。
- `reasoning`、`input`、`cost`、`contextWindow`、`maxTokens` 由渲染器所用的同一份
  models.dev 派生投影填充（ADR 0134），元数据缺失时使用文档化的中性默认值。它们是
  元数据，不是计费事实。

已否决：把每个 provider 配置（含密钥）传入 sidecar，好让 `pi-ai` 直接调用 provider。
那会把全部 provider 凭据放进一个同时运行插件提供的 TypeScript 并持有 bash 的进程，与
ADR 0174 / D336 冲突。sidecar 今天只接收被启动 provider 的配置，这一点保持不变。

已否决：一个不带 `Model` 对象的 PI 专有 `modelRegistry.list()`。表面更小，但它恰好破坏
了 pi 所定义成员的移植性。

### D2. main 拥有目录；sidecar 持有一份 Runner 作用域快照

上游读取是同步的（`getAll(): Model<Api>[]`、`model-registry.d.ts:26-28`），因此 sidecar
不能在读取时抓取：

- main 拥有目录和全部凭据状态。
- sidecar 以 **Runner 实例状态**持有快照，在 Runner 创建时预置，并在 `refresh()` 时
  原子替换。刷新失败会保留上一份快照并记录一条诊断；它绝不会清空注册表。
- 新模块**不持有模块级状态**。jiti 会缓存模块，且模块实例跨 Runner 共享
  （spec 16 §4.3），因此模块作用域的计数器或缓存会在会话之间泄漏。
- provider 或凭据变更最迟在下次扩展加载或显式 `refresh()` 时体现；它们不会被推送到
  正在运行的 Runner。
- 快照是参考性的。`request` 会针对实时状态重新解析 `(providerId, modelId)`，因此过期
  快照只能产生一次被拒绝的调用，绝不会产生一次针对不同 provider、模型或 origin 的
  调用。

main 中的投影来源：来自 host-core 的 provider 行与凭据标志（`providers.list`，
`includeDisabled: false`），与 `createProviderCatalogRuntime`
（`apps/desktop/electron/main/runtime/provider-catalog.ts`）和 `session-launch.ts`
已经在用的 models.dev 派生 `ModelConfig` 合并。就绪性镜像 `listReadyPluginModels`
（`apps/desktop/electron/main/plugin-agent-complete.ts:51-58`）：
`enabled !== false && (hasSecret || hasOauth || authKind === "none")`。这与上游文档化
的 `getAvailable` 一致——它返回"其 provider 具有完整认证配置"的模型（`pi-ai`，
`dist/models.d.ts:122-123`）。

上游 `getAll` 的语义无法核实——该包在这里只提供 `.d.ts` 文件，其运行时过滤不可观测
——因此 PI 把同一份就绪集合投影到两个成员中。这一分歧是 ADR 的一项决策，而不是意外：
为 pi 写的扩展可能期望 `getAll` 包含那些 provider 尚未配置的模型。

目录**不**按会话启动所施加的会话模型策略过滤（`session-launch.ts:330`）。该策略用于挑选
会话的聊天模型，适用于会话启动和选择器；它不得限制扩展能看到或瞄准什么，否则所报告的
用例会变得不可达（D4）。

### D3. 一个执行成员：与协议无关的 provider 请求

执行面是一个 PI 专有成员，而不是 pi `ModelRegistry` 成员，因为它不属于上游契约：

```ts
ctx.providers.request(input): Promise<ProviderRequestResult>
```

它有意**不是**补全 API。调用方提供路径，因此同一个成员可以访问 `/chat/completions`、
`/images/generations`、`/images/edits`、`/embeddings`、`/models`，或 provider 暴露的
任何其他路径。宿主只贡献三样东西，且不带任何协议特性：目标 origin、凭据和传输策略
（D4-D6）。它会按调用方要求**组装信封**——一个 JSON 序列化，或一个
`multipart/form-data` 请求体——但从不解释它，不涉及流式，也不把 provider 响应映射成
PI 类型。

为什么采用这种形态而不是 `complete`：

- 所请求的能力是"调用另一个 provider/模型"，而不是"获得聊天补全"。固化一种协议会
  重演早先草案增加图像端点时所犯的错误。
- 通用请求没有响应映射保真问题：没有需要合成的 `AssistantMessage`，没有需要发明的
  `stopReason`，也没有需要转译的用量。调用方收到 provider 发送的内容。
- 它让宿主表面保持小而稳定，同时插件演进自己的协议处理——即 spec 03 §1 的设计原则。

`modelId` 是可选的但推荐提供，因为它会选择模型专属的 provider 细节。它不会被注入
请求体：想要发送 provider 的 `model` 字段的调用方自己发送它。宿主不会静默添加、改写或
删除请求体字段。

`providerId` 是**必填**的。与 `modelId` 不同，它没有默认值：调用方在每次调用中指定
provider，因此请求不可能静默落到调用方从未指定的 provider 上。

#### 请求体形态

`body` 是一个可辨识联合，因此宿主从不猜测，调用方也从不需手工编码传输格式：

| `body.kind` | 宿主行为 | `content-type` |
|---|---|---|
| `json` | `JSON.stringify(value)` | `application/json` |
| `text` | 逐字发送 | `body.contentType` 或 `text/plain` |
| `base64` | 解码为字节 | `body.contentType` 或 `application/octet-stream` |
| `multipart` | 由 `fields` 与 `files` 组装；boundary 由传输层生成 | `multipart/form-data; boundary=…` |

`multipart.fields` 是文本部分（`name`、`value`）；`multipart.files` 是文件部分
（`name`、`path`、可选 `filename`、可选 `contentType`）。这正是 OpenAI Images 编辑所
需的形状：`fields` 放 `model`、`prompt` 和 `n`，再加上一个名为 `image` 的 `files`
条目——或者若干名为 `image[]` 的条目。

规则：

- **`content-type` 由宿主拥有。** 调用方自带的 `content-type` 请求头会被拒绝（D5），
  因为对 multipart 而言 boundary 必须与宿主构建的请求体匹配。需要特定类型的调用方改为
  设置 `body.contentType`。
- **不做内容嗅探。** 宿主不会为了判断文件类型而检查文件；未指定 `contentType` 时变为
  `application/octet-stream`。类型正确性由调用方负责，这也让宿主不含协议知识。
- **部分元数据会被校验**：`name` 与 `value` 有上限且不含控制字符，`filename` 不含路径
  分隔符。其他任何情况都是 `INVALID_ARGUMENT`。
- **`GET` 上的请求体会被拒绝。** 其他所有方法都接受任何请求体种类；宿主不审查协议
  语义。
- **请求体有上限**（D8）。

#### 哪些本地文件可以上传

一个 `multipart.files` 条目给出一个路径；宿主会读取它，并且只从会话拥有的根读取：

- 会话的 project 根（可能多个）、会话的 scratch 目录，以及附件库
  （`<dataDir>/attachments`）。这些根由宿主捕获，绝不来自调用方。
- 解析是符号链接感知的：候选文件会被 `realpath`，每个根也会被 `realpath`，解析出的文件
  必须严格位于其中某个根之内。`..`、绝对路径逃逸，以及解析到附件库之外的
  `attachments/<sha256>` 引用，一律拒绝。
- 读取是有界的，并在读取时再次对照上限校验，因此在 `stat` 之后变大的文件也无法越界。
- 宿主内部路径保持不可读：存有 provider 密钥与会话存储的数据目录不在允许的根之内。

这正是已发布的 image-edit 输入加载器已经施加的包含性
（`apps/desktop/electron/main/services/image-inputs.ts:6-88` —— 对
project/scratch/attachments 做 realpath，每文件 16 MiB、每组 32 MiB、加载器预算
64 MiB）。本方案把这份包含性与有界读取抽取为一个共享 helper，把图像专用的签名嗅探
留在图像路径上，而不是再写第二套包含性规则（根 `AGENTS.md` §6：一条规则，只放一处）。

坦率的说明：对已经持有 `agent.extension` 的插件而言，读取这些文件并非新能力——它的
模块在 sidecar 里带着 bash 运行。包含性的存在，是为了让请求 API 不会变成通用的
"读取任意宿主文件并发往 provider"原语，也为了让请求处理器的爆炸半径与已发布的图像
路径相当。它约束的是宿主代调用方解析的内容，而不是一个本来就能读取文件的调用方选择以
`base64` 字节发送的内容。

### D4. 路径拼接：仅追加、保留前缀、在 main 中校验

这是该功能的安全核心，并且只在 main 中强制执行，绝不在 sidecar 或扩展中。

规则：

1. **origin 固定。** 最终 URL 的 scheme、host 和 port 来自 provider 行的 `baseUrl`。
   调用方的路径不能引入 scheme、authority 或不同 host。
2. **结果留在基础路径内。** 拼接与规范化之后，最终 pathname 必须仍然是基础 pathname
   加上调用方的各段。
3. **只有路径由调用方控制。** 方法、请求头和请求体都有边界（D5、D6）；目标没有。

对于基础 `https://api.example.com/v1`，接受与拒绝的形式：

| 调用方 `path` | 结果 | 原因 |
|---|---|---|
| `/images/generations` | `https://api.example.com/v1/images/generations` | 追加 |
| `images/generations` | `https://api.example.com/v1/images/generations` | 前导斜杠规范化为一个 |
| `chat/completions?x=1` | `https://api.example.com/v1/chat/completions?x=1` | 查询字符串是路径的一部分 |
| `/` | `https://api.example.com/v1/` | 基础本身 |
| `https://evil.example/x` | 拒绝 `INVALID_ARGUMENT` | 绝对 URL |
| `//evil.example/x` | 拒绝 | scheme-relative |
| `/../admin` | 拒绝 | 逃出基础路径 |
| `/%2e%2e/admin` | 拒绝 | 解码后形成穿越 |
| `/a\..\b` | 拒绝 | 反斜杠与穿越 |
| `/x#frag` | 拒绝 | 片段 |
| `" "` / `"/a\nb"` | 拒绝 | 空、控制字符 |
| 4 KiB 路径 | 拒绝 | 超过长度上限 |

算法，按此顺序——顺序很重要，因为 `new URL` 会在任何检查之前解析 `..`：

1. 解析 `baseUrl`；要求 `http:` 或 `https:`，并拒绝内嵌凭据、查询或片段。该行在写入时
   已由 host-core（`crates/host-core/src/providers/validation.rs`）校验；这是防御性
   复查，不是主闸门。
2. 在任何 URL 构造**之前**校验调用方字符串：非空、≤ 2048 字节、无 `\`、无 `#`、
   无 CR/LF/NUL 及其他控制字符、不以 `//` 开头。做百分号解码（上限两轮），若解码后的
   形式中出现任何 `..` 段则拒绝。
3. 组合：`pathname = base.pathname.replace(/\/+$/, "") + "/" +
   callerPath.replace(/^\/+/, "")`，然后如果调用方带查询，则用它设置 `search`。
4. 规范化，然后断言最终 `origin` 等于基础 origin，**且**最终 pathname 以规范化后的
   基础 pathname 开头。否则拒绝。这第二层检查是双保险：它能捕获任何在步骤 2 中幸存
   下来的编码，因为这样的路径会解析到基础前缀之外。

没有隐式 `/v1`。provider 行的 `baseUrl` 按配置使用，调用方的路径被追加到它之后，与
规定完全一致。需要 `/v1` 的调用方自己传。

最终 URL 去掉查询后的部分就是审计锚点（D10）。

### D5. 凭据与请求头由宿主拥有

宿主解析并施加凭据；调用方永远看不到它们，也不能覆盖它们。

- 解析复用既有的 main 侧 provider 路径：`providers.get`（行：`enabled`、`baseUrl`、
  `headers`、`authKind`、`models`）与 `providers.getSecret` → secret，与
  `apps/desktop/electron/main/services/image-generation-service.ts:43-70` 完全一致。
- 该行必须存在、处于 `enabled`、有 `baseUrl`，并且在给出 `modelId` 时在 `models[]`
  中列出所请求的模型。`authKind === "none"` 不需要 secret；`apiKey` 需要一个；
  `oauth` 在 v1 被拒绝（见下）。
- 请求头组合：先是 provider 行配置的 `headers`，然后是通过
  `normalizeProviderHeaders` / `mergeProviderHeaders`
  （`packages/agent-runtime/src/provider-headers.ts:78-146`，它强制执行既有上限：
  ≤ 32 个请求头、键 ≤ 256 B、值 ≤ 4096 B）合并进来的调用方请求头，最后宿主**最后**
  设置凭据请求头，因此它始终胜出。
- 调用方请求头会被一份拒绝列表拒绝：`authorization`、`cookie`、`set-cookie`、`host`、
  `content-length`、`content-type`、`connection`、`transfer-encoding`、`upgrade`、`proxy-authorization`，
  以及任何以 `x-forwarded-` 开头的键。任何键或值中出现 CR/LF 都会被拒绝。这份拒绝列表
  的存在，是为了让调用方无法伪造、剥离或重定向凭据，也无法破坏传输分帧。
- `authKind === "oauth"` 在 v1 以 `PROVIDER_AUTH_UNSUPPORTED` 被拒绝，与 spec 21 对
  图像生成施加的排除相同。两个原因：对于厂商账号，线上端点依赖模型
  （`vendorOAuth.bindingFor(provider.id, modelId)`），因此仅凭 `baseUrl` 无法确定
  目标；并且访问 token 是短期的，需通过每次调用的认证句柄解析。要让它可用就意味着把
  这个 API 变成一个 OAuth 代理，那是一项决策，而不是细节（§10）。

**不要使用哪个解析器。** 这里不得复用会话启动解析器。`resolveAgentRuntimeLaunch` 会施加
会话模型策略（`session-launch.ts:330`）并拒绝该策略排除的模型，而这正是这个功能存在的
目标类型。因此请求处理器直接解析 provider 行与模型绑定，并且有意不施加任何会话模型策略：
只要 provider 行绑定了某个模型，它就是合法的请求目标。

### D6. 响应契约：状态是结果，失败是错误

- 一个 HTTP 响应——包括 4xx 和 5xx——是**结果**，不是宿主错误。调用方拥有协议语义，
  因此把 provider 的 404 或 400 翻译成 PI 错误码会销毁信息。结果携带 `status`、
  `statusText`、`ok`、`contentType`、响应请求头和响应体。
- 宿主侧失败确实会抛出，并带错误码（D10、§5.4）：路径被拒绝、provider 或模型不可用、
  凭据缺失、传输失败、预算耗尽，或响应超过上限。
- 重定向**不跟随**：请求设置 `redirect: "manual"`，3xx 作为结果返回，带其 `status` 和
  `location`。凭据绝不能重发给 provider 行未指名的宿主，而调用方可以自行决定怎么做。
  这与 spec 21 拒绝重定向的姿态一致。
- **这条路径上永远没有自动重试**。宿主无法知道一次请求是否幂等——向
  `/images/generations` 发 POST 是按次计费的——因此重试是调用方的决定。当 provider
  发送 `Retry-After` 时，结果携带 `retryAfterMs`，以便调用方自行控制节奏。这一点有意
  不同于一次性补全路径：后者在 ADR 0206 下会重试，因为它的请求由宿主拥有，且按构造
  不产生费用。
- 响应体按形态解码返回：内容类型为 JSON 且解析成功时为 `json`，文本类型为 `text`，
  其他情况为 `base64`，并带字节长度。超过上限的响应体被拒绝而非截断，因此不会有静默
  的信息丢失（spec 21 对超大输入设定的约定）。
- `set-cookie` 会从返回的请求头中剥离。
- 请求自身的凭据请求头绝不会回显在结果或错误中，即使 provider 反射了它。

### D7. 授权：信息用 `models.list`，请求用新的 `provider.request`

扩展只有在其所属插件持有 `agent.extension` 时才会运行。该授权买到的是 sidecar 的信任
级别（spec 16 §2），而不是用户的 provider 凭据，因此这两项新能力按所属插件分别设闸：

| 能力 | 授权 |
|---|---|
| `getAvailable` / `getAll` / `find` 中的宿主目录、真实的认证状态 | `models.list` |
| `ctx.providers.request` | `provider.request`（新） |

`provider.request` 需要自己的授权，而不是搭 `agent.complete` 或 `agent.extension`
的便车：它带着用户的凭据触达**整个** provider API 表面——任意路径、任意方法——包括
花钱的端点（generations、batches）以及读取或删除账号资源的端点。没有任何既有权限覆盖
这一点。它被归类为高风险，在安装时展示，并按调用审计。

**主体如何解析。** 不是从线上来的。调用上的 `extensionId` 是未经验证的输入，而一个
会话的所有模块共享同一个 sidecar 进程，该进程还持有 bash（spec 16 §2.2），因此某个
模块可以冒充另一个扩展的 id，或者直接调用代理。因此 main 从它自己拥有的状态推导主体：

1. `agentExtensions: Map<id, {id, pluginId, pluginName, entry, root}>`，仅为被授予
   `agent.extension` 的插件填充；未获授权的声明会被跳过，并作为
   `plugin.agentExtensions.skipped` 审计（`plugin-runtime.ts:3104-3137`）。
2. 会话的扩展集合就是 main 自己在启动时发送的那份投影：
   `plugins.getAgentExtensions().filter(pluginActiveInProject(...))`
   （`session-launch.ts:670-679`）。
3. 处理器通过该映射解析被声明的 `extensionId`。不在会话集合内的 id 会被拒绝；被声明
   的 id 仅用于审计归属。

**残余限制，直说。** 两个插件向同一会话贡献扩展时，在运行时无法区分，因为它们的模块
共享同一个进程。因此规则是**该会话中已加载扩展的那些插件的授权并集**，在调用时基于
实时插件注册表求值。只有一个贡献插件时——常见情况——检查是精确的；有多个时，一个模块
可以使用兄弟插件的授权。逐扩展隔离需要独立进程或模块作用域，而 spec 16 §4.3 并不
提供。这道闸门的真正力量在于用户在安装时看到并确认授权，且每次调用都被审计并限流
——而不是"一个不受信任的模块无法触及这里"。

没有目录授权时，注册表仍会以插件注册的 agent 模型和会话模型作答。没有请求授权时，
调用以 `PERMISSION_DENIED` 和一条审计记录被拒绝。只用 `registerAgent` 的扩展仅凭
`agent.extension` 就继续工作（G6）。

**与已记录决策的对账。** ADR 0258 决策 4 与 spec 16 §5:282 承诺该投影"只暴露模型和
认证可用性"，且不需要额外授权。加入 `models.list` 闸门**收紧**了这项已记录的承诺，而
spec 16 §13 要求新成员在有决策将其移出之前必须以惰性加诊断的形式落地。两者都必须由
伴随该阶段的 ADR 更新，而不是事后更新（§9）。

### D8. 预算、限流与取消

| 控制 | 值 | 依据 |
|---|---|---|
| 速率 | 每插件 8 次请求 / 滚动 60 s，与插件宿主的 `agent.complete` 限流共用一个计数器（`plugin-runtime.ts:678-681`、`:3944-3953`） | 同一插件、同类开销；独立计数器会让插件在两个面之间交替以取得 8 + 8 |
| 在飞并发 | 每插件 4 | 在不串行化正常使用的前提下约束扇出 |
| 单次调用预算 | 默认 60 s，`timeoutMs` 最高 300 s | provider 调用是有界的；调用方可以要求更多 |
| 传输截止时间 | 预算 + 15 s 余量，显式传入 | `rpcTimeoutMs` 默认 130 s，无法知道调用方的预算（`packages/shared/src/rpc-timeouts.ts:54-56`），而 `ParentHostProxy.call` 接受覆盖值（`parent-host-proxy.ts:93-99`） |
| 请求体（非 multipart） | ≤ 1 MiB | JSON、text 或 base64 载荷 |
| Multipart 请求体 | ≤ 8 个文件、≤ 32 MiB/文件、≤ 64 MiB 总计 | 比已发布的图像档位（`image-inputs.ts:48-82`，16 MiB/文件、32 MiB/组）大一档，因为该 API 不限于图像 |
| 响应体 | ≤ 4 MiB | 超过则拒绝，绝不截断 |
| 路径 | ≤ 2048 字节 | D4 |
| 请求头 | 既有 provider 请求头上限 | `provider-headers.ts:16-18` |

取消是显式且双向的：

- 调用方可以传入 `signal`。sidecar 生成一个 `callId`，随请求一起发送，并在中止时
  针对该 id 发送 `extensions.providers.abort`。
- main 注册一个以 `(sessionId, callId)` 为键的 `AbortController`，中止 fetch，并在
  调用落定时清除该条目——失败时也一样清除，因此不会泄漏。
- 运行时销毁和会话切换会中止该会话所有未完成的调用；处理器必须挂接 sidecar 的销毁
  路径，因为 `tools.abort` 只能触达由本地工具路径注册的控制器
  （`packages/host-runtime/src/agent-sidecar.ts:268-271`）。
- 存活超过其 Runner 的调用会被中止；其结果被丢弃，而不是交付给一个运行时已被替换的
  会话。

### D9. 保持惰性的内容

`getApiKeyAndHeaders`、`getApiKeyForProvider` 和 `getProviderAuth` 返回文档化的中性值，
并按 spec 16 §5 的要求，每个扩展每个成员发出一条诊断。PI-Desktop 从不把密钥交给扩展；
需要调用 provider 的调用方使用 `ctx.providers.request`。

`getProvider`、`isUsingOAuth`、`getError`、`complete`、`stream`、`streamSimple`，以及
`modelRegistry` 上的注册系列（`registerProvider`、`unregisterProvider`、
`getRegisteredProviderConfig`、`getRegisteredNativeProvider`、
`getRegisteredProviderIds`）在本次范围内是惰性的。与今天的区别在于它们**存在**且惰性，
而不是抛出（G7）。

这复用了 Runner 已有的、正为此目的存在的 helper（`Runner.inert`，
`extensions/runner.ts:623-635`，用于 `INERT_UI_MEMBERS`，见 `:124` 与 `:707-708`）：
成员存在、每个扩展每个成员发出一条诊断、返回文档化的中性值，并且永不抛出。

`hasConfiguredAuth` 使用 host-core 的语义：`has_secret = has_api_key || has_oauth`
（`crates/host-core/src/providers/repository.rs:23`）。因此 `hasSecret: true` 并不意味着
存在 API key，所以投影同时携带 `hasOauth` 和 `authKind`，扩展才不会对哪些 provider 在
v1 中实际可作为请求目标产生误解。

### D10. 遵循仓库的宿主服务编写规则

扩展桥是继插件 broker 之后的第二个宿主服务面，因此它遵循同一套已记录的约定，而不是
自创一套：

- **声明与审计命名。** spec 12 §6.1 要求每个新能力都在该面的允许列表中以自己的审计
  操作名声明。这三个方法加入 `HOST_PROXY_ALLOWED`
  （`packages/host-runtime/src/agent-sidecar.ts:51-79`），各自带一个独立的审计操作，
  镜像该规格的链条：分组、设闸、执行、审计、应答。
- **错误携带错误码。** spec 03 §4 要求每个失败都携带 `code`；§5.4 列出了它们。
- **审计字段。** spec 03 §5 固定了被记录调用的字段集。每次请求记录 `extensionId`、
  所属 `pluginId`、`sessionId`、`providerId`、`modelId`、`method`、最终的**不含查询的
  路径**、`status`、响应字节数、`durationMs`，以及 `ok` / `errorCode`。绝不记录请求体，
  绝不记录查询字符串（它可能携带 secret），绝不记录凭据。
- **模块大小。** `scripts/check-architecture.mjs` 对**新的 TS/TSX 模块强制 800 LOC
  上限**（另外还有针对 main index 和 app store 的按路径上限，以及 Rust 的 1000），
  因此目录投影、请求客户端和 main 侧请求处理器是各自独立的模块。

## 5. 接口

### 5.1 扩展可见接口

`packages/agent-runtime/src/extensions/runner.ts:191-223` 声明了
`modelRegistry?: unknown`。它将被赋予类型，同时上下文增加一个 PI 专有的同级成员
（`runner.ts:727` 的接线）：

```ts
modelRegistry?: ExtensionModelRegistry   // pi 成员集合，原为 unknown；其余惰性成员在 §3 中枚举
providers?: ExtensionProviderAccess      // PI 专有，新增

interface ExtensionModelRegistry {
  getAll(): Model<Api>[]
  getAvailable(): Model<Api>[]
  find(providerId: string, modelId: string): Model<Api> | undefined
  complete<TApi extends Api>(model: Model<TApi>, context: Context,
    options?: ModelsApiStreamOptions<TApi>): Promise<AssistantMessage>   // 本次范围内惰性
  stream<TApi extends Api>(model: Model<TApi>, context: Context,
    options?: ModelsApiStreamOptions<TApi>): AssistantMessageEventStream   // 本次范围内惰性
  streamSimple(model: Model<Api>, context: Context,
    options?: ModelsSimpleStreamOptions): AssistantMessageEventStream      // 本次范围内惰性
  getProviderDisplayName(providerId: string): string
  getProviderAuthStatus(providerId: string): AuthStatus
  hasConfiguredAuth(model: Model<Api>): boolean
  refresh(options?: ModelsRefreshOptions): Promise<ModelsRefreshResult>
}

interface ExtensionProviderAccess {
  request(input: ProviderRequestInput): Promise<ProviderRequestResult>
}

type ProviderRequestInput = {
  providerId: string
  /** 推荐：选择模型专属的 provider 细节。不会被注入请求体。 */
  modelId?: string
  /** 追加到 provider 的 baseUrl 之后。按 D4 校验。 */
  path: string
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
  headers?: Record<string, string>
  body?: ProviderRequestBody
  /** 默认 60_000，最大 300_000。 */
  timeoutMs?: number
  signal?: AbortSignal
}


type ProviderRequestBody =
  /** JSON, serialized by the host; content-type: application/json. */
  | { kind: "json"; value: unknown }
  /** Opaque text. */
  | { kind: "text"; value: string; contentType?: string }
  /** Small binary payload, base64-encoded by the caller. */
  | { kind: "base64"; value: string; contentType?: string }
  /** multipart/form-data; the host generates the boundary. */
  | {
      kind: "multipart"
      fields?: Array<{ name: string; value: string }>
      files?: Array<{ name: string; path: string; filename?: string; contentType?: string }>
    }
type ProviderRequestResult = {
  status: number
  statusText?: string
  ok: boolean
  contentType?: string
  headers: Record<string, string>
  body: { kind: "json" | "text" | "base64"; value: unknown; bytes: number }
  location?: string
  retryAfterMs?: number
  durationMs: number
}
```

`ExtensionModelRegistry` 中的签名与上游完全一致，因此为 pi CLI 写的扩展可以对该对象
通过类型检查。`AuthStatus` 是 `{configured: boolean; source?: "stored" | "runtime" |
"environment" | "fallback" | "models_json_key" | "models_json_command"; label?: string}`
（`pi-coding-agent/dist/core/provider-composer.d.ts:42-46`）；
`ModelsRefreshOptions` / `ModelsRefreshResult` 是 `{allowNetwork?, providers?, force?,
signal?}` 和 `{aborted: boolean; errors: ReadonlyMap<string, Error>}`
（`pi-ai/dist/models.d.ts:29-40`）。PI 专有的凭据细节属于目录行，而不属于上游类型的
返回值。

### 5.2 sidecar 到 main 的方法

注册在 `HOST_PROXY_ALLOWED` 和 `TrustedExtensionSidecarBridge`
（`packages/host-runtime/src/agent-sidecar.ts:51-79`、`:82-90`，分发位于
`:520-534`），实现在
`apps/desktop/electron/main/runtime/sidecar.ts:345`：

| 方法 | 参数 | 结果 |
|---|---|---|
| `extensions.providers.list` | `{ sessionId }` | `{ models: HostModelDescriptor[] }` |
| `extensions.providers.request` | `{ sessionId, extensionId, callId, providerId, modelId?, path, method, headers?, body?, timeoutMs? }` | `ProviderRequestResult` |
| `extensions.providers.abort` | `{ sessionId, callId }` | `{ ok: boolean }` |

`HostModelDescriptor` 是经过脱敏的目录行，也是 sidecar 构建 `Model<Api>` 所需的材料
——包含 `baseUrl`，不包含 `apiKey`、请求头、secret 引用和原始 provider `config_json`：

```ts
type HostModelDescriptor = {
  providerId: string
  providerName: string
  modelId: string
  label: string
  alias?: string
  /** provider 行存储的 api style；sidecar 据此解析 pi 的线上 API。 */
  apiStyle?: string
  /** models.dev 为该模型钉定的线上 API；优先于 `apiStyle`。 */
  modelApi?: string
  baseUrl: string           // 不是秘密；Model<Api> 必需
  isDefault?: boolean
  supportsReasoning: boolean
  supportsImages: boolean   // 图像输入
  hasSecret: boolean        // host-core 语义：API key 或 OAuth
  hasOauth: boolean
  authKind: string
  toolCall: boolean
  thinkingLevels: string[]
  contextWindow?: number
  maxTokens?: number
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number }
  modalities?: { input: string[]; output: string[] }
}
```

描述符携带 provider 行存储的 api style 与模型级目录钉定值，而不是已解析的线上 API，
因此 pi 的线上 API 词汇留在 agent runtime 内：sidecar 用会话启动所用的同一个 helper
解析它。list 方法只携带 `sessionId`，因为 main 从自己拥有的状态推导主体（D7）；
request 方法携带 `extensionId`，且仅用于审计归属。

### 5.3 路径文法

规范性的，验收测试遵循此表（D4）：origin 由 provider 行固定；只允许追加的段；不允许
scheme、authority、`..`、反斜杠、片段或控制字符；允许查询；≤ 2048 字节；最终 pathname
必须留在基础 pathname 之内。

### 5.4 错误码

宿主失败，各自携带 `code`：

| 错误码 | 何时 |
|---|---|
| `PERMISSION_DENIED` | 缺少授权，或 `extensionId` 不在会话已加载集合内 |
| `INVALID_ARGUMENT` | 路径被 §5.3 拒绝、缺少或为空 `providerId`、方法或请求体形态非法、请求体或请求头超限、multipart 部分中出现控制字符或路径分隔符、`timeoutMs` 未知 |
| `PROVIDER_NOT_FOUND` | 没有该 provider 行，或它被禁用 |
| `MODEL_NOT_CONFIGURED` | `modelId` 不是该 provider 的一个绑定 |
| `PROVIDER_AUTH_MISSING` | 该行需要 secret 但没有存储 |
| `PROVIDER_AUTH_UNSUPPORTED` | v1 中 `authKind === "oauth"`（D5） |
| `NETWORK_ERROR` | 传输失败、DNS、TLS、连接被拒 |
| `TIMEOUT` | 单次调用预算耗尽 |
| `ABORTED` | 调用方、运行时或会话拆除取消了调用 |
| `RESPONSE_TOO_LARGE` | 响应超过上限；携带 `status` 和 `bytes` |
| `RATE_LIMITED` | 每插件限流 |
| `UNSUPPORTED` | 该宿主未接通此功能（例如没有 HTTP 传输的无头宿主） |
| `FILE_NOT_FOUND` | 某个 `multipart.files` 路径不存在，或不是普通文件 |
| `FILE_OUTSIDE_ALLOWED_ROOTS` | 某个 `multipart.files` 路径解析到 project、scratch 与附件根之外 |
| `FILE_TOO_LARGE` | 单个上传文件超过其按文件上限 |
| `UPLOAD_TOO_LARGE` | multipart 载荷超过其总量上限 |

HTTP 4xx/5xx 是结果，不是错误码（D6）。路径、上限或部分形状被拒绝时会抛出错误，
因为请求从未离开宿主。

## 6. 变更面

| 领域 | 文件 | 变更 |
|---|---|---|
| sidecar 访问模块 | `packages/agent-runtime/src/extensions/provider-access.ts`（新增） | 目录快照（Runner 作用域，无模块状态）、描述符投影、惰性成员、请求客户端、路径辅助函数 |
| sidecar 接线 | `packages/agent-runtime/src/runtime.ts:2434-2453`、`:2458-2465` | 用新模块替换内联注册表；增加 `providers` 成员 |
| 桥类型 | `packages/agent-runtime/src/extensions/runner.ts:191-223`、`:727`、`index.ts`、`types.ts` | 桥调用上有类型的 `modelRegistry`、`providers`、`extensionId` |
| 宿主代理 | `packages/host-runtime/src/agent-sidecar.ts:51-79`、`:82-90`、`:520-534` | 三个新的允许列表方法、桥类型成员、分发分支 |
| main 桥 | `apps/desktop/electron/main/runtime/sidecar.ts:345` | 实现三个处理器：主体解析（D7）、目录再校验、审计行、中止注册表 |
| 请求处理器 | `apps/desktop/electron/main` 中的新模块 | 路径校验（D4）、provider 行解析（含 `providers.getSecret`）（D5）、请求头组合、请求体组装（含 multipart）（D3）、关闭重定向、上限、不重试 |
| 共享文件读取器 | `apps/desktop/electron/main/services/image-inputs.ts:6-88` | 把 realpath 包含性与有界读取抽取为可复用的 helper；图像路径保留其签名嗅探并传入其既有上限 |
| 目录投影 | `plugin-agent-complete.ts` 旁的新模块 | 带 `baseUrl`、能力字段与脱敏的就绪模型投影；`PluginModelInfo` 获得可选字段 |
| 传输截止时间 | `packages/shared/src/rpc-timeouts.ts:54-56` | 为请求方法的截止时间增加一条表项或调用点覆盖（D8） |
| SDK 类型 | `packages/plugin-sdk/src/index.ts:703-717` | 在 `PluginModelInfo` 上增加可选字段 |
| 权限注册 | `packages/plugin-sdk/src/index.ts:1258-1305`（`PLUGIN_PERMISSIONS`）、`docs/spec/07-plugins/02-plugin-manifest-schema.md:314-354`（§5 枚举，权威：未知权限会导致校验失败）、`apps/desktop/src/features/plugins/model.ts:39-82`（`PERMISSION_RISK`）、`packages/plugin-devkit/src/check.ts:27-47`（`HIGH_RISK_PERMISSIONS`）及其 `PERMISSION_API_HINTS` | 在每一份副本中声明 `provider.request` |
| i18n | `packages/i18n/src/locales/*/index.ts` | 每个语言环境中的权限标签与描述 |
| Devkit 与文档 | `packages/plugin-devkit`、`docs/plugin-development.md` | 公布新成员 |

三项同步义务，其中两项是本变更不得静默继承的既有缺陷：

- 权限枚举被重复了四次，而 spec `07-plugins/02-plugin-manifest-schema.md:314-354` 是
  权威副本（"未知权限 = 校验失败"）。它当前**遗漏**了 `models.list`、`agent.complete`、
  `agent.extension`、`session.read` 和 `ui.settings`，而它们都在 `PLUGIN_PERMISSIONS`
  中——也就是说 SDK 已经接受 manifest 规格判定为无效的 manifest。加入 `provider.request`
  也必须更新这份副本：S3 加入了 `provider.request` 并补齐了缺口，枚举现在已与
  `PLUGIN_PERMISSIONS` 逐项一致。
- `packages/plugin-devkit/src/check.ts` 在其注释中声称镜像 `PERMISSION_RISK`，
  但遗漏了 `fs.write.workspace`、`fs.delete.workspace`、`agent.complete`、
  `agent.extension`、`desktop.control`、`session.read`、`mcp.server.local`、
  `mcp.server.remote` 和 `background.service`，而
  `apps/desktop/src/features/plugins/model.ts` 将它们标为高风险。S3 把
  `provider.request` 与这些缺失的名字加入了这两份副本，因此该清单已与 renderer 的
  显式 high 档一致。
- 根 `AGENTS.md:106` 把插件工作路由到 `packages/plugin-sdk/AGENTS.md` 和该包 README；
  两者都不存在。这里的局部规则来自根 `AGENTS.md`、spec 07 和既有测试——这是一个要
  报告的文档缺口，不是要凭空发明的东西。

`runtime.ts` 是列出的热点（根 `AGENTS.md` §7），因此新代码放在自己的模块中，
`runtime.ts` 只增加接线。本次范围唯一需要的重构就是上面的受包含文件读取器抽取：复制
这份包含性会让一条安全规则出现第二个真源。`image-inputs.ts` 行为保持不变——图像路径
保留其每文件 16 MiB、每组 32 MiB、64 MiB 预算以及 PNG/JPEG/WebP 嗅探；共享 helper
把上限作为参数。

## 7. 兼容性、数据与安全

- **无 schema、host-core 或设置变更。** 目录通过既有方法读取；凭据通过
  `providers.getSecret`，main 已为图像生成使用它。
- **插件 SDK 保持追加式。** 只有新成员和可选字段。根 `AGENTS.md` 禁止改变插件 SDK
  契约；这里没有这样做。
- **没有凭据跨进程边界。** sidecar→main 的负载携带 `providerId`，而不是密钥；测试断言
  这三个方法的负载、任何目录行、任何扩展可见结果中都不出现密钥材料。
- **威胁模型增量。** 此前，持有 `agent.extension` 的插件可以读取会话模型并在 sidecar
  中运行 bash。此后，加上 `models.list` 和 `provider.request`，它还可以枚举 provider
  和模型，并对 provider `baseUrl` 上的任意路径发起已认证请求。这是一次真实的扩张
  ——正因如此，`provider.request` 是一个独立的高风险授权，带安装时确认、按调用审计、
  限流和有界预算。目标 origin 和凭据请求头仍由宿主拥有，因此这次扩张不会变成凭据外泄
  或 SSRF。
- **最小权限。** 目录不携带凭据；调用方不能改变 origin、逃出基础路径或覆盖凭据请求
  头；HTTP 状态被原样返回而不是重新解释；重定向不被跟随，因此凭据绝不会被重发到别处；
  请求体和请求头都有上限。
- **上传留在会话之内。** 上传的文件必须解析在 project、scratch 或附件根之内，并服从
  D8 的上限。对已经持有 `agent.extension` 的扩展来说这是包含性而非隔离——它的模块本来
  就能用 bash 读取这些文件——但它防止 main 变成通用的"读文件并外发"原语，也让凭据留在
  这些根之外的任何东西都够不到的地方。

## 8. 验证

与新的已认证请求边界相称；§9 的每个阶段都各自验证。

- **单元**：§5.3 路径表（接受的形式，加上绝对 URL、`//host`、`..`、`%2e%2e`、反斜杠、
  片段、控制字符、空、超长，以及前缀逃逸情形）、请求头组合与拒绝列表、凭据请求头
  优先级、方法/请求体/超时校验、响应形态与上限、错误映射，以及限流。Multipart 有自己
  的矩阵：§5.1 的 body 联合类型（包括 `GET` 带 body）、boundary 与 `content-type`
  归属、部分元数据校验、包含性矩阵（根内、`..`、绝对路径逃逸、逃出根的符号链接、
  在附件库里解析到库外的 `attachments/<sha256>`、读取途中文件增大超过上限），以及四个
  文件错误码。
- **契约**：pi `ModelRegistry` 一致性——每个受支持的成员都匹配其上游签名与行为，每个
  不受支持的成员都存在、返回中性值，并且每个扩展只发出一条诊断（G7、spec 16 §5）。
  否定测试：未列出的 `host.proxy` 方法仍被拒绝。
- **集成**：针对夹具宿主验证三个方法的 sidecar 到 main 通路，包括未知 `extensionId`
  拒绝、缺少授权、`oauth` 拒绝、过期快照拒绝、中止，以及运行时销毁。
- **E2E**：扩展现有的受信任扩展脚手架，而不是新增脚本——`scripts/e2e-trusted-extensions.mjs`
  （npm 脚本 `test:e2e:trusted-extensions`），夹具位于
  `apps/desktop/test/e2e/trusted-extensions/{seed,drive,stub-server}.mjs`。该脚手架已经
  通过注册的命令驱动 `ctx.modelRegistry.getAvailable()`、`getProviderAuthStatus` 和
  `setModel`，并且已经断言本方案所依赖的脱敏属性：它序列化注册表，并在出现 `sk-e2e`、
  `secret:provider:`、`authorization` 或 `bearer ` 时失败（`seed.mjs` 计算
  `registryLeaks`，`drive.mjs:196` 断言 `=none`）。新增场景为：通过 `find` 找到第二个
  端点上的模型；通过 `ctx.providers.request` 针对 `stub-server.mjs` 发出 `GET` 与
  `POST`；夹具断言它收到了 provider 的凭据请求头，而调用方提供的 `authorization`
  被拒绝；以及路径逃逸拒绝。Multipart 场景新增一个 body 为 `multipart/form-data` 的
  `POST`，含一个文本字段与一个本地文件：断言夹具收到了两个部分且已施加 provider 的
  凭据请求头、调用方自带的 `content-type` 被拒绝，以及会话根之外的路径在任何请求离开
  宿主之前就被拒绝。
- **脚本**：在共享限流与预算算式变化处扩展
  `apps/desktop/test/plugin-agent-extensions.test.mjs`、`plugin-complete.test.mjs` 和
  `plugin-timeout-budgets.test.mjs`，并为投影和新的访问模块增加单元测试。
- **命令**：`pnpm build:js`、`pnpm --filter @pi-desktop/desktop typecheck`、
  `pnpm lint`、`pnpm -r --if-present test`、
  `node scripts/e2e-trusted-extensions.mjs`，以及 `pnpm check:marketplace`（它读取声明
  的权限范围，因此新权限不能破坏它）。除非用户在任务中要求，否则不运行 `verify:ui:*`。
  真实 provider 和付费端点保持可选加入，绝不作为默认测试路径。
- 除非确实运行过，否则不把任何命令报告为通过。

## 9. 交付阶段

每个阶段都能构建、可独立验证，且不留下死代码。每个把某个成员移出未验证类别的阶段，
都在同一阶段落地自己的 ADR 与规格更新——spec 16 §13 禁止某个成员在有决策将其移出
之前就变成受支持。

- **S1 —— 信息（G1、G2、G3、G7）。** 每个尚未受支持的 `ModelRegistry` 成员都变得存在
  且惰性，并带一条诊断；就绪模型投影随 `extensions.providers.list` 落地到 main；
  sidecar 快照（Runner 作用域）与 `refresh` 落地；`getAvailable` / `find` / 认证状态变
  真实。为该投影与 `models.list` 闸门更新 ADR 与 spec 16 §5，并与 ADR 0258 决策 4
  对账。阶段内顺序：先惰性成员，再投影。仅这一阶段就能让所报告的插件发现另一个端点
  上的 `image2`，并决定如何处理它。
- **S2 —— 请求（G4、G5）。** 每一份副本中的 `provider.request` 授权、三个 RPC 方法、
  路径校验、provider 行与凭据解析、请求头组合、请求体组装（含 multipart）、受包含文件
  读取器抽取、响应契约、限流、中止注册表，以及审计行。ADR 与规格更新：spec 16 §5 与
  §10.1、spec 12 §6.1 的声明与审计名称、spec 13 权限矩阵、若新增错误码则更新
  spec 03 错误码。
- **S3 —— 表面。** `docs/plugin-development.md` §1/§6.12/§7/§12 及其 zh-CN 镜像、
  devkit 类型与提示表（声明的权限现在同时会在入口文件*和*每个
  `contributes.agentExtensions` 模块中查找，因此扩展里的 provider 调用不再被报为
  未使用）、`examples/plugins/provider-request` 示例，以及 `docs/project/README.md`
  索引。§6 中的两处权限枚举偏差都在本阶段修复：既不扩大，也不留作后续事项。

ADR 必须在需要它的那个阶段实现之前存在，而不是之后：这会增加公开扩展契约成员、一个
新的高风险授权，以及扩展代码带着凭据触达用户 provider 的新途径（根 `AGENTS.md` §4）。

唯一的重构是从 `image-inputs.ts` 抽取受包含文件读取器（§6），以保持一条包含性规则
而不是两条。图像服务、补全路径与 `plugin-runtime.ts` 其余部分不被触碰。

## 10. 已决与待决问题

评审中已决：

- `providerId` **必填**，且从不推断（D3）。这是通用的 API 扩展：调用方在每次调用中指定目标。
- 请求授权为 `provider.request`（与 `provider.register` 平行）。
- 不提供薄的 `modelRegistry.complete` 层（N2）。它是后续可追加的，且需要 `AssistantMessage`
  映射，而其 `usage.cost` 与 `stopReason` 无法忠实映射。

下面的条目仍是本方案暂时采用默认值的选择，或需要后续阶段确认的选择。

| 问题 | 决定前的默认 |
|---|---|
| 把 OAuth 支撑的 provider 作为请求目标 | v1 中拒绝（D5）；启用它意味着依赖模型的端点解析与每次调用的认证句柄 |
| 调用方提供的请求头 | 在 D5 拒绝列表之后允许；另一种做法是完全拒绝它们，只依赖 provider 行配置的请求头 |
| 与插件面的 `agent.complete` 计数器共享速率限流 | 每插件共享一个计数器（D8） |
| 上限：1 MiB 非 multipart 请求体、4 MiB 响应体、默认 60 s 预算、最大 300 s | 如所述；2048 字节路径与 provider 请求头上限来自既有常量 |
| Multipart 上限：≤ 8 个文件、≤ 32 MiB/文件、≤ 64 MiB 总计 | 比已发布的图像档位（16 MiB/文件、32 MiB/组）大一档；共享读取器把上限作为参数 |
| 上传文件的 content-type 嗅探 | 不做；未指定类型为 `application/octet-stream`，正确性由调用方负责 |
| 响应体表示 | `json` / `text` / `base64` 加字节数，由内容类型选择 |
| `getAll` 语义：与 `getAvailable` 相同的就绪集合，还是更宽的"已知模型"集合 | 相同的就绪集合；在 ADR 中记录这一分歧 |
| provider 变化时推送目录失效 | 不；在下次扩展加载或显式 `refresh()` 时刷新 |
| `getProvider` 与 `isUsingOAuth` | 保持惰性 |

## 11. 验收标准

当某插件的扩展已加载到一个会话中，且该插件持有 `agent.extension`、`models.list` 和
`provider.request` 时，满足以下条件即为完成：

1. `ctx.modelRegistry.getAvailable()` 返回每个就绪的宿主模型加上插件注册的 agent
   模型，且没有任何一行携带密钥材料。
2. `ctx.modelRegistry.find("<provider-on-a-second-endpoint>", "image2")` 能解析该模型，
   且 `getProviderAuthStatus` 报告其真实认证状态且不含任何 secret。
3. `ctx.providers.request({ providerId, modelId, path: "/images/generations",
   method: "POST", body: {...} })` 到达 `<provider baseUrl>/images/generations`，
   由宿主施加 provider 的凭据，并原样返回 provider 的状态与响应体。省略 `providerId` 的
   调用是 `INVALID_ARGUMENT`；不存在默认 provider（D3）。
4. 调用方不能改变目标 origin、逃出基础路径（`/../`、`/%2e%2e/`）、设置
   `authorization`、设置 `content-type`，也不能观察到 3xx 被跟随。
5. `ctx.providers.request({ providerId, modelId, path: "/images/edits",
   method: "POST", body: { kind: "multipart", fields: [{name: "model", ...},
   {name: "prompt", ...}], files: [{name: "image", path: "<in session>"}] } })`
   作为正确有界、带宿主生成 boundary 的 `multipart/form-data` 请求体，并携带已施加的
   provider 凭据，到达 `<provider baseUrl>/images/edits`。
6. project、scratch 与附件根之外的 `multipart.files` 路径，在任何请求离开宿主之前就以
   `FILE_OUTSIDE_ALLOWED_ROOTS` 被拒绝；缺失文件、超限文件与超限载荷分别报
   `FILE_NOT_FOUND`、`FILE_TOO_LARGE` 和 `UPLOAD_TOO_LARGE`。
7. provider 配置的请求头被施加，调用方请求头在上限之内合并，且凭据请求头无法被覆盖。
8. 没有 `provider.request` 的调用以 `PERMISSION_DENIED` 和一条审计记录失败；不在会话
   已加载集合内的 `extensionId` 被拒绝；只持有 `agent.extension` 的扩展仍能像以前一样
   加载并工作。
9. 每个不受支持的 `ModelRegistry` 成员都存在、返回其中性值，并且每个扩展每个成员只
   发出一条诊断；没有一个抛出。
10. 既有插件 `models.list` 与 `agent.complete` 行为、经 `GenerateImages` 工具的既有
   图像生成，以及既有会话绑定都保持不变，host-core、协议与 schema 无变化。

## 12. 风险

| 风险 | 缓解 |
|---|---|
| 通用的已认证请求是这个面上最宽的能力 | 它有自己的高风险授权、安装时确认、按调用审计、限流、在飞上限、有界预算、固定 origin、不跟随重定向 |
| 路径拼接缺陷变成 SSRF 或凭据重定向 | 双层校验（解析前解码 + 规范化后的前缀与 origin 断言），配一张显式测试表（§5.3），在 main 中强制执行 |
| 同一 sidecar 进程可以使用兄弟插件的授权 | 已记录的残余限制；授权并集规则、安装时同意、按调用审计；隔离需要独立进程（超出范围） |
| 非幂等请求被重试复制 | 这条路径上没有自动重试；`retryAfterMs` 被暴露给调用方以自行控制节奏 |
| 上传变成通用的"读取任意宿主文件并发往 provider"路径 | 包含性到 project、scratch 与附件根并做 realpath 校验、每文件与总量上限，以及只记录数量与字节数、绝不记录路径或字段值的审计行 |
| multipart boundary 或 `content-type` 不一致会破坏请求 | 宿主构建信封并生成 boundary，且调用方自带的 `content-type` 被拒绝（D3、D5） |
| 过期目录误导调用方选择已移除的模型 | main 在调用时重新解析 provider 与模型并拒绝 |
| `getAll` 语义与上游分歧 | 与 `getAvailable` 投影完全相同，并记录在 ADR 中 |
| 脱敏回退，导致某一行或某份负载携带密钥 | 投影单元测试，加上对 sidecar 线路负载和夹具所收请求头的 E2E 断言 |
| 审计日志泄漏携带 secret 的查询字符串 | 审计行记录不含查询的路径 |
| `runtime.ts` 在被扩展时不断增长 | 新代码放在自己的模块中；`runtime.ts` 只增加接线 |

## 13. 范围之外，记录待后

- 把 OAuth 支撑的 provider 作为请求目标（N5）。
- 来自扩展的 `modelRegistry.complete` / 流式补全（N2）。
- 沙箱插件面上的请求 API：它需要一条新的 `HOST_API_ALLOWLIST` 条目、一个
  `PluginHostServices` 成员、`plugin-host-process.mjs` 中的一个 `buildApi()` 代理、
  devkit 提示表，以及 spec 12 §6.1 的各项义务。`plugin-runtime.ts` 已经有 5694 LOC，
  将不得不面对 800 LOC 的模块上限。
- 逐扩展的进程或模块隔离，它会把 D7 中的授权变成真正的安全边界，而不只是限流。
- 把图像能力元数据作为 host-core 列；目录在有用时从 models.dev 的模态推导它。
- 把目录失效推送到正在运行的 Runner。
