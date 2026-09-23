# 13. 模型目录及选择

> **翻译说明：** 本页是与 [英文源规格](/spec/03-runtime/13-model-catalog-and-selection) 一一对应的机器辅助翻译。代码、协议字段和标识符保持原文；如翻译与英文源事实有歧义，以英文版本为准。


## 1. 产品规则

用户必须能够广泛使用**市场上可用的模型**，而不仅仅是精选的演示子集。

因此：

1.目录可刷新
2. 始终允许自定义模型 ID
3.兼容OpenAI的网关是一流的
4. 搜索是跨启用的提供商的全局搜索

## 2. 选择用户体验

### 模型选择器字段
- 搜索框
- 提供商过滤器
- 能力过滤器：工具/愿景/推理
- 排序：最近/提供商/名称

### 设置：一个提供商表单

`ProviderSetupDialog` 是单页表单，不是向导。模型区列出服务返回的结果：

- 列表标题旁的全选复选框一次勾选或取消当前可见行。搜索过滤时，“全部”只作用于匹配行；过滤外已选模型保持不变。已选绑定保留高级覆盖；新勾选的行采用 `bindingFromModelInfo` 或自定义模型默认值。可见行全部选中时为勾选，全部未选时为空，部分选中时为不确定态。
- 同一标题旁的「获取列表」会立刻向服务探测，跳过 600 ms 编辑防抖和先画缓存。没有可探测端点、正在探测或表单保存时不可用；空闲但端点已有效（防抖等待）时仍可点，以便跳过该窗口。加载期间保留现有行。凭据变更触发的自动发现不变。

### 设置：已选模型顺序

AI 服务和 OAuth 厂商账户编辑器共用已选模型面板。每个已选行都有独立的排序手柄：
可拖到另一个可见行之前或之后，也可让手柄获得焦点，按上、下方向键越过相邻的可见行。
表单忙碌或可见已选行不足两个时禁用排序。拖选文本仍用于复制；复选框、高级和移除操作
保持原有行为，不会开始排序。

完整的 `models` 绑定数组决定顺序。过滤只隐藏行：移动时在完整数组中，将原绑定插入
可见目标之前或之后，保留隐藏绑定及其相对顺序。模型 ID、别名和高级覆盖设置随绑定
一起移动。取消拖动或在已选行之外释放，不会更改草稿。

保存通过现有提供商更新流程持久化新顺序，重新打开任一编辑器时会再次显示该顺序。
取消编辑器会丢弃未保存的排序。提供商的兼容字段 `defaultModelId` 仍在保存时反映
首个绑定，因此将模型移至首位会改变该提供商的默认模型。编辑的服务或账户是应用
默认提供商时，保存还会按现有流程将应用级默认模型同步为首个绑定。编辑其他提供商
不会改变应用默认值，明确绑定模型的会话也会保留其已存储的模型选择。新增提供商同样不会
改写这两个应用默认值：默认模型，以及新服务带来图片模型时的默认画图模型，只有在应用
当前没有可解析的选择时（未设置，或其提供商或模型已不存在）才会落到新服务上；用户仍
能运行的默认值会一直保留，直到用户自己改。无需修改存储结构或 IPC 合约。

### 物品显示
- 模型显示名称
- 模型 ID
- 提供商名称
- 能力徽章
- 可选的上下文窗口
- 上限值与用量计数经同一个紧凑格式化函数（`formatCompactTokenCount`）渲染：
  `M` 量级最多两位小数、`K` 量级一位小数，去掉末尾零；`K` 尾数若进位到 1000
  则提升到 `M` 量级。1M 附近的已发布窗口因此保持可区分（1000000 显示 `1M`，
  1048576 与 1050000 显示 `1.05M`，1100000 显示 `1.1M`），不会塌缩成同一个
  `1M`/`1.1M`；服务未发布的上限显示为破折号，用量计数则保留真实的 `0`。
  设置行、Composer 选择器、上下文检查器和聊天记录共用这一份实现。

### 子智能体编辑器

