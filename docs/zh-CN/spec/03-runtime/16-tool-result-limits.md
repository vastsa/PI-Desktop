# 16. 工具结果限制和截断

> **翻译说明：** 本页是与 [英文源规格](/spec/03-runtime/16-tool-result-limits) 一一对应的机器辅助翻译。代码、协议字段和标识符保持原文；如翻译与英文源事实有歧义，以英文版本为准。


## 1. Goal

通过限制工具输出来保持代理上下文健康和 UI 响应，而不会造成静默数据损坏。

## 2. 默认限制

预算是按工具类别计算的，而不是一个共享上限。单个 256KB 上限控制
在实践中，一切都意味着没有上限：测量的会话平均每次 154KB
`Read` 并将整个上下文的 56% 花在 read/search 结果上，其中
强制压实并使代理重新搜索已经发现的内容。

Read/Glob/Grep 获得更严格的预算，因为他们的结果可以在
需求（缩小格局，提前偏移）； shell 输出不是。

Bash 输出通过了两个独立的上限。 **捕获**层限制了什么
主机在进程流式传输时保留在内存中，这就是溢出文件
是写自。 **结果**预算限制了达到模型的内容。捕获是
故意选择两者中较宽松的一个：如果它符合结果预算，则溢出
副本永远不会比它所支持的摘录更完整。

| 频道 | 限制 | 超过时采取行动 |
|---|---|---|
| 读取/Glob/Grep 结果 (`BUDGET_SEARCH`) | 48 KB，2000 行 | 绑定窗口 + `notice` 命名下一步 |
| Bash 标准输出 (`BUDGET_SHELL`) | 96 KB，4000 行，头 | 截断+标记+溢出 |
| Bash stderr (`BUDGET_SHELL_ERR`) | 96 KB，4000 行，**尾部** | 截断+标记+溢出 |
| 任何单行 (`MAX_LINE_CHARS`) | 2000 个字符 | 剪辑，在 `notice` 中计数 |
| 阅读窗口 | 默认2000行，`BUDGET_SEARCH`/`notice` | 分页；从不拒绝文件大小 |
| Grep 匹配 (`headLimit`) | 默认200 | 以 `truncated: true` 停止 |
| 全局条目 (`limit`) | 默认 100 个，最大 1000 个 | 以 `truncated: true` 停止 |
| Bash 捕获保留 (`CAPTURE_MAX_BYTES` / `CAPTURE_MAX_LINES`) | 512 KB，200000 行 | 停止保留；报告遗漏的字节和行 |
| 溢出的完整输出（`SPILL_MAX_BYTES`） | 512 KB | 停止保留；标记仍然命名该文件 |
| Bash 输出流 | 每个流序列 | 保留 stdout/stderr 分离 |
| 重击超时 | 默认60秒； 1–300 秒覆盖 | 杀死进程树+错误 |
| `Edit.ops` 负载 | 256 KB，200 个操作 | `INVALID_ARGUMENT`；更多 Edit 上限见 [18](/zh-CN/spec/03-runtime/18-line-anchored-edit-contract) §12 |

被剪辑的行不是已显示的行。`Read` 会把每一条在 `MAX_LINE_CHARS` 处剪断的行
从 `Edit` 契约校验所用的来源集中排除
（[18-line-anchored-edit-contract](/zh-CN/spec/03-runtime/18-line-anchored-edit-contract) §4.3），
因此压缩或生成的行必须先被收窄到可见范围内才能编辑。剪辑因此同时限制
上下文**并**阻止对被剪断部分的盲写，而不是只做到前者。

限制由主机强制执行。 `builtin_tool_defs()` 中的工具描述包含
逐字数字和范围参数：这个工具看起来无法
作用域事物通过 Bash 和手动 shell 管道进行路由
首先是耗尽上下文的内容。

