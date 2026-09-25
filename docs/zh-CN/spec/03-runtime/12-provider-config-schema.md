# 12. 提供商配置架构

> **翻译说明：** 本页是与 [英文源规格](/spec/03-runtime/12-provider-config-schema) 一一对应的机器辅助翻译。代码、协议字段和标识符保持原文；如翻译与英文源事实有歧义，以英文版本为准。


## 1. 存储位置

由 Rust 主机 DB/settings 存储拥有。

表（[04-data-storage](/zh-CN/spec/03-runtime/04-data-storage) §4.3–4.4、§4.11 中的规范 DDL）：

- `providers`
- `models`（单个目录表；`source: bundled | discovered | user` 替换旧的 `provider_models` / `model_catalog_cache` 拆分）
- `secrets_meta`（无原始秘密值）
- 最近模型的 MRU 位于 `kv(ns='cache')` 中，而不是表中

## 2. 提供商记录 JSON 架构（逻辑）

```json
{
  "$id": "pi-desktop.provider.v1",
  "type": "object",
  "required": ["id", "name", "vendorKey", "type", "protocol", "enabled", "authKind"],
  "properties": {
    "id": { "type": "string", "minLength": 1 },
    "name": { "type": "string", "minLength": 1 },
    "vendorKey": { "type": "string", "minLength": 1 },
    "type": { "enum": ["native", "openai_compatible", "custom"] },
    "protocol": {
      "enum": ["openai", "anthropic", "google", "openai_compatible", "bedrock", "custom_http"]
    },
    "enabled": { "type": "boolean" },
    "baseUrl": { "type": "string" },
    "authKind": {
      "enum": [
        "api_key",
        "api_key_and_base_url",
        "bearer",
        "azure_api_key",
        "aws_sdk_default",
        "custom_headers",
        "oauth",
        "none"
      ]
    },
    "secretRef": { "type": "string" },
    "headers": {
      "type": "object",
      "additionalProperties": { "type": "string" },
      "maxProperties": 32
    },
    "userAgent": { "type": "string", "maxLength": 256, "description": "legacy; migrates into headers.User-Agent" },
    "apiStyle": {
      "enum": [
        "chat_completions",
        "responses",
        "anthropic_messages",
        "google_generative_ai",
        "openai_codex_responses",
        "pi_messages",
        "auto"
      ]
    },
    "compatibility": {
      "type": "object",
      "properties": {
        "supportsTools": { "type": "boolean" },
        "supportsVision": { "type": "boolean" },
        "supportsStreaming": { "type": "boolean" },
        "supportsReasoning": { "type": "boolean" },
        "supportedThinkingLevels": {
          "type": "array",
          "items": {
            "enum": ["off", "minimal", "low", "medium", "high", "xhigh", "max"]
          },
          "uniqueItems": true
        }
      }
    },
    "defaultModelId": { "type": "string" },
    "models": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["id"],
        "properties": {
          "id": { "type": "string", "minLength": 1 },
          "alias": { "type": "string", "maxLength": 60 },
          "contextWindow": { "type": "integer", "minimum": 0 },
          "contextWindowSource": { "enum": ["catalog", "user"] },
          "maxTokens": { "type": "integer", "minimum": 0 },
          "thinkingLevels": {
            "type": "array",
            "items": { "enum": ["off", "minimal", "low", "medium", "high", "xhigh", "max"] },
            "uniqueItems": true
          },
          "defaultThinkingLevel": {
            "type": ["string", "null"],
            "enum": ["off", "minimal", "low", "medium", "high", "xhigh", "max", "omit", null]
          },
          "supportsImages": { "type": ["boolean", "null"] },
          "supportsDocuments": { "type": ["boolean", "null"] },
          "availableForSubagents": { "type": "boolean", "default": false }
        }
      }
    },
    "ownerPluginId": { "type": ["string", "null"] },
    "createdAt": { "type": "string" },
    "updatedAt": { "type": "string" }
  }
}
```

