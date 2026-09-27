---
title: 交付与验收
description: PI-Desktop 的里程碑、验收、E2E、变更和发布流程。
---

# 交付与验收

这一主题把“实现完成”与“可以交付”连接起来，覆盖里程碑、验收标准、E2E、变更清单和发布手册。

## 阅读顺序

1. [MVP 里程碑](/zh-CN/spec/06-delivery/01-mvp-milestones)
2. [验收标准](/zh-CN/spec/06-delivery/02-acceptance-criteria)
3. [AI 开发工作流](/zh-CN/spec/06-delivery/03-ai-development-workflow)
4. [E2E 测试计划](/zh-CN/spec/06-delivery/04-e2e-test-plan)
5. [变更清单](/zh-CN/spec/06-delivery/05-change-checklist)
6. [发布手册](/zh-CN/spec/06-delivery/06-release-runbook)

## 交付闭环

```text
spec → implementation → targeted validation → E2E scenario → release record
```

用户可见或协议可见的行为变化，必须在 E2E 测试计划中留下可执行场景。
