import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { readMainSource } from "./helpers/main-source.mjs";
import { readStoreSource } from "./helpers/store-source.mjs";

const read = (relativePath) => readFile(new URL(relativePath, import.meta.url), "utf8");

const [dialog, editDialog, store, api, protocol, main, styles] = await Promise.all([
  read("../src/components/ProjectCreateDialog.tsx"),
  read("../src/components/ProjectEditDialog.tsx"),
  readStoreSource(),
  read("../src/lib/api.ts"),
  read("../../../packages/shared/src/protocol.ts"),
  readMainSource(),
  read("../src/styles/project-create-dialog.css"),
]);

test("create project dialog supports named multi-folder setup", () => {
  assert.match(dialog, /role="dialog"/);
  assert.doesNotMatch(dialog, /project\.createNamePlaceholder/);
  assert.match(dialog, /api\.pickProjectFolders\(\)/);
  assert.match(dialog, /result\.folders/);
  assert.match(dialog, /project\.createRemoveFolder/);
  assert.match(dialog, /project\.createPrimary/);
  assert.match(dialog, /data-project-source="local"/);
  assert.doesNotMatch(dialog, /project\.createMemoryHint/);
  assert.doesNotMatch(dialog, /project\.createAddFolderHint/);
  assert.doesNotMatch(dialog, /aria-describedby="project-create-memory-hint"/);
  assert.match(dialog, /project-create-dialog-content/);
  assert.match(dialog, /project-create-dialog-section/);
  assert.match(dialog, /project-create-dialog-field-label/);
  // The name field is optional: the dialog derives a default from the source.
  assert.match(dialog, /defaultProjectName\(\{/);
  assert.match(dialog, /resolveProjectName\(name, defaultName\)/);
  assert.match(dialog, /setName\(defaultName\)/);
  assert.match(dialog, /: !projectName \|\| folders\.length === 0 \|\| busy/);
  assert.match(dialog, /querySelectorAll<HTMLElement>\(/);
});

test("create project dialog can create the project from a git checkout", () => {
  // Same dialog, same name field: the source toggle turns the folder list into
  // one repository URL plus its clone destination.
  assert.match(dialog, /type ProjectSource = "local" \| "git"/);
  assert.match(dialog, /data-project-source="git"/);
  assert.match(dialog, /parseGitCloneUrl/);
  assert.match(dialog, /project\.createSourceLabel/);
  assert.match(dialog, /project\.createRepositoryLabel/);
  assert.match(dialog, /project\.createChooseLocation/);
  assert.match(dialog, /project\.cloneDestHint/);
  assert.match(dialog, /api\.pickProjectFolders\(\)/);
  assert.match(dialog, /createProjectFromGit\(\{/);
  assert.match(dialog, /url: cloneTarget\.url/);
  assert.match(dialog, /parentPath: cloneParent/);
  assert.match(dialog, /!projectName \|\| !cloneTarget \|\| !cloneParent \|\| busy/);
  assert.match(dialog, /project\.cloning/);
  assert.match(store, /createProjectFromGit: async \(\{ name, url, parentPath \}\)/);
  assert.match(store, /api\.cloneProjectInto\(url, parentPath\)/);
  assert.match(store, /folders: \[checkout\.path\], primaryPath: checkout\.path/);
  assert.match(api, /cloneProjectInto: \(url: string, parentPath: string\)/);
  assert.match(protocol, /projectCloneCheckout:\s*"pi-desktop\/project\/cloneCheckout"/);
});

test("project creation creates one logical group with a primary workspace", () => {
  assert.match(store, /createProjectDialogOpen: boolean/);
  assert.match(store, /openProject: async \(\) => \{\s*set\(\{ createProjectDialogOpen: true \}\)/);
  assert.match(store, /createProjectFromFolders: async \(\{ name, folders, primaryPath \}\)/);
  assert.match(store, /const orderedFolders = \[/);
  assert.match(store, /api\.createProjectGroup\(normalizedName, orderedFolders\)/);
  assert.match(store, /created\.group\.primaryPath/);
  assert.doesNotMatch(store, /for \(const path of orderedFolders\)/);
  assert.match(store, /get\(\)\.renameProject\(groupPrimary, normalizedName\)/);
  assert.match(store, /set\(\{ createProjectDialogOpen: false, onboarding, page: "chat" \}\)/);
  // Folder picks and git checkouts share one project creation semantic.
  assert.match(store, /async function createNamedProjectGroup\(/);
  assert.match(store, /createProjectFromFolders: async \(\{ name, folders, primaryPath \}\) =>\s*createNamedProjectGroup\(/);
});

test("folder picker is a renderer-only multi-directory selection", () => {
  assert.match(protocol, /projectPickFolders:\s*"pi-desktop\/project\/pickFolders"/);
  assert.match(protocol, /projectGroupCreate:\s*"pi-desktop\/project-group\/create"/);
  assert.match(api, /createProjectGroup: \(name: string, folders: string\[\]\)/);
  assert.match(main, /project\.group\.create/);
  assert.match(api, /pickProjectFolders: \(\) =>[\s\S]*?projectPickFolders/);
  const start = main.indexOf("IPC.invoke.projectPickFolders");
  const end = main.indexOf("IPC.invoke.projectClone", start);
  const handler = main.slice(start, end);
  assert.ok(start >= 0 && end > start, "folder picker handler should exist");
  assert.match(handler, /openDirectory/);
  assert.match(handler, /multiSelections/);
  assert.match(handler, /createDirectory/);
  assert.match(handler, /folders:/);
  assert.doesNotMatch(handler, /workspace\.set/);
});

test("project folder pickers ignore repeated requests while a dialog is open", () => {
  for (const source of [dialog, editDialog]) {
    assert.match(source, /const folderPickerInFlightRef = useRef\(false\)/);
    assert.match(
      source,
      /if \(busyRef\.current \|\| folderPickerInFlightRef\.current\) return;/,
    );
    assert.match(
      source,
      /folderPickerInFlightRef\.current = true;\s*setFolderPickerBusy\(true\);[\s\S]*?api\.pickProjectFolders\(\)/,
    );
    assert.match(
      source,
      /folderPickerInFlightRef\.current = false;\s*setFolderPickerBusy\(false\);/,
    );
  }
  assert.match(main, /let projectPickerActive = false/);
  assert.match(main, /const openProjectPicker = async/);
  assert.match(main, /if \(!result \|\| result\.canceled/);
  assert.match(main, /const owner = getMainWindow\(\)/);
});

test("clone checkout handler clones without touching the active workspace", () => {
  const start = main.indexOf("IPC.invoke.projectCloneCheckout");
  const end = main.indexOf("IPC.invoke.projectSet", start);
  const handler = main.slice(start, end);
  assert.ok(start >= 0 && end > start, "clone checkout handler should exist");
  assert.match(handler, /parentPath/);
  assert.match(handler, /cloneGitRepository\(\{ url, parentPath \}\)/);
  // The renderer still creates the group, so the handler never sets a workspace.
  assert.doesNotMatch(handler, /workspace\.set/);
  assert.doesNotMatch(handler, /dialog\.showOpenDialog/);
});

test("the stylesheet keeps balanced blocks and no duplicated tail", () => {
  // A stray trailing fragment still matched every surface assertion above while
  // breaking the Tailwind build ("Missing opening {"), so the sheet's blocks are
  // checked structurally instead of by pattern.
  const open = (styles.match(/{/g) ?? []).length;
  const close = (styles.match(/}/g) ?? []).length;
  assert.equal(open, close, "every style block must be closed");
  const tail = styles.slice(-200);
  assert.equal(
    (tail.match(/transition: none;/g) ?? []).length,
    1,
    "the reduced-motion block keeps exactly one declaration group",
  );
  assert.match(tail, /\}\s*\}\s*$/);
});

test("create project dialog remains usable on narrow screens and reduced motion", () => {
  assert.match(styles, /width: min\(100%, 480px\)/);
  assert.match(styles, /border-radius: var\(--radius-lg-plus\)/);
  assert.match(styles, /font-size: var\(--text-lg\)/);
  assert.match(styles, /font-size: var\(--text-base\)/);
  assert.match(styles, /gap: 16px/);
  assert.match(styles, /padding: 14px 18px 18px/);
  assert.match(styles, /@media \(max-width: 520px\)/);
  assert.match(styles, /align-items: flex-end/);
  assert.match(styles, /min-height: 48px/);
  assert.match(styles, /project-create-dialog-actions/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(styles, /overflow-y: auto/);
  assert.match(styles, /\.project-create-dialog-source-options \{/);
  assert.match(styles, /\.project-create-dialog-source-option\.is-active \{/);
  assert.match(styles, /\.project-create-dialog-location\.is-chosen/);
  assert.match(styles, /\.project-create-dialog-clone-hint \{/);
});

test("create project dialog stays lineless (D297)", () => {
  assert.match(styles, /\.project-create-dialog-source-option \{[^}]*border: 0;/);
  assert.match(
    styles,
    /\.project-create-dialog-source-option\.is-active \{[^}]*background: var\(--ds-tile-deep\);/,
  );
  assert.doesNotMatch(styles, /border: 1px solid var\(--ds-border-subtle\)/);
  assert.doesNotMatch(styles, /\.project-create-dialog-name-field:focus-visible/);
  assert.doesNotMatch(styles, /outline-offset: 2px/);
  assert.match(
    styles,
    /\.project-create-dialog-source-option:focus-visible,[^}]*box-shadow: 0 0 0 2px color-mix\(in oklab, var\(--ds-accent\) 22%, transparent\);/,
  );
});