插件通过 `contributes.providers` 声明的行带有 `ownerPluginId`（其行 id 为
`plugin:<pluginId>:<declaredId>`），对模型解析、发现、连接测试和会话绑定而言
它是一行普通 provider。用户路径对它只读：`providers.update` 与
`providers.delete` 会以 `PROVIDER_OWNED_BY_PLUGIN` 错误拒绝。该声明在每次插件
加载时从插件 manifest 重新读取，并对自己拥有的字段具有权威性，而已存储的
`headers`、OAuth 账户标签以及用户填入的凭据都会保留。停用插件保留该行并将其
关闭；卸载插件或移除该声明会删除该行及其两个凭据引用（ADR 0259，
`07-plugins/02-plugin-manifest-schema.md` §5.4）。

`models[].alias` 是可选展示标签（ADR 0192）。`models[].id` 仍是发给提供商的
身份，别名从不用于提供商或模型解析。host-core 会修剪别名、丢弃空白值，
并在超过 60 个 Unicode 字符时以 `MODEL_ALIAS_TOO_LONG` 拒绝。

`models[].contextWindow` 与 `models[].maxTokens` 在线为可选。缺失的键、或显式的 `0`，
都不是按模型的选择：host 把它读作 0 并补上通用默认值（128,000 / 8,192）——这与上面
legacy 绑定被物化时用的是同一个值，也与未声明限额的插件 manifest 已经产生的值相同。
存储数组与 manifest 由此对“没有限额的模型”取得一致（D610）。

存储的 `models` 数组逐条解码。不再符合 schema 的条目会被跳过，并在宿主日志里带上
提供商 id、条目下标与原因上报，而不是丢弃整个数组。读取仍可用，但会标记为降级：非法
JSON、根节点非对象、`models` 非数组，或任一条目不可读，都会被上报。缺失的 `models`
键和空数组仍是合法的 legacy 状态；所有条目都不可读的数组仍回退到 legacy 绑定并上报。
为防止设置页的部分视图覆盖并丢失存储数据，当存储值降级时，`providers.update` 会以
`MODEL_BINDINGS_DEGRADED` 拒绝显式替换模型数组；不涉及模型数组的提供商字段仍可更新。

`models[].contextWindowSource` 记录存储的 `contextWindow` 来自哪里：`catalog` 表示
models.dev 快照，之后的目录修正可以替换它（查询未命中而回退到通用形状不算修正）；`user` 表示用户在设置中手改的值，永不被
替换。该字段可选，因此早于该标记写出的配置仍可读，旧客户端会忽略它。host-core 只
保留这两个取值、丢弃其它值，避免出现第三种无人识别的状态。解析规则见
[13-model-catalog-and-selection](13-model-catalog-and-selection.md) §9.1。

`compatibility.supportsReasoning` 和
`compatibility.supportedThinkingLevels` 对于存储的记录保持可读状态
旧客户端兼容性，但 Electron main 在运行时忽略它们
模型分辨率。公共提供商形状是从精确的 pi-ai 中丰富的
代替模型记录。未知的自由形式模型暴露了 `supportsReasoning=false`
和 `supportedThinkingLevels=["off"]`。原始秘密和内部兼容性
JSON 保持隐藏状态。
手输的自定义模型 id 会在写入绑定前先与该快照匹配（`providers.lookupModel`，§9）：
即使该 id 不在任何已发现的列表中，已发布的记录也会提供绑定的上下文窗口、最大输出
token 与思考等级；未发布的 id 仍沿用通用种子值。

`authKind: "oauth"` 标记厂商账户行（ADR 0095、D237）：其凭据是保存在
`secret:provider:<id>:oauth` 下的 OAuth 授权，而不是粘贴的密钥，因此该行
不为它保存 `secretRef`，并以空密钥启动。两种账户专用 apiStyle 是厂商账户专用的
线路 API —— `openai_codex_responses`（Codex 会话封装）与 `pi_messages`
（radius 网关）—— 自定义提供商对话框不提供它们，因为二者都无法配合手输的
base URL 与粘贴的密钥工作。新建自定义服务只提供 Chat Completions、Responses、Anthropic
Messages 和 Google Generative AI；OpenCode Go 仍通过具名服务配置。
历史非 OAuth 行若保存了上述账户专用格式，编辑时会显示禁选的当前格式和
说明，并允许原样保存。仅打开编辑器不会根据匹配的端点预设修改协议、名称
或 URL；选择其他格式才是明确变更。复制此类行时保留草稿中的原格式供
确认，但在主动选择支持的格式前禁止保存和模型发现，并显示原因。
不迁移已有认证类型或凭据。厂商行的样式不由厂商固定：GitHub Copilot 同时
提供 Anthropic、Chat Completions 与 Responses 模型，因此样式跟随所选模型，
并在每次切换模型时重写。`config_json.oauth.accountLabel` 保存已登录账户的
非敏感展示标签。

