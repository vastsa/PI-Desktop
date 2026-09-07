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
      "additionalProperties": { "type": "string" }
    },
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
    "createdAt": { "type": "string" },
    "updatedAt": { "type": "string" }
  }
}
```

`compatibility.supportsReasoning` 和
`compatibility.supportedThinkingLevels` 对于存储的记录保持可读状态
旧客户端兼容性，但 Electron main 在运行时忽略它们
模型分辨率。公共提供商形状是从精确的 pi-ai 中丰富的
代替模型记录。未知的自由形式模型暴露了 `supportsReasoning=false`
和 `supportedThinkingLevels=["off"]`。原始秘密和内部兼容性
JSON 保持隐藏状态。

`authKind: "oauth"` 标记厂商账户行（ADR 0095、D237）：其凭据是保存在
`secret:provider:<id>:oauth` 下的 OAuth 授权，而不是粘贴的密钥，因此该行
不为它保存 `secretRef`，并以空密钥启动。最后两个 apiStyle 是厂商账户专用的
线路 API —— `openai_codex_responses`（Codex 会话封装）与 `pi_messages`
（radius 网关）—— 自定义提供商对话框不提供它们，因为二者都无法配合手输的
base URL 与粘贴的密钥工作。厂商行的样式不由厂商固定：GitHub Copilot 同时
提供 Anthropic、Chat Completions 与 Responses 模型，因此样式跟随所选模型，
并在每次切换模型时重写。`config_json.oauth.accountLabel` 保存已登录账户的
非敏感展示标签。

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

### 命名端点预设

这些行由添加提供商对话框的**服务**下拉框创建。命名服务的常见路径是服务 +
API 密钥；自定义端点在常见路径上并排显示 API 密钥与接口格式。`vendorKey`
使用 models.dev 提供商键。

国际：OpenAI、Anthropic、Google Gemini、OpenRouter、Groq、xAI、Mistral、
Together、Fireworks、OpenCode Go、Z.AI。

国内：DeepSeek、通义千问、月之暗面、智谱 / Coding Plan、硅基流动、火山方舟、
MiniMax、Kimi 编程。

智谱 / Z.AI 的 Completions 请求仍使用 `thinkingFormat: "zai"` 与
`zaiToolStream: true`。

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

## 5. IPC / 主机方法（提供商域）

- `providers.list`
- `providers.get`
- `providers.create`
- `providers.update`
- `providers.delete`
- `providers.testConnection`
- `providers.listModels`
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
  存在即为真）、`hasOauth: boolean` 与非敏感的 `oauthAccountLabel?: string`

### `providers.create` / `providers.update`
- 在：提供商字段 + 可选的 `secretValue` + 可选的 `oauthAccountLabel`
  （合并进 `config_json.oauth`，传空字符串即清除）；旧客户端仍可能发送
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
- 对 `authKind: "oauth"` 行，Electron 主进程读取已认证的目录
  （`models.getAvailable`，它已应用厂商自己的 `filterModels`，因此 Copilot
  账户列出的是其订阅包含的模型），而不是调用 `/models`；返回的每个模型都
  带着其线路 API 所隐含的 apiStyle
- 输出：`{ models: ModelCatalogItem[] }`；每个模型都带有 pi-resolved
  `reasoning` 功能和 `supportedThinkingLevels`。缓存的功能标签
  旧提供程序字段无法覆盖 pi 模型记录。

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
5. 强制实施 SecretValue 最大长度（例如 8KB）
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
