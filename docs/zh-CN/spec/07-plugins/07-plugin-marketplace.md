# 07. 插件市场

> **翻译说明：** 本页是与 [英文源规格](/spec/07-plugins/07-plugin-marketplace) 一一对应的机器辅助翻译。代码、协议字段和标识符保持原文；如翻译与英文源事实有歧义，以英文版本为准。


## 1. 定位

插件市场是一个**分发层**，而不是运行时核心。

原理：

> 首先让本地插件系统运行，然后集成市场。

市场负责：
- 发现
- 搜索
- 显示元数据
- 下载
- 更新检查

宿主负责：
- 验证
- 授权
- 安装
- 运行
- 安全隔离

## 2. 阶段策略

### A阶段✅
- 协议和数据模型
- 本地官方市场提供器（`plugins/market/catalog.json`）

### B阶段✅
- 已实现基于官方提供器的浏览、搜索、下载和安装
- 官方提供商是插件中心 `plugins.aiuo.net`（B 阶段最初指向 GitHub 仓库 `vastsa/pi-desktop-plugins`；见下方「目录来源」与 [ADR 0276](/adr/0276-official-plugin-channel-and-backup-channels)）
- 默认目录 URL：`https://plugins.aiuo.net/catalog.json`
- 包 URL 可以是绝对 `https://` / `http://` / `file://`，或相对路径：目录声明了 `artifactBaseUrl` 时按它解析，否则按目录 URL 解析
- HTTPS 获取在 host-core 中使用 `curl`
- curl 诊断信息优先按 UTF-8 解码，必要时使用当前 Windows ANSI 代码页；网络失败仍为
  `PLUGIN_NETWORK`，但其本地化消息不能以替换字符的形式跨越 RPC 边界。

### 目录来源

「插件 → 市场」始终使用插件中心的官方目录
`https://plugins.aiuo.net/catalog.json`，页面不提供来源选择器。旧版本持久化的
`pluginMarketSource` 和 `pluginMarketCustomUrl` 仍保留以兼容设置读取，但会被忽略；
无需迁移数据。开发与测试仍可通过 `PI_DESKTOP_PLUGIN_MARKET_URL` 指向本地目录，
但已发布界面不会因此开放目录配置。

市场目录与安装包下载遵循设置 → 常规 → 网络。系统模式会让 host-core 的 `curl`
通过 Electron 的认证回环 SOCKS 中继，并按当前操作系统代理/PAC 解析目标。直连模式
强制市场请求直连；自定义模式使用所配置的代理与绕过列表。中继凭据仅在运行期使用，
不会传给工作区 Shell。Windows 上，若已安装的 `curl` 支持，host-core 使用 Schannel 的
尽力吊销检查模式，避免吊销分发点不可用时阻断 HTTPS 请求；证书校验、安装包大小和哈希
检查仍然启用。

官方目录是插件中心生成并发布的 `catalog.json`。安装时客户端向平台解析包地址，而不
是把相对路径拼到基址。如果 resolve 缓慢或不可用，客户端会从官方目录自己的包地址下载，
并校验目录摘要。官方 resolve 路径仍可使用平台返回的 GitHub 与 CNB 包镜像；这些是
官方渠道内部的包镜像，不会切换目录来源。每个镜像的字节都会按其声明的摘要校验。

缓存目录通过 `plugins/market/cache-meta.json` 按来源记录。官方目录缓存是市场快照；
旧来源留下的缓存会被忽略但不会删除。`settings.set` 会让 host 的市场选择保持为官方；
远程抓取仍由显式的 `market.refresh` 触发，避免设置写入因市场超时而持有 host RPC 状态锁。

### 设备标识

