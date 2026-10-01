# 11. 提供商和模型系统

> **翻译说明：** 本页是与 [英文源规格](/spec/03-runtime/11-provider-model-system) 一一对应的机器辅助翻译。代码、协议字段和标识符保持原文；如翻译与英文源事实有歧义，以英文版本为准。


## 1. Goal

PI-Desktop 必须支持用户通常需要的**所有主要市场模型供应商和模型**，而无需将一个微小的允许列表硬编码为产品上限。

策略：

> **通过 pi-ai + 兼容 OpenAI 的逃生舱门 + 可刷新的模型目录实现通用提供商覆盖。**

我们**不会**自己重新实现每个供应商 SDK。
我们对 pi 的多提供商层进行标准化，并添加产品级配置、目录和用户体验。

## 2. 覆盖原则

### 必须支持
1. 第一方主要厂商
2. 流行的聚合器/网关
3. 任何兼容 OpenAI 的端点
4. 用户定义的自定义提供商
5. 模型目录持续刷新

### 产品承诺
- 用户几乎可以通过以下方式连接任何主流 vendor/model：
  - 原生 pi 提供商集成
  - OpenAI兼容的API
  - 自定义提供商定义

### 明确的不承诺
- 保证每个不起眼的供应商的专有非标准协议，无需适配器
- 永远发布离线完整世界模型矩阵，无需更新目录

## 3. 架构

```text
Settings / UI
  → ProviderConfigStore (Rust host DB)
  → AgentRuntime (Node/pi)
      ├─ built-in vendor providers (via pi-ai)
      ├─ openai-compatible provider
      └─ custom provider definitions
  → ModelCatalogService
      ├─ bundled catalog snapshot
      ├─ runtime discovery (where supported)
      └─ refresh from pi model data / remote catalog source
```

## 4. 提供商类型

| 类型 | 描述 | 例子 |
|---|---|---|
| `native` | 通过 pi-ai 进行一流供应商集成 | openai、anthropic、google、bedrock、mistral 等 |
| `openai_compatible` | 任何 OpenAI 聊天 Completions/Responses 兼容网关 | OpenRouter、Together、Groq、Fireworks、DeepSeek、本地网关、企业代理 |
| `custom` | 基于已知协议配置文件的用户定义的提供商 | 私有部署、区域网关 |

协议配置文件（MVP）：

1. `openai`
2. `anthropic`
3. `google`
4. `openai_compatible`
5. `bedrock`（若运行时支持则启用）
6. `custom_http`（后续的进阶/实验特性）

OpenCode Go 以一个名为 `opencode_go` 的 API 风格预设暴露。它仍然处在
`openai_compatible` 提供商路径内：该预设把端点固定为
`https://opencode.ai/zen/go/v1`，使用 Bearer API key 认证，从 `/models` 发现
模型，并通过 pi-ai 的 OpenAI Chat Completions 适配器发送对话回合。它不会另建
第二条传输链路，也不会形成封闭的模型许可名单。Agent 运行时会在每一次 LLM
请求上注入 OpenCode 路由标头（会话回合、子代理、上下文压缩摘要、提示增强以及
插件的一次性调用）：`x-opencode-session` 是持久的对话 id（调用方没有会话时则是
按次生成的 UUID），`x-opencode-client` 为 `pi-desktop`，`User-Agent` 为
`pi-desktop/<APP_VERSION>`，除非该行设置了 `headers["User-Agent"]`。base URL
主机为 `opencode.ai` 的自定义 OpenAI 兼容行也会收到同样的标头。系统不依赖
pi-ai 去发出 `x-opencode-session`。每个提供商行（AI 服务或 OAuth 账户）都可以
设置可选的 `headers`；留空则保持适配器默认值。一层 fetch 包装是最后的写入方，
因此 Codex 与 Anthropic 无法覆盖它们。pi-ai 的 Google 适配器
（`google-generative-ai`、`google-vertex`）会拒绝任何不是 `globalThis.fetch`
的 `fetch`，因此发往它们的请求不带 fetch，只通过合并后的 `headers` 送达 SDK
客户端；调用方传入的 `fetch` 会被清除而非包装（issue #1072）。由于这些适配器既看不到包装、也从不调用
`onResponse`，这样的行不上报捕获到的 HTTP 状态与传输原因：`Retry-After`
退回有界退避阶梯，issue-234 的传输诊断与重建对它不生效。