### 将提供商配置复制为独立草稿

模型配置页在普通非 OAuth 提供商行提供**复制**操作，通常打开新的自定义
服务草稿。草稿中的 API 格式可以修改，便于为同一站点的其他协议复用地址
和模型绑定。OpenCode Go 是例外：副本保留命名服务与固定的 `opencode_go`
格式；先切换为自定义服务，才能选择普通 API 格式。OAuth 账户行不提供此操作。

草稿按明确的字段白名单构建：来源名称、`baseUrl`、`apiStyle` 以及 `models`
中已声明的绑定字段。模型对象及嵌套的 `thinkingLevels` 数组独立复制，编辑
草稿不能修改来源对象。建议名称可带复制标记，用户可以在保存前修改。
不复制来源 `id`、凭据或凭据引用、`hasSecret` 状态、OAuth 元数据、自定义
`headers` 或未知字段。允许使用的自定义请求头也可能包含 token，因此全部
省略。对话框说明：需要认证信息或自定义请求头时，应为新配置重新填写。

Base URL 格式无效、不是 HTTP(S)，或包含用户名/密码、查询参数、片段时，
草稿中的地址留空，避免复制历史 URL 中的凭据。

草稿使用正常的新提供商发现路径，不得把来源 provider id 传给模型发现或
连接测试来解析来源保存的密钥。需要认证的发现请求只使用为新草稿明确
填写的凭据。复制操作不读取或复制秘密存储中的值。

取消草稿不持久化提供商或配置。保存走现有 `createProvider` /
`providers.create` 流程，分配新的提供商身份；填写新密钥时创建该提供商
自己的凭据引用。来源提供商与全局默认提供商、模型选择保持不变。新
提供商自己的默认模型仍按现有创建规则取首个所选模型。复制操作不新增
IPC 方法、存储 schema 或权限边界。

## 3. 内置供应商预设

仅预设预填表单默认值；他们不是一个封闭的世界。

| 供应商密钥 | 默认协议 | 授权类型 | 需要基本网址 |
|---|---|---|---|
| 开放性 | 开放性 | api_key | 不 |
| 人择的 | 人择的 | api_key | 不 |
| 谷歌 | 谷歌 | api_key | 不 |
| 开放路由器 | openai_兼容 | api_key_and_base_url | 是的 |
| 深度搜索 | openai_兼容 | api_key_and_base_url | 是的 |
| 格罗克 | openai_兼容 | api_key_and_base_url | 是的 |
| 在一起 | openai_兼容 | api_key_and_base_url | 是的 |
| 烟花 | openai_兼容 | api_key_and_base_url | 是的 |
| 米斯塔拉尔 | openai_兼容或本机 | api_key | 可选的 |
| 赛 | openai_兼容 | api_key_and_base_url | 是的 |
| azure_openai | openai_兼容 | azure_api_key | 是的 |
| 基岩 | 基岩 | aws_sdk_默认 | 不 |
| 奥拉马 | openai_兼容 | 无 | 是的 |
| 工作室 | openai_兼容 | 无 | 是的 |
| 定制 | openai_兼容 | api_key_and_base_url | 是的 |

### 固定 API 风格预设

| apiStyle | 提供商类型 | authKind | 名称 | baseUrl |
|---|---|---|---|---|
| `opencode_go` | `openai_compatible` | `api_key_and_base_url` | `OpenCode Go` | `https://opencode.ai/zen/go/v1` |