官方渠道的 resolve 请求携带 `deviceId`。host-core 从操作系统暴露的机器标识派生：
Windows 的 `HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid`、macOS 的平台 UUID，
或 Linux 的 `/etc/machine-id`（回退 `/var/lib/dbus/machine-id` 与
`/sys/class/dmi/id/product_uuid`）。上报的是 `sha256("pi-desktop.device.v1:" + <machine id>)`
的 64 个小写十六进制字符，因此机器码原文不出本机，该摘要也与应用计算的其他哈希做了域
分隔。读不到机器标识时，host-core 生成一个随机的 64 字符十六进制 ID，持久化在应用数据
目录（`plugins/market/device.json`），之后一直复用。该值每个进程只读取一次，跨重启
对同一安装保持稳定，不显示在界面上，也不是用户可编辑或重置的设置。它是平台的计数与
限流键（见 [15-plugin-center.md](15-plugin-center.md) §10），不是账号或登录态。

### 官方渠道的 resolve 安装

官方渠道的每一次安装或更新都在刷新目录之后通过平台解析安装包：

1. 与其他渠道相同，刷新目录并选定插件与版本。
2. `POST {center origin}/api/v1/download/resolve`——即提供该官方目录的 origin——JSON
   body 为 `{ deviceId, pluginId, version }`，用户选定版本时才带 `version`。使用
   POST 而非 GET，因为平台自己的契约指出设备 ID 出现在查询串里会落到访问日志。
   元数据请求总时限为三秒且只发起一次，避免慢端点让安装在 `resolve` 阶段等待整个下载
   超时预算或一个 `Retry-After` 间隔。
3. 按顺序尝试返回的 `downloads` 每一项：下载、校验返回的 `sha256` 与声明的
   `sizeBytes`，再把字节交给安装器。某个镜像失败——网络错误、HTTP 错误、摘要不符、
   大小不符——就放弃它并尝试下一个。请求仍限于下文的白名单主机。
4. resolve 超时、传输失败、返回 `429` 或 `503 NO_DOWNLOAD_SOURCE` 时，立即回退到
   目录自身的包地址（`artifactBaseUrl` 加相对 `url`）。目录摘要与大小仍会校验，且
   该次安装不计入统计。如果所有可用镜像都在传输层失败，也使用同一回退。响应格式
   错误或完整性校验失败不会触发回退。
5. 每次安装或更新只调用一次 resolve。响应从不缓存，这也是平台发送
   `Cache-Control: no-store` 的原因；`counted: false` 是正常应答，不是错误。

`200` 响应的 `downloads` 永不为空。拒绝要如实报告，而不是掩盖：

- `403 NOT_PUBLISHED`——该版本尚未发布。报告且不重试。
- `403 PLUGIN_ARCHIVED`——插件已归档。从安装与更新选择中隐藏它。
- `404`——平台没有该版本。报告它；字节路由无法承载的版本字符串（例如带 `+` 的构建
  元数据后缀）属于版本缺失，不能靠猜 URL 绕过。
- `429`——平台按设备 ID 限流（默认每分钟 600 次）。不等待或重试；改用目录地址，
  并按目录摘要校验安装包。
- `503 NO_DOWNLOAD_SOURCE`——平台没有可用镜像时使用目录地址。其他 `503` 部署错误也
  快速回退到目录地址。

resolve 镜像路径以平台返回的摘要为准；回退路径以目录的 `shasum` 为准。明确的 `403`
或 `404` 发布拒绝不会回退到其他包来源。回退不会切换目录来源，产品始终使用官方渠道。

### 安装进度与取消

安装或更新是一次请求，因此它在进行期间会报告自己处于哪一步。
`plugin.installProgress` 通知携带 `pluginId`、`version`、`phase`（`resolve`、
`download`、`verify`、`install`、`enable`）、`source`（正在使用的镜像）及其从 1 开始的
`attempt` / `attempts`、`receivedBytes` / `totalBytes`（`totalBytes` 为 `0` 表示大小
未知），以及 `tried[]`——迄今尝试过的每个镜像，每项为 `{ source, url, error }`。
以失败结束安装的那一条报告还会带上 `error`。报告被限流为每 200 ms 最多一条，外加每次
阶段变化与最终报告，因此字节级进度不会淹没界面。