当 OAuth 厂商围绕本地 provider 行 id 重建运行时模型时，运行时仍保留 pi-ai
原生传输元数据，不会把该行当作普通 OpenAI 端点。GitHub Copilot 请求会保留
固定 pin 模型的 IDE 身份标头，包括 `Editor-Version`、`Editor-Plugin-Version`
与 `Copilot-Integration-Id`；Agent 运行时还会按上下文加入动态的
`X-Initiator`、`Openai-Intent` 与图像请求标头。本地行 id 仍然拥有认证绑定与
对话记录身份；用户设置的提供商 headers 仍是最后的覆盖层。

Copilot 的 Anthropic Messages（Claude）请求将每次请求解析的 OAuth 令牌作为
`Authorization: Bearer` 标头认证发送，不携带 `X-Api-Key`，因为 pi-ai 仅在
`model.provider` 为 `github-copilot` 时选择 Copilot Bearer 认证。
OpenAI 风格的 Copilot 线路 API 仍将令牌作为请求密钥签名；所有线路均保留
逐请求认证解析与账户专属的 `baseUrl`。

智谱 / GLM 与 Z.AI 是命名的 OpenAI 兼容端点预设，收录在一份由 Pi catalog
支撑的、简短的第一方厂商服务列表中（含小米）。添加提供商时的「服务」选择器
会持久化匹配的 Pi catalog `vendorKey`，并使用已发布的端点，在命名服务这条
路径上不显示名称、Base URL 或 API 格式。对话回合仍然使用选定的 pi-ai 适配器
（`chat_completions`、`responses`、`anthropic_messages`、
`google_generative_ai` 或 `opencode_go`）。智谱 / Z.AI 的 Completions 请求
使用 `thinkingFormat: "zai"` 与 `zaiToolStream: true`。DeepSeek 系 Completions
在 `vendorKey`、Base URL、模型 ID 或目录 `family` 能识别为 DeepSeek 时设置
`requiresReasoningContentOnAssistantMessages: true`。pi-ai 只根据
`provider === "deepseek"` 或 `deepseek.com` URL 自动检测，而 PI-Desktop 把 UUID
存成 `model.provider`，因此聚合网关与自定义端点会在无思考内容的助手回合漏掉
`reasoning_content`。非官方 DeepSeek 端点还会设置 `requiresNonEmptyReasoningReplay`，
用文档化的非空占位符而不是 `""` 填补缺失推理（OpenCode / 第三方中转在压缩后拒绝空回传；
见 ADR 0256 / #296）。官方 `deepseek.com` 行仍使用空串回填（#223）。该覆盖不改
`thinkingFormat`。

当 Pi catalog 记录发布了推理 `effort` 选项且没有 `budget_tokens` 选项时
（例如 Opus 4.7+、Opus 5.x、Fable），Anthropic Messages 请求会设置
`forceAdaptiveThinking: true`。这些模型会以 HTTP 400 拒绝
`thinking.type=enabled`，而 Pi catalog 不携带 pi-ai 的 compat 记录，缺少该标志时
pi-ai 会回落到 budget 思考。仍发布 `budget_tokens` 的模型保持 budget 思考，显式的
目录 `compat` 记录会被保留。

目录无法识别的 Anthropic Messages 行（例如某个自定义网关 URL 提供多家发布方都列出的
模型 ID）仍回退到通用模型形状，但当 Anthropic 自己的 Pi catalog 记录中存在完全相同的
模型 ID 时，会采用该记录的 `reasoning_options` 及派生的 `thinkingLevelMap`。Claude
模型接受哪种思考形状是模型本身的属性，而非部署的属性，因此只迁移这两个字段；上下文与
模态限制保持通用值，别名、改名后的 ID、其他 wire API，以及通过 Anthropic 协议提供的
非 Claude 模型均不受影响（#990）。

## 5. 内置供应商矩阵（发货意图）

> 确切的可用性取决于引脚版本的 pi-ai 支持；产品必须公开所有受支持的产品，并为其余产品保持与 OpenAI 兼容的路径开放。

### A 层 — 始终暴露在 UI 中
- OpenAI
- Anthropic
- 谷歌 Gemini
- OpenAI 兼容（通用）

### B 层 — 当运行时支持时公开/如果 pi-ai 中存在则默认启用
- AWS 基岩
- Azure 上的 Azure OpenAI / OpenAI
- 米斯特拉尔
- xAI
- 深寻
- 格罗克
- 在一起
- 烟花
- 连贯
- 困惑
- 开放路由器
- 登月/基米
- 智浦/GLM
- 最小最大
- 百川
- Qwen / DashScope
- 01.AI/易
- 硅流
- NVIDIA NIM
- 奥拉马（当地）
- LM Studio（本地 OpenAI 兼容）
- vLLM / TGI / LocalAI / LiteLLM 网关（通过 OpenAI 兼容）