OpenCode Go（以及任何 `opencode.ai` 主机）的 LLM 请求必须带稳定的
`x-opencode-session`。agent-runtime 在会话、子代理、提示增强与插件 one-shot
上发送该头，并附带 `x-opencode-client: pi-desktop` 与
`User-Agent: pi-desktop/<APP_VERSION>`。行上可选的 `headers` 会覆盖这些默认值；留空则保持适配器默认。

每行（AI 服务或 OAuth 账户）可在高级选项中用键值行编辑自定义请求头。空映射保持 pi-ai / `claude-cli` / OpenCode 默认。fetch 包装器是最后写入者，因此 Codex 与 Anthropic SDK 无法覆盖。禁止 `Authorization` / `Host` / `Content-Type` 等保留头。遗留的 `userAgent` 读取时迁入 `headers["User-Agent"]`。首次 OAuth 登录不收集请求头，登录后再编辑。覆盖 Anthropic OAuth 的 `claude-cli/…` 可能导致 Claude Pro/Max 拒绝请求。

键不区分大小写且唯一，最多 32 条，名称 ≤ 256 字节，值 ≤ 4096 字节，名称只允许字母数字与连字符，且不得含 CR/LF。值先做半角化——全角块（U+FF01–U+FF5E）与表意空格（U+3000）换成对应 ASCII——再修剪，再校验：HTAB、可打印 ASCII 与 Latin-1 补充区可以随请求发出，汉字、emoji、弯引号、NUL 及其它控制字符则以 `HEADERS_INVALID` 拒绝，并指出具体字符与字符下标。半角化覆盖的正是用户真正会撞上的情况：全角字符来自输入法或全角排版的网页，若不处理，`Headers.set` 会在回合中途抛 `Cannot convert argument to a ByteString`。这里刻意不做完整 NFKC：它会把半角片假名改写成 U+00FF 以上的码位并产生组合字符。高级编辑器也会在行旁提示哪些值会被半角化、哪些会被拒绝。

同一条规则在三个边界上以三种**有意不同**的失败方式生效：**编辑器保存**时对无法发送的行报 `HEADERS_INVALID` 并指出字符与下标，因为此时有用户在场可以改；**读取已存映射**时做半角化并丢弃无法发送的行，规则生效前写入的数据不会让回合失败；**收到同步 bundle** 时在反序列化成写入输入之前先做半角化与丢弃，因此旧版本对端（或规则前的备份）仍带着的某一行不会让整个 revision 失败。也就是说读取路径与同步路径一致，只有交互式写入会报错。

### 命名端点预设

这些行由添加提供商对话框的**服务**下拉框创建。命名服务的常见路径是服务 +
API 密钥；自定义端点在常见路径上并排显示 API 密钥与接口格式。`vendorKey`
使用 models.dev 提供商键。

国际：OpenAI、Anthropic、Google Gemini、OpenRouter、Groq、xAI、Mistral、
Together、Fireworks、OpenCode Go、Z.AI。

国内：DeepSeek、通义千问、月之暗面、智谱 / Coding Plan、硅基流动、火山方舟、
MiniMax（`anthropic_messages`，`https://api.minimaxi.com/anthropic/v1`）、
MiniMax (OpenAI)（`chat_completions`，`https://api.minimaxi.com/v1`，别名
`minimax-openai` / `minimax-compatible`）、Kimi 编程。

智谱 / Z.AI 的 Completions 请求仍使用 `thinkingFormat: "zai"` 与
`zaiToolStream: true`。DeepSeek 系 Completions 在 vendor key、URL、模型 ID 或
目录 family 能识别为 DeepSeek 时设置
`requiresReasoningContentOnAssistantMessages: true`，不改 `thinkingFormat`。

### 厂商账户预设

这些行由登录创建（设置 → 模型配置 → 厂商账户），而不是由自定义提供商
对话框创建。列表在运行时由 `models.getProviders().filter(p => p.auth.oauth)`
派生，因此它跟随 pi-ai 而不是本表；`baseUrl`、`apiStyle` 与 `defaultModelId`
在登录后由账户自己的目录填入。

