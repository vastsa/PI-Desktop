# 插件评论测试计划（桌面端）

> **翻译说明：** 本页是与 [英文源规格](/spec/06-delivery/plugin-reviews-test-plan) 一一对应的机器辅助翻译。代码、协议字段和标识符保持原文；如翻译与英文源事实有歧义，以英文版本为准。

面向只读公开插件评论面的可携带、由仓库承载的测试计划：共享类型、host-core
RPC/HTTP 客户端、Electron IPC 桥、渲染器数据层、已安装网格/详情面板 UI、评论抽屉、
语言覆盖与 Electron 夹具。

作为事实来源的引用：

- `docs/spec/07-plugins/07-plugin-marketplace.md` —— 市场/评论行为。
- `docs/spec/06-delivery/04-e2e-test-plan.md` —— 夹具约定与命令。
- 中心对应文档：中心仓库的 `docs/reviews-test-plan.md`（API 规则以及本计划与之配对的
  Go/service/store 证据）。
- 共享类型：`packages/shared/src/types/marketplace.ts`；协议通道位于
  `packages/shared/src/protocol.ts`。
- 自动化证据：`apps/desktop/test/market-review-ipc.test.mjs`、
  `plugin-reviews-logic.test.mjs`、`plugin-reviews-surface.test.mjs`、
  `plugins-page-style.test.mjs`；`crates/host-core/src/plugins/reviews.rs` 单元测试；
  `crates/host-core/src/rpc/plugin_reviews_rpc_tests.rs`；`scripts/e2e/` 下的夹具及其
  `scripts/` 下的运行器。

## 0. 结果状态

| 标记 | 含义 |
| --- | --- |
| `verified` | 在本 worktree 上的运行结束后，最终实际结果记录在“最终执行记录”中。 |
| `baseline:fail` | 该环境中的既有完整套件失败，不是评论功能回归。 |
| `executed; baseline failures` | 命令端到端跑完；只有已知基线失败——不等于通过。 |

下文测试标题逐字复制自各行引用的仓库文件。若标题已与源文件不符，请更新该行。

## 1. 范围与禁止事项

- 仅限任务 worktree；不提交、不推送、不打标签、不发布、不打包。
- 绝不附加用户正在运行的实例或配置档；绝不使用 `verify:ui:*`。获准的模式是 §2.5 中
  的无头 Electron 夹具，使用 `.cache/` 下的隔离 `userData` 配置档。
- 不做宽泛的配置或忽略文件改动。
- 桌面端保持只读：渲染器内不得有登录、发帖、投票、举报或凭据。
- 测试即证据；本计划不声称任何运行已经发生过。

## 2. 命令

### 2.1 Windows 调用变通（tsc / electron-vite）

标准脚本是 `pnpm --filter @pi-desktop/desktop typecheck`、
`pnpm --filter @pi-desktop/desktop build` 以及仓库级 `pnpm test`。当 Windows 上的
pnpm 脚本垫片无法解析时，用 `node` 直接调用 worktree 本地二进制——输入输出一致，
不改任何配置：

```powershell
cd apps/desktop
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
node node_modules/electron-vite/bin/electron-vite.js build
cd ../..
```

仅当产物过期时才重建工作区 dist（夹具会解析它们）：

```powershell
cd packages/shared;     node node_modules/typescript/bin/tsc -p tsconfig.json; cd ../..
cd packages/plugin-sdk; node node_modules/typescript/bin/tsc -p tsconfig.json; cd ../..
```

### 2.2 定向 JS 测试（最终六文件运行）

```powershell
node --test apps/desktop/test/market-review-ipc.test.mjs apps/desktop/test/plugin-reviews-logic.test.mjs apps/desktop/test/plugin-reviews-surface.test.mjs apps/desktop/test/plugins-page-style.test.mjs apps/desktop/test/extensions-page.test.mjs apps/desktop/test/settings-dialog-overlay.test.mjs
```

最终独立运行：**64/64 通过** —— IPC 6、logic 16、surface 14、style 8、extensions 16、
overlay host 套件 4。评论相关用例映射到前四个文件以及 RVD-UI-14 的已安装网格钉扎；
extensions 与 overlay 是渲染器改动触及的相邻回归伴随项（详情面板挂载在视口 overlay
host 上）。

### 2.3 定向 Rust 测试

```powershell
cargo test -p host-core --bin pi-desktop-host-core review
cargo fmt --check
cargo clippy -p host-core --all-targets
```

已知无关的 clippy 警告（warn 级）：`crates/host-core/src/transcripts.rs:893`
`clippy::filter_next`。

### 2.4 完整 host-core 套件背景

```powershell
cargo test -p host-core --bin pi-desktop-host-core
```

该环境中的已知基线：**912 通过；38 失败；1 忽略**，全部 38 个都在 Windows
shell/worktree 区域（`background_tasks`、`data_relocation`、`rpc::*`、
`session_worktrees`、`tools::bash_*`、`tools::powershell_*`）——不是评论回归。
按 `baseline:fail` 报告；不要依据本计划去修它们。

### 2.5 国际化