读取从不拒绝文件大小。前一个 >512KB 拒绝告诉模型
“使用 Grep 或 Bash 对其进行采样”，这正是未分页读取的方式
Goal/`Read` 管道，其输出不受限制。

## 3. 截断标记格式

已实现的标记 (host-core `truncate_to`)，附加用于头部切割和
预先进行尾部切割：

```text
[truncated: kept the first 4000 of 51234 lines; limit 4000 lines / 96KB. Full output saved to <path> — Grep it, or Read it with offset/limit.]
[truncated: kept the last 1200 of 51234 lines; limit 4000 lines / 96KB. Narrow the request to see more.]
[truncated: no complete line fits the 96KB limit; kept 98304 bytes of a single 4200000-byte line. Full output saved to <path> — Grep it, or Read it with offset/limit.]
```

标记总是标明哪一端幸存下来，有多少被排除在总数之外，
适用的限制，以及从哪里获得其余的。出现溢出语句
仅当实际编写完整副本时。

Read/Glob/Grep 不在其有效负载中嵌入标记：窗口元数据
（`offset`、`lineCount`、`totalLines`、`truncated`）加上 `notice` 字符串携带与
兄弟字段相同的信息，这让负载本身保持可机械解析。`Read` 的内容带行号并以
`[path#TAG]` 开头（ADR 0087）；它不再是字节忠实的，因此把它复制进 `Write` 的
消费者必须去掉头部和 `N:` 前缀，`Write` 也会防御性地去掉它们。

仅检查点聚合截断使用不同的模型上下文标记
§4 因此诊断可以区分信息被缩短的位置。

## 3a。泄漏文件

当 Bash 输出超出其预算时，更完整的副本（最多 `SPILL_MAX_BYTES`）
写入 `<data_dir>/scratch/<session_id>/tool-output/<label>-<ms>-<seq>.log`
并在标记中命名。重用每个会话的临时生命周期
(`scratch::remove_session_dir` / `sweep`)，因此溢出会随着会话而消失，并且
过时的内容在启动时就会被清除——没有单独的保留策略。

该目录是在第一次溢出时创建的，而不是在会话启动时创建的，因此会话
保持在预算之内，什么都没有留下。一次失败的泄漏只需要付出暗示，
从来不是工具的结果。

Grep 可以读取溢出文件，因为显式 `path` 参数会停止父级
忽略应用中的文件 — 同样的规则可以让 `path` 进入
`node_modules` 或 `dist`。

## 4. 面向模型与面向 UI

- 模型接收带有标记的截断有效负载
- Renderer 在 Bash 运行时接收有序的 `stdout` 和 `stderr` 块；的
  最终 model/UI 结果仍然是有界组合有效负载。
- UI 可能会为 Bash/Read 提供“在查看器中打开完整输出”（后 MVP 可选）
- 完整的原始输出不需要永久保留；会话可能会在 MVP 中存储截断的形式
- 每个结果主机上限不会聚合并行批次，并且它
  在上下文压缩期间不需要：活动回合的检查点仅保留最新的用户消息，已完成
  回合不保留用户消息，因此工具结果根本不会跨越边界 (D203/D275)。刀具输出
  仅通过检查点摘要即可到达下一个上下文。
- 活动检查点可能截断的一条消息是最新的保留用户消息，
  超过 20,000 个代币保留限制的代币。它保留了 75/25
  head/tail 与此标记之间共享其文本，而不是
  掉落：

```text
[checkpoint truncated: this message crossed the retained context budget]
```

- 仅检查点截断永远不会重写原始转录消息
  或其 UI/diagnostic 结果；它仅改变未来的重建模型
  上下文

## 5. 部分结果标志

每个有界工具都会报告 `truncated: boolean`。另外 Read/Glob/Grep
报告什么是有界的以及如何继续：

