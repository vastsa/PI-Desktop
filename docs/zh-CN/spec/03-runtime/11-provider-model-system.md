# 11. 提供商和模型系统

> **翻译说明：** 本页是与 [英文源规格](/spec/03-runtime/11-provider-model-system) 一一对应的机器辅助翻译。代码、协议字段和标识符保持原文；如翻译与英文源事实有歧义，以英文版本为准。


## 1. Goal

PI-Desktop 必须支持用户通常需要的**所有主要市场模型供应商和模型**，而无需将一个微小的允许列表硬编码为产品上限。

策略：

> **通过 pi-ai + 兼容 OpenAI 的逃生舱门 + 可刷新的模型目录实现通用提供商覆盖。**

我们**不会**自己重新实现每个供应商 SDK。
我们对 pi 的多提供商层进行标准化，并添加产品级配置、目录和用户体验。

## 2. 覆盖原则

###必须支持
1、第一方主要厂商
2. 流行的聚合器/网关
3.任何兼容OpenAI的端点
4. 用户定义的自定义提供程序
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

协议配置文件 (MVP)：

1.`openai`
2.`anthropic`
3.`google`
4.`openai_compatible`
5. `bedrock`（如果运行时支持启用）
6. `custom_http`（稍后为advanced/experimental）

智谱 / GLM 与 Z.AI 是命名的 OpenAI 兼容端点预设，不是新的线路 API。添加服务的
「服务」下拉框提供国内/国际标准 API 以及 GLM Coding Plan 地址，持久化对应的
models.dev `vendorKey`，并锁定端点。对话仍走 pi-ai 的 OpenAI Chat Completions
适配器，并带上 `thinkingFormat: "zai"` 与 `zaiToolStream: true`。PI-Desktop
存储 models.dev 的键（`zhipuai`、`zhipuai-coding-plan`、`zai`、
`zai-coding-plan`），以免与 pi-ai 国际 Coding Plan 传输名 `zai` 混淆。

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

## 6. 车型扶持政策

### 6. 1 无硬模型许可上限
PI-Desktop 不得将用户永久限制在简短的固定模型列表中。

### 6. 2 目录职责
1. **pi-ai 的捆绑目录**是已知的唯一运行时元数据源
   模型。
2. **运行时本机发现**和持久缓存提供选择和
   离线可用性，但绝不重写已知模型运行时语义。
3. **用户定义的模型 ID** 仍然可选； pi 中缺少的 ids 使用
   显式通用后备。
4. **pi-ai 升级** 刷新权威模型元数据快照。
   当前引脚为 `@earendil-works/pi-ai` / `pi-agent-core` **^0.82.1+**。
   该快照包括 **Claude Opus 5**（`claude-opus-5` 和提供商原生
   别名，例如 Bedrock 推理配置文件和 OpenRouter
   `anthropic/claude-opus-5`）具有 1M 上下文、自适应思维和
   出版了思维层次图。与这些目录匹配的自由格式网关 ID
   条目通过相同的 D136 路径解析； pin 中仍然不存在 id
   继续使用通用的非推理后备。

当前 context window 的有效值也要在 sidecar 与统计检查器之间保持一致：已发布
的 `models.dev limit.context` 会替换旧 binding 中的 128k 通用种子；用户在
Advanced 中填写的非默认值仍然优先。未知模型仍使用 128k，不能凭模型 ID 推断
1m 能力。

### 6. 3 涵盖的模型系列
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
  headers?: Record<string, string> // non-secret headers only
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

上面的兼容性字段保留为持久模式兼容性
面向老客户的表面。 PI-Desktop 不再将它们读取为运行时模型
覆盖。推理支持和受支持的思维水平来自
解决了 pi-ai 模型记录；未知的自由格式 ID 未暴露任何推断
推理能力。

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
证明账户。一个厂商可以跨越多种线路 API —— Copilot 同时提供 Anthropic、
Chat Completions 与 Responses 模型 —— 因此行的 `apiStyle` 跟随所选模型。

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
- set/replace/delete 键
- 登录/退出厂商账户，并看到某一行使用的是哪个账户
- 选择多个模型并编辑每个绑定的上下文窗口、输出上限与启用的思考等级；目录元数据
  为 API 提供商与已登录的厂商账户提供初始值。绑定只能启用所解析 models.dev 记录
  已发布的等级，因为运行时会在构造请求前把绑定与该已发布集合取交集。两种界面通过
  同一个选择器呈现这些设置，因此厂商账户编辑器提供与 API 提供商编辑器相同的按绑定
  编辑，并应用同样的向已发布等级收敛的处理（D270）
- enable/disable 提供商
- 测试连接
- 不要暴露推理、思维水平、上下文窗口、输出限制、
  温度或所选模型的兼容性覆盖

### 模型选择器
- 搜索启用的提供商的所有模型
- provider/vendor 分组
- 显示能力徽章（tools/vision/reasoning）
- 允许“刷新模型”
- 允许自定义模型 ID 输入

### Empty/error 状态
- 没有配置提供商
- 钥匙丢失
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

1.应用程序附带捆绑的目录快照
2. 用户可以点击**刷新模型目录**
3.刷新可能会更新：
   - 为具有列表 API 的提供商发现模型
   - 通过应用程序更新渠道捆绑目录
4.刷新失败不得擦除现有目录

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
- `apiStyle`（`chat_completions` | `responses` | `auto`）
- 兼容性标志
- 自定义标头（非秘密）

这是**通用逃生舱**，保证超出本机集成的市场覆盖范围。

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