### C 层 — 用户自定义
任何未列出但可通过以下方式联系的供应商：
- OpenAI 兼容基础 URL
- 自定义标题
- 自定义授权方案

## 6. 模型支持策略

### 6.1 无硬性模型许可名单上限
PI-Desktop 不得把用户永久限制在一份简短的固定模型列表上。

### 6.2 Catalog responsibilities

1. pi-ai 0.99.1 Providers/Models own published metadata, transport, thinking
   support and native operation types. Electron's historically named
   `ModelsDevCatalog` is an account-aware adapter over this public API.
2. Startup is cache-only and disables ambient environment/file credentials.
   Each configured account has its own Models collection and Host credential
   store. Same-vendor rows cannot borrow one another's credentials.
3. OAuth live entitlement IDs are published through the account provider's
   refresh/filter boundary. A successful list governs available chat models;
   discovery failure preserves the pinned catalog. Live-only IDs may inherit
   same-tier adapter/thinking metadata, with unknown prices retained as unknown.
4. Settings exposes published metadata separately from explicit binding
   overrides. Effective chat limits, inputs, thinking and request shape are
   projected once at the account boundary and reused for ordinary sessions,
   delegates, compaction and image lookup. Pi's unsupported/null effort mappings
   cannot be re-enabled by stale persisted settings. No saved data is rewritten.
5. Chat, image and classifier models are selected by operation type even when
   they share a model ID. A small display-only operation metadata supplement
   preserves settings visibility for image/audio/video/embedding records that
   Pi does not publish. It supplies no runtime auth, dispatch, price or entitlement.
6. Free-form IDs remain configurable. Conservative generic metadata applies
   when no published model matches; explicit user overrides remain supported.
   Unknown relay metadata uses exact final-segment matching and an unambiguous
   official publisher. Known endpoint aliases cannot borrow past an ambiguous
   same-endpoint miss. No deployment/date/thinking suffix is removed.
7. Settings catalog refresh calls Pi's public refresh API. Release scripts no
   longer fetch or package the independent Pi catalog JSON catalog. Pi version
   pins provide the reproducible catalog baseline.
8. PDF capability remains metadata; attachments use bounded file references
   until the runtime supports a native PDF content block. Image capability is
   resolved against the effective selected binding before transport.

### 6.3 涵盖的模型系列
目录和自定义模型条目必须支持通用功能类：

- 文字聊天/编码模型
- 推理/思维模型
- 长上下文模型
- 视觉/多模式输入模型
- 具有工具调用能力的模型
- JSON/structured 具有输出功能的模型（提供商支持的情况下）

## 7. 配置模式

```ts
type ProviderAuthKind =
  | "api_key"
  | "api_key_and_base_url"
  | "bearer"
  | "azure_api_key"
  | "aws_sdk_default"
  | "custom_headers"
  | "oauth" // 厂商订阅账户，凭据由 Electron 主进程持有
  | "none" // local no-auth

type ProviderConfig = {
  id: string                    // uuid/ulid
  name: string                  // display name
  vendorKey: string             // openai/anthropic/google/openrouter/custom/...
  type: "native" | "openai_compatible" | "custom"
  protocol: "openai" | "anthropic" | "google" | "openai_compatible" | "bedrock" | "custom_http"
  enabled: boolean
  baseUrl?: string
  authKind: ProviderAuthKind
  secretRef?: string            // pointer into secret store
  headers?: Record<string, string> // optional outbound headers; empty keeps adapter defaults
  apiStyle?:
    | "chat_completions"
    | "responses"
    | "anthropic_messages"
    | "google_generative_ai"
    | "openai_codex_responses" // 仅厂商账户
    | "pi_messages"            // 仅厂商账户
    | "auto"
  compatibility?: {
    supportsTools?: boolean
    supportsVision?: boolean
    supportsStreaming?: boolean
    supportsReasoning?: boolean
    supportedThinkingLevels?: ThinkingLevel[]
  }
  defaultModelId?: string
  models?: UserModelConfig[]    // optional user-defined models
  createdAt: string
  updatedAt: string
}

type UserModelConfig = {
  id: string                    // provider-local model id/slug
  displayName: string
  providerId: string
  contextWindow?: number
  maxOutputTokens?: number
  capabilities?: Array<"text" | "tools" | "vision" | "reasoning" | "json">
  pricingHint?: string
  hidden?: boolean
}

type ModelBinding = {
  id: string
  contextWindow: number
  /** `contextWindow` 的来源；早于该标记的记录没有此字段，按历史规则解析
   * （见 `13-model-catalog-and-selection.md` §9.1）。 */
  contextWindowSource?: "catalog" | "user"
  maxTokens: number
  thinkingLevels: ThinkingLevel[]
  defaultThinkingLevel: SessionThinkingLevel | null
  availableForSubagents?: boolean // opt-in for AI-driven delegation
}

type SelectedModelRef = {
  providerId: string
  modelId: string
}

type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
```

