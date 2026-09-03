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

### 物品显示
- 模型显示名称
- 模型 ID
- 提供商名称
- 能力徽章
- 可选的上下文窗口

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
- `thinkingLevel`（`off|minimal|low|medium|high|xhigh|max`）

在会话中改变模型或思维水平只会影响后续回合。
存储的思维偏好在重启后仍然存在；有效请求级别
在执行时对所选模型进行能力限制。

对于新创建的会话，渲染器会解析应用程序默认提供程序的
当前的默认模型功能。具有推理能力的模型始于
其已发布的 `supportedThinkingLevels` 中的最高规范级别；一个
非推理模型或缺失的能力元数据从 `off` 开始。这是一个
仅创建默认值，绝不会重写现有会话的存储选择。

## 5. 能力警告

如果用户在 Agent 模式下选择不带工具标记的模型：

- 显示非阻塞警告
- 不要硬阻止（供应商标签可能不完整）

## 6. 刷新行为

`providers.refreshModels`：

1. 查询运行时支持的发现端点
2.合并到目录缓存中
3.保留用户定义的模型
4. 返回计数：added/updated/failed 提供商

桌面对配置的提供程序使用 stale-while-revalidate：

1. 在 Rust 拥有的 SQLite 期间，对每个保存的提供商的最新目录进行水合
   渲染器引导程序
2. 立即在输入框选择器和保存的提供程序中渲染该目录
   编辑对话框
3. 每个渲染器生命周期内每个提供程序最多执行一次实时刷新
4. 将成功的响应合并到 SQLite 中并替换渲染器快照
5. 在提供程序配置更改后重置渲染器刷新标记
   下一个打开的选择器将重新验证端点

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

## 10. 默认模型策略

应用级默认模型选择器按已配置模型列出厂商下的每个模型；选择条目会同时保存所属厂商和准确的模型 ID。
选择器支持按厂商名称和模型 ID 本地搜索；结果列表在浮层内滚动，没有匹配项时显示明确的空状态。
选择器使用简洁的设置专用搜索文案；每项优先显示模型 ID，厂商名称作为次要信息。
结果按厂商分组，每组只显示一次厂商名称，不在每个模型行重复。

应用程序级默认值：
- 第一个成功测试的提供商 + 其 default/recommended 模型
- 如果未配置，则新手引导清单需要在第一个代理运行之前设置提供商

会话级别：
- 继承应用程序创建时的默认设置
- 将思维初始化到继承模型发布的最高水平
  当它支持推理时，否则 `off`
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

## 12. 刷新策略

- settings/model 选择器中的手动刷新按钮
- 提供商 create/test 成功后的可选刷新
- MVP 中没有激进的背景轮询
- 刷新失败保留以前的缓存并显示非致命错误

Electron 使用本地 `models.dev` 记录装饰缓存和新发现的模型行。其
`contextWindow` 与 agent sidecar 共享同一套 effective 解析；提供商发现只
为目录缺失的模型提供 ID，未知模型仍使用通用后备。

上下文窗口解析必须与 agent runtime 使用同一个 effective window：已发布的
`models.dev limit.context` 会替换旧 binding 中遗留的 128k 通用种子，因此
`gpt-5.6-luna` 这类 1m 级模型不会再显示为 128k。用户在 Advanced 中输入的
非默认值仍是明确的按模型覆盖；未知模型仍保守使用 128k，不能仅凭 ID 猜测。

## 13. 搜索行为

- displayName、modelId、提供商名称、vendorKey 上不区分大小写的匹配
- 能力过滤器是 AND
- 提供商过滤器是精确的providerId
- 空查询首先显示最近的内容 + popular/bundled

## 14. 验收标准

- [ ] 搜索可查找跨多个提供商的模型
- [ ] 自定义模型 ID 路径无需目录命中即可工作
- [ ] 最近的模型出现在选择器中
- [ ] 刷新合并到缓存和选择器中（绝不破坏性替换）
- [ ] 重新启动会在实时刷新和离线之前水合先前的目录
      刷新使缓存的选择器保持填充状态
- [ ] 能力徽章可见
- [ ] 会话模型更改仅适用于下一回合
- [ ] 新会话将具有推理能力的继承模型默认为最高
      已发布的思维水平，否则默认为 `off`
- [ ] 推理选择器是能力门控和 pi 发布的稀疏级别
      在 Composer、Electron main 和 pi sidecar 中以相同的方式设置钳位
- [ ] 提供程序设置和缓存发现无法覆盖已知的 pi 模型
- [ ] 未知的自由形式模型在没有发明功能的情况下仍然可以运行
- [ ] 固定 pi-ai ^0.82.1+ 将 `claude-opus-5`（和网关兼容的别名）解析为已发布的 1M 上下文自适应思维记录，无需桌面覆盖