`market.cancelInstall { id }` 返回 `{ cancelled, id }`，且只取消当前正在运行的安装。
真正能被中断的只有下载：该请求在字节到达时、尝试每个镜像之前，以及写入安装包之前的
最后一个安全点被检查。被取消的安装以 `PLUGIN_CANCELLED`（JSON-RPC 码 1019）失败，
对话框静默关闭，而不是报告错误。

对话框只用于手动安装或更新，后台自动更新不会打开它。它显示当前阶段、
`mirror n/N · name`、由 `receivedBytes` / `totalBytes` 得出的确定进度条与传输速度，
以及仅在 `download` 与 `resolve` 期间可用的取消按钮。安装成功后约 2 秒自动关闭，
悬停时暂停该倒计时。安装失败时对话框保持打开，显示可读的错误与尝试过的镜像，
并提供复制与重试操作。

### 客户端可见的目录策略

稳定 ID 以 `demo.` 开头的开发示例仍可用作插件开发的离线测试样本和直接安装目标，
但桌面客户端会在更新市场状态之前过滤这些条目。它们不出现在卡片、分类或搜索结果中；
已安装的示例仍在“已安装”中可见，允许用户禁用或卸载。

### 目录中的内置插件

ID 同时由某个构建从 `resources/plugins` 随应用打包的条目仍然保留：卡片会解析到内置的行、
显示已安装版本，并在目录中存在严格更新的版本时提供更新。这是用户无需等待应用更新即可
获取上游新版本的受支持途径（ADR 0241）。只有严格更新的版本才算更新——版本相同不算，
目录中更旧的条目也不算，那只会是披着更新外衣的降级。

更新内置插件后它仍然是内置插件。卸载仍按「该构建是否随应用打包」以 ID 拒绝，而不是按
行的 `source` 判断，因此更新过的插件依然不容用户卸载；同时已安装版本会跨过下一次启动，
除非该构建自带严格更新的版本——这样从未安装过任何东西的用户也能拿到应用更新。

### C阶段（部分✅）
- 自动更新策略+实施权限差异门控
- 评分：桌面端匿名读取公开评分摘要与评论，无需账号，并链接到插件中心供用户撰写评论；
  强制签名仍在计划中。

### D 阶段（进行中）

插件源码迁移到发布者自己的仓库，目录升级到 schema v2（ADR 0102）。客户端用
同一条代码路径读取 v1 和 v2；v2 增加源码溯源、审查结论、撤回状态和显式声明的
制品基址。发布侧见 [15-plugin-center.md](15-plugin-center.md)。

## 3. 市场提供商抽象

```ts
interface MarketProvider {
 id: string
 list(query: MarketQuery): Promise<MarketSearchResult>
 get(pluginId: string): Promise<MarketPluginDetail>
 getDownloadInfo(pluginId: string, version?: string): Promise<MarketDownloadInfo>
 checkUpdates(installed: InstalledPluginRef[]): Promise<MarketUpdateInfo[]>
}
```

已发布客户端目前只提供 `official` 提供商。开发专用的
`PI_DESKTOP_PLUGIN_MARKET_URL` 覆盖允许本地测试目录，但不会在产品界面增加来源控制。

## 4. 数据模型

### 目录 schema v2

没有 `schemaVersion` 的目录即 v1，含义不变。`schemaVersion: 2` 增加下列字段；
它们全部可选，因此 v1 目录解析行为完全不变，而客户端把缺失字段当作"未声明"，
不会当成默认放行。

v1 和 v2 目录中的 `author` 都是字符串。manifest 中允许的 `{ name, url?, email? }`
对象可用于 `manifest.json`，但不能用于 `catalog.json`；host-core 收到该字段的对象值时，
会以 `PLUGIN_MARKET_INVALID` 拒绝整个刷新操作。