子智能体新建/编辑表单复用 Composer 已提供的已配置、可运行模型（已启用且持有凭据，
或 `authKind: none` 的提供商）。
控件是锚定在触发器上的可搜索、按提供商分组的菜单，而不是原生 `<select>`：
定义可以钉住任意已配置模型，列表因此可能长达数十行，
只有锚定浮层能在自身内部滚动并接受过滤。沿用会话为空值，
选项为按提供商显示名分组的 `vendorKey-or-name/modelId`，
不再配置中的固定值仍作为额外行保留，以免编辑时被悄悄丢掉。
每个选项都来自已配置的提供商目录，因此保存的值总能被解析；
表单不提供手填模型 ID 的入口，当没有任何提供商提供可运行模型时，
改为显示带操作按钮的空态（直接打开模型设置），而不是手填输入框。
pin 中只有斜杠是结构性字符：提供商部分按归一化别名匹配，
自定义端点的显示名可以包含空格，因此选择器与草稿校验共用同一个拆分函数，
不会出现「选得到却存不下」的分歧。
多个提供商使用通用或重复的厂商标识时，选项会改用唯一的提供商显示名；如果显示名也重复，
则使用已存储的提供商 ID，确保每个已配置提供商都不会从选择器中消失。
思考选择器提供沿用会话（空值）、不发送（do-not-send）以及七个规范档位；
沿用会话保持会话级别，不发送持久化为 `thinkingLevel: omit`，不改写提供商适配器自己的默认值。

### 高级
- “使用自定义模型 ID”
- “刷新目录”

## 3. 最新模型

保留最近选择的模型参考：

```ts
type RecentModelRef = {
  providerId: string
  modelId: string
  usedAt: string
}
```

在选择器中显示前 N 个。

## 4. 会话模型绑定

每个会话存储：

- `providerId`
- `modelId`
- `thinkingLevel`（`off|minimal|low|medium|high|xhigh|max|omit`）

在会话中改变模型或思维水平只会影响后续回合。
存储的思维偏好在重启后仍然存在；有效请求级别
在执行时对所选模型绑定的已启用档位钳位，但 `omit` 在推理模型上保留，
且不发送思考覆盖。

对于新创建的会话，渲染器会解析所选（或应用默认）模型的 `ModelBinding`。
具有推理能力的模型始于该绑定的 `defaultThinkingLevel`（`omit` 保留；其它值
钳位到已启用档位）；当默认值未设置时，才回落到已发布
`supportedThinkingLevels` 中的最高已启用档。非推理模型或缺失的能力元数据从
`off` 开始。这是一个仅创建时的默认值，绝不会重写现有会话的存储选择。

未固定的会话仍在 list/get/create/fork/configure 上展示该继承默认模型的
推理能力；丰富步骤不会写入 `providerId`/`modelId`。桌面创建会话时会把当时的
应用默认（或 Composer 草稿覆盖）写入持久化 id。之后改默认模型不会改写已创建
会话。打开仍为空 id 的旧行时，会快照最近一次使用的模型，否则快照当前默认，
从而不再跟随设置。当所选目录/绑定模型暴露了思考等级时，Composer 不得把
`supportsReasoning: false` 或空等级列表当作权威快照，因此回合中改档不会把
菜单塌缩成只剩关闭思考。

## 5. 能力警告

如果用户在 Agent 模式下选择不带工具标记的模型：

- 显示非阻塞警告
- 不要硬阻止（供应商标签可能不完整）

## 6. 刷新行为

随应用打包的 `apps/desktop/resources/models.dev/api.json` 快照是启动基线。
`scripts/release.mjs` 在创建发布标签前更新该快照；应用启动不会请求或写入目录。
设置页通过 Electron 专用的 `providers.refreshModelCatalog` 通道重新获取
`https://models.dev/api.json`；成功响应只替换当前进程内存中的 models.dev
目录，不会写入用户数据。