上面这些兼容性字段，是为老客户端保留的持久化模式兼容面。PI-Desktop 不再把
它们当作运行时的模型覆盖来读取。`ModelInfo` 的推理支持与受支持的思考级别
描述的是解析出的 Pi catalog 记录；有效的 provider/会话能力则来自那个确切的
`ModelBinding`。未知的自由格式 id 以通用形态起步，不带任何推断出的推理能力；
空的绑定等级数组是通用种子，非空的显式 binding 才会主动启用或禁用相应级别。

提供商对话框会为每个选中的模型持久化一条 `ModelBinding`。第一条 binding 是
当前对话以及旧版运行时消费方的有效模型。对话级别的模型切换与跨数组路由仍属
后续工作。只有 `defaultModelId` 的旧版提供商，在主机读取时会被具体化为一条
回退 binding，并在下一次提供商写入时升级为 `models`。

`ModelBinding.availableForSubagents`（布尔值，默认 false）：这是一个选择加入
的标志，让该模型可用于 AI 驱动的子代理委托。启用后，该模型会出现在注入父
agent 系统提示的委托目录中。父 agent 随后就能通过 Task 工具的 `model` 参数
选中它。为某个定义解析固定模型不代表授予此许可。启动载荷通过独立的
`subagentModelKeys` 传递允许覆盖的模型键；仅供定义固定使用的绑定仍只通过
正常的固定模型解析生效，包括 `Task.model` 重复该定义自己的固定键。按需匹配使用唯一
provider id/vendor/name 查找，不得用另一账号凭据覆盖固定模型。多个账号的 vendor/model 别名冲突时，已勾选账号改用
确切的提供商 ID 作为覆盖键。优先级保持 Task.model → 定义固定模型 → 会话模型
（D278；ADR subagent-model-opt-in）。该许可约束所有让 AI 为委派工作挑选模型的入口，
而不只是 `Task.model`：`session/collaboration/spawn` 的 `modelKey` 指向未勾选的模型时
以 `PERMISSION_DENIED` 拒绝，省略该键或写出默认模型自己的键仍按继承处理。

## 8. 秘密

- 通过安全存储存储的 API 密钥（`SECRET_*` API）
- 提供程序配置仅存储 `secretRef` / hasSecret 布尔值
- Renderer 从未在列表 API 中接收原始密钥
- 可选的密钥验证调用：`providers.testConnection`
- 厂商账户行保存的是 OAuth 授权而不是密钥；`hasSecret` 覆盖任一种凭据，
  `hasOauth` 用于区分二者（第 8a 节）

## 8a. 厂商账户（OAuth）提供商

提供商行可以由厂商订阅账户认证 —— Claude Pro/Max、ChatGPT Plus/Pro、
Copilot 以及 pi-ai 其余的 OAuth 厂商 —— 而不是粘贴的密钥（ADR 0095、
D237）。可选厂商由 `models.getProviders().filter(p => p.auth.oauth)` 派生，
因此列表跟随依赖版本而不是写死的表；`registerBunOAuthFlows()` 在启动时
调用一次，因为 pi-ai 通过 electron-vite 无法打包的动态 import 加载流程。

Electron 主进程拥有登录会话与凭据；渲染层只看到事件与一个非敏感的账户
标签。登录会按 `vendorKey` 幂等 upsert 一行 `authKind: "oauth"`，随后用
账户自己的目录填入 `baseUrl`、`apiStyle` 与 `defaultModelId`。

请求认证**按请求**解析，而不是在启动时解析：

```text
sidecar 请求
  → 运行时 provider binding（启动时注入 `resolveAuth`）
  → 宿主代理 `provider.resolveAuth` { sessionId, providerId }
  → Electron 主进程（本地应答，绝不转发给 host-core）
      · 绑定表校验 → 不匹配则 PROVIDER_NOT_BOUND
      · pi-ai `models.getAuth(providerId)` → 仅过期时在锁下刷新
  → 短时 ModelAuth { apiKey?, headers?, baseUrl? }
```

