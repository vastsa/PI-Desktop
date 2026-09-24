import assert from "node:assert/strict";
import { test } from "vitest";
import { catalogs, en, flattenCatalog, ko, zhCN, zhTW } from "../src/index.ts";

const english = flattenCatalog(en);
const chinese = flattenCatalog(zhCN);
const traditional = flattenCatalog(zhTW);
const korean = flattenCatalog(ko);

test("shell status and crash copy stay user-facing", () => {
  assert.equal(english["app.tagline"], "Local AI coding partner");
  assert.equal(
    english["app.uiCrashed"],
    "Something went wrong with the interface",
  );
  assert.equal(english["status.hostOk"], "Connected");
  assert.equal(english["status.degraded"], "Limited");
  assert.equal(english["status.fatal"], "Can't reach the local service");
  assert.equal(
    english["status.unsupportedGlibc"],
    "This Linux build needs glibc 2.35 or newer (Ubuntu 22.04, Debian 12, Fedora 36+).",
  );
  assert.equal(
    chinese["status.unsupportedGlibc"],
    "当前 Linux 构建需要 glibc 2.35 或更高版本（Ubuntu 22.04、Debian 12、Fedora 36+）。",
  );
  assert.equal(english["errors.TURN_ABORTED"], "Stopped.");
  assert.equal(chinese["app.tagline"], "本地 AI 编程助手");
  assert.equal(chinese["app.uiCrashed"], "界面出现了问题");
  assert.equal(chinese["status.hostOk"], "已连接");
});

test("failed turns expose a localized continuation prompt", () => {
  assert.equal(
    english["chat.continueUnfinishedTaskPrompt"],
    "Continue the user's unfinished task.",
  );
  assert.equal(
    chinese["chat.continueUnfinishedTaskPrompt"],
    "继续用户未完成的任务",
  );
  assert.equal(
    english["errors.MUTATION_RETRY_BUDGET_EXHAUSTED"],
    "The same edit failed three times, so this turn stopped instead of retrying blind. Ask again to continue.",
  );
  assert.equal(
    chinese["errors.MUTATION_RETRY_BUDGET_EXHAUSTED"],
    "同一处修改连续失败三次，本轮已停止，不再盲目重试。再说一次即可继续。",
  );
});

test("common setup and marketplace copy avoid developer jargon", () => {
  assert.equal(english["nav.temporarySessions"], "Temporary chats");
  assert.equal(english["menu.refreshMarket"], "Refresh marketplace");
  assert.equal(english["settings.providers"], "AI providers");
  assert.doesNotMatch(english["menu.refreshMarket"], /from repo/i);
  assert.doesNotMatch(english["status.hostOk"], /Host/i);
  assert.doesNotMatch(english["status.fatal"], /backend/i);
  assert.equal(chinese["nav.temporarySessions"], "临时对话");
  assert.equal(chinese["settings.providers"], "AI 服务");
  assert.equal(chinese["menu.refreshMarket"], "刷新插件市场");
  assert.equal(traditional["nav.temporarySessions"], "臨時對話");
  assert.equal(traditional["settings.providers"], "AI 服務");
  assert.equal(traditional["menu.refreshMarket"], "重新整理外掛市場");
  assert.equal(korean["settings.language"], "언어");
  assert.equal(korean["nav.projects"], "프로젝트");
  assert.equal(korean["nav.temporarySessions"], "임시 대화");
});

test("Plan mode and Auto permission copy stay explicit in both locales", () => {
  assert.equal(english["settings.modePlan"], "Plan");
  assert.equal(chinese["settings.modePlan"], "规划");
  assert.equal(chinese["chat.permissionAcceptEdits"], "允许编辑");
  assert.equal(traditional["chat.permissionAcceptEdits"], "允許編輯");
  assert.equal(english["plan.approvalRegion"], "Plan approval");
  assert.equal(
    english["plan.readyAnnouncement"],
    "Plan ready. The plan is open in the Work Panel.",
  );
  assert.equal(english["plan.approveAsk"], "Approve (Ask)");
  assert.equal(english["plan.approveAcceptEdits"], "Approve (Accept edits)");
  assert.equal(english["plan.approveAuto"], "Approve (Auto)");
  assert.equal(english["plan.chooseApprovalMode"], "Choose approval mode");
  assert.equal(chinese["plan.approvalRegion"], "规划审批");
  assert.equal(
    chinese["plan.readyAnnouncement"],
    "规划已就绪，已在工作面板中打开。",
  );
  assert.equal(chinese["plan.approveAsk"], "批准（每次询问）");
  assert.equal(chinese["plan.approveAcceptEdits"], "批准（自动接受编辑）");
  assert.equal(chinese["plan.approveAuto"], "批准（全自动）");
  assert.equal(chinese["plan.chooseApprovalMode"], "选择批准权限");
  assert.match(english["plan.autoWarning"], /may change files/);
  assert.match(chinese["plan.autoWarning"], /可能修改文件/);
});

/**
 * E2E-024X: a page may not restate its own title as a subtitle, and a setting
 * may not explain an obvious control. These keys were rendered once and are
 * gone; keep them gone in every locale.
 */
