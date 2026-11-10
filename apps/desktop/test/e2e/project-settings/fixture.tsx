import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { IPC, parseProjectAgentSettings, type ProjectAgentSettings, type ProjectGroupRecord, type ProjectCapabilityCatalog } from "@pi-desktop/shared";
import { ProjectCreateDialog } from "../../../src/components/ProjectCreateDialog";
import { ProjectEditDialog } from "../../../src/components/ProjectEditDialog";
import { ProjectInstructionsDialog } from "../../../src/components/ProjectInstructionsDialog";
import { ProjectAgentSettingsFields } from "../../../src/components/ProjectAgentSettingsFields";
import { useAppStore } from "../../../src/stores/app-store";
import "../../../src/styles/tokens.css";
import "../../../src/styles/base.css";
import "../../../src/styles/ui-kit.css";
import "../../../src/styles/project-create-dialog.css";
import "../../../src/styles/projects.css";

await i18n.use(initReactI18next).init({ lng: "en", keySeparator: false,
  resources: { en: { translation: flattenCatalog(catalogs.en) }, "zh-CN": { translation: flattenCatalog(catalogs["zh-CN"]) } }, interpolation: { escapeValue: false } });
const t = (key: string) => { if (!i18n.exists(key)) throw new Error(`Missing translation ${key}`); return String(i18n.t(key)); };
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const nextTask = () => new Promise<void>((resolve) => {
  const channel = new MessageChannel();
  channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); resolve(); };
  channel.port2.postMessage(null);
});
async function until(predicate: () => unknown, message: string) {
  const deadline = performance.now() + 6_000;
  while (!predicate() && performance.now() < deadline) await nextTask();
  check(predicate(), `${message}: ${document.body.textContent?.slice(-2_500)}`);
}
async function click(node: HTMLButtonElement | HTMLInputElement | null | undefined) {
  check(node && !node.disabled, `Expected enabled control: ${node?.outerHTML ?? "missing"}; ${document.body.textContent?.slice(-2_000)}`);
  flushSync(() => node.click()); await nextTask(); await nextTask();
}
async function edit(node: HTMLInputElement | HTMLTextAreaElement | null, value: string) {
  check(node, "Missing input");
  const prototype = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(node, value);
  flushSync(() => node.dispatchEvent(new Event("input", { bubbles: true })));
  await nextTask();
}
const button = (key: string) => [...document.querySelectorAll<HTMLButtonElement>("button")]
  .find(node => node.textContent?.trim() === t(key) || node.getAttribute("aria-label") === t(key));
const choice = (name: string) => [...document.querySelectorAll<HTMLLabelElement>("label")]
  .find(node => node.textContent?.includes(name))?.querySelector<HTMLInputElement>('input[type="checkbox"]');
const groupChoices = (key: string) => document.querySelector(`[role="group"][aria-label="${t(key)}"]`)
  ?.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
let catalog: ProjectCapabilityCatalog = { skills: [{ id: "skill/a", name: "Skill Alpha" }, { id: "skill/b", name: "Skill Beta" }],
  mcpServers: [{ id: "mcp/a", name: "MCP Alpha" }, { id: "mcp/b", name: "MCP Beta" }] };