有两条后果值得写明：厂商访问令牌约一小时有效，因此载荷与运行时都不得
缓存它；而由于该行的 `apiKey` 恒为 `""`、注入的解析器是函数，运行时身份
（`matches()`）保持稳定，所以 OAuth 会话跨回合复用温热运行时而不是重建。
因此 sidecar 永远拿不到刷新令牌，拿到的访问令牌也只属于其会话绑定的那个
提供商。

这类行的模型发现读取已登录账户自己的模型列表；连接测试仍通过解析认证来证明
账户。请求失败，或返回的不是模型列表时，才回退到 pi-ai（`models.getAvailable`，
含厂商自己的 `filterModels`）。各厂商打自己的接口：ChatGPT Plus/Pro
（`openai-codex`）是 `GET {base}/codex/models?client_version=…`，因此
`gpt-6-luna` 这类账户已经提供、pin 里还没有的 id 也能出现；该接口要求
`client_version`，并隐藏最低 Codex 客户端版本更高的模型，所以取值是固定的
Codex CLI 版本（`CODEX_MODELS_CLIENT_VERSION`），账户模型缺失时调高；普通
`{ data: [...] }` 不当成 Codex 列表。Copilot 是带 IDE 身份头和 `X-GitHub-Api-Version` 的 `GET {base}/models`，
只保留 `model_picker_enabled === true` 且未被策略禁用的 id，pin 不认识的 id
只有在其家族已经对应唯一线路 API 时才加入。Anthropic 用 OAuth 身份头请求
`GET {base}/v1/models`。Kimi、Meta、xAI、OpenRouter 请求 `GET {base}/models`
（Kimi 走 Anthropic 风格的 `/v1`）。Radius 继续用网关目录刷新，不再另打一遍。
账户请求失败时，日志记录 HTTP 状态码和一小段单行的响应内容摘要，其中去掉了
请求自身的凭据和任何形似令牌的值，便于从提供商日志诊断上游契约变化。
图像、视频、语音和嵌入模型会被丢掉。Pi catalog 不认识的 id 只从同档位的 pin
兄弟继承限额，xAI 按 `grok-4.7`、`grok-4.6`、`grok-4.5`、`grok-4.3` 的固定新到旧顺序，
不按 pin 顺序。Pi catalog 不能把账户列表里没有的 id 加进去。一个厂商可以
跨越多种线路 API，因此行的 `apiStyle` 跟随所选模型。

### Anthropic token 端点限流

固定版本 pi-ai 0.99.1 的仓库补丁为 Anthropic 授权码交换与刷新提供同一套
有限策略：只重试明确的 HTTP 429，最多总共三次请求。先等待至少 1 秒、再
等待至少 2 秒；若 `Retry-After` 给出更长的秒数或 HTTP 日期，则遵守该时间。
服务器要求的等待超出剩余预算时结束本次尝试，不缩短等待后提前重试。
缺失或无效提示使用有限的指数退避。

请求、响应体读取和等待共用一个 30 秒 helper 截止时间及原始调用方 signal；
更早的调用方截止时间优先。pi-ai 现有刷新操作在凭据存储锁内有 15 秒限制。
取消同样中断等待。补丁不把刷新移出该锁：失败保留已有凭据，成功旋转后
仅写入一次新授权。

网络失败、响应体中断、5xx 和 `invalid_grant` 均不重放，因为非幂等 token
请求的结果可能不确定。明确的 `invalid_grant` 即使标为 429 也立即结束。
HTTP/token JSON 失败显示有限恢复说明，不包含原始响应体、URL 或嵌套堆栈。
登录失败提示稍后关闭弹窗并重新发起登录；刷新失败提示等待后重试，持续失败
时重新登录。仅凭 HTTP 429 不能证明授权码是否已被使用，因此不声称其已失效。

沿用现有依赖补丁机制，OAuth 端点、PKCE、凭据归属、IPC 和存储 schema 不变。

## 9. 模型目录服务

```ts
interface ModelCatalogService {
  listProviders(): Promise<ProviderDescriptor[]>
  listModels(filter?: ModelQuery): Promise<ModelDescriptor[]>
  refreshCatalog(options?: { providerId?: string }): Promise<RefreshResult>
  resolveModel(ref: SelectedModelRef): Promise<ResolvedModel>
  upsertUserModel(model: UserModelConfig): Promise<void>
}
```

### 模型描述符

