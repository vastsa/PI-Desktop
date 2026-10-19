/**
 * Session rows use a two-click delete arm. Project rows use an explicit modal
 * so dismissal can never be mistaken for confirmation.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const LOCALE_IDS = ["en", "zh-CN", "zh-TW", "de", "es", "fr", "ko", "tr", "pt-BR"];

/** The label every locale arms its delete item with. */
const CONFIRM_LABELS = {
  en: "Delete?",
  "zh-CN": "确认删除？",
  "zh-TW": "確認刪除？",
  de: "Löschen?",
  es: "¿Eliminar?",
  fr: "Supprimer ?",
  ko: "삭제할까요?",
  tr: "Silinsin mi?",
  "pt-BR": "Excluir?",
};

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const [
  hookSource,
  sidebarSource,
  projectsSource,
  capabilityLayoutSource,
  skillsPageSource,
  ...localeSources
] = await Promise.all([
  read("../src/hooks/use-armed-delete.ts"),
  read("../src/components/Sidebar.tsx"),
  read("../src/pages/ProjectsPage.tsx"),
  read("../src/components/settings/AgentCapabilityLayout.tsx"),
  read("../src/components/settings/AgentSkillsPage.tsx"),
  ...LOCALE_IDS.map((id) => read(`../../../packages/i18n/src/locales/${id}/index.ts`)),
]);

const catalogs = new Map(LOCALE_IDS.map((id, index) => [id, localeSources[index]]));

/** A top-level catalog block, so a key lookup cannot match another namespace. */
function catalogBlock(source, name, next) {
  const start = source.search(new RegExp(`^  "?${name}"?: \\{`, "m"));
  assert.ok(start >= 0, `${name} block starts`);
  const rest = source.slice(start + 1);
  const end = rest.search(new RegExp(`^  "?${next}"?: \\{`, "m"));
  assert.ok(end > 0, `${name} block ends`);
  return rest.slice(0, end);
}

function blockValue(block, key) {
  const match = block.match(new RegExp(`^    "?${key}"?:\\s*"([^"]*)"`, "m"));
  assert.ok(match, `${key} is defined in the block`);
  return match[1];
}

/** The body of one two-step delete handler, up to its closing brace. */
function handlerBlock(source, name) {
  const start = source.indexOf(`const ${name} = `);
  assert.ok(start >= 0, `${name} exists`);
  const rest = source.slice(start);
  const end = rest.indexOf("\n  };");
  assert.ok(end > 0, `${name} closes`);
  return rest.slice(0, end);
}

test("the arm expires on its own and has a single owner", () => {
  assert.match(hookSource, /export const ARMED_DELETE_MS = 3200/);
  assert.match(hookSource, /const timer = setTimeout\(\(\) => setArmed\(null\), timeoutMs\)/);
  assert.match(hookSource, /return \(\) => clearTimeout\(timer\)/);

  // The settings capability rows keep importing the hook from their shared
  // layout, and the layout re-exports the one implementation instead of
  // carrying a second copy with its own timeout.
  assert.match(capabilityLayoutSource, /export \{ useArmedDelete \} from "\.\.\/\.\.\/hooks\/use-armed-delete"/);
  assert.doesNotMatch(capabilityLayoutSource, /export function useArmedDelete/);
  assert.doesNotMatch(capabilityLayoutSource, /DELETE_CONFIRM_MS/);
  assert.match(skillsPageSource, /useArmedDelete\(\)/);
});

test("only session rows use the shared two-step delete arm", () => {
  assert.match(
    sidebarSource,
    /import \{ useArmedDelete \} from "\.\.\/hooks\/use-armed-delete"/,
  );
  assert.match(
    sidebarSource,
    /const \{ armed: armedDelete, setArmed: setArmedDelete \} = useArmedDelete\(\)/,
  );
  assert.doesNotMatch(projectsSource, /useArmedDelete|armedDelete/);

  const projectRequest = handlerBlock(sidebarSource, "requestDeleteProject");
  assert.match(projectRequest, /setDeleteProjectFor\(entry\)/);
  assert.doesNotMatch(projectRequest, /armedDelete|deleteProjectAction/);
});

test("the session menu deletes on the second click, not the first", () => {
  assert.match(sidebarSource, /id: "delete-session"/);
  assert.match(sidebarSource, /onSelect: \(\) => requestDeleteSession\(session\),/);
  // The item shows which click it is on, for the pointer and for the tests.
  assert.match(
    sidebarSource,
    /label:[\s\S]*?armedDelete === session\.id[\s\S]*?t\("nav\.deleteTaskConfirm", \{ defaultValue: "Delete\?" \}\)[\s\S]*?t\("nav\.deleteTask", \{ defaultValue: "Delete" \}\)/,
  );

  const request = handlerBlock(sidebarSource, "requestDeleteSession");
  assert.match(request, /if \(armedDelete !== session\.id\) \{/);
  assert.match(request, /setArmedDelete\(session\.id\);\s*return;/);
  assert.match(request, /setArmedDelete\(null\);\s*void deleteSession\(session\);/);
  assert.ok(
    request.indexOf("deleteSession(session)") > request.indexOf("setArmedDelete(session.id)"),
    "the delete runs only behind the arm",
  );
  // Nothing closes the menu on the first click, so the second one can land on
  // the very same item.
  assert.doesNotMatch(request, /closeMenus/);
});

test("the session delete label ships in every catalog", () => {
  for (const id of LOCALE_IDS) {
    const source = catalogs.get(id);
    const expected = CONFIRM_LABELS[id];
    assert.equal(
      blockValue(catalogBlock(source, "nav", "sessionCollaboration"), "deleteTaskConfirm"),
      expected,
      id,
    );
    if (id !== "en") {
      assert.notEqual(expected, CONFIRM_LABELS.en, `${id} is translated`);
    }
  }

  assert.equal(
    blockValue(catalogBlock(catalogs.get("zh-CN"), "settings", "project"), "capabilityRemoveConfirm"),
    "再点一次删除",
  );
});