```powershell
# 目录完整性
cd packages/i18n
node node_modules/vitest/vitest.mjs run
cd ../..

# 评论块与键位对齐（每种语言都必须打印 reviewsBlock=1 sevenKeys=7）
$root = 'C:\Code\ReactProjects\PI-Desktop\.slim\worktrees\plugin-reviews'
foreach ($l in 'de','en','es','fr','ko','pt-BR','tr','zh-CN','zh-TW') {
  $f = "$root\packages\i18n\src\locales\$l\index.ts"
  $block = (Select-String -Path $f -Pattern '^\s*reviews: \{' -CaseSensitive).Count
  $keys  = (Select-String -Path $f -Pattern 'summaryTitle:|viewAll:|composeHint:|composeCta:|reviewVersion:|filterLabel:|sortLabel:' -CaseSensitive).Count
  "$l : reviewsBlock=$block sevenKeys=$keys"
}
```

`-CaseSensitive` 很重要：缺了它键位计数会读到 8，因为无关的键
`capabilityFilterLabel` 也会匹配 `filterLabel:`。确认每种语言都是
`reviewsBlock=1 sevenKeys=7`。

### 2.6 Electron 夹具（真实 Chromium，无头）

```powershell
node scripts/e2e-plugin-reviews-drawer.mjs     # 五个探针：drawer / batch-stale-guard / narrow drawer / stale summary / unavailable summary
node scripts/e2e-installed-grid.mjs            # installed grid + control rails + dialogs
node scripts/e2e-plugin-detail-focus.mjs       # detail-sheet focus interplay
```

每个运行器都用 esbuild 构建真实组件，在隐藏的 Electron 窗口中以私有配置档加载，
每个探针打印一行 PASS。渲染器不安装任何东西；不触碰用户实例。

## 3. 用例

### 3.1 共享类型与渲染器 API

| ID | 检查 | 预期 | 状态 |
| --- | --- | --- | --- |
| RVD-TYP-01 | `PluginReviewSummary` 与中心契约一致：`ratingAvg: number \| null`、五个向下取整星桶、三个情绪计数 | 在 shared + desktop typecheck 中编译；公开类型中不含私有字段（`userId`、`hiddenReason`） | `verified`（2026-10-16 最终 typecheck + build） |
| RVD-TYP-02 | `PluginReviewPage` 携带 `reviews`、`nextCursor: string \| null`、`summary`、由 host 构建的 `reviewUrl`；`PluginReviewQuery` 允许 `cursor?/limit?/sentiment?/sort?` | `api.marketReviewSummaries(ids)` / `api.marketReviews(query)` 通过 preload 白名单返回共享类型 | `verified`（2026-10-16 最终 typecheck + build） |

### 3.2 Electron IPC 桥 —— `market-review-ipc.test.mjs`

| ID | 测试标题（逐字） | 预期断言 | 状态 |
| --- | --- | --- | --- |
| RVD-IPC-01 | review channels are registered and allowed through the preload gate | `IPC.invoke.marketReviewSummaries === "pi-desktop/market/reviewSummaries"`、`marketReviews === "pi-desktop/market/reviews"`，且两者都在 `IPC_WHITELIST` 中 | `verified`（2026-10-16 六文件运行） |
| RVD-IPC-02 | summary reads forward the ids and return the host payload unchanged | 处理函数以 `{pluginIds}` 调用 host 的 `market.reviewSummaries`，并原样返回 `{summaries}` | `verified`（2026-10-16 六文件运行） |
| RVD-IPC-03 | a missing or malformed id list becomes an empty request, never a crash | 缺失 payload 与 `pluginIds: "demo.hello"` 都转发 `{pluginIds: []}` | `verified`（2026-10-16 六文件运行） |
| RVD-IPC-04 | review reads forward the query and return the page unchanged | 完整查询（含 `cursor`）被转发；页面原样返回 | `verified`（2026-10-16 六文件运行） |
| RVD-IPC-05 | an unsupported or unreachable center reaches the caller unchanged | 拒绝携带 `data.errorCode === "PLUGIN_NETWORK"` —— 不重映射、不掩盖 | `verified`（2026-10-16 六文件运行） |
| RVD-IPC-06 | review reads require a running host | 无 host → 以 `host unavailable` 拒绝 | `verified`（2026-10-16 六文件运行） |

### 3.3 Host RPC —— `plugin_reviews_rpc_tests.rs`

前置条件：一个夹具 HTTP 服务器在回环 origin 上扮演可信中心；host-core 通过真实请求
处理器驱动。