```jsonc
{
  "schemaVersion": 2,
  "providerId": "official",
  "catalogId": "pi-plugin-center",
  "generatedAt": "2026-08-18T02:00:00Z",
  "policyVersion": "2026.08.1",
  // Optional. The official source omits it: relative package URLs resolve
  // against the catalog directory, so GitHub and the CNB mirror each serve
  // their own packages without crossing providers. A mirror or enterprise
  // source that stores packages elsewhere declares its own base here.
  "artifactBaseUrl": null,
  "plugins": [
    {
      "id": "acme.todo",
      "publisherId": "acme",
      "trust": "verified | community | unknown",
      "repository": "https://github.com/acme/pi-plugin-todo",
      "versions": [
        {
          "version": "1.2.0",
          "url": "packages/acme.todo-1.2.0.piplug",
          "shasum": "<sha256 hex>",
          "sizeBytes": 40960,
          "permissions": ["fs.read"],
          "minPiDesktop": "0.8.0",
          "yanked": false,
          "yankedReason": null,
          "provenance": {
            "sourceRepository": "https://github.com/acme/pi-plugin-todo",
            "sourceRef": "refs/tags/v1.2.0",
            "sourceCommit": "<40-hex commit>",
            "sourcePath": ".",
            "builder": "pi-plugin-center-builder@1.0.0",
            "builtAt": "2026-08-18T01:55:00Z"
          },
          "review": {
            "decision": "approved",
            "risk": "low",
            "policyVersion": "2026.08.1",
            "reviewedAt": "2026-08-18T01:58:00Z"
          },
          "signature": "<base64>",
          "signatureAlg": "ed25519",
          "keyId": "pi-center-2026"
        }
      ]
    }
  ]
}
```

v2 的客户端规则：

- 解析相对包 URL 时 `artifactBaseUrl` 优先于目录文件所在目录。绝对 URL 按原样
  使用，但仍须通过下载域名白名单。
- `trust` 仅用于展示，绝不从发布者提供的文本推导。客户端无法归因到已配置官方源
  的取值一律显示为 `unknown`。见 [15-plugin-center.md](15-plugin-center.md) 第 11 节。
- `yanked: true` 的版本从安装和更新选择中移除，但保留在版本历史里并附带原因；
  已安装该版本的插件会被标记为需要注意。
- `minPiDesktop` 高于当前应用版本时，在下载前就拒绝安装。
- `provenance` 随已安装插件一起保存并在详情面板展示，因此可以追溯到具体仓库和
  commit。
- `signature` 校验规则见 [08-plugin-signing-updates.md](08-plugin-signing-updates.md)，
  在插件中心签名阶段落地前保持可选。无法验证的签名绝不当作有效签名。

### MarketPluginSummary
```ts
type MarketPluginSummary = {
 id: string
 name: string
 description: string
 author: string
 iconUrl?: string
 latestVersion: string
 downloads?: number
 updatedAt: string
 categories?: string[]
 permissionSummary: string[]
 verified?: boolean
 installable?: boolean
}
```

`i18n` 是展示元数据，不是摘要类型的字段。宿主按应用语言解析卡片的 `name` / `description`
及详情中的 `safetyNotes`，逐字段回退到条目自身的值，使已翻译的插件内容以用户语言显示
（ADR 0267）。目录条目采用与 manifest 相同的声明块：
`{ en: { name, description, safetyNotes }, "zh-CN": { … } }`。
搜索匹配所有语言，而不只匹配当前展示语言；格式错误的声明块会导致目录解析失败，
未知语言及条目中的未知字段则会被忽略。

### 市场插件详细信息
```ts
type MarketPluginDetail = MarketPluginSummary & {
 readmeMarkdown?: string
 versions: Array<{
 version: string
 publishedAt: string
 changelog?: string
 minPiDesktop?: string
 shasum?: string
 url?: string
 sizeBytes?: number
 }>
 screenshots?: string[]
 homepage?: string
 repository?: string
 permissions: string[]
 safetyNotes?: string
}
```

