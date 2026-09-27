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

主办方负责：
- 验证
- 授权
- 安装
- 运行
- 安全隔离

## 2. 阶段策略

### A阶段✅
- 协议和数据模型
- 当地官方市场提供商（`plugins/market/catalog.json`）

### B阶段✅
- Browse/search + 下载安装是针对官方提供商实施的
- 官方提供商是专用的 GitHub 存储库 `vastsa/pi-desktop-plugins`
- 默认目录 URL：`https://raw.githubusercontent.com/vastsa/pi-desktop-plugins/main/catalog.json`
- 包 URL 可以是绝对 `https://` / `http://` / `file://`，或根据目录 URL 解析的相对路径
- HTTPS 获取在 host-core 中使用 `curl`

### 目录来源选择

「扩展 → 市场」决定目录从哪里获取。host-core 解析 URL 时把环境变量放在最高
优先级，这样开发构建和测试可以指向本地目录，而不必改动已持久化的设置：

| 优先级 | 来源 | 取值 |
| --- | --- | --- |
| 1 | `PI_DESKTOP_PLUGIN_MARKET_URL` | 任意 URL |
| 2 | `pluginMarketSource: "mirror"` | `https://cnb.cool/aixk/pi-desktop-plugins/-/git/raw/main/catalog.json` |
| 2 | `pluginMarketSource: "custom"` | `pluginMarketCustomUrl` |
| 3 | `pluginMarketSource: "official"`（默认） | 上面的默认目录 URL |

镜像用于无法访问 `raw.githubusercontent.com` 的网络环境。镜像提供的目录与官方
逐字节一致，且目录中的包路径是相对路径，因此 `resolve_package_url` 会让安装包
下载跟随提供该目录的来源，切换来源不影响 shasum 校验。

缓存目录会通过 `plugins/market/cache-meta.json` 记录其来源。来自其他来源的快照
只被忽略而不删除——它的包 URL 指向用户刚切走的那个提供商——所以切回去时无需
重新请求即可恢复该目录。`settings.set` 只在内存中重新指定来源；在那里发起抓取
会让 host RPC 状态锁卡在市场超时上，因此切换后由渲染进程触发 `market.refresh`。

### 客户端可见的目录策略

保留稳定 ID 以 `demo.` 开头的仅开发示例条目
可用作插件开发的离线装置和直接安装目标，
但桌面客户端会在更新其市场状态之前过滤它们。他们
不显示为卡片、类别或搜索结果。一个已经安装好的
示例在已安装中仍然可见，因此仍然可以禁用或卸载它。

### C阶段（部分✅）
- 自动更新策略+实施权限差异门控
- 评级/强制签名仍在计划中

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

支持多个提供商：
- `official`
- `custom`（企业私有源）
- `local-mock`（开发）

## 4. 数据模型

### 目录 schema v2

没有 `schemaVersion` 的目录即 v1，含义不变。`schemaVersion: 2` 增加下列字段；
它们全部可选，因此 v1 目录解析行为完全不变，而客户端把缺失字段当作"未声明"，
不会当成默认放行。

```jsonc
{
  "schemaVersion": 2,
  "providerId": "official",
  "catalogId": "pi-plugin-center",
  "generatedAt": "2026-08-18T02:00:00Z",
  "policyVersion": "2026.08.1",
  // 可选。官方源不声明它：相对包 URL 按目录文件所在目录解析，
  // 因此 GitHub 与 CNB 镜像各自提供自己的安装包，不会跨提供方。
  // 把安装包放在别处的镜像或企业源，在这里声明自己的基址。
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
            "sourceCommit": "<40 位 commit>",
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

### 市场插件详细信息
```ts
type MarketPluginDetail = MarketPluginSummary & {
 readmeMarkdown?: string
 versions: Array<{
 version: string
 publishedAt: string
 changelog?: string
 minPiDesktop?: string
 }>
 screenshots?: string[]
 homepage?: string
 repository?: string
 permissions: string[]
 safetyNotes?: string
}
```

`installable` 表示 `latestVersion` 是否带有安装所需的包元数据（`url` 与
`shasum`）。发布者可以先登记版本、稍后再上传安装包；这样的版本仍然可以被发现，
但市场列表和详情面板会禁用安装按钮并标注「尚未发布安装包」，而不是发起一个
host 必然拒绝的下载。批量更新会跳过这类版本，而不是让整批更新失败。

### 目录发布闸门

发布或排查一次发布之前，先在仓库里跑预检：

```bash
pnpm check:marketplace -- \
  --url https://raw.githubusercontent.com/vastsa/pi-desktop-plugins/main/catalog.json \
  --plugin <plugin-id>