| ID | 测试（逐字） | 预期断言 | 状态 |
| --- | --- | --- | --- |
| RVD-RPC-01 | `review_summaries_rpc_returns_only_the_centers_answers` | 只有被请求且被回答的 id；中心多答的未请求项被丢弃 | `verified`（2026-10-16 加固后的 Rust 运行） |
| RVD-RPC-02 | `review_summaries_rpc_dedupes_and_chunks_installed_ids` | 重复项折叠；以 ≤100 个 id 分批；请求被记录 | `verified`（2026-10-16 加固后的 Rust 运行） |
| RVD-RPC-03 | `review_summaries_rpc_is_empty_without_asking_the_center` | 空 id → `{summaries:{}}` 且不发 HTTP 请求 | `verified`（2026-10-16 加固后的 Rust 运行） |
| RVD-RPC-04 | `review_summaries_rpc_rejects_malformed_center_answers` | 坏 JSON/形状 → `PLUGIN_MARKET_INVALID` | `verified`（2026-10-16 加固后的 Rust 运行） |
| RVD-RPC-05 | `review_summaries_rpc_reports_a_legacy_center_as_unavailable` | 404 → `PLUGIN_NETWORK`（不可用），绝不为零 | `verified`（2026-10-16 加固后的 Rust 运行） |
| RVD-RPC-06 | `review_summaries_rpc_never_fabricates_zeros_when_the_center_is_down` | 中心宕机 → 报错；不编造零摘要 | `verified`（2026-10-16 加固后的 Rust 运行） |
| RVD-RPC-07 | `review_summaries_rpc_stays_bounded_when_the_center_stalls` | 停滞 → 在 5 秒评论时限内失败 | `verified`（2026-10-16 加固后的 Rust 运行） |
| RVD-RPC-08 | `review_summaries_rpc_never_holds_the_host_state_lock_across_io` | 先捕获可信 origin，I/O 前释放 host 状态锁 | `verified`（2026-10-16 加固后的 Rust 运行） |
| RVD-RPC-09 | `review_summaries_rpc_refuses_a_non_http_center` | `file://` 目录 → 不可用，不发请求 | `verified`（2026-10-16 加固后的 Rust 运行） |
| RVD-RPC-10 | `review_summaries_rpc_keeps_the_center_bounded` | 请求携带 5 秒超时、1 MiB 上限，且不跟随重定向 | `verified`（2026-10-16 加固后的 Rust 运行） |
| RVD-RPC-11 | `reviews_rpc_returns_the_page_with_a_trusted_review_url` | 页面 + 摘要 + 来自生效可信 origin 的 `reviewUrl`（含夹具覆盖） | `verified`（2026-10-16 加固后的 Rust 运行） |
| RVD-RPC-12 | `reviews_rpc_refuses_non_visible_rows_in_the_public_list` | 非可见行 → `PLUGIN_MARKET_INVALID` | `verified`（2026-10-16 加固后的 Rust 运行） |
| RVD-RPC-13 | `reviews_rpc_propagates_center_outages` | 中心错误 → 以 `PLUGIN_NETWORK` 传播 | `verified`（2026-10-16 加固后的 Rust 运行） |
| RVD-RPC-14 | `reviews_rpc_rejects_invalid_input_before_any_network` | 坏 `pluginId`/`limit`/`cursor`/`sentiment`/`sort` → `INVALID_PARAMS`，零请求 | `verified`（2026-10-16 加固后的 Rust 运行） |
| RVD-RPC-15 | `reviews_rpc_rejects_pages_that_break_the_public_contract` | 超出上限的页、错误 pluginId、坏评分/时间戳/越界 → `PLUGIN_MARKET_INVALID` | `verified`（2026-10-16 加固后的 Rust 运行） |
| RVD-RPC-16 | `reviews_rpc_never_follows_redirects` | 中心返回 3xx → 拒绝，不跳转 | `verified`（2026-10-16 加固后的 Rust 运行） |

2026-10-16 的一次跨主机运行还在真实运行的中心上端到端演练了这一层（host stdio RPC，
零状态 9/9、非零 11/11）——见 §5 第 12 行。它补充但不替代上面的定向测试。

### 3.4 Host 客户端边界/校验 —— `plugins/reviews.rs`

| ID | 测试（逐字） | 预期 | 状态 |
| --- | --- | --- | --- |
| RVD-CLI-01 | `review_reads_are_bounded` | 超时 5 秒；1 MiB 响应上限；100 个摘要 id | `verified`（2026-10-16 加固后的 Rust 运行） |
| RVD-CLI-02 | `the_origin_keeps_only_the_catalogs_host` | 保留 http(s) origin（含端口）；拒绝 `file://`、带凭据 URL、藏查询的 authority | `verified`（2026-10-16 加固后的 Rust 运行） |
| RVD-CLI-03 | `summaries_batches_dedupe_and_cap_at_one_hundred` | 205 个唯一 id 加重复项 → 分批 100/100/5，每个 id 只出现一次 | `verified`（2026-10-16 加固后的 Rust 运行） |
| RVD-CLI-04 | `review_urls_stay_on_the_trusted_origin` | 游标被百分号编码；列表/摘要/页面 URL 不离开 origin | `verified`（2026-10-16 加固后的 Rust 运行） |
| RVD-CLI-05 | `summary_consistency_is_enforced` | 分布与情绪计数之和等于 `ratingCount`；零计数 ⇔ 空平均值；0..5 范围 | `verified`（2026-10-16 加固后的 Rust 运行） |
| RVD-CLI-06 | `review_contract_is_enforced` | 插件正确、状态可见、2..=10 半星、ISO 时间戳、正文 ≤2000 字符、版本 ≤128、名称 ≤200；空版本与 `editedAt` 可接受 | `verified`（2026-10-16 加固后的 Rust 运行） |

### 3.5 渲染器纯逻辑 —— `plugin-reviews-logic.test.mjs`