let groups: ProjectGroupRecord[] = [];
let markdown = "";
const writes: { method: string; settings: ProjectAgentSettings }[] = [];
const unexpected: string[] = [];
const errors: string[] = [];
let heldCatalog: ReturnType<typeof deferred<ProjectCapabilityCatalog>> | undefined;
let catalogCalls = 0;
const stamp = "2026-11-01T00:00:00.000Z";
function project(name: string, path: string, settings: ProjectAgentSettings): ProjectGroupRecord {
  return { id: "fixture-group", name, primaryPath: path, roots: [{ path, name: "project", position: 0 }],
    createdAt: stamp, updatedAt: stamp, ...("capabilities" in settings ? { capabilities: settings.capabilities } : {}) };
}
Object.defineProperty(window, "piDesktop", { value: {
  platform: "win32", on() { return () => {}; },
  async invoke(method: string, payload: Record<string, unknown> = {}) {
    let data: unknown;
    if (method === IPC.invoke.projectCapabilitiesList) { catalogCalls++; data = heldCatalog ? await heldCatalog.promise : catalog; }
    else if (method === IPC.invoke.projectPickFolders) data = { folders: ["/fixture/project"], canceled: false };
    else if (method === IPC.invoke.projectGroupList) data = { groups: structuredClone(groups) };
    else if (method === IPC.invoke.projectGroupInstructionsGet) data = { content: markdown };
    else if (method === IPC.invoke.projectGroupInstructionsSave) { markdown = String(payload.content); data = { content: markdown }; }
    else if ([IPC.invoke.projectGroupCreate, IPC.invoke.projectGroupUpdate, IPC.invoke.projectGroupRename].includes(method)) {
      const settings = parseProjectAgentSettings(payload);
      writes.push({ method, settings });
      if (settings.instructions !== undefined) markdown = settings.instructions;
      groups = [project(String(payload.name), "/fixture/project", { capabilities: groups[0]?.capabilities, ...settings })];
      data = { group: structuredClone(groups[0]) };
    } else if (method === IPC.invoke.projectSet) data = { workspace: { path: String(payload.path), name: groups[0]?.name ?? "Fixture" } };
    else if (method === IPC.invoke.appGetOnboarding) data = { completed: true };
    else { unexpected.push(method); throw new Error(`Unexpected IPC ${method}`); }
    return { ok: true, data };
  },
} });
const root = createRoot(document.getElementById("root")!);
const checks: string[] = [];
const onError = (error: unknown) => { errors.push(String(error)); };
let closed = 0;
function showEdit() {
  flushSync(() => root.render(<ProjectEditDialog key={`edit-${closed}`} project={{ path: "/fixture/project", name: "Fixture", groupId: "fixture-group" }}
    onClose={() => { closed++; }} onSaved={() => {}} onError={onError} />));
}
function Fields({ path }: { path: string }) {
  const [value, setValue] = useState<ProjectAgentSettings>({ capabilities: { skillIds: ["missing/skill"] } });
  return <ProjectAgentSettingsFields projectPath={path} value={value} onChange={setValue} />;
}
Object.assign(window, { projectSettingsProbe: async () => {
  try {
    flushSync(() => useAppStore.setState({ ready: true, createProjectDialogOpen: true, settings: null,
      workspace: null, openProjects: [], openProjectPaths: [], projectMeta: {} }));
    flushSync(() => root.render(<ProjectCreateDialog />));
    await until(() => choice("Skill Alpha") && !choice("Skill Alpha")!.disabled, "Catalog did not load");
    await click(button("project.createAddFolder"));
    await until(() => document.querySelector(".project-create-folder-row"), "Folder was not added");
    await until(() => choice("Skill Beta") && !choice("Skill Beta")!.disabled, "Folder catalog not ready");
    await click(choice("Skill Beta"));
    await click(choice("MCP Alpha"));
    await click(choice("MCP Beta"));
    await edit(document.querySelector("textarea"), "# App-owned\nPROJECT-CONTEXT");
    await click(button("project.createAction"));
    await until(() => !useAppStore.getState().createProjectDialogOpen, "Create did not complete");
    check(writes.length === 1 && JSON.stringify(writes[0].settings.capabilities) === JSON.stringify({ skillIds: ["skill/a"], mcpServerIds: [] }), "Create lost selections");
    check(markdown === "# App-owned\nPROJECT-CONTEXT", "Create lost Markdown");
    checks.push("create-through-store");

    showEdit();
    await until(() => document.querySelector<HTMLTextAreaElement>("textarea")?.value === markdown && choice("Skill Alpha") && !choice("Skill Alpha")!.disabled, "Saved settings not loaded");
    check(choice("Skill Alpha")?.checked && !choice("Skill Beta")?.checked && !choice("MCP Alpha")?.checked, "Selection did not round-trip");
    await edit(document.querySelector("textarea"), "界".repeat(10_923));
    check(button("project.editAction")?.disabled, "UTF-8 size limit was not enforced");
    await edit(document.querySelector("textarea"), "# Revised");
    await click(groupChoices("project.agentSkills")?.[0]);
    await click(choice("MCP Alpha"));
    await click(button("project.editAction"));
    await until(() => closed === 1, "Edit did not complete");
    check(groups[0].capabilities?.skillIds === undefined, "Inherit was not restored");
    check(groups[0].capabilities?.mcpServerIds?.join() === "mcp/a" && markdown === "# Revised", "Edit lost settings");
    checks.push("edit-round-trip-and-byte-limit");

    flushSync(() => root.render(<ProjectInstructionsDialog project={{ name: "Fixture", path: "/fixture/project", legacy: true }}
      onClose={() => {}} onSaved={() => { closed++; }} onError={onError} />));
    await until(() => document.querySelector<HTMLTextAreaElement>("textarea")?.value === "# Revised", "Legacy instruction route did not resolve group");
    await edit(document.querySelector("textarea"), "# Independent Markdown");
    await click(button("settings.instructionsSave"));
    await until(() => closed === 2, "Instructions did not save");
    check(markdown === "# Independent Markdown", "Wrong instructions storage");
    checks.push("app-owned-instructions");

    const before = writes.length;
    await useAppStore.getState().createProjectFromFolders({ name: "Reopen", folders: ["/fixture/project"], agentSettings: {} });
    check(writes.length === before && markdown === "# Independent Markdown", "Untouched reopen overwrote settings");
    await useAppStore.getState().createProjectFromFolders({ name: "Reopen", folders: ["/fixture/project"], agentSettings: { capabilities: { skillIds: [] }, instructions: "" } });
    check(writes.length === before + 1 && groups[0].capabilities?.skillIds?.length === 0 && markdown === "", "Explicit reopen settings were not saved");
    checks.push("existing-project-preservation");

    heldCatalog = deferred();
    flushSync(() => root.render(<Fields path="/old" />));
    await until(() => document.querySelector('[role="status"]'), "Loading state missing");
    const old = heldCatalog;
    heldCatalog = undefined;
    flushSync(() => root.render(<Fields path="/new" />));
    await until(() => choice("Skill Alpha") && !choice("Skill Alpha")!.disabled, "New catalog missing");
    old.resolve({ skills: [{ id: "stale", name: "Stale catalog" }], mcpServers: [] });
    await nextTask(); await nextTask();
    check(!choice("Stale catalog") && choice("missing/skill")?.checked, "Stale response replaced choices or dropped unavailable selection");
    await click(choice("missing/skill"));
    check(!choice("missing/skill"), "Unavailable selection cannot be removed");
    heldCatalog = deferred();
    const expected = catalogCalls + 1;
    flushSync(() => root.render(<Fields path="/failure" />));
    await until(() => catalogCalls === expected, "Failure request missing");
    heldCatalog.reject(new Error("Fixture catalog unavailable"));
    await until(() => document.querySelector('[role="alert"]'), "Catalog error hidden");
    heldCatalog = undefined;
    await click(button("project.agentRetry"));
    await until(() => choice("Skill Alpha") && !choice("Skill Alpha")!.disabled, "Retry failed");
    check(!choice("Skill Alpha")?.checked, "Explicit empty selection widened after retry");
    checks.push("catalog-race-retry-unavailable");
    check(errors.length === 0 && unexpected.length === 0, `Errors: ${errors}; unexpected: ${unexpected}`);
    await document.fonts.ready;
    check(document.documentElement.scrollWidth <= window.innerWidth, "Project settings overflow horizontally");
    return { ok: true, checks, writes: writes.length };
  } catch (error) { return { ok: false, error: error instanceof Error ? error.stack : String(error), errors, unexpected, checks }; }
  finally { root.unmount(); }
} });