| vendorKey | 订阅 | 典型 apiStyle | 登录形态 |
|---|---|---|---|
| anthropic | Claude Pro/Max | anthropic_messages | PKCE + 本地回调 |
| openai-codex | ChatGPT Plus/Pro | openai_codex_responses | PKCE + 本地回调，或手动贴码 |
| github-copilot | Copilot | 随模型而变 | 设备码 |
| openrouter | 账户余额 | chat_completions | PKCE + 本地回调 |
| kimi-coding | Kimi | chat_completions（仅 headers 认证） | 设备码 |
| xai | xAI | chat_completions | 设备码 |
| radius | Radius | pi_messages | PKCE + 本地回调 |

## 4. 模型目录缓存记录

```ts
type ModelCatalogCacheRecord = {
  providerId?: string // empty for global bundled
  modelId: string
  displayName: string
  vendorKey: string
  capabilities: string[]
  contextWindow?: number
  source: "bundled" | "discovered" | "user"
  updatedAt: string
  raw?: unknown
}
```

上下文窗口解析与 sidecar 保持一致：若 models.dev 已发布正数
`limit.context`，它会替换旧 binding 中的 128k 通用种子；用户在模型
Advanced 控件中设置的非默认值仍优先。未知模型继续使用 128k 的保守后备。

Copilot OAuth 行还会保留固定 pin 的 pi-ai 传输模型中的静态 IDE 身份标头
（`Editor-Version`、`Editor-Plugin-Version` 与 `Copilot-Integration-Id`），
即使运行时模型使用本地行 id 进行账户隔离。Agent 运行时会按每次调用提供
Copilot 的上下文相关请求标头；已保存的同名自定义 header 会覆盖默认值。

## 5. IPC / 主机方法（提供商域）

- `providers.list`
- `providers.reorder`
- `providers.get`
- `providers.create`
- `providers.update`
- `providers.delete`
- `providers.testConnection`
- `providers.listModels`
- `providers.lookupModel`
- `providers.cacheModels`（内部 Electron-main 到主机持久桥）
- `providers.refreshModels`
- `providers.upsertUserModel`
- `providers.deleteUserModel`

## 6. 安全限制

1. list/get 提供商 API 从未返回原始机密
2. 如果可以使用密钥存储，`headers` 不得存储 `Authorization: Bearer <secret>`
3.导出设置默认排除机密

## 7. 迁移

- 通过 `PRAGMA user_version` 的架构版本（04-数据存储§7）
- 提供商记录累加进化；每个提供商的扩展字段登陆 `config_json`
- 未知的未来协议值不应使旧的应用程序版本崩溃（ignore/disable，带有警告）

## 8. SQL（Rust 拥有的 SQLite）

规范的 DDL 位于 [04-data-storage](/zh-CN/spec/03-runtime/04-data-storage) (D086) 中。提供商域表摘要：

```sql
-- providers: id/name/vendor_key/type/protocol/api_style/auth_kind/base_url/
--            enabled/secret_ref/default_model_id + config_json (headers,
--            compatibility, future knobs), INTEGER ms timestamps
-- models:    PK(provider_id, model_id), display_name, source
--            (bundled|discovered|user), capabilities_json, context_window,
--            max_output_tokens, deprecated — refresh upserts never overwrite
--            source='user' rows
-- secrets_meta: secret_ref PK, owner_kind/owner_id, kind, backend
```

> 原始秘密材料**不**存储在这些表中。

## 9. 宿主方法合约 (v1)

### `providers.list`
- 在：`{ includeDisabled?: boolean }`
- 输出：`{ providers: ProviderPublic[] }`
- `ProviderPublic` 排除原始秘密；包括 `hasSecret: boolean`（**任一种**凭据
  存在即为真）、`hasOauth: boolean`、非敏感的 `oauthAccountLabel?: string`
  与可选的 `headers?: Record<string, string>`

### `providers.reorder`
- in: `{ id: string, targetId: string, placement: "before" | "after" }`
- out: `{ ok: true }`
- Atomically move the source relative to the target in the current host list.
  A missing source/target or invalid placement returns `INVALID_PARAMS` without
  writing. Moving to the current position is a successful no-op.
- Persist ordered provider IDs in `kv` at `providers.order`. `providers.list`
  applies that order before returning rows; absent metadata preserves creation
  order. New providers follow saved rows in creation order, deleted IDs are
  ignored, and disabled rows keep their relative position when filtered out.