| ID | 测试标题（逐字） | 预期断言 | 状态 |
| --- | --- | --- | --- |
| RVD-LOG-01 | the official review URL encodes the plugin id into the fallback page | 官方 URL 对插件 id 做百分号编码（`/`、空格、`#`） | `verified`（2026-10-16 六文件运行） |
| RVD-LOG-02 | the page URL wins only when it is a usable http(s) address | host `reviewUrl` 为 http(s) 时采用；`javascript:`、`data:`、相对路径、空白 → 回退官方页 | `verified`（2026-10-16 六文件运行） |
| RVD-LOG-03 | one query key names exactly one plugin, sentiment and sort | 不同插件/筛选/排序 → 不同 key | `verified`（2026-10-16 六文件运行） |
| RVD-LOG-04 | mergeReviews appends unseen rows once and keeps the shown order | 去重追加，保持首次出现顺序 | `verified`（2026-10-16 六文件运行） |
| RVD-LOG-05 | rating formatting follows the contract: one decimal, half stars trimmed | `4.5→"4.5"`、`5→"5.0"`、null/NaN → null；半星修剪为整星/半星文本 | `verified`（2026-10-16 六文件运行） |
| RVD-LOG-06 | sentiment shares split the good / medium / bad counts into percentages | `[2,1,0] → 67/33/0`；空摘要 → 全零 | `verified`（2026-10-16 六文件运行） |
| RVD-LOG-07 | a query carries the page limit and only adds a cursor when paging | 始终带 limit；仅翻页时带 cursor | `verified`（2026-10-16 六文件运行） |
| RVD-LOG-08 | a first page fills the list and closes the load | 就绪状态、行、`nextCursor`、摘要、生效 URL | `verified`（2026-10-16 六文件运行） |
| RVD-LOG-09 | a summary of zero reviews is carried through as zero, not as unavailable | `ratingCount 0`、空平均值 —— 与不可用不同 | `verified`（2026-10-16 六文件运行） |
| RVD-LOG-10 | a summary answer replaces the requested ids, so an omitted id loses its rating | 请求子集替换映射；未请求 key 绝不进入；零保持为零（陈旧评分片行为） | `verified`（2026-10-16 六文件运行） |
| RVD-LOG-11 | a page that does not carry reviewUrl falls back to the official page | 缺少 `reviewUrl` → 官方页 | `verified`（2026-10-16 六文件运行） |
| RVD-LOG-12 | an answer for another query cannot reach the list on screen | 已被放弃 query 的迟到答案 → 丢弃 | `verified`（2026-10-16 六文件运行） |
| RVD-LOG-13 | switching filter drops the old rows; retrying the same filter keeps them | 切筛选清空到 loading；同 key 重试保留行 | `verified`（2026-10-16 六文件运行） |
| RVD-LOG-14 | paging appends without repeating a row that moved between pages | 按 id 去重；到底时游标清空 | `verified`（2026-10-16 六文件运行） |
| RVD-LOG-15 | a failure keeps readable rows and only replaces an empty list | 后续页失败保留行；首页失败是错误状态 | `verified`（2026-10-16 六文件运行） |
| RVD-LOG-16 | a failure for a query that is no longer on screen is ignored | 陈旧失败 → 状态不变 | `verified`（2026-10-16 六文件运行） |

### 3.6 UI 源码契约 —— `plugin-reviews-surface.test.mjs`

