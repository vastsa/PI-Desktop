# 工作区索引 rg 基线（P2-0）

> **翻译说明：** 本页是与 [英文源规格](/spec/06-delivery/rg-baseline-2026-09-13) 一一对应的机器辅助翻译。代码、协议字段和标识符保持原文；如翻译与英文源事实有歧义，以英文版本为准。

- 日期：2026-09-13
- 机器：macOS arm64（开发工作站）
- rg：系统 `rg`，按宿主 `try_system_rg` 的调用方式（`--json --no-config --hidden -e <pattern> -- <dir>`），stdout 丢弃
- Fixture：100 / 1,000 / 5,000 个单行文本文件；每个文件含 `fn_<i> commonToken id`，每 37 个文件追加一行中文，最后一个文件追加各规模专属的稀有词 `needle_<size-1>`（保证至少 1 次命中）
- 方法：每格 8 次；`first_ms` 为第 1 次，`warm_p50/p95` 取第 2–8 次
- 脚本：`scripts/rg-baseline.py`（`python3 scripts/rg-baseline.py` 可复现）

| 文件数 | 查询 | first_ms | warm_p50_ms | warm_p95_ms |
|---|---|---|---|---|
| 100 | common_literal | 24.0 | 10.5 | 15.9 |
| 100 | cjk_literal | 14.5 | 12.0 | 19.5 |
| 100 | short_pattern | 9.2 | 9.9 | 12.1 |
| 100 | regex_pattern | 10.9 | 10.0 | 10.7 |
| 100 | rare_literal | 8.9 | 10.0 | 12.6 |
| 1000 | common_literal | 20.2 | 16.7 | 17.1 |
| 1000 | cjk_literal | 16.1 | 15.8 | 18.3 |
| 1000 | short_pattern | 16.6 | 16.6 | 18.0 |
| 1000 | regex_pattern | 16.2 | 17.2 | 17.6 |
| 1000 | rare_literal | 16.8 | 16.6 | 17.0 |
| 5000 | common_literal | 92.9 | 52.9 | 54.3 |
| 5000 | cjk_literal | 61.5 | 66.0 | 69.3 |
| 5000 | short_pattern | 63.2 | 65.0 | 67.4 |
| 5000 | regex_pattern | 69.2 | 67.1 | 165.5 |
| 5000 | rare_literal | 63.3 | 59.8 | 80.3 |

P2-B 校准提示（单机单次证据，非承诺）：

- 100–1k 文件时进程派生 `rg` 热态约 10–17ms，5k 约 53–67ms。快路径只需在字面量子集上胜过它，且准入检查自身开销必须远低于 ~1ms，回退才不会劣化。
- 热 p95 大多接近 p50；偶发离群（5k regex 165ms）是调度噪声。P2-B 计时断言应先看 p50，p95 放宽或剔除离群。
- 首次（冷）运行可能明显慢于热 p50（5k common 约 93ms vs 53ms）；冷缓存单列报告。
- 本表结论不跨机器/系统迁移；作为门槛前必须重测。