- This is a display preference, including for plugin-owned rows. Provider
  configuration, credentials, enabled state, timestamps and the default model
  remain unchanged. Plugin configuration write restrictions still apply.
- Uses the existing `kv` extension boundary; no database migration or protocol
  version bump. Older applications ignore this metadata.

### `providers.create` / `providers.update`
- 在：提供商字段 + 可选的 `secretValue` + 可选的 `oauthAccountLabel`
  （合并进 `config_json.oauth`，传空字符串即清除）+ 可选的 `headers`
  （合并进 `config_json.headers`，传 `{}` 即清除）；遗留 `userAgent` 读取时迁入 `headers["User-Agent"]`；旧客户端仍可能发送
  `supportsReasoning` / `supportedThinkingLevels`
- 行为：保留配置；如果存在secretValue，则写入密钥存储并设置
  `secretRef`；传统思维领域可能仍保留在
  `config_json.compatibility` 但不影响运行时分辨率
- 输出：`ProviderPublic`

### `providers.delete`
- 在：`{ id, deleteSecret?: boolean }` 默认 `deleteSecret=true`
- 行为：同时清除两个凭据引用（`:api_key` 与 `:oauth`）及其元数据记录，
  因此重新创建的提供商绝不会继承他人的刷新令牌
- 输出：`{ ok: true }`

### `providers.testConnection`
- 在：`{ id, modelId?: string }`
- 输出：`{ ok: boolean, latencyMs?: number, error?: AppError, sampleModelId?: string }`
- `authKind: "oauth"` 行通过解析厂商认证（必要时刷新令牌）来自证，而不是用
  它并不持有的密钥去访问网络

### `providers.listModels`
- 渲染器 IPC 位于：`{ providerId, source?: "cache"|"refresh" }`； `cache`
  返回没有提供商网络访问权限的持久目录，而 `refresh`
  在 Electron main 中运行发现
- 将 RPC 托管在：`{ providerId?: string }` 中；只读取 Rust 拥有的 `models`
  表
- 对 `authKind: "oauth"` 行，Electron 主进程读取已登录账户自己的模型列表
  （见 `03-runtime/11-provider-model-system.md`），请求失败才回退到 pi-ai
  的 `models.getAvailable`。返回的每个模型都带着其线路 API 所隐含的
  apiStyle。`openai-codex` 调用 `GET {base}/codex/models`，因此 `gpt-6-luna`
  这类账户 id 不需要等 pin 更新；models.dev 不会发明这些 ID。Copilot 仍只列出
  账户已启用的模型。
- 输出：`{ models: ModelCatalogItem[] }`；每个模型都带有 pi-resolved
  `reasoning` 功能和 `supportedThinkingLevels`。缓存的功能标签
  旧提供程序字段无法覆盖 pi 模型记录。

### `providers.lookupModel`
- 渲染器 IPC 入参：`{ modelId, baseUrl?, providerId?, vendorKey? }`
- 输出：`{ info: ModelInfo | null }`
- 只读取本地 models.dev 快照：先 `ensureLoaded` 再 `findModel`，不访问提供商网络，
  也不调用主机 RPC。`vendorKey` 与 `baseUrl` 仅用于在重复 id 之间消歧归属的发布提供
  商；`providerId` 会回显在返回记录上供设置界面使用。
- 需要它是因为 `providers.listModels` 只描述已保存或已探测提供商的目录：手输的自定义
  id 在提供商保存前没有别的通道取得其已发布限额。
- 命中时按拾取模型的口径（`bindingFromModelInfo`）为这条绑定播种：已发布的上下文窗口、
  最大输出 token 与思考等级，并标记 `contextWindowSource: "catalog"`；存储的 id 仍是
  用户输入的那个（`bindingForCustomModelInfo`）。未命中（`null`）保持今天的行为：按
  通用 128,000 / 8,192 与空思考等级播种（`bindingForCustomModel`）。行先落下再原地升级，
  因此查询慢、失败或未发布时仍然只留一行可用记录，且不会覆盖期间发生的编辑或删除。

