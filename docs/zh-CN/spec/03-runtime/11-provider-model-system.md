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
请求上注入 OpenCode 路由标头（会话回合、子代理、提示增强以及插件的一次性
调用）：`x-opencode-session` 是持久的对话 id（调用方没有会话时则是按次生成的
UUID），`x-opencode-client` 为 `pi-desktop`，`User-Agent` 为
`pi-desktop/<APP_VERSION>`，除非该行设置了 `headers["User-Agent"]`。base URL
主机为 `opencode.ai` 的自定义 OpenAI 兼容行也会收到同样的标头。系统不依赖
pi-ai 去发出 `x-opencode-session`。每个提供商行（AI 服务或 OAuth 账户）都可以
设置可选的 `headers`；留空则保持适配器默认值。一层 fetch 包装是最后的写入方，
因此 Codex 与 Anthropic 无法覆盖它们。

当 OAuth 厂商围绕本地 provider 行 id 重建运行时模型时，运行时仍保留 pi-ai
原生传输元数据，不会把该行当作普通 OpenAI 端点。GitHub Copilot 请求会保留
固定 pin 模型的 IDE 身份标头，包括 `Editor-Version`、`Editor-Plugin-Version`
与 `Copilot-Integration-Id`；Agent 运行时还会按上下文加入动态的
`X-Initiator`、`Openai-Intent` 与图像请求标头。本地行 id 仍然拥有认证绑定与
对话记录身份；用户设置的提供商 headers 仍是最后的覆盖层。

智谱 / GLM 与 Z.AI 是命名的 OpenAI 兼容端点预设，收录在一份由 models.dev
支撑的、简短的第一方厂商服务列表中（含小米）。添加提供商时的「服务」选择器
会持久化匹配的 models.dev `vendorKey`，并使用已发布的端点，在命名服务这条
路径上不显示名称、Base URL 或 API 格式。对话回合仍然使用选定的 pi-ai 适配器
（`chat_completions`、`responses`、`anthropic_messages`、
`google_generative_ai` 或 `opencode_go`）。智谱 / Z.AI 的 Completions 请求
使用 `thinkingFormat: "zai"` 与 `zaiToolStream: true`。DeepSeek 系 Completions
在 `vendorKey`、Base URL、模型 ID 或目录 `family` 能识别为 DeepSeek 时设置
`requiresReasoningContentOnAssistantMessages: true`。pi-ai 只根据
`provider === "deepseek"` 或 `deepseek.com` URL 自动检测，而 PI-Desktop 把 UUID
存成 `model.provider`，因此聚合网关与自定义端点会在无思考内容的助手回合漏掉
`reasoning_content`。该覆盖不改 `thinkingFormat`。

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

### 6.2 目录职责
1. **models.dev**（`https://models.dev/api.json`）是唯一的模型元数据来源。
   Electron main 在开发时读取签入仓库的发布资源
   `apps/desktop/resources/models.dev/api.json`，在发布构建中读取打包后的
   `resources/models.dev/api.json` 路径。它绝不会把提供商凭据发给目录。
2. 签入的快照由 `scripts/release.mjs` 在创建发布标签之前刷新。运行时，
   设置 → 模型配置可以显式地重新抓取 `https://models.dev/api.json`；成功的
   响应只替换当前进程的内存内目录。抓取失败则保留上一份有效的内存内目录，
   并且绝不写入用户数据。
3. **运行时/提供商发现**与 Rust 拥有的缓存，为自定义、本地或需要认证的账户
   专属端点提供模型 id。提供商匹配接受已配置的厂商键、归一化的 API URL、
   models.dev 的提供商身份，以及带厂商前缀的 id（例如
   `deepseek/deepseek-v4`）；不带目录前缀的提供商模型 id，只有在提供商身份
   明确无歧义时，才会匹配到那个去掉前缀的精确后缀。原生适配器键可以使用目录
   别名——例如 pi-ai 的 `openai-codex` ChatGPT 订阅适配器通过 `openai` 记录
   解析模型元数据——而适配器本身保留自己的传输身份。它们不能凭空发明或替换
   模型元数据。已配置的自由格式 id 在 models.dev 中不存在时，仍可选中，
   并使用通用的纯文本、非推理基线。对于目录尚不认识的端点，设置里依然允许
   显式覆盖思考级别。