// Measure the real dialog rather than asserting a particular CSS implementation.
function assertChoiceLayout(group: Element) {
  const list = group.querySelector<HTMLElement>(".project-agent-settings-options");
  check(list, "Capability choices missing");
  const rows = [...list.querySelectorAll<HTMLLabelElement>("label")];
  check(rows.length === 12, "Expected the complete long-description catalog");
  check(list.scrollHeight > list.clientHeight, "Long catalog must scroll within its bounded list");
  check(list.scrollWidth <= list.clientWidth + 1, "Capability list overflows horizontally");
  for (const [index, row] of rows.entries()) {
    const bounds = row.getBoundingClientRect();
    const copy = row.querySelector<HTMLElement>(".project-agent-settings-option");
    check(copy, "Capability label missing");
    const content = copy.getBoundingClientRect();
    check(content.top >= bounds.top - 1 && content.bottom <= bounds.bottom + 1,
      `Capability row ${index} clips its description: row=${bounds.height}, content=${content.height}`);
    check(content.right <= bounds.right + 1, `Capability row ${index} overflows its width`);
    const next = rows[index + 1]?.getBoundingClientRect();
    check(!next || content.bottom <= next.top, `Capability row ${index} overlaps the next choice`);
  }
  return { list, rows };
}

Object.assign(window, { projectSettingsLayoutProbe: async () => {
  const checks: string[] = [];
  const descriptions = [
    "Generate or edit raster images, illustrations, photos, banners, and project assets with the configured image model. Supports reference images, edits of earlier results, variants, and batches. Prefer existing code-native tools for vector edits.",
    "用于项目资源分析、界面验证与配置检查。完整说明需要自然换行，保留所有文字，不能被压缩到相邻技能或服务的名称上。支持多步骤处理、状态恢复与错误报告。",
    "A service with a long unbroken identifier: " + "resource-catalog-".repeat(24),
  ];
  const options = (kind: string) => Array.from({ length: 12 }, (_, index) => ({
    id: `${kind}/${index}`, name: index === 10 ? `${kind}-` + "long-name-".repeat(18) : `${kind} ${index + 1}`,
    description: descriptions[index % descriptions.length],
  }));
  catalog = { skills: options("Skill"), mcpServers: options("MCP") };
  try {
    for (const language of ["en", "zh-CN"]) {
      await i18n.changeLanguage(language);
      for (const mode of ["create", "edit"]) {
        groups = mode === "edit" ? [project("Fixture", "/fixture/project", {})] : [];
        markdown = "";
        flushSync(() => root.render(null));
        if (mode === "create") {
          flushSync(() => useAppStore.setState({ ready: true, createProjectDialogOpen: true, settings: null,
            workspace: null, openProjects: [], openProjectPaths: [], projectMeta: {} }));
          flushSync(() => root.render(<ProjectCreateDialog />));
          await click(button("project.createAddFolder"));
        } else showEdit();
        await until(() => choice("Skill 12") && !choice("Skill 12")!.disabled, "Long catalog did not load");
        await document.fonts.ready;
        for (const key of ["project.agentSkills", "project.agentMcp"]) {
          const group = document.querySelector(`[role="group"][aria-label="${t(key)}"]`);
          check(group, "Capability group missing");
          const { list, rows } = assertChoiceLayout(group);
          const last = rows.at(-1)!;
          const input = last.querySelector<HTMLInputElement>("input")!;
          input.focus();
          input.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
          await nextTask();
          const bounds = input.getBoundingClientRect();
          const hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
          check(list.scrollTop > 0 && last.contains(hit), `Last capability checkbox is not reachable: ${JSON.stringify({ input: bounds.toJSON(), list: list.getBoundingClientRect().toJSON(), scrollTop: list.scrollTop })}`);
          check(document.activeElement === input && input.checked, "Last capability cannot receive focus");
          flushSync(() => last.click());
          await nextTask();
          check(!input.checked && !group.querySelector<HTMLInputElement>("input")?.checked,
            "Clicking a long label did not leave inheritance and deselect its own choice");
        }
        check(document.documentElement.scrollWidth <= window.innerWidth, "Dialog overflows the viewport horizontally");
        const previousWrites = writes.length;
        await click(button(mode === "create" ? "project.createAction" : "project.editAction"));
        await until(() => writes.length === previousWrites + 1, "Layout interaction did not save");
        const saved = writes.at(-1)!.settings.capabilities;
        check(saved?.skillIds?.length === 11 && !saved.skillIds.includes("Skill/11"), "Skill click saved the wrong choice");
        check(saved?.mcpServerIds?.length === 11 && !saved.mcpServerIds.includes("MCP/11"), "MCP click saved the wrong choice");
        checks.push(`${language}-${mode}-long-catalog`);
      }
    }
    check(errors.length === 0 && unexpected.length === 0, `Errors: ${errors}; unexpected: ${unexpected}`);
    return { ok: true, checks };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.stack : String(error), checks, errors, unexpected };
  } finally { root.unmount(); }
} });