| ID | 测试标题（逐字） | 预期断言 | 状态 |
| --- | --- | --- | --- |
| RVD-UI-01 | installed plugins keep their state groups and their disclosure | 分组顺序 `attention, updates, active, disabled`；`role="list"`；保留 details 披露 | `verified`（2026-10-16 六文件运行） |
| RVD-UI-02 | an installed card grows one call to action: update, then open panel | Update 按钮名出目标版本；仅启用+已声明时有面板；设置在启用+已声明之后；禁用卡片无主操作 | `verified`（2026-10-16 六文件运行） |
| RVD-UI-03 | installed and marketplace cards carry the rating chip in their metadata | `RatingChip` 位于既有 meta 行内；`ratingCount <= 0` 时隐藏 | `verified`（2026-10-16 六文件运行） |
| RVD-UI-04 | the installed card shows the trust glyph only from installed metadata | 盾牌来自已安装信任层级；没有“已验证安装”字样 | `verified`（2026-10-16 六文件运行） |
| RVD-UI-05 | the detail sheet puts the ratings summary between permissions and versions | 区块顺序 Permissions < Ratings & reviews < Versions；不可用文案；抽屉入口不依赖摘要（不可用入口行为） | `verified`（2026-10-16 六文件运行） |
| RVD-UI-06 | the review drawer mounts over the detail sheet without unmounting it | 同层、DOM 在后；绝对 z-index 1；打开时面板与遮罩 `inert` | `verified`（2026-10-16 六文件运行） |
| RVD-UI-07 | Escape closes the top drawer only and focus comes back to its opener | Escape 先于面板被消费；Tab 双向环绕；对话框焦点 + 回到打开者 | `verified`（2026-10-16 六文件运行） |
| RVD-UI-08 | the drawer is a read-only surface whose one write path is the centre page | 禁用的 scoped composer 字段；真实锚点；点击与中键经 `api.browserOpenExternal` 打开；失败 toast；无登录/投票/举报/`fetch` | `verified`（2026-10-16 六文件运行） |
| RVD-UI-09 | a review's version reads as self-reported, never as an installed version | `reviewVersion` 标签；没有裸 `v{version}` span | `verified`（2026-10-16 六文件运行） |
| RVD-UI-10 | the drawer filters, sorts, and pages with stale answers dropped | 情绪/排序组带 `aria-pressed`；游标 Load more；重试；`role="alert"`；含卸载在内的代数失效 | `verified`（2026-10-16 六文件运行） |
| RVD-UI-11 | every installed and marketplace id is batched without a tab refresh | 已安装+市场 id 的单个 `Set` → 一次摘要调用；成功经 `nextSummaryMap(ids, …)` 替换；失败 → 不可用，绝不为零 | `verified`（2026-10-16 六文件运行） |
| RVD-UI-12 | closing the detail closes the drawer with it | 抽屉 id 与选择一起清空 | `verified`（2026-10-16 六文件运行） |
| RVD-UI-13 | the review drawer keeps a real-Chromium user-path fixture | 夹具钉住抽屉探针——现为五个，含 `pluginReviewsBatchProbe` 与 `pluginReviewsNarrowDrawerProbe`（带 320×720 `setContentSize` 切换）；夹具驱动页面 hook、Tab/Escape、inert、写链接 | `verified`（2026-10-16 六文件运行 + 2026-10-17 探针） |
| RVD-UI-14 | the installed grid keeps a real-Chromium user-path fixture | 钉住已安装网格夹具与 fixture：`installedGridLayoutProbe`/`installedGridActionsProbe`、真实 `InstalledPluginsPanel` + `PluginDialogs`、作用域控件及其菜单（`scope-compact-trigger`、`scope-compact-menu.is-open`）、控制栏（`plugins-row-controls`）、操作路径（`marketInstall`、`disablePlugin`、`setPluginScope`）以及 340px 网格下限（`gridTemplateColumns`） | `verified`（2026-10-16 六文件运行） |

### 3.7 页面集成（取数语义）

| ID | 检查 | 预期 | 状态 |
| --- | --- | --- | --- |
| RVD-PAGE-01 | 快速输入下的摘要批量：稳定卡片来自最终 query，被扣留的早先答案不能覆盖它们 | `pluginReviewsBatchProbe`（顺序受控——第一个摘要答案被扣住，直到最终答案落地才放行；**不声称基于墙钟的防抖**）：稳定卡片恰为最终 query 的插件；新评分片读到 4.5（3）；最终批次未评分的插件没有评分片；最终批次请求的 id 等于展示的 id；放行被扣答案后新评分片不变且不出现陈旧评分片 | `verified`（2026-10-17 batch-stale-guard 探针） |
| RVD-PAGE-02 | 摘要失败被隔离 | 不可用状态；安装/更新绝不等待它 | `verified`（2026-10-16 六文件运行 / 抽屉探针） |
| RVD-PAGE-03 | 早于评论 API 的中心 | 不可用 —— 与零不同；不编造零 | `verified`（2026-10-16 六文件运行 / 抽屉探针） |
| RVD-PAGE-04 | 抽屉列表失败独立于摘要 | 抽屉重试自己的列表；禁用的 composer 与外部链接仍可达 | `verified`（2026-10-16 六文件运行 / 抽屉探针） |

### 3.8 Electron 夹具 E2E —— `scripts/e2e-plugin-reviews-drawer.mjs`

| ID | 探针（逐字） | 步骤 / 预期 | 状态 |
| --- | --- | --- | --- |
| RVD-E2E-01 | `pluginReviewsDrawerProbe` | 卡片评分片（`aria-label "Rated 4.5 out of 5 from 3 ratings"`、文本 `4.5 (3)`）→ 详情区块顺序 → 打开者滚动到可见 → 抽屉取得焦点，面板+遮罩 inert → Tab 陷阱双向环绕 → 第一页带“User-reported version v1.2.0” → Load more 追加 r1/r2/r3 并去重 → 被筛选切换甩开的慢“All”答案被丢弃 → Negative 失败显示错误 + 重试恢复 → 写链接 href 是 host URL；主键与中键打开；右键不打开 → 打开失败 toast → Escape 只关抽屉，焦点与面板滚动恢复 | `verified`（2026-10-16 六探针重跑） |
| RVD-E2E-02 | `pluginReviewsStaleSummaryProbe` | 一次摘要刷新若省略了某请求 id，则移除该插件陈旧评分片 | `verified`（2026-10-16 六探针重跑） |
| RVD-E2E-03 | `pluginReviewsUnavailableSummaryProbe` | 摘要读取失败 → 无评分片；详情显示“Ratings aren't available from this source.”且抽屉入口保留；抽屉重试状态、禁用 composer、官方回退链接；重试恢复列表且 host `reviewUrl` 取代回退 | `verified`（2026-10-16 六探针重跑） |