```

预检刻意比发现流程更严格：每个已发布版本都必须有合法且在该插件内唯一的语义化
版本号、64 位 SHA-256 校验和、包 URL、正数包大小以及权限数组。目录没过这道闸门
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

v1 目录把所有安装包都放在同一个仓库下，因此校验和是唯一需要的控制。目录 v2 的包
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

白名单之外的包 URL 在任何网络请求发出之前就以 `PLUGIN_MARKET_UNTRUSTED_HOST` 失败，
错误信息会指出被拒绝的主机，便于运维区分配置错误的私有源和恶意目录条目。

`.piplug` 软件包现在可以在本地生产：`pnpm pi-plugin pack <dir>`
（同样，`PluginPack` 代理工具）写入 `dist/<id>-<version>.piplug` 和
打印其 sha256，插件页面通过相同的方式安装该文件
作为市场下载的验证和权限审查。分布通过
因此，市场是可选的——为个人使用而编写的插件永远不会
必须离开机器。参见
[插件开发者体验](/zh-CN/spec/07-plugins/10-plugin-devex)。

其插件声明 `contributes.skills` 的目录条目也必须声明
`permissions` 中的 `agent.prompt.inject`；没有它，技能就会变得惰性，
权限审查不会提及它们。 `pi-plugin check` 对此发出警告
组合。

## 6. 更新路径

1. 启动后或按计划执行 `checkUpdates`
2.将安装的版本与最新版本进行比较
3. UI显示可用更新列表
4、用户确认后下载升级

策略：
- MVP 之后的第一个版本：手动更新
- 稍后：可选自动更新（低风险插件或仅限官方插件）

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
└─ Permission dialog (install / upgrade)
```

所有五个表面都处于一个分段控制之下，该控制承载相关的
每个选项卡计数。没有单独的数字概览带；更新警报，
选项卡计数和已安装组计数保留可操作状态，无需
将其复制到静态卡行 (D196) 中。标头保留单个
上下文主要操作（浏览市场/刷新市场）和移动
检查更新、应用自动更新、安装包和加载本地
插入溢出菜单（D169）。

安装的行故意默认为安静的两行摘要，其中包含
插件名称、可选的本地源标记、id 和版本。国家集团
标题包含“活动”/“已关闭”/“可用更新”/“需要注意”，以及
加载错误保持内联。能力、居民服务状况以及
带有风险色彩的权限芯片在折叠的本机详细信息中呈现
披露；扩展它可以暴露现有的完整读数，而无需进行每一个
排高。安装的行使用一个当前状态范围触发器；打开显示
三个范围选择及其解释，并选择此项目
打开现有的项目选择器。行图标操作在静止时保持可见，并且
在悬停和键盘焦点时显示其标签。这是一个仅渲染器
演示选择；插件
权限和激活合同不变。

详细信息表必须显示：
- 权限，按风险等级分组和标记
- 作者
- 版本（可选版本列表）
- 更新时间
- 风险描述（安全说明标注）
- 安装按钮

市场卡呈现字母组合字形，而不是获取 `iconUrl`；的
渲染器不执行远程图像加载（D169）。

## 8. 信任模型

| 级别 | 含义 |
|---|---|
| 已验证 | 官方或认证出版商 |
| 社区 | 社区插件 |
| 未知 | 定制来源/未经认证 |

