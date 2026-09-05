import assert from "node:assert/strict";
import { test } from "vitest";
import { en, flattenCatalog, zhCN } from "../src/index.ts";

const english = flattenCatalog(en);
const chinese = flattenCatalog(zhCN);

test("shell status and crash copy stay user-facing", () => {
  assert.equal(english["app.tagline"], "Local AI coding partner");
  assert.equal(
    english["app.uiCrashed"],
    "Something went wrong with the interface",
  );
  assert.equal(english["status.hostOk"], "Connected");
  assert.equal(english["status.degraded"], "Limited");
  assert.equal(english["status.fatal"], "Can't reach the local service");
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
});

test("common setup and marketplace copy avoid developer jargon", () => {
  assert.equal(
    english["chat.emptyHint"],
    "Add a provider and open a project to start.",
  );
  assert.equal(english["nav.temporarySessions"], "Temporary chats");
  assert.equal(english["menu.refreshMarket"], "Refresh marketplace");
  assert.equal(english["settings.providers"], "AI providers");
  assert.equal(
    english["settings.apiStyleDesc"],
    "The request format this service expects.",
  );
  assert.match(english["project.subtitle"], /active project/);
  assert.doesNotMatch(english["chat.emptyHint"], /Configure a provider/);
  assert.doesNotMatch(english["menu.refreshMarket"], /from repo/i);
  assert.doesNotMatch(english["status.hostOk"], /Host/i);
  assert.doesNotMatch(english["status.fatal"], /backend/i);
  assert.equal(chinese["nav.temporarySessions"], "临时对话");
  assert.equal(chinese["settings.providers"], "AI 服务");
  assert.equal(chinese["menu.refreshMarket"], "刷新插件市场");
  assert.equal(chinese["chat.emptyHint"], "添加服务并打开项目即可开始。");
});

test("Plan mode and Auto permission copy stay explicit in both locales", () => {
  assert.equal(english["settings.modePlan"], "Plan");
  assert.equal(chinese["settings.modePlan"], "规划");
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

test("page copy keeps actions and removes redundant explanatory paragraphs", () => {
  assert.equal(english["project.archiveSubtitle"], "Opened folders and their chats.");
  assert.equal(english["scheduled.emptyBody"], "Create a task above.");
  assert.equal(english["panel.empty.body"], "Choose a tool or open a resource.");
  assert.equal(chinese["project.archiveSubtitle"], "已打开的文件夹及其对话。");
  assert.equal(chinese["scheduled.emptyBody"], "请在上方创建任务。");
  assert.equal(chinese["panel.empty.body"], "选择工具或打开资源。");
  assert.doesNotMatch(english["project.archiveSubtitle"], /without losing|Activate|archive the rest/);
  assert.doesNotMatch(chinese["project.archiveSubtitle"], /可以|而不丢失/);
});
