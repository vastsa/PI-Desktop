---
title: 界面截图
description: PI-Desktop 的每个界面，全部取自运行中的应用。
---

# 界面截图

下面每一张都来自支撑 [E2E 测试计划](/zh-CN/spec/06-delivery/04-e2e-test-plan)
的截图装置：应用以 `PI_DESKTOP_CAPTURE=1` 在一个临时数据目录上启动，自行走过每个
界面并写出 PNG，再由 `scripts/publish-screenshots.py` 转换成本页的图片。因此这些
截图展示的是实际发布的界面，而不是设计稿——包括全新安装时看到的空态。

会话标题和对话内容来自截图装置的样例数据。
[English version](/guide/screenshots) 是同样的界面配英文界面语言。

## 主页与会话

主页是全新安装打开后的第一个界面：标题区、输入框，以及按项目分组会话的侧边栏。

![浅色主题下的 PI-Desktop 主页](../../public/screenshots/app/zh/home-light.webp)

![深色主题下的 PI-Desktop 主页](../../public/screenshots/app/zh/home-dark.webp)

![深色主题下的对话页](../../public/screenshots/app/zh/dark-home.webp)

对话流式写入正文，右侧是缩略导航条；鼠标划过导航条时标记会放大，并预览光标下的
那条消息。

![带缩略导航条的对话](../../public/screenshots/app/zh/minimap.webp)

![光标下放大的缩略导航条](../../public/screenshots/app/zh/minimap-hover.webp)

Composer 的模型 × 推理芯片切换当前会话使用的模型。在输入框里，`/` 打开命令菜单，`@` 打开文件引用菜单。

![Composer 中的模型和推理菜单](../../public/screenshots/app/zh/model-menu.webp)

![输入框的斜杠命令菜单](../../public/screenshots/app/zh/composer-slash.webp)

![输入框的 @ 文件引用菜单](../../public/screenshots/app/zh/composer-at.webp)

## 工作面板

当智能体产出工作产物时，工作面板在对话旁边打开。下面几张是尚未打开工作区时的面板
状态，也就是一次新对话的起点。

![审阅面板](../../public/screenshots/app/zh/panel-review.webp)

![浏览器预览面板](../../public/screenshots/app/zh/panel-browser.webp)

![文件浏览面板](../../public/screenshots/app/zh/panel-files.webp)

![工作面板切换菜单](../../public/screenshots/app/zh/panel-menu.webp)

## 目的地页

合并请求、项目归档和定时任务都是从侧边栏进入的整页目的地。

![合并请求页](../../public/screenshots/app/zh/pulls-live.webp)

![深色主题下的合并请求页](../../public/screenshots/app/zh/dark-pulls.webp)

![项目归档](../../public/screenshots/app/zh/project-archive-live.webp)

![深色主题下的项目归档](../../public/screenshots/app/zh/dark-project-archive.webp)

![定时任务](../../public/screenshots/app/zh/scheduled-live.webp)

## 通知与提示

通知收件箱持久保留已完成的工作、权限请求和更新提醒；Toast 负责其中即时提示的部分。

![浅色主题下的通知收件箱](../../public/screenshots/app/zh/notifications-light.webp)

![深色主题下的通知收件箱](../../public/screenshots/app/zh/notifications-dark.webp)

![窄窗口下的通知浮层](../../public/screenshots/app/zh/notifications-narrow.webp)

![浅色主题下的成功、警告与错误提示](../../public/screenshots/app/zh/toasts-light.webp)

![深色主题下的成功、警告与错误提示](../../public/screenshots/app/zh/toasts-dark.webp)

## 全局搜索

`⌘K` 用一个弹窗同时搜索会话、页面、设置项和命令。选中设置项会跳到对应标签页并
高亮闪烁那一行。

![显示最近会话的全局搜索](../../public/screenshots/app/zh/search.webp)

![匹配会话的全局搜索](../../public/screenshots/app/zh/search-query.webp)

![匹配设置项的全局搜索](../../public/screenshots/app/zh/search-settings.webp)

![匹配目的地页的全局搜索](../../public/screenshots/app/zh/search-pages.webp)

![从搜索跳转到的设置项](../../public/screenshots/app/zh/search-anchor.webp)

![深色主题下的全局搜索](../../public/screenshots/app/zh/search-dark.webp)

## 插件

已安装插件、插件市场和打包流程都在插件页上。

![已安装的插件](../../public/screenshots/app/zh/plugins-live.webp)

![插件市场](../../public/screenshots/app/zh/plugins-market.webp)

![插件页菜单](../../public/screenshots/app/zh/plugins-menu.webp)

![单个插件的行菜单](../../public/screenshots/app/zh/plugins-row-menu.webp)

![新建插件模板弹窗](../../public/screenshots/app/zh/plugins-template.webp)

## 扩展

MCP 服务、技能和子智能体独立于插件管理，各自可以全局启用或按项目启用。

![MCP 服务](../../public/screenshots/app/zh/extensions-mcp.webp)

![生效范围选择器](../../public/screenshots/app/zh/extensions-scope.webp)

![MCP 服务编辑器](../../public/screenshots/app/zh/extensions-mcp-editor.webp)

![技能](../../public/screenshots/app/zh/extensions-skills.webp)

![子智能体](../../public/screenshots/app/zh/extensions-subagents.webp)

![插件提供的子智能体](../../public/screenshots/app/zh/extensions-subagents-provided.webp)

![子智能体编辑器](../../public/screenshots/app/zh/extensions-subagent-editor.webp)

![深色主题下的子智能体](../../public/screenshots/app/zh/extensions-subagents-dark.webp)

![深色主题下的 MCP 服务](../../public/screenshots/app/zh/extensions-mcp-dark.webp)

## 设置

设置是一个整页目的地，左侧是可搜索的标签栏。

![基础——语言、主题与外观](../../public/screenshots/app/zh/settings-live.webp)

![深色主题下的基础设置](../../public/screenshots/app/zh/dark-settings.webp)

![模型配置中的默认模型与 AI 服务](../../public/screenshots/app/zh/settings-models.webp)

![扩展市场中的插件目录源选择](../../public/screenshots/app/zh/settings-extensions.webp)

![扩展市场中的自定义插件目录地址](../../public/screenshots/app/zh/settings-extensions-custom.webp)

## 如何重新生成

先构建渲染层，确认 `target/debug/pi-desktop-host-core` 存在，创建
`/tmp/codex-screens`，然后按语言各跑一遍并发布：

```bash
pnpm --filter @pi-desktop/desktop build
mkdir -p /tmp/codex-screens

# 英文一遍；中文一遍在命令末尾加 --lang=zh-CN。
cd apps/desktop && PI_DESKTOP_CAPTURE=1 PI_DESKTOP_DATA_DIR=$(mktemp -d) \
  ELECTRON_RENDERER_URL= ./node_modules/.bin/electron .

python3 scripts/publish-screenshots.py --source /tmp/codex-screens --locale zh
```

最后一张写完后，装置会在标准输出打印 `CAPTURE_DONE`。
