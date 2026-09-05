# 02. i18n（英语优先）

> **翻译说明：** 本页是与 [英文源规格](/spec/04-ux/02-i18n-english-first) 一一对应的机器辅助翻译。代码、协议字段和标识符保持原文；如翻译与英文源事实有歧义，以英文版本为准。


## 1. 政策

PI-Desktop 是一款全球产品。

- **默认区域设置：** `en`
- **源语言：** 英语
- **specs/UI/source 字符串的创作语言：** 英语
- 其他语言环境是英文源的翻译

## 2. 框架要求

UI 必须使用 **i18next + React-i18next** (D012)。

规则：

1. 没有硬编码的面向用户的英文句子长期散落无ID
2. 每个可见的字符串都有一个稳定的密钥
3.区域设置切换不得需要代码编辑
4. 每个发布的语言环境都具有与英语相同的扁平化按键集
5. 插值变量名称和集在每个语言环境中都匹配
6. 日期和时间使用活动应用程序区域设置而不是主机默认值
7. Electron 应用程序菜单自定义标签和渲染器窗口控件
   消耗目录键；本机角色标签可以使用 Electron/OS 本地化

## 3. 目录结构

```text
packages/i18n/src/locales/
├── en/index.ts
├── zh-CN/index.ts
└── tr/index.ts
```

英文目录是翻译目录的源类型。`packages/i18n` 中的注册表列出每个已发布语言（id、本地名称、英文名称）。自动化测试会校验每个已发布语言的目录键和插值变量。新增语言只需加一份目录和一行注册表；语言选择器读取该注册表。

## 4. 关键约定

```text
domain.section.item
```

示例：

- `chat.composer.placeholder`
- `settings.providers.add`
- `plugins.permissions.fs.write`
- `errors.tool.denied`
- `composer.mode.agent`
- `composer.mode.plan`
- `plan.approval.title`
- `plan.approval.artifactPath`
- `plan.approval.openArtifact`
- `plan.approval.approve`
- `plan.approval.reject`
- `plan.approval.permissionAutoWarning`
- `settings.shell.default`
- `settings.shell.unavailable`
- `errors.COMMAND_SHELL_CHANGED`
- `errors.COMMAND_SHELL_INVALID`
- `errors.SHELL_NOT_FOUND`
- `errors.PLAN_ARTIFACT_WRITE_FAILED`
- `errors.PLAN_EXECUTION_INTERRUPTED`
- `errors.PLAN_REQUIRES_INTERACTIVE_SESSION`

## 5. 非 UI 语言界面

同样是英语优先：

- docs/spec
- ADR
- 提交消息
- issue/PR 模板
- 插件示例文档
- 核心产品中的命令标题

插件稍后可能会包含本地化的显示字段，但英语字段是必需的。

## 6. 验收

1.应用程序默认以英文启动
2. 英文源目录存在语言环境文件
3. 切换架构支持额外的语言环境
4. 核心UI路径无中文硬依赖
5. 目录测试拒绝丢失键或不匹配的插值变量
6. 导入、项目和临时会话在每个已发布语言中公开本地化的可见和无障碍标签
7. macOS 系统菜单自定义命令和 Windows/Linux 窗口控件在每个已发布语言中公开本地化标签
8. 启动启动画面和渲染器崩溃 chrome 使用目录键（`app.starting`、
   `app.shellName`、`app.tagline`、`app.uiCrashed`)；空屋英雄称号是
   在每个已发布的语言环境中进行翻译
9. 用户可见的目录副本更喜欢简单的产品语言而不是内部语言
   工程术语（issue/PR/Windows/Linux/macOS/`app.starting`，其中 UI
   已经说了项目）。状态、空状态、错误和设置提示说明
    发生了什么以及下一步该做什么 (D149)
10. Agent/Plan/Goal 选择器、合约状态、title/artifact-opener/
    记住批准模式操作、Bash/Auto 突变警告、
    shell catalog/unavailable 状态、故障关闭恢复和共享
Plan/Goal 错误代码
    在每个已发布语言中都有匹配的键；无聊天操作模式键或命令
    已发货