4. models.dev 记录把 `id`、`name`、`description`、`family`、`attachment`、
   `reasoning`、`reasoning_options`、`tool_call`、`structured_output`、
   `temperature`、`knowledge`、`release_date`、`last_updated`、
   `modalities.input/output`、`open_weights`、`limit.context/input/output`、
   `cost`、`interleaved`、`status`、`experimental` 和 `provider` 映射到共享的
   模型界面上。
5. pi-ai 仅仅是请求/OAuth 的实现层。它自带的模型目录与模型能力函数，不会被
   用来读取名称、上限、定价、模态、推理或其他模型配置。
6. 输入与输出模态数组保留 `text`、`image`、`audio`、`video` 和 `pdf`。文本
   agent 选择器暴露能处理文本的模型，同时在文件中保留全部原始记录以备将来的
   界面使用。只有当模型接受图片输入时，图片才会作为临时图片内容块发送。PDF
   能力会在模型元数据中呈现并保留；由于 pi-ai 0.85 没有原生的 PDF 内容块，
   PDF 附件仍然是有界的文件引用，而不会被错误地编码成图片。
7. 用户编辑过的 `ModelBinding` 值仍属于显式的提供商配置：它们控制选定的请求
   上限、启用的思考级别、应用到新的主页草稿与新持久化会话的默认思考级别
   （会被钳制到已启用集合上；只有在默认值未设置时才取已启用中最强的那个），
   以及附件能力覆盖。`models.dev` 提供已发布的元数据，并为新添加的已知模型
   播下初始的思考级别选择；它不是对用户为该端点显式启用的级别的运行时闸门。
   出于兼容考虑，仍然带着旧的通用 `128,000` 上下文种子的 binding 会跟随新
   发布的 `limit.context`；非默认的 Advanced 值仍保持显式。这样目录刷新之后，
   sidecar 与上下文检查器仍处在同一个有效窗口上。
8. 设置为每个 binding 渲染七个规范思考级别。对已知的推理模型，已发布的级别
   一开始就是选中的。非推理或未知模型显示同样的选项但不选中，并附一行简短的
   手动覆盖说明。`defaultThinkingLevel` 从该 binding 已启用的级别中选取，
   因此存下来的默认值始终属于那个显式集合。
9. `supportsImages` 与 `supportsDocuments` 是三态覆盖。缺省或 `null` 表示跟随
   已发布的 models.dev 模态，因此目录的更正仍然能作用到已保存的 binding；
   `true` 或 `false` 是用户的显式回答，并在目录变动后继续有效。与思考级别
   不同，这两个覆盖不会被收窄到已发布的能力，因为经过代理或自托管的端点
   经常接受其目录条目未列出的输入。启用图片输入会打开临时图片内容块；启用
   PDF 输入只记录该能力，不改变编码方式——pi-ai 0.85 没有 PDF 内容块，
   PDF 仍是有界的文件引用。
10. 设置里的复选框展示的是相对于已发布基线的有效答案；把某一项设回已发布的
    值，存下来的是"跟随目录"，而不是一个取值相同的覆盖。因此与 models.dev
    保持一致本身就是重置，不需要另外的重置控件，也不需要逐项能力的解释文案。
11. `ModelInfo` 是设置界面用来对照的已发布记录，因此已存储的 binding 不得
    塑造它的能力或推理字段。有效上限、推理与思考级别都通过那个确切的 binding
    解析；有效的传输模态数组还会额外套用显式的附件覆盖。
12. 用户已配置过的模型，即使实时发现不再列出它，也保留它已发布的记录，使其
    能力仍然可见、可编辑。只有已经存在于该提供商 `models` 中的 id 才会被
    重新加入，绝不会加入整个目录；而且只有发现实际返回的那些行才会被写入
    模型缓存。

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
  maxTokens: number
  thinkingLevels: ThinkingLevel[]
  defaultThinkingLevel: ThinkingLevel | null
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
描述的是解析出的 models.dev 记录；有效的 provider/会话能力则来自那个确切的
`ModelBinding`。未知的自由格式 id 以通用形态起步，不带任何推断出的推理能力，
但显式的 binding 可以主动启用相应级别。

