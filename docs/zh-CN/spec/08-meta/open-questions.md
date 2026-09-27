# 开放式问题

> **翻译说明：** 本页是与 [英文源规格](/spec/08-meta/open-questions) 一一对应的机器辅助翻译。代码、协议字段和标识符保持原文；如翻译与英文源事实有歧义，以英文版本为准。


> 更新了基线 `0.4.12`（无图标的编辑器提示行）。
> 冻结的决策位于 [decisions-log.md](/zh-CN/spec/08-meta/decisions-log) 中；已解决
> 物品会移动到那里而不是停留在这里。

## 最近解决（参见决策日志）

- Sidecar 打包格式 → Electron 二进制文件上的 `ELECTRON_RUN_AS_NODE` (D008)
- 代码签名/公证操作设置 → 双通道 + 发布运行手册 (D072)
- 应用程序图标/品牌标记 v1 → 具有派生 ICNS 的规范 `build/icon_1024.png`
  （D079）；渲染器身份和共享 `BrandLogo` 用法 → D094
- zh-CN 语言环境时间轴 → zh-CN 字符串与英语一起提供，并且是
  由 UI e2e 场景断言（英语仍然是源语言）
- 应用程序更新所有权和交付模式 → D120 / ADR 0022

## 仍然开放

### 发布/分发（首次发布后）
1. 何时公开发布源或将其替换为经过身份验证的
   端点无需传送客户端凭证
2. DMG之外的分发（Homebrew cask？直接下载页面？）
3. 签名Windows/macOS应用内安装、Linux发布、回滚和
   stable/prerelease 推出政策

### 市场（后 MVP）
1. 官方市场域名和提供商 ID
2. 是否默认启用第三方源
3. 私有源身份验证：令牌标头与 mTLS
4. `.zip` 是否与 `.piplug` 一起仍然被接受

### 插件高级策略
1. 何时强制执行严格的独立进程插件运行时（ADR 0008 目标）
2. 未来的插件设置是否可能包含特殊存储下的秘密字段
3. 除了硬默认删除之外，可选的“卸载时保留数据”UX copy/defaults
4. `ui.panel` 贡献是否暗示获得小组许可还是必须声明
   （从 07-plugins/02-plugin-manifest-schema 追踪）

### 提供商/模型
1. 远程目录分发渠道（签名应用程序更新与专用目录源）
2. 是否发布大型多供应商捆绑目录或精简 + 按需刷新
3. Azure 部署名称 UX 详细信息与原始模型 ID
4. MVP 中超越 aws_sdk_default 的基础 region/profile 高级 UI

### 工具
1. JS linter 选择（biome vs oxlint）——样式标记已经由
   `scripts/check-style-tokens.mjs`；一般的 linter 仍未被挑选

## 决策规则

- 冻结的决定转到 `decisions-log.md`（D 条目）
- 架构边界更改需要 ADR
- 非阻塞抛光保留在这里，直到实施临近
