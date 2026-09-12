# PI-Desktop 规格导航

> **翻译说明：** 本页是与 [英文源规格](/spec/NAV) 一一对应的机器辅助翻译。代码、协议字段和标识符保持原文；如翻译与英文源事实有歧义，以英文版本为准。


## 总览
- [README.md](/zh-CN/spec/README)

## 0. 基线
- [00-baseline.md](/zh-CN/spec/00-baseline)

## 1. 产品
- [README.md](/zh-CN/spec/01-product/README)
- [00-overview.md](/zh-CN/spec/01-product/00-overview)
- [01-product-scope.md](/zh-CN/spec/01-product/01-product-scope)
- [02-non-goals.md](/zh-CN/spec/01-product/02-non-goals)

## 2. 架构
- [README.md](/zh-CN/spec/02-architecture/README)
- [01-architecture.md](/zh-CN/spec/02-architecture/01-architecture)
- [02-tech-stack.md](/zh-CN/spec/02-architecture/02-tech-stack)
- [04-documentation-site.md](/zh-CN/spec/02-architecture/04-documentation-site)
- [03-repo-structure.md](/zh-CN/spec/02-architecture/03-repo-structure)
- [05-remote-agent-control.md](/zh-CN/spec/02-architecture/05-remote-agent-control)

## 3. 运行时
- [README.md](/zh-CN/spec/03-runtime/README)
- [01-ipc-protocol.md](/zh-CN/spec/03-runtime/01-ipc-protocol)
- [02-agent-runtime.md](/zh-CN/spec/03-runtime/02-agent-runtime)
- [03-tools-and-permissions.md](/zh-CN/spec/03-runtime/03-tools-and-permissions)
- [04-data-storage.md](/zh-CN/spec/03-runtime/04-data-storage)
- [05-host-core-rust.md](/zh-CN/spec/03-runtime/05-host-core-rust)
- [06-host-rpc-protocol.md](/zh-CN/spec/03-runtime/06-host-rpc-protocol)
- [07-process-model.md](/zh-CN/spec/03-runtime/07-process-model)
- [08-error-codes.md](/zh-CN/spec/03-runtime/08-error-codes)
- [09-logging-and-observability.md](/zh-CN/spec/03-runtime/09-logging-and-observability)
- [10-session-state-machine.md](/zh-CN/spec/03-runtime/10-session-state-machine)
- [11-provider-model-system.md](/zh-CN/spec/03-runtime/11-provider-model-system)
- [12-provider-config-schema.md](/zh-CN/spec/03-runtime/12-provider-config-schema)
- [13-model-catalog-and-selection.md](/zh-CN/spec/03-runtime/13-model-catalog-and-selection)
- [14-secrets-storage.md](/zh-CN/spec/03-runtime/14-secrets-storage)
- [15-workspace-ignore-rules.md](/zh-CN/spec/03-runtime/15-workspace-ignore-rules)
- [16-tool-result-limits.md](/zh-CN/spec/03-runtime/16-tool-result-limits)
- [17-asktool-questions.md](/zh-CN/spec/03-runtime/17-asktool-questions)
- [18-line-anchored-edit-contract.md](/zh-CN/spec/03-runtime/18-line-anchored-edit-contract)
- [19-remote-agent-control-protocol.md](/zh-CN/spec/03-runtime/19-remote-agent-control-protocol)

## 4. 用户体验
- [README.md](/zh-CN/spec/04-ux/README)
- [01-ui-ia.md](/zh-CN/spec/04-ux/01-ui-ia)
- [02-i18n-english-first.md](/zh-CN/spec/04-ux/02-i18n-english-first)
- [03-permission-ux.md](/zh-CN/spec/04-ux/03-permission-ux)
- [04-builtin-commands.md](/zh-CN/spec/04-ux/04-builtin-commands)
- [05-onboarding.md](/zh-CN/spec/04-ux/05-onboarding)
- [06-settings-ia.md](/zh-CN/spec/04-ux/06-settings-ia)
- [07-ui-design-system.md](/zh-CN/spec/04-ux/07-ui-design-system)
- [08-component-spec.md](/zh-CN/spec/04-ux/08-component-spec)
- [09-interaction-patterns.md](/zh-CN/spec/04-ux/09-interaction-patterns)
- [10-workbuddy-benchmark-ux.md](/zh-CN/spec/04-ux/10-workbuddy-benchmark-ux)
- [11-asktool-question-card.md](/zh-CN/spec/04-ux/11-asktool-question-card)
- [12-prompt-enhancement.md](/zh-CN/spec/04-ux/12-prompt-enhancement)

## 5. 安全性
- [README.md](/zh-CN/spec/05-security/README)
- [01-security.md](/zh-CN/spec/05-security/01-security)
- [02-remote-control-security.md](/zh-CN/spec/05-security/02-remote-control-security)

## 6. 交付
- [README.md](/zh-CN/spec/06-delivery/README)
- [01-mvp-milestones.md](/zh-CN/spec/06-delivery/01-mvp-milestones)
- [02-acceptance-criteria.md](/zh-CN/spec/06-delivery/02-acceptance-criteria)
- [03-ai-development-workflow.md](/zh-CN/spec/06-delivery/03-ai-development-workflow)
- [04-e2e-test-plan.md](/zh-CN/spec/06-delivery/04-e2e-test-plan)
- [05-change-checklist.md](/zh-CN/spec/06-delivery/05-change-checklist)
- [06-release-runbook.md](/zh-CN/spec/06-delivery/06-release-runbook)
- [07-remote-control-rollout.md](/zh-CN/spec/06-delivery/07-remote-control-rollout)

## 7. 插件
- [README.md](/zh-CN/spec/07-plugins/README)
- [01-plugin-system.md](/zh-CN/spec/07-plugins/01-plugin-system)
- [02-plugin-manifest-schema.md](/zh-CN/spec/07-plugins/02-plugin-manifest-schema)
- [03-plugin-api.md](/zh-CN/spec/07-plugins/03-plugin-api)
- [04-plugin-security.md](/zh-CN/spec/07-plugins/04-plugin-security)
- [05-plugin-lifecycle.md](/zh-CN/spec/07-plugins/05-plugin-lifecycle)
- [06-plugin-packaging.md](/zh-CN/spec/07-plugins/06-plugin-packaging)
- [07-plugin-marketplace.md](/zh-CN/spec/07-plugins/07-plugin-marketplace)
- [08-plugin-signing-updates.md](/zh-CN/spec/07-plugins/08-plugin-signing-updates)
- [09-plugin-command-palette.md](/zh-CN/spec/07-plugins/09-plugin-command-palette)
- [10-plugin-devex.md](/zh-CN/spec/07-plugins/10-plugin-devex)
- [11-plugin-storage-isolation.md](/zh-CN/spec/07-plugins/11-plugin-storage-isolation)
- [12-plugin-ipc-and-host-services.md](/zh-CN/spec/07-plugins/12-plugin-ipc-and-host-services)
- [13-plugin-permissions-matrix.md](/zh-CN/spec/07-plugins/13-plugin-permissions-matrix)
- [14-plugin-roadmap.md](/zh-CN/spec/07-plugins/14-plugin-roadmap)
- [15-plugin-center.md](/zh-CN/spec/07-plugins/15-plugin-center)

## 8. 元数据
- [README.md](/zh-CN/spec/08-meta/README)
- [decisions-log.md](/zh-CN/spec/08-meta/decisions-log)
- [open-questions.md](/zh-CN/spec/08-meta/open-questions)

## ADR
- [../adr/README.md](/adr/README)