提供商对话框会为每个选中的模型持久化一条 `ModelBinding`。第一条 binding 是
当前对话以及旧版运行时消费方的有效模型。对话级别的模型切换与跨数组路由仍属
后续工作。只有 `defaultModelId` 的旧版提供商，在主机读取时会被具体化为一条
回退 binding，并在下一次提供商写入时升级为 `models`。

`ModelBinding.availableForSubagents`（布尔值，默认 false）：这是一个选择加入
的标志，让该模型可用于 AI 驱动的子代理委托。启用后，该模型会出现在注入父
agent 系统提示的委托目录中。父 agent 随后就能通过 Task 工具的 `model` 参数
选中它。

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

这类行的模型发现读取已认证的目录（`models.getAvailable`，它已应用厂商
自己的 `filterModels`），而不是探测 `/models`；连接测试通过解析认证来
证明账户。对 ChatGPT Plus/Pro（`openai-codex`）这类静态 OAuth 厂商，该
目录是已固定的 pi-ai 模型列表，而不是实时 `/models` 探测，因此 `gpt-6-astra`
这类新账户模型只有在 pin 包含它之后才会出现。models.dev 在 ID 可用后仍
提供元数据，但不能把 ID 加进已认证列表。一个厂商可以跨越多种线路 API ——
Copilot 同时提供 Anthropic、Chat Completions 与 Responses 模型 —— 因此行
的 `apiStyle` 跟随所选模型。

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

## 11. 运行时解析算法

当使用 `(providerId, modelId)` 开始回合时：

1.从主机加载提供程序配置
2. 如果 missing/disabled → 失败（`MODEL_NOT_CONFIGURED`；保留详细信息：`PROVIDER_DISABLED`）
3. 解析凭据：密钥行通过 `secretRef` 读取机密（从不记录机密；丢失 →
   `PROVIDER_SECRET_MISSING`）；`oauth` 行完全跳过这一步并以空密钥启动，
   因为认证按请求解析（第 8a 节）
4. 通过精确的 vendor/id 或兼容的解析完整的 pi-ai 模型记录
   带有分隔符限制后缀的网关别名
5.解决后，复制pi的名字，推理标志，思维层次图，输入
   模式、定价、上下文窗口、输出限制、标题和兼容性
   逐字记录；当未解决时，接受原始模型 ID 和通用模型
   纯文本、非推理后备
6. 将会话思维水平与 PI 支持的水平相结合并构建
   通过仅替换 provider/model 标识来选择运行时提供程序适配器
   API 适配器、身份验证和显式配置的端点 URL
7. 使用中止句柄和单独的 answer/thinking 事件执行流
8. 将供应商错误转换为共享 `AppError` 代码 (§15)

如果模型不在 pi 的目录中，当用户明确指定时仍然允许它
输入模型 ID，提供商接受未知 ID。 Cached/discovered
能力字段不会促进回退到已知的运行时模型。

## 12. 兼容性层

| 层 | 意义 |
|---|---|
| 满 | 工具 + 流媒体 + 愿景 verified/expected |
| 标准 | 预计聊天流媒体 |
| 有限 | 通过兼容网关尽最大努力 |
| 未知 | 用户定制，不保证 |

UI 可能会显示层级提示，但默认情况下不得硬阻止未知模型。

## 13. 刷新和更新策略

1. Electron main 在提供模型元数据之前先读取随包的发布资源：开发时是
   `apps/desktop/resources/models.dev/api.json`，打包构建中是
   `resources/models.dev/api.json`。
2. `scripts/release.mjs` 抓取 `https://models.dev/api.json`，校验它，并在创建
   发布标签之前原子地替换签入仓库的那份资源。
3. 设置 → 模型配置可以随时强制一次远程刷新；成功的响应只更新当前进程的
   内存内目录。
4. 提供商端点发现只为随包/内存内 models.dev 快照中没有的模型提供 id；未知的
   id 使用通用元数据。
5. 刷新失败不得擦除随包文件、Rust 拥有的提供商缓存，或已配置的 binding。

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
`@earendil-works/pi-ai@0.85.1`，在终态事件处跳出事件循环（消费方停止
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
