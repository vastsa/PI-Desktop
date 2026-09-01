# 14. 密钥存储

> **翻译说明：** 本页是与 [英文源规格](/spec/03-runtime/14-secrets-storage) 一一对应的机器辅助翻译。代码、协议字段和标识符保持原文；如翻译与英文源事实有歧义，以英文版本为准。


## 1. Goal

在 Rust 主机所有权下安全地存储提供商凭据和未来敏感令牌，渲染器 logs/UI 持久性的原始秘密泄漏为零。

## 2. 所有权

| 关注 | 业主 |
|---|---|
| 秘密 write/read/delete | Rust host-core |
| 秘密元数据索引 | SQLite `secrets_meta` |
| 操作系统安全存储集成 | Rust host-core |
| 厂商账户登录/刷新编排 | Electron 主进程（`oauth.ts`） |
| 渲染器知识 | `hasSecret` / `hasOauth` 布尔值与一个非敏感账户标签 |

Node pi sidecar 可能会通过主机 RPC 接收**临时内存中**的秘密，但从未由 sidecar 保留。对于厂商账户提供商，它拿到的更少：按请求解析出的短时 `ModelAuth`，永远不含 OAuth 刷新令牌（§10）。

## 3. 后端

### 小学
- **Electron/OS 安全存储风格后端** 由主机介导
- macOS：第一个版本首选钥匙串支持的路径

### 后备
如果主后端不可用：
1. 使用机器本地密钥材料加密秘密 blob
2.将密文存储在app data下
3.在元数据中标记`backend=file_fallback`
4.设置中出现安全警告

MVP 必须实现两条路径的自动选择。

## 4. 数据模型

```ts
type SecretMeta = {
  secretRef: string
  providerId?: string
  kind: "api_key" | "bearer_token" | "azure_api_key" | "custom"
  backend: "safeStorage" | "file_fallback"
  updatedAt: string
}

// raw value never appears in SQLite tables
// raw value never appears in IPC list/get provider responses
```

`secretRef` 格式：

```text
secret:provider:<providerId>:api_key
secret:provider:<providerId>:oauth
```

两个引用相互独立，因此一个提供商行可以只有 API 密钥、只有厂商账户，或两者兼有。OAuth 引用保存序列化后的 pi-ai `OAuthCredential`（访问令牌、刷新令牌、过期时间），通过通用的 `secrets.set` 路径写入，因此由同一个后端加密，但不进入 `secrets_meta` 索引；删除提供商会清除两个引用及其可能存在的元数据记录。

## 4a. 提供商就绪标志

| 标志 | 含义 |
|---|---|
| `hasSecret` | 该行拥有**任一种**凭据 —— API 密钥或厂商账户 |
| `hasOauth` | 该行拥有厂商账户凭据 |
| `oauthAccountLabel` | 已登录账户的非敏感展示标签（来自 `config_json.oauth.accountLabel`） |

`hasSecret` 刻意保持为唯一的就绪信号，因此厂商账户到来时，模型选择器、输入框守卫和提供商列表都不需要新增条件。`hasOauth` 只影响呈现：账户徽标，以及在厂商行上隐藏 API 密钥输入框。

## 5. 托管 RPC

- `secrets.set` `{ secretRef, value, meta }`
- `secrets.delete` `{ secretRef }`
- `secrets.has` `{ secretRef } -> boolean`
- `secrets.getForRuntime` `{ secretRef, reason, runId }` **仅限内部**（main/host → 不暴露给渲染器）

### 面向渲染器的表面
Renderer 使用接受 create/update 上的可选 `secretValue` 的提供程序方法，并且仅读取 `hasSecret`。

## 6. 访问规则

1. Renderer 无法列出原始机密
2. 日志编辑：与秘密模式/已知秘密引用匹配的掩码值
3. `getForRuntime` 需要活动运行上下文并经过审核
4.导出默认排除机密
5. Uninstall/reset 应用程序会删除机密，除非未来的显式迁移工具另有说明
6. 提供商删除默认删除链接的秘密 —— API 密钥与 OAuth 凭据都删
7. OAuth 刷新令牌永不跨越进程边界：只有 Electron 主进程读取它，且只用于铸造请求认证

## 7. 编辑政策

切勿写入日志：
- 授权标头
- API 密钥
- 不记名代币
- 名为 `secretValue`/`hasSecret`/create/update 的查询参数

替换为：
```text
***REDACTED***
```

## 8. 故障模式

| 案例 | 行为 |
|---|---|
| 设置失败 | 如果需要机密，提供程序更新会自动失败 |
| 后端降级为后备 | 在设置中每个会话警告一次 |
| 运行时丢失秘密 | `PROVIDER_SECRET_MISSING` |
| 解密失败 | 视为缺失+提示重新输入 |

## 9. 验收标准

- [ ] set/has/delete 适用于本机 macOS arm64 和 Intel x64 路径
- [ ] 渲染器永远不会收到提供商 list/get 上的原始机密
- [ ] 运行时可以暂时获取一个回合的秘密
- [ ] 日志在正常故障测试中不包含原始密钥材料
- [ ] 后备后端在主后端不可用时工作（dev/test 线束）
- [ ] 厂商账户行报告 `hasSecret` 与 `hasOauth`，且不暴露凭据

## 10. 厂商账户凭据

Electron 主进程拥有登录、退出与刷新编排（ADR 0095、D237），因为 pi-ai 声明这部分归宿主应用。`oauth.ts` 在 `secrets.getForRuntime` / `secrets.set` / `secrets.delete` 之上实现 pi-ai 的 `CredentialStore`，并按提供商串行化 `modify`，使 pi-ai 的带锁刷新假设在并发回合下依然成立。

请求认证只朝一个方向流动：

1. `authKind: "oauth"` 行的启动载荷中 `apiKey: ""`。主进程在启动时不读取凭据。
2. 每次请求，运行时调用宿主代理方法 `provider.resolveAuth`，参数为 `{ sessionId, providerId }`。
3. Electron 主进程在本地应答 —— 该调用**绝不转发给 host-core** —— 并先用每次启动的绑定表校验这一对标识。未绑定的提供商以 `PROVIDER_NOT_BOUND` 失败。
4. 应答是短时 `ModelAuth`（`apiKey`、`headers`、`baseUrl`），仅在过期时才在存储锁下刷新。

因此 sidecar 持有的是一个可作废、约一小时有效、且仅限其会话所绑定的那一个提供商的令牌 —— 严格少于密钥行下发给它的长期 API 密钥。