抽屉夹具运行五个探针：上述三个加上 `pluginReviewsBatchProbe`（RVD-PAGE-01）和
`pluginReviewsNarrowDrawerProbe`（RVD-NARROW-01，带 320×720 `useContentSize` 切换）。
完整运行：5/5 PASS。

### 3.9 已安装网格、详情焦点与已安装卡片夹具

| ID | 运行器 | 范围 / 预期 | 状态 |
| --- | --- | --- | --- |
| RVD-E2E-04 | `node scripts/e2e-installed-grid.mjs`（`scripts/e2e/installed-grid.tsx`），探针 `installedGridLayoutProbe` + `installedGridActionsProbe` | 真实 `InstalledPluginsPanel` + `PluginDialogs` 置于 1100×900 夹具窗口，只有 IPC 边界被伪造；七个插件（error、disabled-with-update、plain disabled、panel-only、settings-only、updater、long id）。布局探针 PASS：分组/成员/错误、控制栏顺序 + 禁用门控、披露、真实作用域菜单、评分片内联 + 长 id 截断、340px 网格下限 + 低于 340 的回退、窄屏控制栏换行。操作探针 PASS：update→permission→`marketInstall`(v1.2.3)、面板 id、设置面板开/关、溢出菜单自动更新 false + 卸载。报告 2/2 通过；最终重跑为准 | `verified`（2026-10-16 六探针重跑，2/2） |
| RVD-E2E-05 | `node scripts/e2e-plugin-detail-focus.mjs`（`scripts/e2e/plugin-detail-focus.tsx`） | 摘要读取返回 `{}` 时的详情面板焦点/滚动交互——面板行为独立于评论面 | `verified`（2026-10-16 六探针重跑） |

**已安装卡片真实组件夹具（已落地）。** 运行器 `scripts/e2e-installed-grid.mjs`，夹具
`scripts/e2e/installed-grid.tsx`，探针 `installedGridLayoutProbe`（分组、控制栏、披露、
作用域、meta、网格）与 `installedGridActionsProbe`（更新路径、面板、设置、行菜单）。
只有 IPC 边界被伪造；渲染器之外不安装任何东西。下表只陈述夹具断言的内容。

| ID | 用例 | 步骤 / 预期（由夹具断言） | 状态 |
| --- | --- | --- | --- |
| RVD-GRID-01 | 网格 —— 宽 | 在 1100px 宿主下，`.plugins-list` 计算列数 ≥2 且每列 ≥340−1px（340px 下限） | `verified`（2026-10-16 已安装网格布局探针） |
| RVD-GRID-02 | 网格 —— 窄 | 宿主强制为 300px：恰好一列且 ≤300px；网格无横向溢出（`scrollWidth <= clientWidth + 1`）；卡片右缘留在网格内 | `verified`（2026-10-16 已安装网格布局探针） |
| RVD-GRID-03 | 控件顺序 | updater 控制栏恰好 4 个：作用域控件 → 主操作“Update to v1.2.3” → 设置图标（`aria-label "Plugin settings"`）→ 菜单换行；panel-only 控制栏 3 个：作用域 → “Open panel” → 菜单；settings-only 控制栏 3 个且设置图标在第二位；每个禁用卡片：控制栏 2 个（作用域 + 菜单），无主操作、无设置图标、无面板操作 | `verified`（2026-10-16 已安装网格布局探针） |
| RVD-GRID-04 | 更新 CTA | 主按钮点击 → 权限对话框“Install Acme Updater?”并名出“v1.2.3” → 接受 → `marketInstall` 记录为 `{id:"acme.updater", version:"1.2.3", enable:true, autoUpdate:true}`；安装对话框让位 | `verified`（2026-10-16 已安装网格操作探针） |
| RVD-GRID-05 | 面板 CTA | panel-only 卡片上的“Open panel” → `openPluginPanel("acme.panel")`；禁用卡片不提供面板操作 | `verified`（2026-10-16 已安装网格操作探针） |
| RVD-GRID-06 | 设置 | 设置图标 → `.plugins-settings-modal` 标题“Acme Updater settings”；关闭控件消隐它 | `verified`（2026-10-16 已安装网格操作探针） |
| RVD-GRID-07 | 分组、成员、禁用态 | 七个夹具分四组：Needs attention 1（Acme Broken，错误文本“Manifest could not be read”）；Updates available 2（Acme Dormant、Acme Updater）；Active 3（Acme Panel、Acme Settings、Long Identifier）；Turned off 1（Acme Off）。禁用门控同 GRID-03 | `verified`（2026-10-16 已安装网格布局探针） |
| RVD-GRID-08 | 作用域 | 紧凑作用域触发器（第一个控件）打开 `.scope-compact-menu.is-open`，含 3 个 `role="menuitemradio"` 选项；“Off” → `disablePlugin("acme.updater")` 且菜单关闭；“Projects” → `setPluginScope("acme.updater", {mode:"projects", projects:[]})` | `verified`（2026-10-16 已安装网格布局探针） |
| RVD-GRID-09 | 行溢出菜单 | 触发器 `aria-label "Actions for Acme Updater"`：“Disable auto-update” → `setPluginAutoUpdate("acme.updater", false)`，菜单关闭；重开 → “Uninstall” → `uninstallPlugin("acme.updater")`。源码层面（未演练——未播种此类插件）：Reload 仅对 `source === "dev"` 出现，内置插件省略 Uninstall | `verified`（2026-10-16 已安装网格操作探针） |
| RVD-GRID-10 | 披露 | updater 的 `details.plugins-row-details` 初始关闭，点击摘要展开，其正文包含“Capabilities”；settings-only 卡片没有 details 区块 | `verified`（2026-10-16 已安装网格布局探针） |
| RVD-GRID-11 | 评分片几何 | 评分片位于 `.plugins-row-meta` 内（chipRect 在 metaRect ±1px 内——不换到独立行）；meta 行高 ≤24px；零摘要卡片不渲染评分片；长 id 卡片的 `.plugins-row-id` 截断（`scrollWidth > clientWidth + 8`）且留在卡片内。此处不断言有/无评分片之间的卡片高度差 | `verified`（2026-10-16 已安装网格布局探针） |