版本条目在目录输入中没有顺序保证。宿主解析语义版本，以最高的有效版本作为 `latestVersion`，
不假设数组首项就是最新版本。详情响应按版本从新到旧排列；未指定版本的安装也选择同一最新版本。
无效版本字符串的优先级低于有效语义版本。缺少 `shasum` 或 `url` 的版本仍可展示和发现，
但在发布者补齐安装包元数据前不可安装。

`installable` 表示 `latestVersion` 是否带有安装所需的包元数据（`url` 与
`shasum`）。发布者可以先登记版本、稍后再上传安装包；这样的版本仍然可以被发现，
但市场列表和详情面板会禁用安装按钮并标注「尚未发布安装包」，而不是发起一个
host 必然拒绝的下载。批量更新会跳过这类版本，而不是让整批更新失败。

### 目录发布闸门

发布或排查一次发布之前，先在仓库里跑预检：

```bash
pnpm check:marketplace -- \
  --url https://plugins.aiuo.net/catalog.json \
  --plugin <plugin-id>
```

预检刻意比发现流程更严格：每个已发布版本都必须有合法且在该插件内唯一的语义化
版本号、64 个字符的 SHA-256 校验和、包 URL、正数包大小以及权限数组。目录没过这道闸门
时，应当先在市场发布方修好，而不是去改客户端的更新行为。

### 市场下载信息
```ts
type MarketDownloadInfo = {
 pluginId: string
 version: string
 url: string
 sizeBytes: number
 shasum: string // sha256
 signature?: string // mandatory later
 signatureAlg?: "ed25519"
 publishedAt: string
}
```

## 5. 安装路径（市场）

```text
browse/search
 → detail
 → install
 → download to cache
 → verify shasum/(signature)
 → hand to local packaging installer
 → permission review
 → enable?
```

任何验证失败时：中止并可选择清理缓存。

### 下载域名白名单

v1 目录把所有安装包都放在同一个已知仓库下，因此宿主可以跟随任意重定向，并只依赖校验和。
目录 v2 的包
URL 描述的是一个受发布者影响的 release，所以宿主还必须约束**请求发往哪里**，而不
只是约束收到什么。

在下载市场安装包之前，host-core 解析该 URL，并在不满足下列全部条件时拒绝：

1. 协议是 `https`，本地开发目录可以是 `file://`。
2. URL 不携带内嵌凭证。
3. 主机在下表白名单中，或者就是当前生效目录的来源主机。

| 主机 | 用途 |
| --- | --- |
| `github.com` | release 资产下载入口 |
| `objects.githubusercontent.com` | GitHub 重定向 release 资产的去处 |
| `release-assets.githubusercontent.com` | 当前的 release 资产源站 |
| `raw.githubusercontent.com` | 目录文件与仓库内托管的安装包 |
| `codeload.github.com` | 仓库归档下载 |
| `cnb.cool` | 镜像目录与镜像资产 |

重定向被限制为 HTTPS 并重新校验：跳转后的最终 URL 必须满足与初始 URL 相同的规则。
自定义或企业目录只被信任其自身主机——把客户端指向一个私有目录，并不会为任意第三方
主机放宽白名单。

官方渠道的 resolve 响应给出的是镜像列表，而不是任意 URL 清单，而这些镜像正是上表中的
分发主机：平台已经发布的 GitHub raw 仓库与 CNB 镜像。位于其他主机的镜像条目会像该
主机上的包 URL 一样被拒绝，因此客户端会尝试列表中的下一个镜像；如果所有条目都指向
这类主机，安装就会失败，而不是放宽白名单。因此把镜像迁到本表之外的主机需要客户端
发版，而不是在平台侧改配置。

白名单之外的包 URL 在任何网络请求发出之前就以 `PLUGIN_MARKET_UNTRUSTED_HOST` 失败，
错误信息会指出被拒绝的主机，便于运维区分配置错误的私有源和恶意目录条目。