### `providers.cacheModels`（内部主机 RPC）
- 在：`{ providerId, models: DiscoveredModelInput[] }`
- 行为：以事务方式将成功的实时发现更新到 `models` 中
`source='discovered'`；永远不会覆盖 `source='user'` 行并且永远不会删除
  失败或部分刷新时先前的缓存行
- 输出：`{ cached: number, models: ModelCatalogItem[] }`
- 原始机密和授权标头绝不是此调用的一部分

### `providers.refreshModels`
- 在：`{ id }`
- 输出：`{ added: number, updated: number, removed: number, models: ModelCatalogItem[] }`

### `providers.upsertUserModel` / `providers.deleteUserModel`
- 管理自由格式/覆盖模型条目

## 10. 验证规则

1. `name` 在提供商中是唯一的（不区分大小写）
2. `openai_compatible` / 本地网关需要绝对 `baseUrl`，除非预设表示可选
3. `authKind=none` 禁止用于需要密钥的云预设
4. headers key 不区分大小写，唯一
5. headers key 不区分大小写且唯一，最多 32 条；名称只允许字母数字与连字符；
   值先由全角折成半角再修剪，最多 4096 字节，不得含 CR/LF，只能是可打印
   Latin-1——U+00FF 以上的字符或控制字符会被拒绝，并指出该字符与字符下标
6. 强制实施 SecretValue 最大长度（例如 8KB）；全角的值在写入与读取时都折成
   半角，因为密钥最终会签进 HTTP 头。仍然不是 Latin-1 的密钥**不会**被拒绝：
   有些认证方式并不把密钥放进请求头（查询参数、SigV4 签名），写入侧无从判断，
   这类密钥仍在发请求时报错
6. modelId 必须是非空的修剪字符串；允许 `/`、`.`、`:`、`-`
7.旧客户端上的未知协议 => 提供程序显示为禁用并带有警告，而不是崩溃
8. 旧版 `supportsReasoning`（如果存在）仍必须验证为布尔值，但
   没有运行时效果
9. 旧版 `supportedThinkingLevels`（如果存在）仍必须验证为
   一系列规范思维水平，但没有运行时效果

## 11. 秘密引用格式

```text
secret:provider:<providerId>:api_key
secret:provider:<providerId>:oauth
```

两个引用相互独立，因此一行可以只有密钥、只有厂商账户，或两者兼有；参见
[14-secrets-storage](14-secrets-storage.md) §10。未来的多重秘密提供商可能会
继续添加后缀（`:client_secret` 等）。

### 接口格式引导与原生搜索

每个提供商保留一个服务入口。开启模型的 `nativeWebSearch` 不改写服务地址、
接口格式、名称、凭据引用或其他模型。界面与运行时共用 `nativeWebSearchTransport`：
仅匹配已确认的官方 HTTPS 来源和路径，且用户开启搜索时，才在请求阶段选择已有适配器。
DeepSeek 官方根地址或 `/v1` 通过 `/anthropic/v1/messages` 搜索；xAI 和旧 OpenAI
Chat Completions 配置使用同源 Responses。关闭搜索后恢复原配置的请求方式。
原有 Responses、Codex、Anthropic 及其他明确选择的协议不变。
不依据厂商名或模型名跳转；中转站、自定义端口、其他路径、含凭据或查询片段的地址不匹配。

不增加 DeepSeek 搜索预设、第二个服务、切换接口操作、迁移或 IPC 字段。
其他尚未集成的搜索格式会说明应用未适配，不代表厂商官网或其他 API 不支持。
部分官方搜索需要独立的协议适配，详见搜索服务核查记录。

#### 端点解析

用户填写的 Base URL 会先被解析，再进行任何探测。解析是 `@pi-desktop/shared/provider-endpoint`
中的一层纯逻辑，设置对话框与 Electron main 共用，因此「显示的地址」「探测的地址」「保存的
地址」不会互相矛盾：

- 裸主机名会补上 `https://`，仍限定在用户填写的来源内；含凭据、查询或片段的地址一律拒绝。
- 粘贴的接口后缀（`/chat/completions`、`/responses`、`/messages`）既指明格式，也会从基础地址中
  移除；`/models` 只表示粘贴的是发现地址。与所选格式冲突的后缀会原样保留，由用户决定，而不是
  悄悄改写这一行。