```ts
type ModelDescriptor = {
  providerId: string
  vendorKey: string
  modelId: string
  displayName: string
  source: "bundled" | "discovered" | "user"
  capabilities: Array<"text" | "tools" | "vision" | "reasoning" | "json">
  contextWindow?: number
  maxOutputTokens?: number
  deprecated?: boolean
  tags?: string[]
  supportedThinkingLevels?: ThinkingLevel[]
}
```

## 10. UI 要求

### 设置 → Agent → 提供商
- 快速添加内置供应商
- 添加 OpenAI 兼容端点
- 添加自定义提供商
- 编辑基础 URL/headers
- set/replace/delete 密钥
- 在高级选项中设置可选自定义请求头（留空则保持适配器默认值）；复制与持久化
  所用的同一份规范化 JSON
- 登录/退出厂商账户，并看到某一行使用的是哪个账户
- 编辑厂商账户的非机密标签、自定义请求头与默认模型
- enable/disable 提供商
- 测试连接
- 选择多个模型并编辑每条绑定的上下文窗口、输出上限与启用的思考级别；目录
  元数据为 API 提供商与已登录的厂商账户提供初始值。选择器始终暴露七个规范
  级别：已发布的级别为已知模型播种，而任何显式选择都会为代理端点或新发布的
  模型保留下来。两种界面通过同一个选择器呈现，因此厂商账户编辑器提供与 API
  提供商编辑器相同的按绑定编辑
- 模型卡片默认保持紧凑，按需展开 metadata/configuration，并让对话框操作留在
  可独立滚动的内容区域之外
- 不要暴露原始的目录兼容性内部细节或提供商机密
- 设置 → 导入可以从 Claude Code、Codex、OpenCode、Pi 和 CC Switch 复制
  provider/model 行。扫描是显式的。已存储的 API key 会被复制进宿主密钥库；
  OAuth/订阅授权则不会。重复导入时只会跳过等价提供商（归一化 URL + API
  风格 + 相同凭据）；同一端点的不同凭据仍保持为独立提供商。
  不涉及协议或模式版本升级（D342 / ADR 0179 / ADR 0188）

### 模型选择器
- 搜索启用的提供商的所有模型
- provider/vendor 分组
- 显示能力徽章（tools/vision/reasoning）
- 允许“刷新模型”
- 允许自定义模型 ID 输入

### Empty/error 状态
- 没有配置提供商
- 密钥缺失
- 找不到模型
- 提供商未经授权
- 目录刷新失败（仍然允许手动模型 ID）

## 11. Runtime resolution algorithm

When starting a turn with `(providerId, modelId)`:

1. Load the Host provider row; fail for a missing or disabled explicit account.
2. Resolve credentials only for that account. OAuth refresh remains per request.
3. Resolve the typed chat model from the account Pi collection, with conservative
   generic fallback for explicitly configured unknown compatible IDs.
4. Apply the central effective binding projection and clamp thinking with Pi's
   public capability helper. Preserve native costs and unknown-price provenance.
5. Build the transport with the actual vendor/model identity and the configured
   endpoint. Anthropic roots normalize a trailing `/v1` because its adapter
   appends `/v1/messages`. Delegates use the same account/binding resolution.
6. Stream with cancellation and separate answer/thinking events. Attribute usage
   to each physical request operation, including retries, and translate errors
   to shared AppError codes. Replay aggregation deduplicates operation IDs.

An unavailable saved account never silently falls back to the default account.

## 12. 兼容性层

| 层 | 意义 |
|---|---|
| 满 | 工具 + 流媒体 + 愿景 verified/expected |
| 标准 | 预计聊天流媒体 |
| 有限 | 通过兼容网关尽最大努力 |
| 未知 | 用户定制，不保证 |

UI 可能会显示层级提示，但默认情况下不得硬阻止未知模型。

## 13. Refresh & update policy

1. Use the pinned Pi catalog at startup without network or ambient credentials.
2. Settings may explicitly refresh Pi provider catalogs in memory.
3. Provider endpoint discovery preserves configured IDs and Host caches; OAuth
   live discovery publishes account entitlements through the same Models owner.
4. Failed refresh retains available metadata and configured bindings.
5. Release catalog changes arrive through reviewed Pi pins and patches; the
   release script does not fetch a second model catalog.

## 14. 本地/离线模型支持

通过兼容 OpenAI 的本地服务器支持：

- Ollama（如果 pi 支持，则为原生，否则与 OpenAI 兼容的代理）
- LM工作室
- vLLM / TGI / LocalAI / LiteLLM 代理
- 其他本地网关

要求：