宿主在下载市场安装包之前立即刷新目录，确保包 URL 和校验和来自同一份当前目录快照，
避免将短期 UI/目录缓存与可变 release URL 上的新包错误组合。刷新不可用时，可使用最后一份
有效目录进行离线安装，但下载字节仍须通过该目录的校验和检查。

`.piplug` 软件包现在可以在本地生产：`pnpm pi-plugin pack <dir>`
（也可使用 `PluginPack` Agent 工具）会写入 `dist/<id>-<version>.piplug` 并输出 SHA-256。
插件页安装该文件时，与市场下载使用相同的校验和权限审核流程。因此经市场分发是可选的，
个人使用的插件完全可以留在本机。参见
[插件开发者体验](/zh-CN/spec/07-plugins/10-plugin-devex)。

其插件声明 `contributes.skills` 的目录条目也必须声明
`permissions` 中的 `agent.prompt.inject`；没有该权限时技能不会生效，权限审核也不会列出它们。
`pi-plugin check` 会对此组合给出警告。

## 6. 更新路径

1. 打开扩展页时或按计划执行 `checkUpdates`
2. 比较已安装版本与最新版本
3. 界面显示可用更新列表
4. 用户确认后下载并升级

策略：
- 扩展页打开时，只使用最后一份有效的本地目录，静默检查已安装插件的更新元数据；
  这种仅使用缓存的检查不能因等待市场网络超时而占用 Host RPC 状态锁。
- 显式检查会刷新远程目录，离线时回退到最后一份有效缓存。
- 自动更新仍由用户按插件选择启用，且绝不静默接受新增权限。

## 7. Marketplace UI 信息架构

```text
Extensions
├─ Installed
│ ├─ Search + result count
│ └─ Groups: Needs attention · Updates available · Active · Turned off
├─ MCP
├─ Skills
├─ Marketplace
│ ├─ Search
│ ├─ Categories
│ └─ Card grid
├─ Detail sheet (shared by both tabs)
│ └─ Review drawer (public reads; covers the detail sheet)
└─ Permission dialog (install / upgrade)
```

五个界面统一使用分段切换控件，并显示各标签页相关的数量。不另设数字概览栏；更新提醒、
标签页计数和已安装分组计数已经承载可操作状态，无需再复制到静态卡片行（D196）。
页头只保留一个与当前上下文相关的主要操作（浏览市场 / 刷新市场），将检查更新、应用自动
更新、安装包和加载本地插件放入溢出菜单（D169）。

已安装插件使用自动填充的卡片网格（`minmax(min(340px, 100%), 1fr)`），容器比单张卡片
更窄时也不会出现列溢出。卡片默认只显示简洁摘要：插件名称、可选的本地来源标记、ID、版本
及公开评分标签。分组标题承载“已启用 / 已关闭 / 有可用更新 / 需要处理”等状态，加载错误
仍在对应位置显示。能力、常驻服务状态及按风险着色的权限标签放在默认折叠的原生 Details
展开控件内；展开后显示完整信息，无需让每张卡片都占用较大高度。控制区靠卡片左侧排列并
支持换行：先是紧凑的范围选择器，再是唯一的主要操作（更新到可用版本或打开插件面板），
之后是 28px 的设置及溢出图标按钮。已禁用插件不显示主要操作和设置图标。打开范围选择器时
显示三种范围及说明，选择“当前项目”会打开已有的项目选择器。图标按钮始终可见，悬停或
键盘聚焦时显示标签。已安装记录带有已验证信任等级时，卡片显示信任盾牌，不添加“已验证
安装”文案。这些只是渲染器展示方式，插件权限与激活契约不变。

详情面板必须显示：
- 权限，按风险等级分组和标记
- 权限与版本之间的评分摘要：保留一位小数的平均分、评分人数及好评 / 中评 / 差评分布；
  中心不可用时应显示不可用，不能显示为零。评论入口保持可访问，不能丢失其重试和外部链接。
- 作者
- 版本（可选择版本的列表）
- 更新时间
- 风险描述（安全说明标注）
- 安装按钮