const REMOVED_EXPLANATORY_KEYS = [
  "project.subtitle",
  "project.archiveSubtitle",
  "project.emptyIndexBody",
  "scheduled.emptyBody",
  "chat.emptyHint",
  "panel.empty.body",
  "panel.review.noChangesHint",
  "settings.languageDesc",
  "settings.devToolsDesc",
  "settings.themeLightDesc",
  "settings.themeDarkDesc",
  "settings.themeSystemDesc",
  "settings.applicationDesc",
  "settings.logsDesc",
  "settings.fontDesc",
  "settings.shortcutDescription",
  "settings.importScanDesc",
  "settings.linkOpenTargetDesc",
  "settings.commandShellDesc",
  "settings.contextUsageDisplayDesc",
  "settings.closeBehaviorTrayDesc",
  "settings.closeBehaviorQuitDesc",
  "settings.capabilityNoMatchesHint",
  "settings.fullAccessDesc",
  "settings.autoReviewDesc",
  "settings.defaultPermissionsDesc",
  "settings.apiKeyHint",
  "settings.baseUrlHint",
  "settings.apiStyleDesc",
  "plugins.newFromTemplateHint",
  "plugins.newFromTemplateBody",
  "plugins.selectVersion",
  "extensions.mcp.labelHint",
  "extensions.mcp.transportStdioHint",
  "extensions.mcp.transportHttpHint",
  "extensions.mcp.descriptionHint",
];

test("removed explanatory copy stays removed", () => {
  for (const key of REMOVED_EXPLANATORY_KEYS) {
    assert.equal(english[key], undefined, `en still defines ${key}`);
    assert.equal(chinese[key], undefined, `zh-CN still defines ${key}`);
  }
});

test("font size presets use Starbucks-style cup names", () => {
  assert.equal(english["settings.fontSizeSmall"], "Tall");
  assert.equal(english["settings.fontSizeDefault"], "Grande");
  assert.equal(english["settings.fontSizeLarge"], "Venti");
  assert.equal(english["settings.fontSizeXl"], "Trenta");
  assert.equal(chinese["settings.fontSizeSmall"], "中杯");
  assert.equal(chinese["settings.fontSizeDefault"], "大杯");
  assert.equal(chinese["settings.fontSizeLarge"], "超大杯");
  assert.equal(chinese["settings.fontSizeXl"], "超超大杯");
});

test("chat context-menu copy stays user-facing", () => {
  assert.equal(english["chat.copyFailed"], "Couldn't copy to the clipboard");
  assert.equal(english["chat.messageMenu"], "Message actions");
  assert.equal(english["chat.copyConversation"], "Copy conversation");
  assert.equal(chinese["chat.copyFailed"], "复制到剪贴板失败");
  assert.equal(chinese["chat.copyConversation"], "复制整个对话");
  assert.equal(chinese["chat.selectMessageText"], "选中消息文本");
});

test("pt-BR keeps security disclosures and action semantics intact", () => {
  const brazilian = flattenCatalog(catalogs["pt-BR"]);
  const importWarning = brazilian["plugins.agentExtension.importConfirm"];
  assert.match(importWarning, /processo/i);
  assert.match(importWarning, /ferramentas|acesso/i);
  assert.match(importWarning, /instru[çc][oõ]es/i);
  assert.match(importWarning, /\bnpm\b/i);
  assert.match(importWarning, /depend[eê]ncias/i);

  assert.match(brazilian["plugins.permissionHelp.clipboard.read"], /hist[oó]rico/i);
  assert.match(brazilian["plugins.permissionHelp.clipboard.write"], /substitu/i);
  assert.match(brazilian["settings.permissionModeDesc"], /sem.{0,24}(?:permiss|autoriza|confirm)/i);
  assert.match(brazilian["settings.permissionModeDesc"], /alterar.{0,20}arquivos?/i);
  assert.match(brazilian["settings.networkInsecureNoticeBody"], /credenciais/i);
  assert.match(brazilian["settings.infiniteProviderRetryDesc"], /API/i);
  assert.match(brazilian["settings.infiniteProviderRetryDesc"], /parar|interromper/i);
  assert.match(brazilian["settings.importModelsScanDesc"], /chaves de API salvas são copiadas/i);
  assert.match(brazilian["settings.importModelsScanDesc"], /logins de assinatura não são/i);
  assert.match(brazilian["settings.copyProviderHint"], /serviço independente/i);
  assert.match(brazilian["settings.copyProviderHint"], /chaves de API.*logins de contas.*cabeçalhos personalizados não são copiados/i);
  assert.match(brazilian["settings.copyProviderHint"], /modelo padrão.*inalterado/i);
  assert.match(brazilian["settings.apiStyleChooseCustom"], /conta do provedor/i);
  assert.match(brazilian["settings.apiStyleChooseCustom"], /formato de API compatível.*salvar este serviço/i);
  assert.match(brazilian["settings.modelsFallbackNote"], /somente o modelo configurado está disponível/i);
  assert.match(brazilian["plugins.marketEmpty"], /nenhum plugin corresponde à sua pesquisa/i);
  assert.doesNotMatch(brazilian["chat.queuedPromptEmpty"], /vazi[oa]/i);
  assert.match(brazilian["chat.queuedPromptEmpty"], /mensagem na fila/i);
  assert.match(brazilian["settings.promptEnhancementCustomTemplate"], /modelo personalizado/i);
  assert.equal(brazilian["settings.smoothStreaming"], "Exibição gradual");
  assert.match(brazilian["settings.smoothStreamingDesc"], /caractere por caractere/i);
  assert.match(brazilian["settings.smoothStreamingDesc"], /máquina de escrever/i);
  assert.match(brazilian["settings.smoothStreamingDesc"], /reduzir animações/i);

  assert.doesNotMatch(brazilian["project.clear"], /excluir|deletar/i);
  assert.doesNotMatch(brazilian["notifications.clearAll"], /excluir|deletar/i);
  assert.match(brazilian["chat.acHint"], /Enter/);
  assert.match(brazilian["chat.acHint"], /Esc/);
});