重复的元数据查询使用容量有界的进程内缓存，键由配置的厂商键、基础 URL 和
去除首尾空白且不区分大小写的模型 ID 组成。匹配和未匹配结果都会缓存，原有的
提供商偏好、别名匹配和候选排序保持不变。成功加载打包快照或在设置中刷新并
替换目录后，缓存失效；刷新失败则保留之前的目录及查询结果。补全会话能力时，
每个会话只解析一次匹配的目录记录，再应用当前提供商/模型绑定和会话默认值，
因此用户覆盖值不会作为过期能力留在缓存中。刷新大型会话列表时，同样的查询
不能在每次出现时都重新扫描完整目录。

提供商模型加载仍采用 stale-while-revalidate：

1. `source: "cache"` 从 Rust 拥有的 SQLite 读取已保存提供商的规范化发现记录，
   不访问提供商网络。
2. 渲染器可以立即在 Composer 和提供商对话框中显示这些记录。
3. `source: "refresh"` 优先使用打包或内存中的 models.dev 目录，只有需要发现
   models.dev 未提供的模型 ID 时才探测提供商端点。
4. 成功的提供商发现可以更新 Rust 拥有的规范化缓存，但不能替换匹配的
   models.dev 记录或其元数据。
5. 发现结果不完整或不可用时，保留已配置的 `ModelBinding` ID；models.dev
   中不存在的 ID 使用通用元数据。

## 7. 线下行为

如果刷新失败/离线：

- 使用缓存目录
- 永远不要清除已渲染的缓存列表或闪烁空选择器
- 允许自定义模型ID
- 仍然允许具有已知模型 ID 的提供商

## 8. 目录项架构

```ts
type ModelCatalogItem = {
  providerId: string
  vendorKey: string
  modelId: string
  displayName: string
  source: "bundled" | "discovered" | "user" | "recent"
  capabilities: Array<
    | "tools"
    | "vision"
    | "reasoning"
    | "streaming"
    | "json"
    | "long_context"
  >
  contextWindow?: number
  maxOutputTokens?: number
  deprecated?: boolean
  notes?: string
  supportedThinkingLevels?: Array<
    "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
  >
}
```

## 9. 选择解析顺序

当 UI/search 请求选取器模型时：

1. 启用提供商的最新模型
2. 用户自定义模型
3.discovered/refreshed缓存
4. 捆绑快照
5. 始终包含“自定义模型 ID”输入操作

通过 `(providerId, modelId)` 优先进行重复数据删除：
`user > discovered > bundled > recent-only`。

### 9.1 对话 Composer 范围

对话 Composer 是已配置模型选择器，而不是原始发现目录。对于每个已启用且
可运行的提供商，它只渲染该提供商持久化 `models` 绑定中的模型 ID（或旧版
`defaultModelId` 回退值）。缓存或实时发现的记录可以为这些行补充显示名称和
元数据，但未配置的发现模型不会出现在对话区列表中。发现不可用时，已配置的
模型 ID 仍会单独显示。

设置中的提供商对话框仍使用发现结果添加和配置模型；保存模型绑定后，该模型才
有资格出现在 Composer 中。

组合 Composer 菜单打开时，渲染器会在进入“模型”子菜单前开始加载提供商模型。
因此首个可见行优先来自缓存目录或已配置绑定，实时发现仍在后台更新。非空的已配置
别名会根据等价模型 ID 从绑定中解析，并在目录刷新期间保持为唯一可见的模型名称。

## 10. 默认模型策略

应用级默认模型选择器按已配置模型列出厂商下的每个模型；选择条目会同时保存所属厂商和准确的模型 ID。
选择器支持按厂商名称和模型 ID 本地搜索；结果列表在浮层内滚动，没有匹配项时显示明确的空状态。
选择器使用简洁的设置专用搜索文案；每项优先显示模型 ID，厂商名称作为次要信息。
结果按厂商分组，每组只显示一次厂商名称，不在每个模型行重复。

应用程序级默认值：
- 第一个成功测试的提供商 + 其 default/recommended 模型
- 如果未配置，则新手引导清单需要在第一个代理运行之前设置提供商