公开评论只支持读取：桌面端无需登录，不执行认证，也不提交评论、投票或举报。“查看全部
评论”打开一个与详情面板同级的独立评论抽屉，覆盖详情面板，但保留后者的挂载状态及滚动
位置；Escape 只关闭最上层抽屉。被覆盖的详情面板设为 `inert`，Tab 焦点限制在抽屉内，
键盘焦点不能进入被覆盖区域；关闭后，焦点回到打开抽屉的按钮。抽屉入口不依赖评分摘要是否
成功：摘要读取失败或中心尚不支持评论时，抽屉仍可打开，自行重试列表，并始终显示禁用的
评论编辑区及外部链接。在宿主报告实际 `reviewUrl` 前，链接回退到官方插件页。
抽屉可按评价倾向筛选，按最新或最有帮助排序，并通过稳定游标分页；按 ID 去重，丢弃用户已
切换离开的筛选条件对应的响应。摘要读取成功时，替换刚请求过的插件 ID 的评分；中心不再
提供某插件时，它的评分应消失，而非保留过期值。所有可见文案（包括无障碍名称）均本地化。
评论中的版本标为用户自行报告，它是评论作者的声明，不代表实际已安装版本。编辑区永久
禁用，唯一操作是真实的“到插件中心撰写评论”链接，通过系统浏览器（`browserOpenExternal`）
打开中心页面，优先使用宿主提供、对应实际中心源站的 `reviewUrl`，否则回退到
`https://plugins.aiuo.net/plugins/{encodedId}#reviews`。读取评论不能阻断或延迟安装、更新
或其他任何插件操作。

扩展列表页保持概览文案简洁：页头和标签标识所在界面，分区标题及空状态直接给出标签与
操作，不附解释段落。解释保留在有助于决策的位置，包括权限审核、详情面板、编辑器和错误状态。

市场卡片使用首字母标识，而不加载 `iconUrl`；渲染器不加载远程图片（D169）。

按 Escape 关闭详情面板时，清除市场卡片详情按钮的焦点，与鼠标关闭一致：卡片不残留横线或焦点框。随后使用 Tab 导航时，浅色和深色主题下都应在圆角详情按钮内部完整显示焦点框，不能被裁剪成安装区域上方的一条横线。

## 8. 信任模型

| 级别 | 含义 |
|---|---|
| 已验证（verified） | 官方或认证发布者 |
| 社区 | 社区插件 |
| 未知 | 定制来源/未经认证 |

UI 必须使信任级别可见。
社区不得伪装成经过验证的。

在目录 v2 下，级别由插件中心签发，而不是发布者自行声明。客户端把任何无法归因到
已配置官方源的条目显示为 `unknown`，也绝不因为目录里这么写就提升级别。v1 目录的
布尔 `verified` 仍按原义映射为 `verified` / `community`，因为 v1 目录只有市场
维护者能写入。

## 9. 私有来源（未来的企业支持）

已发布客户端不提供或持久化私有目录来源。`PI_DESKTOP_PLUGIN_MARKET_URL` 覆盖仅供本地
开发与测试使用，不是产品设置。企业来源支持需要未来的产品决策，并需明确设计安全与授权。

## 10. 远程 API 草稿 (HTTP)

> 草案（MVP 后）。不是最终实现契约，仅为协议草案。

- `GET /v1/plugins?query=&category=&page=`
- `GET /v1/plugins/:id`
- `GET /v1/plugins/:id/versions`
- `GET /v1/plugins/:id/download?version=`
- `POST /v1/updates/check`

所有下载元数据必须包含 `shasum`。

## 11. 明确不做（市场 v1）

- 应用内付费结账
- 远程插件代码热补丁
- 静默自动安装
- 未经验证的下载和执行
- 桌面内的评论 / 社交系统：只读取公开内容，撰写、投票和举报都留在中心网页中完成；
  编辑入口是外部链接，绝不是桌面表单。

## 12. 验收（市场只读+安装） {#_12-接受-市场只读-安装}