- 格式按以下顺序确定：用户显式选择、粘贴的接口后缀、精确匹配的已发布端点、已知主机、发布方的
  `npm` 适配器，最后回落到 Chat Completions。模型 ID 不参与判断：同一网关用一条 Chat Completions
  路由提供 `gpt-*`、`claude-*`、`gemini-*` 时，仍保持该路由。
- 当格式来自端点推断时，自定义表单会在选择器旁显示「自动识别：…」。用户手动选择的格式（以及
  命名预设自身的格式）此后始终优先。

随后发现流程会按置信度顺序探测解析出的候选地址：最多四个、去重、且都限定在用户填写的来源内。
第一个返回模型列表的候选胜出，其应答地址即表单显示并保存的 Base URL。整轮各候选共享 12 秒预算
（而不是每个候选各自计时），并且串行执行，因为每次请求都携带用户的 API Key。该 Key 不会发送到
其他来源，跨来源重定向会被拒绝而不是跟随。`/v1beta`、`/compatible-mode/v1` 等厂商专属路径来自
端点注册表，不做无差别猜测，且只在用户只填了主机名时提供：填了具体路径就是该部署自己的答案，因此
返回空的 `/api/v1` 会照实报告，而不会被换成注册表里的 `/api/paas/v4` 兄弟路径。唯一的通用附加路径
是未知 OpenAI 兼容端点的 `/v1`。三种已发布的模型列表结构都会被读取——`data[].id`、Google 的
`models[].name`，以及智谱 OpenAI Responses 端点返回的 `models[].slug`——因此有应答的端点不会被
当成空列表。连接测试复用同一
套请求构造，因此「模型列表加载成功」与「连接测试通过」描述的始终是同一个地址、认证头与格式。

### 按哪个发布方读取元数据

行自身没有指明发布方时，按端点能识别的发布方来读，顺序是：已发布基础地址完全匹配的目录记录、
端点注册表中的已知主机、以及该主机在目录里恰好只有一个发布方时的这条记录。这样自定义行指向厂商
的另一个接口路径时（例如智谱 OpenAI Responses 端点 `https://open.bigmodel.cn/api/v1`），不会对
目录里已有完整描述的模型显示成通用的 128k / 8k / 纯文本默认值。

完全识别不出发布方时（中转站、或目录不认识的主机），先由 app 自带 provider 的发布方回答：它们是一等
presets 背后的厂商与网关，其记录描述的就是这个模型；中转商自己的标记描述的是它自己的部署。只有当这些
发布方都没声明该 ID 时，候选才扩大到所有声明它的发布方 —— 否则只有中转站收录的 ID 会退化成通用的
128k 纯文本行。在该候选池内按各家的共识取值：上下文与输出取下中位数；除工具能力外的各项能力，只在
所有发布方都声明时才保留，因此只可能低估。工具能力按声明该能力的发布方的多数决：中转站列出的一个 ID
可能被上百个发布方声明，某个并不描述该部署的中转商既不应替它下结论，也不应让整条记录作废；票数持平
则不声明。仅仅是名字末段相同（`provider-a/foo` 与 `gateway/foo`）的两条不同路由不算同一模型，因此
身份确实未知的 ID 仍然不做匹配。以这种方式借用的记录不声明推理的线上字段形状（那是部署的属性），而
Anthropic Messages 行仍使用 Anthropic 自己的形状。模型 ID 不参与判断该读哪个发布方。

查找针对的是行已经列出的 ID：服务返回的 ID 若自身记录是音频模型（TTS/ASR 同类），也会命中该记录。
只有目录列表本身限定为文本 / Agent 模型，因为它决定一行「提供」哪些模型。

元数据匹配可以跟随发布日期后缀：`mify/mimo-v2.5-pro-0731` 会借用 `mimo-v2.5-pro` 的发布记录，
但目录中与该 ID 完全一致的记录仍然优先于这类别名。别名只影响元数据：已保存绑定的线上 ID 保持
服务实际返回的原值。

无效或带凭据的地址仍然不给建议，取消仍然不写入草稿。