会话级别：
- 创建时继承应用默认，并写入该 `providerId`/`modelId`
- 之后改设置里的默认模型只作用于新会话和未持久化的首页草稿，不改已创建会话
- 将思维初始化到所选模型绑定的默认思考等级（钳位到已启用档；
  未设置时才回落最高已启用档），当它支持推理时，否则 `off`
- 可以独立覆盖

## 11. 能力门控

| mode/feature | 所需能力 |
|---|---|
| Agent 模式工具 | `tools`（如果丢失则发出警告；仅当运行时无法运行时才硬块） |
| 图像输入 | `vision` |
| 推理 UI 可供性 | `reasoning` |
| 结构化修复助手 | `json` 可选 |

除非不可能执行，否则警告是非阻塞的。

### 11. 1 推理能力解析

1. 解析 pi 目录元数据以获得确切的 `(vendorKey, modelId)` 或
   分隔符限制的兼容网关别名。
2、完整的pi模型记录，权威； cached/discovered 模型
   功能和遗留提供程序覆盖不能取代其推理
   旗帜或思维层面的地图。
3. pi 中不存在的自由格式 id 是未知的通用模型，并且仅公开
   `off`； UI 无法将其提升为具有推理能力。
4. 仅当解析的 pi 模型支持时，Composer 才会渲染选择器
   推理并仅列出已解析的 `supportedThinkingLevels`。
5. 如果 stored/requested 级别不可用，请选择最近支持的级别
通过先向上然后向下扫描来调整水平。非推理模型
   始终解析为 `off`。
6. 更改为非推理提供商仍然存在 `off`；没有不支持的级别
   泄漏到下一个请求中。

### 11.2 目录元数据的模型 ID 匹配

目录补全使用 `catalogModelIdsMatch`，不使用解析已配置绑定身份的共享
`modelIdsMatch`。绑定身份接受不区分大小写的完整 ID、完整斜杠路径后缀、
已知厂商的 `-`/`.` 前缀，以及仅有一侧带 `@region` 的别名；两个不同地区、
任意路由前缀或思考/端点后缀不会合并为同一绑定。
元数据查询还可以匹配 `proxy/` 或 `custom/` 等通用路由下的完整裸叶子 ID，
但必须避免已知厂商冲突；两个不同的完整路由路径不会仅因叶子相同而匹配。
它只会剥离末尾以 `-` 或 `:` 分隔的 `thinking`、
`think`、`agent`、`latest`（也可在 `@region` 之前），不会剥离任意短横线代理
前缀或 `low`、`high`、`max` 等 effort 后缀。目录索引用这些别名生成有界
候选键，再由匹配器确认；若厂商键或 API URL 已选中已知目录提供商，
查询仅限该提供商，不能借用别家能力。
这些别名只用于附加已发布的元数据，不改变配置的请求模型 ID，后缀本身也
不证明模型有推理能力。未命中的自由格式 ID 仍是无推断能力的未知通用模型；
只有已发布的记录或显式绑定设置可提供能力。

## 12. 刷新策略

- settings/model 选择器中的手动刷新按钮
- 提供商 create/test 成功后的可选刷新
- MVP 中没有激进的背景轮询
- 刷新失败保留以前的缓存并显示非致命错误

Electron 使用本地 `models.dev` 记录装饰缓存和新发现的模型行。其
`contextWindow` 与 agent sidecar 共享同一套 effective 解析；提供商发现只
为目录缺失的模型提供 ID，未知模型仍使用通用后备。

上下文窗口解析必须与 agent runtime 使用同一个 effective window。每个 binding 记录
自己的 `contextWindow` 从哪来（`contextWindowSource`）：

- `catalog`——该值是 models.dev 快照，之后目录修正 `limit.context` 时会跟着更新，
  所以 `gpt-5.6-luna`（`1,050,000`）这类记录不会再显示为 128k，被修正上限的模型
  也不用删掉重建；
- `user`——该值来自 Advanced 里的手改（含预设档位），任何目录修正都不会覆盖它，
  包括手改的 `128,000`。

