# 提供商模板与原生账号

> **翻译说明：** 本页是与 [英文源规格](/spec/07-plugins/17-provider-template-accounts) 一一对应的中文镜像。代码、协议字段和标识符保持原文；如有歧义，以英文源规格为准。

## 添加可复用的服务集成

当用户需要添加多个账号时，应使用 `contributes.providerTemplates`，而不是
`contributes.providers`。两个数组可以共存，但其中的 ID 必须跨数组唯一。
安装或启用模板只会添加原生服务选择器入口，**不会**创建账号。官方服务保持独立，行为不变。
设置表单和账号编辑器会展示来源插件与端点。

下面的最小示例声明兼容的 API key 传输；保留的 `.test` 地址仅用于文档，不能处理真实请求：

```json
{
  "schemaVersion": 1,
  "id": "example.gateway",
  "name": "Example Gateway",
  "version": "1.0.0",
  "main": "main.cjs",
  "permissions": ["provider.register"],
  "contributes": {
    "providerTemplates": [{
      "version": 1,
      "id": "gateway",
      "name": "Example compatible service",
      "authKind": "api_key",
      "baseUrl": "https://api.example.test/v1",
      "apiStyle": "chat_completions",
      "models": [{ "id": "example-chat" }]
    }]
  }
}
```

`main.cjs` 可以导出空对象。该声明不需要 OAuth 或推理钩子，标准传输也不会把密钥交给插件代码。
但与所有可信 Node 插件一样，加载任意入口代码本身并不意味着具有操作系统沙箱保障。

## V1 封闭契约

`PluginProviderTemplateV1` 复用提供商的显示、传输与模型字段，并增加 `version: 1`。
模板、本地化标签、模型、适配器与 OAuth 中的未知字段都会被递归拒绝。
模板或创建请求不能传入内部所有权、账号 ID 或密钥引用。
旧 `contributes.providers` 的校验与固定身份仍保持兼容。

- 模板 ID 为 `[a-zA-Z][a-zA-Z0-9_-]{0,63}`；模型 ID 长度为 1..256 个 UTF-16 单元，
  去除首尾空白后必须唯一，最多 64 个模型。
- 名称、vendor key、模型名称和分类上限为 128 个单元，描述上限为 280。
  本地化分类与描述必须恰好包含 `en` 与 `zh-CN`。控制字符会被拒绝。
- `baseUrl` 必须是绝对 HTTP(S) URL，最多 2048 个单元，不得包含用户信息、片段、空白或反斜杠。
  语法合法不等于获得网络权限，现有 Host 端点、DNS 与代理策略仍然适用。
- 模型限额必须是正 uint32 整数；思考档位最多 16 个字符串，每个最多 64 个单元。
  适配器声明的操作限定模型能力，用户偏好不能增加未支持的 chat/images 操作。
- 在兼容传输支持端点发现时可使用 `models: []`。发现失败保留已保存账号，允许重试。

## 声明式 OAuth

设置 `authKind: "oauth"`，并将 `oauth.flow` 设为 `authorization_code` 或 `device_code`。
两者都要求公开的 `clientId`（1..512 个单元）与 HTTPS `tokenUrl`。
授权码流程还要求 HTTPS `authorizationUrl`；设备码流程要求 HTTPS `deviceAuthorizationUrl`。
端点同样受 2048 单元的 URL 限额与公开 HTTPS 策略约束。
可选 `scopes` 数组最多包含 64 个唯一 RFC 6749 scope token，每项为 1..256 个 ASCII 字符。
`redirectPath` 仅适用于授权码流程，默认 `/callback`；最多 256 个字符，
必须以单个 `/` 开头，且只能包含 ASCII 字母、数字、`/`、`_`、`-`。

Host 负责 PKCE S256、随机 state 校验、临时 IPv4 回环回调、令牌交换与刷新，
以及 RFC 8628 的等待、降低轮询频率和过期处理。响应只映射
`access_token`、`refresh_token`、`expires_in`，不接受可执行字段映射、客户端密钥、
JWT 解码或任意服务端 header 映射。请求、响应、轮询与回调生命周期均有界且可取消。
密钥通过现有账号密钥存储加密。这些标准流程不需要自定义 OAuth 权限或回调。
回环监听器在接受回调前校验 state 及 code/error 的形状。
非法或重复参数得到固定拒绝响应，但不消耗本次登录；有效回调仍可在原超时内完成。
与 state 绑定的拒绝授权响应会终止登录，不进行令牌交换。
外部 I/O 完成后还会独立重新校验回调结果。

省略 flow 或使用 `custom` 时调用 `onProviderOAuth`，需要 `provider.oauth`。
自定义流程只接受流程与显示字段，不接受声明式端点。
自定义推理还需要 `provider.inference` 和 V1 适配器导出。
两项权限都明确披露可信代码的访问范围，注册权限不会隐含授予它们。
OAuth 请求的可选 `accountId` 标识 Host 选定的模板账号；`providerId` 仍是 manifest 贡献 ID。
推理绑定在现有插件、runtime、会话与模型校验之外，再加入账号和模板身份。
推理凭据绝不包含刷新令牌。

## Host API 与持久化

- `providers.getTemplate({pluginId, templateId})` 返回权威、活动且已授权的定义。
  Main 使用该接口；它不是任意写入 manifest 的 API。
- `providers.createFromTemplate({pluginId, templateId, name?, secretValue?})`
  创建 UUID 账号。`secretValue` 仅适用于 API key。
  Renderer 通过 `providersCreateFromTemplate` 转发此封闭请求，由 Rust 校验。
- `providers.completeTemplateOAuth({id})` 仅供 Main 调用 Host：完成待登录 OAuth
  账号前，重新校验模板与已存凭据。