- 自定义基础 URL
- 身份验证可能是 `none`
- 手动输入模型 ID 始终可用
- 目录刷新可以使用 `/v1/models`（如果可用）；否则用户定义的模型

## 15. 故障分类（提供商域）

规范代码位于 [08-error-codes](/zh-CN/spec/03-runtime/08-error-codes) 中；保留细节
代码映射到规范父级直到发出（第 3.6 节）。

| 代码 | 状态 | 意义 | 面向用户的指导 |
|---|---|---|---|
| `PROVIDER_UNAUTHORIZED` | 直播 | invalid/expired 密钥或身份验证被拒绝 | 重新输入秘密/检查帐户 |
| `PROVIDER_RATE_LIMITED` | 直播 | 429/名额 | 稍后重试/切换模型 |
| `PROVIDER_SECRET_MISSING` | 直播 | 无秘密启用的提供商 | 完成设置 |
| `MODEL_NOT_CONFIGURED` | 直播 | 没有选定的模型或提供商拒绝选定的模型并返回 404 | 选择或配置可用模型 |
| `PROVIDER_ERROR` | 直播 | 其他上游提供商失败 | 重试/检查详细信息 |
| `NETWORK_ERROR` | 直播 | 无法到达提供商端点 | 检查网络和基础 URL |
| `STREAM_FAILED` | 直播 | 流在中途掉线 | 重试回合 |
| `PROVIDER_BASE_URL_INVALID` | 保留 → `PROVIDER_ERROR` | 格式错误或无法访问的基础 URL | 固定端点 |
| `PROVIDER_PROTOCOL_MISMATCH` | 保留 → `PROVIDER_ERROR` | 端点协议错误 | 切换协议配置文件 |
| `PROVIDER_MODEL_NOT_FOUND` | 保留 → `MODEL_NOT_CONFIGURED` | 提供商的模型 ID 未知 | 刷新目录或自定义 ID |
| `PROVIDER_TIMEOUT` | 保留 → `TIMEOUT` | 网络或服务器超时 | 重试/检查网络 |
| `PROVIDER_UNSUPPORTED_CAPABILITY` | 保留 → `PROVIDER_ERROR` | tools/vision/reasoning 不支持 | 切换模型或禁用功能 |
| `PROVIDER_DISABLED` | 保留 → `MODEL_NOT_CONFIGURED` | 提供程序存在但已禁用 | 启用提供商 |

## 16. OpenAI兼容的一级路径

如果供应商公开了 OpenAI 兼容的 API，则任何供应商都可以在没有本机 SDK 的情况下加入。

必填字段：
- `baseUrl`
- 身份验证（`api_key` / `bearer` / `none` / 自定义标头）
- 模型 ID（目录或自由格式）

可选：
- `apiStyle`（`chat_completions` | `opencode_go` | `responses` | `auto`）
- 兼容性标志
- `headers`（可选的出站 HTTP 标头；留空则保持适配器默认值）

对于 OpenAI Chat Completions 适配器，系统指令默认使用标准的 `system` 角色。
这样做是为了让任意兼容网关都能互通，因为有些上游路由会拒绝较新的 `developer`
角色，其中也包括推理模型的路由。当某个端点已知接受该角色时，解析出的模型
记录可以显式设置 `compat.supportsDeveloperRole: true`；这个覆盖的作用域限于
该模型，不会改变其他提供商。

这是**通用逃生舱**，保证超出原生集成之外的市场覆盖范围。

目录条目还可以额外固定模型级 wire API（例如 `api: "openai-responses"`）。存在时它优先于 provider 级 `apiStyle`，因此 `opencode_go` 下的 responses-only 模型会走 Responses adapter 而非 Chat Completions；没有模型级固定时保持 provider 级风格不变。

### 16.1 Responses 流终止（pi-ai 补丁）

OpenAI Responses 适配器必须把 `response.completed`（以及
`response.incomplete`）视为流的终点：完成响应收尾后即停止消费流，
而不是继续等待服务端的 TCP FIN。上游 pi-ai 会一直迭代直到服务端关闭
连接，在保持空闲连接不关的反向代理后面会导致整个回合挂起。在该修复
随上游发布之前，`patches/` 通过 pnpm patch 修改
`@earendil-works/pi-ai@0.99.1`，在终态事件处跳出事件循环（消费方停止
迭代时 OpenAI SDK 会中止底层请求）。待 pi-ai 发布包含该修复的版本后
移除补丁。

## 17. 多提供商产品规则