UI 必须使信任级别可见。
社区不得伪装成经过验证的。

在目录 v2 下，级别由插件中心签发，而不是发布者自行声明。客户端把任何无法归因到
已配置官方源的条目显示为 `unknown`，也绝不因为目录里这么写就提升级别。v1 目录的
布尔 `verified` 仍按原义映射为 `verified` / `community`，因为 v1 目录只有市场
维护者能写入。

## 9. 私人来源（面向企业）

支持配置：

```json
{
 "marketProviders": [
 {
 "id": "official",
 "url": "https://market.example.com"
 },
 {
 "id": "corp",
 "url": "https://plugins.company.local",
 "tokenEnv": "PI_DESKTOP_MARKET_TOKEN"
 }
 ]
}
```

## 10. 远程 API 草稿 (HTTP)

> 选秀（后 MVP）。不是最终的实现绑定；仅协议草案。

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
- Comment/social系统（可延期）

## 12. 接受（市场只读+安装）

1.可以浏览插件列表
2.可以查看权限和版本
3.可以下载安装
4. 验证失败无法安装
5.安装后出现Installed


## 12. 实施情况

桌面扩展页面现在包含一个市场选项卡，该选项卡调用：

- `market.search`
- `market.getDetail`
- `market.install`
- `market.checkUpdates`
- `market.applyUpdates`

安装在启用之前始终通过校验和验证和权限审查。


## 13. 官方市场存储库

### 当前源（目录 v1）

存储库：[vastsa/pi-desktop-plugins](https://github.com/vastsa/pi-desktop-plugins)

```text
catalog.json
packages/*.piplug
plugins/<id>/
scripts/pack_plugin.py
scripts/rebuild_catalog.py
```

维护流程：

1.编辑`plugins/<id>`
2.`python3 scripts/pack_plugin.py plugins/<id>`
3.`python3 scripts/rebuild_catalog.py`
4. 提交 + 推送至 `main`
5. PI-Desktop 通过 `market.refresh`/市场 UI 刷新

目前由维护者就地编辑源码、打包、手工重建目录。下面要变的正是这一点，而地址不变。

### 由谁写入（目录 v2）

存储库：[vastsa/pi-plugin-center](https://github.com/vastsa/pi-plugin-center)

该仓库仍是分发源。变的是谁往里写：插件中心接管 `catalog.json` 的生成和
`packages/*.piplug` 的发布，第三方插件的源码留在发布者自己的仓库，而不是放进
`plugins/`。

默认目录 URL、镜像 URL 和相对包 URL 全部不变，因此不需要发布客户端版本，也不需要
用户操作。由于目录和安装包都是这里以及 CNB Git 镜像上的静态文件，即使插件中心的
API 不可用，浏览、安装和更新依然可用。

见 [15-plugin-center.md](15-plugin-center.md)。

使用 env 覆盖目录 URL：

```text
PI_DESKTOP_PLUGIN_MARKET_URL=https://raw.githubusercontent.com/<owner>/<repo>/<ref>/catalog.json
```


## 14. 市场细节用户体验

扩展目标将详细信息打开为右侧表（稀松布 + Escape + 外部
单击“dismiss”），加载 `market.getDetail` 并显示：

- 关于文本、作者和存储库/主页链接（在作品中打开
  面板浏览器，绝不是系统浏览器）
- 安全说明作为警告标注
- 按风险等级分组的权限，每个权限都有简单的语言解释
- 版本列表作为可选择的行，所选版本驱动粘性
  安装/更新操作
- 自述文件降价

从任一选项卡都可以通过权限对话框进行安装，该对话框将
请求进入高/中/低风险部分并标记新条目
相对于已安装的版本，因此升级不能默默地扩大访问范围
（D169）。

贡献文档位于官方仓库：

- https://github.com/vastsa/pi-desktop-plugins/blob/main/CONTRIBUTING.md
- 实用模板：`plugins/demo.workspace-summary`