1. 可以浏览插件列表
2. 可以查看权限和版本
3. 可以下载并安装
4. 验证失败无法安装
5. 安装后出现在“已安装”列表中


## 13. 实施情况

桌面扩展页面现在包含一个市场选项卡，该选项卡调用：

- `market.search`
- `market.getDetail`
- `market.install`
- `market.checkUpdates`
- `market.applyUpdates`

安装在启用之前始终通过校验和验证和权限审查。


## 14. 官方市场存储库

分发仓库（[vastsa/pi-desktop-plugins](https://github.com/vastsa/pi-desktop-plugins)）
保存已发布的 `catalog.json` 及其引用的 `packages/*.piplug` 制品，不托管或审核插件源码。
中心从各发布者自己的仓库打包、审核、记录 SHA-256 并发布，然后发布官方目录和安装包引用
（[15-plugin-center.md](15-plugin-center.md)、
[ADR 0276](/adr/0276-official-plugin-channel-and-backup-channels)）。

### 已退役的源码布局（目录 v1） {#当前源-目录-v1}

```text
catalog.json               # published catalog, generated by the center
packages/*.piplug          # published artifacts
plugins/<id>/              # removed — sources live in each publisher's repository
scripts/pack_plugin.py     # removed — the center packs
scripts/rebuild_catalog.py # removed — the center generates the catalog
```

此处过去描述的逐插件维护流程（编辑 `plugins/<id>`、打包、重建目录、提交）已经退役。
现在通过中心发布版本：为发布者仓库打标签、绑定插件、提交版本，`catalog.json` 再经镜像同步。

### 由谁写入（目录 v2）

存储库：[vastsa/pi-plugin-center](https://github.com/vastsa/pi-plugin-center)

该仓库仍是分发源。变的是谁往里写：插件中心接管 `catalog.json` 的生成和
`packages/*.piplug` 的发布，第三方插件的源码留在发布者自己的仓库，而不是放进
`plugins/`。

默认目录 URL、镜像 URL 和相对包 URL 全部不变，因此不需要发布客户端版本，也不需要
用户操作。由于目录和安装包都是这里以及 CNB Git 镜像上的静态文件，即使插件中心的
API 不可用，浏览、安装和更新依然可用。

见 [15-plugin-center.md](15-plugin-center.md)。

显式检查更新会重新抓取远程目录，离线时回退到最后一份有效本地目录。打开扩展页也会执行
仅使用缓存的静默更新检查，使已安装条目刷新，无需让市场界面等待远程请求。市场页头的
刷新操作仍是显式的远程刷新入口。

使用 env 覆盖目录 URL：

```text
PI_DESKTOP_PLUGIN_MARKET_URL=https://raw.githubusercontent.com/<owner>/<repo>/<ref>/catalog.json
```


## 15. 市场细节用户体验

扩展页面以右侧详情面板展示插件信息，带遮罩，支持 Escape 或点击面板外关闭。
面板加载 `market.getDetail`，展示：

- 简介、作者及仓库 / 主页链接（在工作面板 Browser 中打开，绝不使用系统浏览器）
- 安全说明作为警告标注
- 按风险等级分组的权限，每个权限都有简单的语言解释
- 以可选择行展示的版本列表，所选版本决定固定在面板边缘的安装 / 更新操作
- README Markdown

从任一标签页发起安装都会进入权限对话框。对话框按高 / 中 / 低风险分组，并标记相对于
已安装版本新增的权限，因此升级不能静默扩大访问范围（D169）。

编写插件的文档随宿主维护，发布通过中心完成：

- 宿主指南：`docs/plugin-development.md`
- 发布：[plugins.aiuo.net](https://plugins.aiuo.net)，通过控制台或发布 skill 的 MCP 接口
- 内置模板：`panel-basic`、`agent-tool-basic`、`skill-pack`、`full-demo`
- 分发侧贡献指南：`vastsa/pi-desktop-plugins` 的 `CONTRIBUTING.md`