### 3.10 语言、无障碍、窄宽度、样式

| ID | 检查 | 预期 | 状态 |
| --- | --- | --- | --- |
| RVD-I18N-01 | 九种语言的评论字符串（`de,en,es,fr,ko,pt-BR,tr,zh-CN,zh-TW`） | 每种语言恰好一个嵌套 `reviews: {` 块以及全部七个键名（`summaryTitle`、`viewAll`、`composeHint`、`composeCta`、`reviewVersion`、`filterLabel`、`sortLabel`）；§2.5 检查对每种语言打印 `reviewsBlock=1 sevenKeys=7`；vitest 目录套件通过 | `verified`（目录 30/30 + shared 1272；语言对齐已复检） |
| RVD-A11Y-01 | 抽屉表面的可访问名称/状态 | `role="dialog"`、`aria-modal="true"`、有标签标题；筛选/排序 `aria-pressed`；列表标签；加载错误 `role="alert"`；星评 `role="img"` 带评分标签；Tab 陷阱 + inert；Escape 返回焦点 | `verified`（2026-10-16 六探针重跑） |
| RVD-NARROW-01 | 320×720 窄抽屉（真实几何） | 真实组件上的 `pluginReviewsNarrowDrawerProbe`，隐藏窗口调整为 320×720（`useContentSize`）：抽屉矩形完全在视口内；文档与抽屉主体无横向溢出；7+ 控件（4 个情绪、2 个排序、关闭、写链接）留在抽屉内；筛选/排序 `aria-pressed`；主体可滚动（`scrollTop > 0`）；composer 在视口内；写链接路由 `browserOpenExternal(REVIEW_URL)`；关闭后详情面板保留。夹具应用 `base.css` 以及仓库的 reduced-motion `animation: none`。**320 是唯一被断言的窄宽度** —— 375 仅由探针的 `<= 375` 守卫覆盖，不另跑一次 | `verified`（2026-10-17 narrow-drawer 探针） |
| RVD-STYLE-01 | `plugins-page-style.test.mjs` —— “review surfaces use design tokens in both themes” | 评分片使用等宽数字；摘要用 `--plugins-tile`；遮罩用 `--ds-modal-veil`；抽屉预留 `--ds-toolbar-height`；composer 字段用 token；写链接有样式 | `verified`（2026-10-16 六文件运行） |

### 3.11 非干扰不变式

| ID | 检查 | 预期 | 状态 |
| --- | --- | --- | --- |
| RVD-REL-01 | 中心宕机 / 旧中心绝不影响安装、更新或插件操作 | 评论读取独立失败；摘要/列表读取失败时已安装网格与市场操作仍可用 | `verified`（探针 + 定向测试证据，2026-10-16） |
| RVD-REL-02 | 评论不使用渲染器网络或认证 | 只有 host RPC 通道；抽屉中无 `fetch`；`browserOpenExternal` 是唯一外部导航，且仅用 host URL | `verified`（探针 + 定向测试证据，2026-10-16） |
| RVD-REL-03 | URL 信任 | 不根据包或评论内容派生 URL；`reviewUrl` 只来自生效可信 origin（含夹具覆盖） | `verified`（探针 + 定向测试证据，2026-10-16） |

## 4. 最终证据摘要

以下行为行全部在冻结源码上闭合；§5 的执行记录承载工件。

| 行为 | 用例 |
| --- | --- |
| 保留不可用入口（抽屉入口、重试、外部链接） | 探针 2026-10-16 验证（RVD-E2E-03）；RVD-UI-05 在六文件运行中验证；RVD-PAGE-04 验证（抽屉失败独立性由探针钉住） |
| 陈旧评分片省略即移除评分片 | 探针 2026-10-16 验证（RVD-E2E-02）；RVD-LOG-10 / RVD-UI-11 在六文件运行中验证 |
| 桥接加固：响应身份、拒绝重定向、时间边界 | 已验证 —— 加固后 22 个 Rust 测试（16 RPC + 6 客户端单元）通过，此后 Rust 源码未再改动（`host-core-after-hardening.txt`） |
| 已安装卡片真实组件夹具 | 2026-10-16 验证（RVD-E2E-04 + RVD-GRID-01 … RVD-GRID-11）；RVD-UI-14 在六文件运行中验证 |