1. 允许多个提供商具有相同的供应商密钥（例如两个 OpenRouter 帐户）。
2. 提供商 `name` 是用户可编辑的，并且每个 workspace/user 配置文件都是唯一的。
3. 默认应用程序模型是 `(providerId, modelId)` 对，而不是单独的 modelId。
4. 会话存储其自己的 `(providerId, modelId)` 绑定。
5. 删除提供商会阻止引用该提供商的新轮次；历史会话保留 audit/display 的 ID。
6. 导出设置从不包含原始机密。
7. 导入设置可以重新创建提供商 shell 并提示输入机密。
8. 推理能力是特定于模型的，除非提供商有明确的说明
   兼容性覆盖；提供程序默认值不得覆盖会话的
   在回合解析期间选择的模型。

## 18. 验证规则

- 需要 `name`
- 需要 `vendorKey`
- 需要 `protocol`
- 当端点不隐式时，openai_compatible/custom 需要 `baseUrl`
- 当 `authKind` 需要密钥时需要秘密
- 标头不得包含原始 api 密钥（使用密钥存储）
- 模型 ID 非空

## 19. 验收标准

- [ ] 从 UI 添加 OpenAI / Anthropic / Google / OpenAI 兼容的提供商
- [ ] 使用基本 URL + 密钥添加任意 OpenAI 兼容的自定义提供程序
- [ ] 通过跨提供商的目录搜索选择模型
- [ ] 当目录丢失时接受自由格式模型 ID
- [ ] 目录刷新填充至少一个本机和一个兼容提供程序的模型，而不破坏现有提供程序
- [ ] 连接测试返回结构化 success/failure，无秘密泄露
- [ ] 可以在设置中登录厂商账户、用它跑完一个回合并退出登录；sidecar 全程
      拿不到刷新令牌
- [ ] 会话可以在回合之间切换模型
- [ ] 具有推理能力的模型仅公开受支持的思维水平和
      所选级别达到pi；不受支持的提供商解析为 `off`
- [ ] 缺少 key/model 块，以稳定、可操作的错误代码运行
- [ ] 至少一个本地提供程序路径（Ollama 或 LM Studio 风格）已记录并可测试
- [ ] 没有产品硬性限制，如“只有 3 个供应商/10 个模型”

## 20. 非目标 (MVP)

- 建立我们自己的完整供应商SDK生态系统
- 保证所有供应商具有相同的 tool/vision 质量
- 提供商市场（不需要；配置是本地的）
- 超越模型功能标志的完整多模式附件工作室
- 自动发现每个供应商门户的付费计划
- 不支持 pi-ai 的专有非 HTTP SDK
- 云同步的提供商配置文件

## 托管搜索消息与预算契约

- 搜索内容和进度事件必须拥有正式适配器类型，不能伪装成客户端工具调用。
  搜索结果和 Responses 搜索项不要求 `name` 或 `arguments`；既有回放记录保持兼容：
  本应用写出的、缺少回放 id 的记录为该消息降级为“没有 replay”，而不是让回合失败，
  升级前的历史因此仍可用。
- 回放与 token 估算共享搜索阶段的解释规则。有效 usage 只覆盖其前缀一次；
  usage 为零或失效时，全量估算必须包含搜索回放数据，不重复计算展示轮次和流式临时字段。
  估算不是服务端计费保证。
- 相同上下文重建保留系统前缀语义；真实指令或工具声明变化仍影响 usage 有效性。
  系统分段、工具增加和移除不能在重建时丢弃。
- 搜索后本地工具续跑、Task、普通续聊和重启恢复均须验证；依赖升级必须运行
  离线适配器与打包 sidecar 回归，不能只验证界面。

同一搜索投影适用于主代理与原生 pi 会话的上下文/压缩估算及输出预算。
已知目标模型时，估算遵守该适配器既有的模型切换回放边界。压缩序列化把搜索投影传入摘要请求，
不伪装成客户端工具调用。被压缩前缀转为生成的文本摘要；保留尾部中的原始搜索仍按既有规则回放，
不承诺摘要无损保留原始搜索块。

### 搜索配置引导

搜索开关与运行时共用请求路由判断。官方 DeepSeek、xAI 和旧 OpenAI Chat Completions
配置开启搜索后，内部使用已确认的搜索接口，不增加第二个服务，不改写连接设置。
其他模型及关闭搜索的请求继续使用原协议，搜索默认关闭。路由只匹配精确来源和路径，
不根据展示名称或模型名推断。最终适配器继续负责搜索解析和历史回放。
未集成格式显示“应用尚未适配”，不冒充厂商能力结论。详见提供商配置规格。