在标记出现之前保存的 binding 没有来源标记，它们按确定的历史规则解析：已发布的
`limit.context` 只替换恰好等于 128,000 的通用种子，其余值一律按显式值保留；未知模型
仍保守使用 128k，不能仅凭 ID 猜测。标记在持久化记录中是可选的，旧版本写出的配置
仍可读，降级版本会忽略它。

## 13. 搜索行为

- displayName、modelId、提供商名称、vendorKey 上不区分大小写的匹配
- 能力过滤器是 AND
- 提供商过滤器是精确的providerId
- 空查询首先显示最近的内容 + popular/bundled

## 14. 验收标准

- [ ] 搜索可查找跨多个提供商的模型
- [ ] 两个编辑器都可通过拖动手柄或上、下方向键调整已选模型顺序；保存后重新打开会
      保留顺序、别名和覆盖设置，过滤后的移动会保留隐藏绑定及其顺序
- [ ] 取消拖动或取消编辑器会保留相应的原顺序；表单忙碌时禁用排序，文本复制和行操作
      仍正常工作
- [ ] 自定义模型 ID 路径无需目录命中即可工作
- [ ] 最近的模型出现在选择器中
- [ ] 刷新合并到缓存和选择器中（绝不破坏性替换）
- [ ] 重新启动会在实时刷新和离线之前水合先前的目录
      刷新使缓存的选择器保持填充状态
- [ ] 能力徽章可见
- [ ] 会话模型更改仅适用于下一回合
- [ ] 新会话将具有推理能力的继承模型默认为该绑定存储的默认
      思考等级（钳位到已启用档；未设置时才用最高已启用档），否则默认为 `off`
- [ ] 推理选择器是能力门控和 pi 发布的稀疏级别
      在 Composer、Electron main 和 pi sidecar 中以相同的方式设置钳位
- [ ] 提供程序设置和缓存发现无法覆盖已知的 pi 模型
- [ ] 未知的自由形式模型在没有发明功能的情况下仍然可以运行
- [ ] 固定 pi-ai ^0.82.1+ 将 `claude-opus-5`（和网关兼容的别名）解析为已发布的 1M 上下文自适应思维记录，无需桌面覆盖
- [ ] 目录修正的模型上限会回流到已保存的 `catalog` 绑定，无需删除重建；用户在
      Advanced 手改的值（`user`）在任何修正下都不被覆盖，包括手改的 `128,000`
- [ ] 没有来源标记的旧 binding 按确定规则解析：128k 通用种子跟随目录，其余值保持原样
- [ ] 来源标记能在提供商保存/读取往返后保留，未标记记录仍可正常使用
- [ ] 紧凑上限文本不会高于已发布值，1M 附近的相邻窗口保持可区分
      （`1M` / `1.05M` / `1.1M`），且永远不会渲染出大于等于 1000 的 `K` 尾数

### StepFun Step 5 Preview

The service picker exposes only StepFun Plan for StepFun, selecting
`https://api.stepfun.com/step_plan/v1` and Chat Completions. Ordinary API
services remain usable as custom configurations; existing saved endpoints
are never rewritten or relabelled as subscription services.
Discovery still determines which models the key can use. For exactly
`step-5-preview` at the plan endpoint or a saved ordinary API endpoint, a reviewed first-party metadata supplement
provides a 1,024,000-token context/input window, a conservative 64,000-token
output cap, image and tool support, and low/medium/high reasoning when the
first-party models.dev record is absent. Third-party catalog records do not
override that supplement. A first-party record supersedes it after refresh.

The metadata source is `provider`, distinct from `models.dev`; user binding
overrides keep their existing precedence. Other endpoints and model IDs are
unchanged. The desktop does not add video attachment transport. See ADR
`stepfun-first-party-model-metadata` and the StepFun setup guide.

## 生图模型绑定

默认对话模型下方有独立的生图模型行。模型高级设置可指定唯一绑定；保存服务商表单才生效，取消丢弃选择，替换不会改变对话默认值。工具和批量合约见[图片生成与编辑](/zh-CN/spec/03-runtime/21-image-generation)。