## 5. 最终执行记录（本次运行）

本次运行的本地执行环境：Windows / PowerShell；隔离的 Electron 夹具配置档位于
`.cache/` 下；每行记录 worktree 修订。以下结果是最终记录的执行；每行引用其证据工件。
源码已冻结；两处人工几何/行为检查仍单独列为人工项，与自动化证据分开。

本次运行的有日期的结果：**2026-10-16/17，coordinator 验证** —— 六个文件中的 64 个定向
JS 测试与八个 Electron 探针（5 个抽屉 + 2 个已安装网格 + 1 个详情焦点）在当前精确源码上
全部通过；完整桌面 typecheck 与生产 `electron-vite` 构建退出码 0（main/preload/renderer
均已构建）。跨主机契约检查（零 9/9、非零 11/11）已被独立阅读并接受。本轮不再预期桌面
生产代码改动；本计划是唯一剩余的易变工件。

| # | 命令 / 路径 | 状态 | 记录的证据 | 备注 |
| --- | --- | --- | --- | --- |
| 1 | `node --test … market-review-ipc / plugin-reviews-logic / plugin-reviews-surface / plugins-page-style / extensions-page / settings-dialog-overlay …` | verified | 2026-10-16 coordinator 定向六文件运行：64/64 通过（shell 输出） | 按文件：IPC 6、logic 16、surface 14、style 8、extensions 16、overlay host 套件 4。归档日志时请对照当次 shell 输出确认 overlay 文件名 |
| 2 | `cargo test -p host-core --bin pi-desktop-host-core review` | verified | 加固后 22 个 Rust 测试（16 RPC + 6 客户端单元）通过；此后 Rust 源码未变（`host-core-after-hardening.txt`） | 接受既有证据 —— 不做无谓重跑 |
| 3 | `cargo fmt --check` / `cargo clippy -p host-core --all-targets` | verified | fmt 干净；clippy 退出码 0（`clippy-after-hardening.txt`） | `transcripts.rs:893` 有已知无关 warn |
| 4 | `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`（desktop） | verified | 2026-10-16 在 F7/F8 代码上最终重跑：退出码 0（`plugin-reviews-desktop-finalbuild.log`） | 完整桌面 typecheck 通过 |
| 5 | `node node_modules/electron-vite/bin/electron-vite.js build`（desktop） | verified | 2026-10-16 在 F7/F8 代码上最终重跑：退出码 0（`plugin-reviews-desktop-finalbuild.log`） | main/preload/renderer 已构建；只有既有的超大 chunk 警告 |
| 6 | `node scripts/e2e-plugin-reviews-drawer.mjs` | verified | 2026-10-17：抽屉夹具 5/5 PASS，退出码 0（含 batch-stale-guard 与 narrow-drawer 探针） | Electron 探针总数现为 8（5 抽屉 + 2 网格 + 1 详情焦点）；取代更早的 3 探针抽屉运行 |
| 7 | `node scripts/e2e-installed-grid.mjs`（`installedGridLayoutProbe` + `installedGridActionsProbe`） | verified | 2026-10-16 coordinator 六探针重跑（退出码 0） | 已安装网格 2/2；承载 RVD-GRID-01 … 11 |
| 8 | `node scripts/e2e-plugin-detail-focus.mjs` | verified | 2026-10-16 coordinator 六探针重跑（退出码 0） | 详情焦点通过 |
| 9 | i18n §2.5 检查 + vitest 目录套件 | verified | 目录套件 30/30 与 shared 1272 通过（更早记录）；`reviewsBlock=1 sevenKeys=7` 已在当前源码上对九种语言机械复检 | 各语言都存在评论键；不做 UI 重跑 |
| 10 | `cargo test -p host-core --bin pi-desktop-host-core`（完整） | executed; baseline failures | 912 通过 / 38 `baseline:fail` / 1 忽略（`host-core-after-hardening.txt`） | 仅环境性失败；非绿色套件 |
| 11 | 窄窗口检查 | verified | `pluginReviewsNarrowDrawerProbe` 于 320×720（2026-10-17）：无溢出、控件在内、主体可滚动、composer 在内、链接路由、关闭后保留面板。已安装网格窄屏由 300px 探针单独覆盖（RVD-GRID-02） | 320 是唯一被断言的窄宽度；375 仅有 `<= 375` 守卫 |
| 12 | 跨主机契约检查（host stdio RPC → 真实中心） | verified | 2026-10-16 —— 零运行 9/9 + 非零运行 11/11，已被独立阅读并接受 | 同一个 host 二进制（未重建）；非零种子经中心真实写 API 播种；尽管有一个举报夹具，公开行不含私有字段。补充但不替代加固后通过的定向 RVD-RPC-01…16 测试（第 2 行） |
| 13 | 最终 oracle 门 | PASS | 八个已知发现全部在冻结源码上闭合；不再预期生产修复 | 覆盖两份计划的跨仓库门 |

## 6. 变更控制

- 本文档是仓库交付物；更正只落在本文档。
- 最终结果记录在 §5，相关用例行就地更新。
- 不得从本计划发起提交、推送、打标签或打包。