```ts
type ReadResult = {
  path: string; root: "workspace" | "scratch" | "external"
  content: string          // "[path#TAG]" header + "N:"-prefixed window
  tag: string              // 4 hex, whole-file; the Edit anchor
  offset: number; lineCount: number
  totalLines?: number      // present only once end of file was reached
  fileBytes: number
  truncated: boolean
  notice?: string          // next offset, budget stop, clipped-line count
}

type GrepResult =
  | { matches: { path: string; line: number; text: string }[]; tags: Record<string, string>; count: number; files: number; truncated: boolean; notice?: string }
  | { files: string[]; count: number; truncated: boolean; notice?: string }        // outputMode: filesWithMatches
  | { counts: { path: string; count: number }[]; count: number; truncated: boolean; notice?: string }  // outputMode: count

type GlobResult = { matches: string[]; count: number; truncated: boolean; notice?: string }
```

`tags` 只在 `content` 模式下出现，因为只有该模式会显示行。另外两种模式可搜索，
但不是可编辑的锚点。

对于批准的外部路径，`path` 是绝对路径； `Read` 还报道
`root: "external"`。 `Glob` 和 `Grep` 使用绝对路径作为其外部
匹配。 sidecar 发出 `filesWithMatches`； host-core 还标准化了
常见的 `files_with_matches` 和 `files-with-matches` 提供商拼写。

`notice` 是面向模型的散文，而不是稳定的契约：它命名了下一个偏移量，
停止扫描的预算，或剪切了多少行。 `truncated`
计数即为稳定信号。

## 6. 优先级规则

1. 截断时切勿省略截断标记
2. Bash 标准输出保持领先地位； Bash stderr 保留其**尾巴**，因为失败
   命令的可操作消息是它最后打印并删除的内容
   96KB 的进度噪声导致模型盲目重试
3. 二进制文件：不要将原始二进制文件转储到模型中；返回元数据错误
   `TOOL_BINARY_CONTENT`。通过扩展黑名单加上嗅探来检测
   第一个 4KB（任何 NUL 字节，或 >30% 不可打印）。 Grep 跳过二进制文件
   静默地而不是匹配有损解码的字节
4. 比整个预算长的单行会产生字符边界安全前缀
   （或后缀，用于尾部切割），绝不是空的有效负载
5. 聚合检查点截断必须保留每个提供商有效的助手
   tool-call/result 配对并在持久化之前重新估计结果尾部
6.Glob和Grep的相关顺序是文件修改时间，最新的在前，
   因此，有上限的结果使一半更有可能被询问
7. 超时和中止仅在完成过程后关闭两个输出流
   树已被关闭；没有孤儿进程可以继续写入输出

## 7. 验收标准

- [x] 超大 Bash 输出用标记截断并溢出更完整的副本
- [x] Bash stderr 在截断时保留其最后几行
- [x] Grep 在 `headLimit` 和 `truncated: true` 处停止
- [x] Grep 和 Read 在 2000 个字符处剪辑行，且被剪辑的行被排除在 `Edit` 来源集之外
- [x] Read 对多兆字节文件进行分页而不是拒绝它，并报告
下一个偏移量
- [x] 读取拒绝带有 `TOOL_BINARY_CONTENT` 的二进制内容
- [x] 显式 `path` 到达被忽略的树（`node_modules`，溢出目录）
- [x] Glob 和 Grep 按修改时间对结果进行排序，最新的在前
- [x] 截断结果仍然有效 UTF-8 文本
- [x] 捕获上限高于结果预算，因此溢出的副本可以
  比它支持的摘录更完整，并报告它省略的字节和行
- [ ] stdout 和 stderr 分别使用稳定的每个工具序列值进行流传输
- [ ] Bash 使用 60 秒默认值并拒绝 1-300 秒之外的覆盖
- [ ] timeout/abort 停止完整的进程树并且不再发出后续块
- [ ] 超大并行结果批次压缩为有界标记尾部，
  重新启动后仍然存在，并保持原始成绩单结果不变