- 公开行在权威 `ownerPluginId` 之外可包含 `pluginTemplateId`、`pluginTemplateVersion: 1`；
  密钥从不成为公开字段。
- Schema 26 增加 `provider_template_bindings(provider_id PRIMARY KEY REFERENCES
  providers(id) ON DELETE CASCADE, template_id, version CHECK(version=1), definition_json)`。
  `definition_json` 保存经过校验的先前 manifest 定义，而不是凭据。
  `config_json.pluginTemplate.pending` 标记尚未完成的登录。
  迁移先备份 schema25，保留旧行、密钥与偏好，不把旧单例行转换成模板账号。
  Schema24 先执行模型发现 v25 迁移；仅含发现字段或仅含模板表的两种历史 v25
  均能安全升级。仅在补建发现字段时初始化状态，不覆盖已有的上架/下架记录。

## 原生用户路径与生命周期

选择器键 `plugin-template:<pluginId>:<templateId>` 只用于目录，不是账号身份。
添加任意多个账号后，入口仍然可用。新登录分配账号；以原生账号 ID 登录只重新认证该账号。
待登录 OAuth 账号被禁用，不进入可用模型列表。
失败或取消会清理待登录账号及密钥；清理失败记录不含密钥的诊断，启动时重试遗留待登录账号清理。

账号复用原生名称、密钥编辑、启用状态与模型选择，包括别名、限额、推理配置、
委派授权和显式空选择。发现与刷新按账号隔离。
认证、端点、协议、客户端、scopes 或适配器的敏感变更会使旧凭据与发现结果失效；
普通显示更新保留偏好。重新认证可恢复已失效的模板账号，不会再建一个账号。

- 禁用或撤权：保留账号、密钥与偏好，拒绝新工作并取消插件 runtime 的进行中工作。
  重新启用时校验来源并恢复用户选择。
- 移除模板：保留账号并标记不可用；仅在有效来源协调后恢复。用户可以删除不可用账号。
- 删除账号：取消该账号的登录、刷新与推理，删除其密钥与发现结果。
  其他账号及可复用入口不受影响。
- 卸载：删除全部自有账号、密钥、发现结果与待登录状态，不删除或重新绑定历史会话和消息。
  在移除注册信息或密钥前，以原子事务禁用全部自有账号，持久化 Host 专用的
  `config_json.pluginCleanupPending: true`。
  即使某次删除失败，也要尝试每个账号和两个凭据通道。
  清理或注册信息持久化失败时，RPC 返回 `INTERNAL`（1000）及安全的可重试诊断，
  不能假报成功或泄漏存储路径。待清理行不得启用、完成登录或被协调过程接管。
  启动、重复卸载和同 ID 注册都会重试清理；恢复成功后，先删除旧授权再协调。
  如果意图事务失败，必须在改动注册信息或密钥前中止。
  此机制不新增数据库 schema 或公开插件 manifest 字段。
- 迟到的回调不能重建已删除账号，也不能返回过时模型输出。

原生聊天、子代理和图像工具继续由现有模块负责授权、执行与持久化。
图像可用性取决于适配器实际操作能力与账号就绪状态；仅图像模型不能成为聊天默认模型。
自定义适配器若没有安全且不计费的探测，连接测试返回 `UNSUPPORTED` / `network: skipped`，
不刷新凭据、不发起付费生成。不增加隐式自定义重试或付费服务回退。

自定义回调异常与流错误事件转为 Host 拥有的固定错误码和消息，不把原始异常文本写入事件或日志。
这保护的是错误通道，不会阻止恶意可信代码通过原生 Node I/O 主动外传数据。
历史审计探针仍然只代表修复前证据。

## 可执行验收（不访问真实服务）

构建 JS 后，从请求工作树执行：

```sh
node --test apps/desktop/test/provider-template-*.test.mjs
# Actual Rust Host + plugin child; build the Host first (no release packaging):
cargo build -p host-core --locked
node --test apps/desktop/test/provider-template-native-host.e2e.mjs
```

- `provider-template-user-path`：原生选择器、设置与编辑，两个 key 账号，
  无认证发现及 OAuth ID、取消交互。
- `provider-template-accounts`：真实插件子进程、公开 OAuth 编排、原生聊天、
  委派及图像工具、刷新、重新认证、删除与密钥隔离。
- `provider-template-declarative-account`：公开原生账号 OAuth 入口、真实回环 PKCE/设备码引擎、
  合成 HTTPS 边界、刷新以及迟到取消或卸载的清理；不使用自定义 OAuth 钩子或权限。
- `provider-template-inference`：真实插件子进程、来源与账号绑定、安全错误。
  `provider-template-image-lifecycle` 覆盖按账号取消图像调用。
- `provider-template-oauth` 覆盖协议与安全边界；`provider-template-connection` 如实报告不支持的探测。
- Rust 模板、插件、RPC 与迁移测试覆盖真实存储、生命周期、所有权拒绝和旧版升级。
  SDK 测试覆盖封闭 manifest。
- `provider-template-native-host.e2e`：真实 Rust Host 进程、数据库、加密密钥存储，
  配合插件子进程与原生执行器，验证独立登录、刷新、偏好、聊天、委派、图像、删除、重启、
  卸载及保留历史会话。fixture 未使用的工具仍为桩实现。

部分 fixture 在声明的位置模拟外部服务或 Host RPC 边界；原生 Host fixture 使用真实存储。
它们都不代表完整 Electron 窗口验收或真实 Antigravity 互通验证。
参见 [E2E 计划](../06-delivery/04-e2e-test-plan.md) 与
[决策依据](/adr/plugin-provider-template-accounts)。
