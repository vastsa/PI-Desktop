/**
 * The session and project rows delete in two clicks: the first click arms the
 * menu item and relabels it, the second removes the row. The arm is the same
 * one the settings capability rows use (`hooks/use-armed-delete.ts`), and it
 * expires on its own so a row never stays one stray click away from a
 * permanent delete.
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

test("the session and project rows share that arm", () => {
  for (const [surface, source] of [
    ["Sidebar", sidebarSource],
    ["ProjectsPage", projectsSource],
  ]) {
    assert.match(
      source,
      /import \{ useArmedDelete \} from "\.\.\/hooks\/use-armed-delete"/,
      surface,
    );
    assert.match(source, /const \{ armed: armedDelete, setArmed: setArmedDelete \} = useArmedDelete\(\)/);
  }
});

test("the session menu deletes on the second click, not the first", () => {
  assert.match(sidebarSource, /data-action="delete-session"/);
  assert.match(sidebarSource, /onClick=\{\(\) => requestDeleteSession\(session\)\}/);
  // The item shows which click it is on, for the pointer and for the tests.
  assert.match(sidebarSource, /data-armed=\{armedDelete === session\.id \? "true" : undefined\}/);
  assert.match(
    sidebarSource,
    /className=\{cx\("danger", armedDelete === session\.id && "is-armed"\)\}/,
  );
  assert.match(
    sidebarSource,
    /\{armedDelete === session\.id\s*\?\s*t\("nav\.deleteTaskConfirm", \{ defaultValue: "Delete\?" \}\)\s*:\s*t\("nav\.deleteTask", \{ defaultValue: "Delete" \}\)\}/,
  );
  // The session ids are the armed keys of the sidebar's session items, and the
  // project items namespace theirs so the two menus can never share an arm.
  assert.match(sidebarSource, /const projectDeleteKey = \(entry: ProjectEntry\) => `project:\$\{entry\.key\}`/);

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

test("both delete labels ship in every catalog and read the same", () => {
  for (const id of LOCALE_IDS) {
    const source = catalogs.get(id);
    const expected = CONFIRM_LABELS[id];
    assert.equal(blockValue(catalogBlock(source, "nav", "sessionCollaboration"), "deleteTaskConfirm"), expected, id);
    assert.equal(blockValue(catalogBlock(source, "project", "pulls"), "deleteMenuConfirm"), expected, id);
    if (id !== "en") {
      assert.notEqual(expected, CONFIRM_LABELS.en, `${id} is translated`);
    }
  }

  // The armed label states the same action in the settings rows the pattern is
  // copied from, so the two surfaces never disagree about what a second click
  // does.
  assert.equal(
    blockValue(catalogBlock(catalogs.get("zh-CN"), "settings", "project"), "capabilityRemoveConfirm"),
    "再点一次删除",
  );
});
