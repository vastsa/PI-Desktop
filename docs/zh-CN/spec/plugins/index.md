---
title: 插件系统
description: PI-Desktop 的插件包、API、权限、生命周期和开发体验。
---

# 插件系统

插件系统允许用户在本地安装和运行扩展，同时保留明确的包格式、API、权限和生命周期边界。

## 阅读顺序

1. [插件系统](/zh-CN/spec/07-plugins/01-plugin-system)
2. [插件开发](/zh-CN/plugin-development)
3. [Manifest schema](/zh-CN/spec/07-plugins/02-plugin-manifest-schema)
4. [插件 API](/zh-CN/spec/07-plugins/03-plugin-api)
5. [插件安全](/zh-CN/spec/07-plugins/04-plugin-security)
6. [插件生命周期](/zh-CN/spec/07-plugins/05-plugin-lifecycle)
7. [开发体验](/zh-CN/spec/07-plugins/10-plugin-devex)

## 当前边界

- 第一阶段面向本地、用户安装的插件。
- 包格式是 `.piplug`，信任起点是 sha256 校验。
- Marketplace 协议可以先定义，市场实现按路线图推进。
