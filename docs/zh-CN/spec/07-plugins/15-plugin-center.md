# 15. 插件中心

> **翻译说明：** 本页是与 [英文源规格](/spec/07-plugins/15-plugin-center) 一一对应的机器辅助翻译。代码、协议字段和标识符保持原文；如翻译与英文源事实有歧义，以英文版本为准。

> 管理仓库：[vastsa/pi-plugin-center](https://github.com/vastsa/pi-plugin-center)
> 分发仓库：[AIUO-Net/pi-desktop-plugins](https://github.com/AIUO-Net/pi-desktop-plugins)
> 决策记录：[ADR 0102](../../../adr/0102-publisher-owned-plugin-source-and-git-hosted-artifacts.md)
> 客户端契约：[07-plugin-marketplace.md](07-plugin-marketplace.md)

本文定义取代单仓库市场的分发系统，是插件中心服务的规范性方案；桌面客户端读取的数据与
接口契约仍以市场规范为准。

实现范围：本仓库包含桌面客户端与 `packages/plugin-devkit/src/publish.ts`，后者只准备本地包和提交文件，
不会上传。下文的中心 API、工作进程（Worker）、身份与签名章节描述的是独立服务的设计，
不代表 SDK 方法，也不能证明服务器已经运行。当前客户端默认读取
`https://plugins.aiuo.net/catalog.json`，并使用所述 `/api/v1` 下载解析 / 评论路由。
详见市场契约及源码 `crates/host-core/src/plugins/marketplace`、`reviews.rs` 和 `resolve.rs`。

## 1. 定位

插件中心是插件分发的发布侧。它回答三个客户端自己无法回答的问题：

1. 这个发布者是否真的控制他声称要发布的那个仓库？
2. 这些字节由什么源码产生，能否在安装前展示给用户？
3. 这个版本是否适合发布，是谁做的决定？

校验、权限审核、安装、隔离和运行时仍然由客户端负责。插件中心绝不会因此获得在用户机器上
运行客户端本来不会接受的代码的能力。

## 2. 归属模型

| 资产 | 归属 | 位置 |
|---|---|---|
| 插件源码 | 发布者 | 发布者自己的 GitHub 仓库 |
| 构建输入（commit、tree、path） | 插件中心（固定副本） | 中心数据库 + 快照存储 |
| 注册表与审查证据 | 插件中心 | `vastsa/pi-plugin-center` |
| `.piplug` 制品 | 插件中心（发布） | `AIUO-Net/pi-desktop-plugins/packages/` |
| 目录 | 插件中心（生成） | `AIUO-Net/pi-desktop-plugins/catalog.json` |
| 分发镜像 | 插件中心 | 分发仓库的 CNB Git 镜像 |
| 安装决定 | 用户 | 桌面端权限审查 |

插件源码绝不会被复制进 PI-Desktop 拥有的 Git 仓库。中心为构建和审查证据保留固定
commit 的不可变快照；该快照是存储，不是 Git 镜像，也不对外发布。

## 3. 仓库划分与制品托管

参考方案使用 S3/R2 加 CDN。本系统把管理面与分发面拆开，并复用已经存在的 Git 托管
（ADR 0102 第 2 节）。

### 3.1 布局

```text
vastsa/pi-plugin-center                 # 管理面
├─ registry/<pluginId>.json             # 已发布状态投影，每插件一个文件
├─ schema/                              # submission、registry、catalog、review
├─ scripts/                             # 目录生成与校验
└─ api/ db/                             # 服务契约与迁移

AIUO-Net/pi-desktop-plugins               # 分发面，地址完全不变
├─ catalog.json                         # 由插件中心生成
├─ packages/<pluginId>-<version>.piplug # 由插件中心发布
└─ plugins/                             # 已移除——源码保存在发布者自己的仓库
```

插件中心绝不把插件源码写进这两个仓库中的任何一个。`plugins/` 存放过本项目自己的示例插件，
早于发布者自持源码这一模型；2026-10 起每个版本都来自发布者仓库，该目录已删除。第三方插件
只新增一个安装包和一条目录条目，不新增源码。

### 3.2 制品 URL

```text
https://raw.githubusercontent.com/AIUO-Net/pi-desktop-plugins/main/packages/<pluginId>-<version>.piplug
```

目录声明 `artifactBaseUrl`，包条目的 `url` 保持为相对路径
`packages/<pluginId>-<version>.piplug`。无论目录由哪个主机提供，客户端都按目录声明的基址
解析安装包地址：

```text
中心目录              artifactBaseUrl = raw.githubusercontent.com/AIUO-Net/pi-desktop-plugins/main
本分发仓库            raw.githubusercontent.com/AIUO-Net/pi-desktop-plugins/main
CNB 镜像              cnb.cool/aixk/pi-desktop-plugins/-/git/raw/main/…
```

由于使用 Git 镜像，安装包与目录会同步更新并保持逐字节一致。即使提供目录的主机并不托管
安装包，声明 `artifactBaseUrl` 仍可确保安装包 URL 指向预期主机；不声明时，客户端会以目录
文件所在的目录为基址，可能将下载请求发往错误的主机。

### 3.3 用什么替代 WORM

没有对象锁语义，完整性改由三条互相独立的记录支撑：

1. 制品的 SHA-256 在发布事务内写入中心数据库，此后永不更新。
2. 字节与该摘要在同一个 commit 中提交进分发仓库，因此 Git 历史同时持有两者，且只
   追加。
3. 客户端在解压任何内容之前，先用目录中的摘要校验下载到的字节。

于是要改变一个已发布版本解析到的内容，必须重写分发仓库的历史，而不是替换一个文件；
这既应由分支保护阻止，也对任何克隆过该仓库的人可见。这是可发现篡改，而不是可阻止
篡改，是放弃对象存储所接受的代价。

### 3.4 保留策略

每个已发布安装包在其版本仍被提供期间都保留在 `packages/` 中。撤回的版本保留目录条目
和撤回原因，其安装包可以在事件窗口关闭后从 `packages/` 删除，这样已经收到警告的用户
不会被悄悄重新投递那些被撤下的字节。

删除文件并不回收历史。分发仓库的体积单调增长，这是提交制品所接受的代价（ADR 0102）。

## 4. 服务架构

```text
            ┌──────────────────────────────┐
            │ Vercel 上的 Next.js          │
            │ SEO 页面 · 发布者控制台      │
            └──────────────┬───────────────┘
                           │ HTTPS
            ┌──────────────▼───────────────┐
            │ 中心 API                     │
            │ 身份 · 归属 · 提交           │
            └──────┬───────────────┬───────┘
                   │               │
        ┌──────────▼─────┐   ┌─────▼──────────┐
        │ PostgreSQL     │   │ Redis / 队列   │
        │ 事实源         │   │ 任务与租约     │
        └────────────────┘   └─────┬──────────┘
                                   │
                          ┌────────▼─────────┐
                          │ Worker           │
                          └──┬────────────┬──┘
                             │            │
                 ┌───────────▼──┐   ┌─────▼─────────┐
                 │ 隔离 runner  │   │ AI 审查       │
                 │              │   │ primary+critic│
                 └───────────┬──┘   └─────┬─────────┘
                             │            │
                       ┌─────▼────────────▼─────┐
                       │ Policy evaluator       │
                       │ 唯一的发布门禁         │
                       └───────────┬────────────┘
                                   │
                       ┌───────────▼────────────┐
                       │ Release publisher      │
                       │ GH Releases + CNB + Git│
                       └────────────────────────┘
```

### 4.1 职责划分

| 组件 | 负责 | 禁止 |
|---|---|---|
| Next.js | 页面、表单、SEO、状态展示 | 访问数据库、持有密钥、决定发布 |
| 中心 API | 身份、归属、提交、查询 | 执行插件代码、直接构建、直接发布 |
| PostgreSQL | 账号、绑定、版本、审查、审计 | 充当队列或对象存储 |
| Redis | 队列、租约、幂等锁 | 充当权威数据源 |
| 工作进程（Worker） | 编排快照、构建、扫描、审查、判定 | 绕过状态机或覆盖历史尝试记录 |
| 隔离执行器（runner） | 安装依赖、构建、测试、扫描 | 访问生产机密、宿主机或白名单之外的网络 |
| 发布执行器（Release publisher） | 上传制品、同步镜像、重新生成目录 | 发布策略评估器未批准的版本 |

API 进程绝不执行发布者提供的代码。所有需要执行不可信输入的环节均在隔离执行器中进行。

## 5. 身份与归属

单个 GitHub App 同时承担登录和仓库访问。

- **OAuth（PKCE + state，短期用户令牌）** 证明提交者身份。
- **GitHub App 安装实例（installation）** 证明该账号授予了哪些仓库的访问权及其权限范围。
- **Webhook** 传递安装实例、仓库、推送、版本发布及成员关系的变化，确保安装实例撤销后
  立即停止接受后续提交。

申请的权限都是只读：仓库元数据、仓库内容，以及固定源码所需的 commit/tag/release
读取权限。不申请写权限、机密访问权或组织管理权限。新增权限范围必须有 ADR。

归属校验在提交入队之前完成，绝不在之后补：

1. 会话的 GitHub 账号与请求身份一致。
2. 安装实例仍存在，且仍覆盖目标仓库。
3. 账号持有 `admin`、`maintain` 或明确允许的角色。
4. 提交的规范化 URL 与 GitHub 返回的 owner/name 完全一致。
5. 账号、安装实例和仓库的绑定关系，连同校验时间及权限证据的哈希值一起持久化。

失败返回 `SOURCE_OWNERSHIP_DENIED` 或 `SOURCE_OWNERSHIP_UNAVAILABLE`。仅仅登录永远
不够。

个人访问令牌不是受支持的发布凭证。GitHub App 私钥仅存于密钥管理系统；安装访问令牌
按需换取，缓存时间不超过其有效期。

## 6. 提交状态机

```text
submitted
  → ownership_verified
  → source_pinned
  → scanning
  → building
  → ai_review
  → policy_evaluated
  → approved
  → published

任意中间态 → needs_info | changes_requested | blocked | build_failed | canceled
published → yanked
```

规则：

- 只有服务端能推进状态，并使用带行版本号的条件更新，避免并发工作进程同时推进同一版本。
- `published`、`canceled`、`yanked` 是该版本的终态。重试会创建新的尝试记录，
  不会重新激活已结束的状态。
- 每次重试创建新的 `review_attempt`，并保留前一次尝试的输入、输出和哈希值。
- 队列重复投递按提交键保证幂等；工作进程崩溃后可恢复租约，不会重复发布。
- 未完成的确定性门禁不能被 AI 报告标记为通过。

## 7. 源码固定

接受的输入：

```json
{
  "pluginId": "acme.todo",
  "repository": "https://github.com/acme/pi-plugin-todo",
  "path": ".",
  "ref": "refs/tags/v1.2.0",
  "channel": "stable",
  "version": "1.2.0",
  "artifact": {
    "mode": "publisher-release",
    "assetUrl": "https://github.com/acme/pi-plugin-todo/releases/download/v1.2.0/acme.todo-1.2.0.piplug",
    "sha256": "…"
  },
  "idempotencyKey": "…"
}
```

- 只接受规范化的 HTTPS GitHub URL；拒绝查询参数、片段、凭据或非 GitHub 主机。
- `ref` 必须是完整的 40 位十六进制 commit SHA，或 `refs/tags/<tag>`。
  附注标签会继续解析到对应提交。
- 工作进程自行重新解析提交、目录树与归档。客户端提供的哈希值仅用于比对，不能直接信任。
- 快照记录仓库、提交的 ref、解析后的 commit、tree SHA、归档 SHA-256 和抓取时间。
- 解包拒绝绝对路径、`..` 穿越、符号链接、硬链接、设备文件和重复路径，并限制总大小、
  单文件大小、文件数和目录深度。

### 7.1 制品模式

| 模式 | 发布者提供 | 中心执行 |
|---|---|---|
| `publisher-release` | 附加在发布者自己的 GitHub Release 上的 `.piplug` | 按提交的摘要校验字节，核对包内 `manifest.json` 与固定源码一致，然后转存 |
| `center-build` | 仅提供固定源码版本所需的信息 | 在隔离执行器中从固定 commit 构建，然后转存 |

`publisher-release` 是默认模式，因为它把工具链责任留在发布者一侧。两种模式下中心都会
转存，也都要求包内清单的身份信息与固定源码及提交的版本一致。

## 8. 审查与发布门禁

每个版本针对同一份证据包运行两轮独立的 AI 审查：`primary` 检查契约、行为、权限、
数据处理方式和供应链；`critic` 接收相同输入，寻找 `primary` 遗漏或言过其实的结论。
`critic` 绝不把 `primary` 的输出当作事实。每次尝试都记录模型、提示词版本和输入哈希值。

审查技能将源码、清单和日志一律视为不可信数据，不执行其中的任何指令。它无法访问网络，
运行环境不提供环境变量，也无权访问密钥。证据不足时输出 `needs_info`，不会猜测；输出只能是符合
schema 的 JSON。

策略评估器是唯一能产出 `approved` 的组件。它从数据库而不是报告中重新核验：

- 版本元组与记录的提交一致。
- 快照、制品、软件物料清单（SBOM）和构建溯源信息的哈希值一致。
- 所有必需的确定性门禁均已通过。
- `primary` 与 `critic` 两次审查记录均存在且相互独立。
- 没有未解决的高危或严重问题、权限升级或数据处理方式变更。
- 签名、目录密钥、构建器版本和策略版本均有效。
- 该版本仍是唯一、未撤销的发布候选。

模型报告中的 `deterministicGates`、`publishable` 和 `approved` 是建议性文本，一律忽略。
评估器失败、证据缺失或依赖服务不可用时，只能进入 `needs_info` 或 `build_failed`，
绝不进入 `published`。

## 9. 发布顺序

只有按此顺序执行，发布才是持久的：

1. 提交数据库事务，将版本标记为已发布并写入制品摘要。
2. 发出事务发件箱（outbox）事件。
3. 在 `pi-plugin-center` 写入注册表条目，并据此重新生成目录。
4. 把安装包与重建后的 `catalog.json` 以**同一个** commit 提交进 `pi-desktop-plugins`。
5. 由 CNB Git 镜像复制该 commit。

第 4 步刻意合成一个 commit：否则在两个 commit 之间抓取目录的客户端，会看到一条
安装包尚不存在的条目。任一步失败都保留上一份目录，因此不存在"数据库已发布、客户端
却拿到指向缺失安装包的目录"的状态。

## 10. 公开 API

```text
GET  /v2/catalog.json
GET  /v2/plugins
GET  /v2/plugins/{pluginId}
GET  /v2/plugins/{pluginId}/versions
GET  /v2/plugins/{pluginId}/versions/{version}
GET  /v2/publishers/{publisherId}
GET  /v2/categories
GET  /v2/healthz
```

面向发布者：

```text
GET  /v2/auth/github/start
GET  /v2/auth/github/callback
GET  /v2/me
POST /v2/auth/logout
GET  /v2/github/installations
POST /v2/github/installations/link
POST /v2/plugins/{pluginId}/submissions
GET  /v2/submissions/{submissionId}
POST /v2/submissions/{submissionId}/cancel
```

仅限服务身份的内部接口：

```text
POST /internal/workflows/plugin-scan
POST /internal/policy-evaluations/{releaseId}
POST /internal/catalog-publications
POST /v2/webhooks/github
```

公开响应只包含已发布数据并带 schema 版本。变更操作要求会话、CSRF 与 Origin 校验、
幂等键和审计事件。内部路由拒绝浏览器会话。

**桌面客户端读取生成出来的目录，并调用一条下载路由。** 官方插件渠道的每次安装或更新
都通过 `POST /api/v1/download/resolve` 解析，发送插件 ID、用户选定版本时的版本号，以及
稳定的设备标识（`deviceId`），让平台能够对下载去重，并按设备而不是按来源地址限流。
对应的制品字节下载接口 `GET /download/{id}/{version}` 供市场网页与控制台使用，
桌面客户端不使用它。浏览与检查更新仍然只需要静态文件。客户端为 resolve 请求设置
三秒时限；超时、限流或返回 `NO_DOWNLOAD_SOURCE` 时，回退到目录自身的安装包 URL，
并继续校验目录中的摘要。这可避免缓慢的 API 阻塞安装，同时保留对尚未发布、已归档或
不存在版本的明确拒绝。客户端一侧的契约——
渠道、镜像、摘要校验以及标识的派生方式——见
[07-plugin-marketplace.md](/zh-CN/spec/07-plugins/07-plugin-marketplace)。

正在运行的安装通过 `plugin.installProgress` 报告自己的进度——当前阶段、正在尝试的镜像
与已收到的字节数——并可用 `market.cancelInstall` 取消仍在运行的安装，其中只有下载阶段
可被中断。两者都是客户端一侧的契约：平台的 resolve 调用不变，每次安装或更新仍然只收到
一次请求。

客户端还会匿名读取公开的插件评论：

```text
GET  /api/v1/review-summaries?pluginIds=id1,id2
GET  /api/v1/plugins/{pluginId}/reviews?cursor=&limit=&sentiment=&sort=
```

摘要路由返回屏幕上这些插件 id 的聚合评分（已知插件没有评论时得到零摘要；服务不可用与
零是不同的状态），因此卡片无需刷新目录即可显示评分。评论路由返回一页可见评论及其摘要
和一个稳定的不透明游标。两者只携带插件 id 与所选的筛选、排序、页大小和游标——不含账户、
会话或设备标识符——桌面客户端不能发布、投票或举报：撰写评论在插件中心自己的网页上进行。
公开读取是匿名的，且绝不阻塞安装、更新或任何其他客户端操作。

## 11. 信任层级

| 层级 | 含义 | 谁能设置 |
|---|---|---|
| `verified` | 经中心审核、身份已确认的发布者 | 中心运营方 |
| `community` | 归属已校验、自动审查通过的发布者 | 策略评估器 |
| `unknown` | 中心未审核的自定义或企业源 | 客户端默认值 |

发布者无法声明任何层级。目录生成时从数据库写入层级；插件元数据里提交的取值会被丢弃。
客户端把任何无法归因到中心的条目渲染为 `unknown`，也绝不因为目录文本就提升层级。

## 12. 迁移

| 阶段 | 状态 | 客户端行为 |
|---|---|---|
| 1 | `catalog.json` 由人工维护，schemaVersion 1 | 按现状读取 v1 |
| 2 | 改由插件中心生成同一个文件，仍为 v1 | 无变化 |
| 3 | 生成的目录声明 schemaVersion 2 | v2 字段存在时才渲染 |
| 4 | 中心发布的插件与第一方插件并列 | 按条目展示溯源与信任层级 |

目录 URL 始终不变，因此任何阶段都不需要发布客户端版本、迁移设置或用户操作。早于 v2
的客户端照常工作，因为每个 v2 字段都是可选的增量字段。

## 13. 交付阶段

### 阶段 0 —— 契约（本次变更）

- ADR 0102、本文档，以及市场规范中的目录 v2 契约。
- 注册表条目、目录、提交和审查报告的 JSON Schema。
- 插件中心仓库脚手架：schema、目录生成器、校验脚本、发布工作流、API 契约、
  数据库迁移。
- 客户端：目录 v2 解析、下载域名白名单、执行撤回限制与 `minPiDesktop` 版本要求、溯源采集与
  展示、`pi-plugin publish`。

验收：客户端能从分发仓库提供的 v2 目录完成安装，并拒绝白名单之外主机提供的安装包。

### 阶段 1 —— 身份与固定

GitHub App OAuth、安装实例绑定、归属校验、Webhook、源码快照。验收：用户无法提交
自己不控制的仓库，且每个被接受的输入都固定到 commit。

### 阶段 2 —— 构建与审查

隔离执行器、确定性打包、SBOM 与构建溯源信息、两轮 AI 审查、schema 校验。验收：同一输入
复现同一制品摘要，且任何模型输出都无法伪造门禁。

### 阶段 3 —— 策略、签名与目录版次

策略评估器、签名密钥、目录版次与回滚、客户端签名校验。验收：只有已批准的版本
能进入已发布目录，且版次可回滚。

### 阶段 4 —— 发布者控制台与 SEO

提交历史、版本状态、证据摘要、详情页、sitemap、hreflang。验收：公开页面只展示已发布
数据。

### 阶段 5 —— 韧性

备份与恢复演练、执行器逃逸演练、令牌撤销、目录回滚、限流、告警。

## 14. 明确不做

- 把发布者源码复制进 PI-Desktop 的仓库。
- 把个人访问令牌当作发布凭证。
- 在 API 进程中执行插件代码、安装依赖或运行测试。
- 让前端、普通管理路由或模型输出把状态置为 `published`。
- 以人工审核为主流程。人只处理事故、申诉和策略例外。
- 对象存储、独立运维的 CDN、应用内支付或远程代码热补丁。

## 15. "插件中心已上线"的验收

- 归属校验针对真实的 GitHub App 安装实例通过集成测试。
- API、工作进程、隔离执行器、数据库、队列和密钥管理系统均为生产实例。
- 两轮审查与可信策略评估器已启用。
- 构建可复现，制品可依据构建溯源信息验证。
- 目录具备版次、签名和回滚路径。
- 公开页面只暴露已批准、已发布的版本，且撤回能够传播。
- 审计、指标、备份、恢复和一次安全演练均已完成。

在此之前，任何本地测试夹具、静态样例或人工步骤都只是开发验证，不得被描述为发布能力。
