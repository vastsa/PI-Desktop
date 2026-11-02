import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  GLOBAL_SCOPE,
  type AgentCapabilityLevel,
  type BuiltinSkillRecord,
  type UserSkillRecord,
} from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { capabilityQuery, deriveProjectOverrides, type CapabilityOverride } from "../../lib/capability-scope";
import { useAppStore } from "../../stores/app-store";
import { useHostCollection } from "../../hooks/use-host-collection";
import { useRowBusy } from "../../hooks/use-row-busy";
import {
  AgentCapabilityPage,
  AgentProjectPicker,
  CapabilityButton,
  CapabilityEmpty,
  CapabilityGroupHeader,
  CapabilityPanel,
  CapabilityRow,
  CapabilityRowMenu,
  CapabilityToggle,
  CapabilityToolbar,
  matchesCapabilitySearch,
  projectDisplayName,
  useAgentProjects,
  useArmedDelete,
  type CapabilityFilter,
  type CapabilityMenuItem,
} from "./AgentCapabilityLayout";
import {
  SkillEditorSheet,
  draftFromSkill,
  emptySkillDraft,
  type SkillDraft,
} from "./SkillEditorSheet";
import {
  IconArrowUpDown,
  IconBookOpen,
  IconDownload,
  IconFileText,
  IconFolderOpen,
  IconPencil,
  IconPlus,
  IconRefresh,
  IconTrash,
} from "../icons";
import { SkillMarketPanel } from "./SkillMarketPanel";
import { AgentSkillImportPanel } from "../../features/settings/imports/AgentSkillImportPanel";
import { ImportToggleButton } from "../../features/settings/import-workbench";

import { TooltipButton } from "../ui";
const GLOBAL_SKILLS_PATH = "~/.agents/skills";

function projectSkillsPath(projectPath: string | null): string {
  return projectPath ? `${projectPath}/.agents/skills` : "<project-root>/.agents/skills";
}

type SkillEditorState = {
  draft: SkillDraft;
  editing: UserSkillRecord | null;
  level: AgentCapabilityLevel;
};

type SkillCollection = {
  builtins: BuiltinSkillRecord[];
  global: UserSkillRecord[];
  project: UserSkillRecord[];
  /** Stored per-project overrides on global rows, from the accepted fetch. */
  globalOverrides: Record<string, CapabilityOverride>;
};

const EMPTY_SKILL_COLLECTION: SkillCollection = {
  builtins: [],
  global: [],
  project: [],
  globalOverrides: {},
};

export function AgentSkillsPage() {
  const { t } = useTranslation();
  const showToast = useAppStore((state) => state.showToast);
  const { selectedProjectPath, setSelectedProjectPath, options } = useAgentProjects();
  const fetchSkills = useCallback(async (): Promise<SkillCollection> => {
    // The global list omits the selected project on purpose: its rows read the
    // global default, the same scope the switch writes, so the two can never
    // disagree (#1957). The project-scoped global query runs beside it only to
    // surface stored overrides: the runtime gives them precedence, so a stale
    // one written by the old UI must stay visible and resettable, not hidden.
    const [builtins, global, project, globalEffective] = await Promise.all([
      api.listBuiltinSkills(),
      api.listUserSkills({ level: "global" }),
      selectedProjectPath
        ? api.listUserSkills({ level: "project", projectPath: selectedProjectPath })
        : Promise.resolve({ skills: [] as UserSkillRecord[] }),
      selectedProjectPath
        ? api.listUserSkills({ level: "global", projectPath: selectedProjectPath })
        : Promise.resolve({ skills: [] as UserSkillRecord[] }),
    ]);
    // The derived map rides inside the collection: useHostCollection only
    // accepts the newest request, so a late stale fetch can never repaint the
    // override badges of the project the reader has since switched to.
    return {
      builtins: builtins.builtins ?? [],
      global: global.skills ?? [],
      project: project.skills ?? [],
      globalOverrides: selectedProjectPath
        ? Object.fromEntries(deriveProjectOverrides(global.skills ?? [], globalEffective.skills ?? []))
        : {},
    };
  }, [selectedProjectPath]);
  const {
    data: { builtins: builtinSkills, global: globalSkills, project: projectSkills, globalOverrides },
    setData: setSkills,
    loading,
    refreshing,
    reload: load,
  } = useHostCollection(fetchSkills, EMPTY_SKILL_COLLECTION, (error) =>
    showToast(error instanceof Error ? error.message : String(error), { variant: "error" }),
  );
  const [filter, setFilter] = useState<CapabilityFilter>("all");
  const [importOpen, setImportOpen] = useState(false);
  const [search, setSearch] = useState("");
  const rowBusy = useRowBusy();
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [editor, setEditor] = useState<SkillEditorState | null>(null);
  const [view, setView] = useState<"skills" | "market">("skills");
  const [saving, setSaving] = useState(false);
  const { armed, setArmed } = useArmedDelete();

  const rowKey = (level: AgentCapabilityLevel, id: string) => `${level}:${id}`;
  const builtinRowKey = (id: string) => `builtin:${id}`;

  const patchBuiltin = (id: string, patch: Partial<BuiltinSkillRecord>) => {
    setSkills((current) => ({
      ...current,
      builtins: current.builtins.map((row) => (row.id === id ? { ...row, ...patch } : row)),
    }));
  };

  const patchRow = (
    level: AgentCapabilityLevel,
    id: string,
    patch: Partial<UserSkillRecord>,
  ) => {
    setSkills((current) => ({
      ...current,
      [level]: current[level].map((row) => (row.id === id ? { ...row, ...patch } : row)),
    }));
  };

  const levelQuery = (level: AgentCapabilityLevel) =>
    capabilityQuery(level, selectedProjectPath);

  /**
   * The switch flips locally first and only reverts if the host refuses, so one
   * row's request never blanks the list or freezes the others.
   */
  const toggle = async (skill: UserSkillRecord, level: AgentCapabilityLevel) => {
    const key = rowKey(level, skill.id);
    if (!rowBusy.begin(key)) return;
    const next = !skill.enabled;
    patchRow(level, skill.id, { enabled: next });
    try {
      // The switch writes the row's own level scope: a global skill records
      // the global default, a project row records that project's override.
      await api.setUserSkillEnabled(skill.id, next, levelQuery(level));
      showToast(
        t(next ? "settings.capabilityEnabled" : "settings.capabilityDisabled", {
          name: skill.name || skill.id,
        }),
        { variant: "success" },
      );
    } catch (error) {
      patchRow(level, skill.id, { enabled: skill.enabled });
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      rowBusy.end(key);
    }
  };

  // A stored per-project override keeps runtime precedence over the global
  // default, so it has to be visible and clearable, never just hidden. Writing
  // the current default under the project's scope removes the key: the host
  // drops a per-project entry whose value matches the default.
  const resetProjectOverride = async (skill: UserSkillRecord) => {
    if (!selectedProjectPath) return;
    const key = rowKey("global", skill.id);
    if (!rowBusy.begin(key)) return;
    try {
      await api.setUserSkillEnabled(skill.id, skill.enabled, {
        level: "global",
        projectPath: selectedProjectPath,
      });
      showToast(
        t("settings.capabilityOverrideReset", { name: skill.name || skill.id }),
        { variant: "success" },
      );
      await load();
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      rowBusy.end(key);
    }
  };

  const toggleBuiltin = async (skill: BuiltinSkillRecord) => {
    const key = builtinRowKey(skill.id);
    if (!rowBusy.begin(key)) return;
    const next = !skill.enabled;
    patchBuiltin(skill.id, { enabled: next });
    try {
      await api.setBuiltinSkillEnabled(skill.id, next);
      showToast(
        t(next ? "settings.capabilityEnabled" : "settings.capabilityDisabled", {
          name: skill.name || skill.id,
        }),
        { variant: "success" },
      );
    } catch (error) {
      patchBuiltin(skill.id, { enabled: skill.enabled });
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      rowBusy.end(key);
    }
  };

  /** Where a new or imported skill lands: the filtered level, global when both. */
  const targetLevel: AgentCapabilityLevel = filter === "project" ? "project" : "global";

  const openCreate = () => {
    if (targetLevel === "project" && !selectedProjectPath) {
      showToast(t("settings.selectProjectFirst"), { variant: "error" });
      return;
    }
    setEditor({
      draft: {
        ...emptySkillDraft(),
        scope:
          targetLevel === "global"
            ? GLOBAL_SCOPE
            : { mode: "projects", projects: [selectedProjectPath!] },
      },
      editing: null,
      level: targetLevel,
    });
  };

  const openEdit = async (skill: UserSkillRecord, level: AgentCapabilityLevel) => {
    const key = rowKey(level, skill.id);
    if (!rowBusy.begin(key)) return;
    try {
      const result = await api.readUserSkill(skill.id, levelQuery(level));
      setEditor({
        draft: draftFromSkill(result.skill ?? skill, result.body ?? ""),
        editing: result.skill ?? skill,
        level,
      });
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      rowBusy.end(key);
    }
  };

  const save = async () => {
    if (!editor) return;
    const { draft, editing, level } = editor;
    const projectPath = level === "project" ? selectedProjectPath ?? undefined : undefined;
    const payload = {
      name: draft.name.trim(),
      description: draft.description.trim(),
      body: draft.body,
      enabled: draft.enabled,
      scope: draft.scope,
      level,
      ...(projectPath ? { projectPath } : {}),
    };
    setSaving(true);
    try {
      if (editing) await api.updateUserSkill(editing.id, payload);
      else await api.createUserSkill(payload);
      await load();
      showToast(
        t(editing ? "settings.skillSaved" : "settings.skillCreated", { name: payload.name }),
        { variant: "success" },
      );
      setEditor(null);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setSaving(false);
    }
  };

  const reveal = async (skill: UserSkillRecord, level: AgentCapabilityLevel) => {
    try {
      await api.revealUserSkill(skill.id, levelQuery(level));
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    }
  };

  const remove = async (skill: UserSkillRecord, level: AgentCapabilityLevel) => {
    const key = rowKey(level, skill.id);
    if (!rowBusy.begin(key)) return;
    try {
      await api.removeUserSkill(skill.id, levelQuery(level));
      await load();
      showToast(t("settings.capabilityDeleted", { name: skill.name || skill.id }), {
        variant: "success",
      });
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      rowBusy.end(key);
      setArmed(null);
    }
  };

  const importSkill = async (
    level: AgentCapabilityLevel = targetLevel,
    sourceKind: "file" | "dir" = "file",
  ) => {
    if (level === "project" && !selectedProjectPath) {
      showToast(t("settings.selectProjectFirst"), { variant: "error" });
      return;
    }
    const importKey = sourceKind === "dir" ? "import-dir" : "import";
    if (!rowBusy.begin(importKey)) return;
    try {
      const result = await api.importUserSkill({
        level,
        sourceKind,
        ...(level === "project" && selectedProjectPath
          ? { projectPath: selectedProjectPath }
          : {}),
      });
      if (!result.canceled) {
        await load();
        if (result.skill) {
          showToast(t("settings.skillImported", { name: result.skill.name }), {
            variant: "success",
          });
        }
        if (result.imported?.length) {
          showToast(t("settings.skillBatchImported", { count: result.imported.length }), {
            variant: "success",
          });
        }
        if (result.failed?.length) {
          const first = result.failed[0];
          const folder = first.path.split(/[\\/]/).filter(Boolean).at(-1) ?? first.path;
          showToast(t("settings.skillBatchFailed", {
            count: result.failed.length,
            first: `${folder}: ${first.error}`,
          }), { variant: "error" });
        }
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      rowBusy.end(importKey);
    }
  };

  const visible = useMemo(() => {
    const match = (skill: UserSkillRecord) =>
      matchesCapabilitySearch(search, skill.name, skill.id, skill.description);
    const matchBuiltin = (skill: BuiltinSkillRecord) =>
      matchesCapabilitySearch(search, skill.name, skill.id, skill.description);
    return {
      builtins: builtinSkills.filter(matchBuiltin),
      global: globalSkills.filter(match),
      project: projectSkills.filter(match),
    };
  }, [builtinSkills, globalSkills, projectSkills, search]);

  const counts = {
    all: visible.builtins.length + visible.global.length + visible.project.length,
    global: visible.builtins.length + visible.global.length,
    project: visible.project.length,
  };

  const projectName = useMemo(
    () =>
      options.find((project) => project.path === selectedProjectPath)?.name ??
      (selectedProjectPath ? projectDisplayName(selectedProjectPath) : undefined),
    [options, selectedProjectPath],
  );

  /** Where a move sends a row, named the way the toast should say it. */
  const moveTarget: Partial<Record<AgentCapabilityLevel, string>> = {
    global: t("settings.globalLevel"),
    project: selectedProjectPath
      ? `${t("settings.projectLevel")} · ${projectName ?? projectDisplayName(selectedProjectPath)}`
      : undefined,
  };

  /**
   * Move one row to the other level. The project picker owns the destination,
   * so the same action reads "Move into <project>" on a global row and "Move to
   * Global" on a project one.
   *
   * The host moves the document rather than copying it, and a destination that
   * already holds the id or display name renames the arriving skill, so the
   * toast reports the new name instead of pretending the id survived.
   */
  const move = async (skill: UserSkillRecord, level: AgentCapabilityLevel) => {
    const to: AgentCapabilityLevel = level === "global" ? "project" : "global";
    const target = moveTarget[to];
    if (!target) {
      showToast(t("settings.selectProjectFirst"), { variant: "error" });
      return;
    }
    const key = rowKey(level, skill.id);
    if (!rowBusy.begin(key)) return;
    try {
      const result = await api.transferUserSkill({
        id: skill.id,
        from: levelQuery(level),
        to: levelQuery(to),
      });
      await load();
      const name = skill.name || skill.id;
      const arrived = result.skill;
      showToast(
        arrived && arrived.id !== skill.id
          ? t("settings.capabilityMovedRenamed", {
              name,
              target,
              newName: arrived.name || arrived.id,
            })
          : t("settings.capabilityMoved", { name, target }),
        { variant: "success" },
      );
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      rowBusy.end(key);
    }
  };

  const renderRow = (skill: UserSkillRecord, level: AgentCapabilityLevel) => {
    const key = rowKey(level, skill.id);
    const name = skill.name || skill.id;
    const busy = rowBusy.isBusy(key);
    const isArmed = armed === key;
    const items: CapabilityMenuItem[] = [
      {
        key: "reveal",
        label: t("extensions.skills.reveal"),
        icon: <IconFolderOpen size={14} />,
        onSelect: () => {
          setMenuFor(null);
          void reveal(skill, level);
        },
      },
      /**
       * A move needs a destination, so a global row offers it only while the
       * picker names a project; a project row always has Global to go back to.
       */
      ...(moveTarget[level === "global" ? "project" : "global"]
        ? [
            {
              key: "move",
              label:
                level === "global"
                  ? t("settings.capabilityMoveToProject", {
                      project:
                        projectName ?? projectDisplayName(selectedProjectPath ?? ""),
                    })
                  : t("settings.capabilityMoveToGlobal"),
              icon: <IconArrowUpDown size={14} />,
              onSelect: () => {
                setMenuFor(null);
                void move(skill, level);
              },
            } satisfies CapabilityMenuItem,
          ]
        : []),
      ...(level === "global" && selectedProjectPath && globalOverrides[skill.id]
        ? [
            {
              key: "reset-override",
              label: t("settings.capabilityOverrideResetItem"),
              icon: <IconRefresh size={14} />,
              disabled: busy,
              onSelect: () => {
                setMenuFor(null);
                void resetProjectOverride(skill);
              },
            } satisfies CapabilityMenuItem,
          ]
        : []),
      {
        key: "remove",
        label: isArmed ? t("settings.capabilityRemoveConfirm") : t("extensions.skills.remove"),
        icon: <IconTrash size={14} />,
        danger: true,
        onSelect: () => {
          if (isArmed) {
            setMenuFor(null);
            void remove(skill, level);
          } else {
            setArmed(key);
          }
        },
      },
    ];
    return (
      <CapabilityRow
        key={key}
        glyph={<IconBookOpen size={16} />}
        name={name}
        off={!skill.enabled}
        menuOpen={menuFor === key}
        badges={
          <>
            <span className="agent-capability-badge is-level">
              {level === "global"
                ? t("settings.capabilityFilterGlobal")
                : t("settings.capabilityFilterProject")}
            </span>
            {level === "global" && selectedProjectPath && globalOverrides[skill.id] ? (
              <span className="agent-capability-badge is-override">
                {globalOverrides[skill.id] === "off"
                  ? t("settings.capabilityOverrideOff")
                  : t("settings.capabilityOverrideOn")}
              </span>
            ) : null}
            {skill.source === "imported" ? (
              <span className="agent-capability-badge">{t("settings.imported")}</span>
            ) : null}
          </>
        }
        description={skill.description || t("settings.noCapabilityDescription")}
        actions={
          <>
            <TooltipButton
              type="button"
              className="settings-icon-button"
              ariaLabel={t("extensions.skills.rowActions", { name })}
              tooltip={t("extensions.skills.edit")}
              disabled={busy}
              onClick={() => void openEdit(skill, level)}
            >
              <IconPencil size={15} />
            </TooltipButton>
            <CapabilityRowMenu
              label={t("extensions.skills.rowActions", { name })}
              items={items}
              disabled={busy}
              open={menuFor === key}
              onOpenChange={(open) => {
                setMenuFor(open ? key : null);
                if (!open) setArmed(null);
              }}
            />
            <CapabilityToggle
              checked={skill.enabled}
              busy={busy}
              label={t("settings.toggleCapability", { name })}
              onChange={() => void toggle(skill, level)}
            />
          </>
        }
      />
    );
  };

  const renderBuiltinRow = (skill: BuiltinSkillRecord) => {
    const key = builtinRowKey(skill.id);
    const name = skill.name || skill.id;
    const busy = rowBusy.isBusy(key);
    return (
      <CapabilityRow
        key={key}
        glyph={<IconBookOpen size={16} />}
        name={name}
        off={!skill.enabled}
        badges={
          <span className="agent-capability-badge is-level">
            {t("settings.builtin")}
          </span>
        }
        description={skill.description || t("settings.noCapabilityDescription")}
        actions={
          <CapabilityToggle
            checked={skill.enabled}
            busy={busy}
            label={t("settings.toggleCapability", { name })}
            onChange={() => void toggleBuiltin(skill)}
          />
        }
      />
    );
  };

  const showGlobal = filter !== "project";
  const showProject = filter !== "global";
  const newSkillTitle =
    targetLevel === "project"
      ? t("settings.capabilityCreateInProject")
      : t("settings.capabilityCreateInGlobal");
  const importButton = (level: AgentCapabilityLevel) => (
    <>
      <CapabilityButton
        busy={rowBusy.isBusy("import")}
        title={
          level === "project"
            ? t("settings.capabilityImportToProject")
            : t("settings.capabilityImportToGlobal")
        }
        onClick={() => void importSkill(level, "file")}
      >
        <IconDownload size={14} />
        {t("settings.importSkillFile")}
      </CapabilityButton>
      <CapabilityButton
        busy={rowBusy.isBusy("import-dir")}
        title={
          level === "project"
            ? t("settings.capabilityImportToProject")
            : t("settings.capabilityImportToGlobal")
        }
        onClick={() => void importSkill(level, "dir")}
      >
        <IconDownload size={14} />
        {t("settings.importSkillDir")}
      </CapabilityButton>
    </>
  );

  const marketButton = (
    <CapabilityButton
      onClick={() => setView("market")}
    >
      <IconFileText size={14} />
      {t("settings.sklm.browse")}
    </CapabilityButton>
  );

  if (view === "market") {
    return (
      <SkillMarketPanel
        installedIds={[...globalSkills, ...projectSkills].map((skill) => skill.id)}
        onBack={() => {
          setView("skills");
          void load();
        }}
        onInstalled={() => {
          setView("skills");
          void load();
        }}
      />
    );
  }

  return (
    <AgentCapabilityPage
      toolbar={
        <CapabilityToolbar
          filter={filter}
          onFilterChange={setFilter}
          counts={counts}
          search={search}
          onSearchChange={setSearch}
          searchPlaceholder={t("extensions.skills.searchPlaceholder")}
          projectPicker={
            <AgentProjectPicker
              value={selectedProjectPath}
              options={options}
              label={t("settings.selectProject")}
              onChange={setSelectedProjectPath}
            />
          }
          actions={
            <>
              <ImportToggleButton
                open={importOpen}
                controls="agent-skills-import-panel"
                label={t("settings.importSkillFromTools")}
                disabled={targetLevel === "project" && !selectedProjectPath}
                onClick={() => setImportOpen((current) => !current)}
              />
              <CapabilityButton variant="primary" title={newSkillTitle} onClick={openCreate}>
                <IconPlus size={14} />
                {t("settings.newSkill")}
              </CapabilityButton>
              {marketButton}
            </>
          }
        />
      }
    >
      <section
        id="agent-skills-import-panel"
        className="settings-card-block import-inline-section"
        hidden={!importOpen}
      >
        <div className="settings-card-heading-line">
          <h3 className="settings-card-heading">
            {t("settings.importAgentSkillsTitle")}
          </h3>
        </div>
        <div className="import-inline-workbench">
          <AgentSkillImportPanel
            key={`${targetLevel}:${targetLevel === "project" ? selectedProjectPath ?? "" : ""}`}
            level={targetLevel}
            projectPath={targetLevel === "project" ? selectedProjectPath ?? undefined : undefined}
            onImported={load}
          />
        </div>
      </section>

      <CapabilityPanel
        loading={loading}
        refreshing={refreshing}
        loadingLabel={t("settings.loadingCapabilities")}
      >
        {counts.all === 0 && search.trim() ? (
          <CapabilityEmpty
            message={t("settings.capabilityNoMatches")}
            icon={<IconBookOpen size={18} />}
          />
        ) : (
          <>
            {showGlobal ? (
              <>
                <CapabilityGroupHeader
                  label={t("settings.builtinSkills")}
                  count={visible.builtins.length}
                />
                {visible.builtins.map(renderBuiltinRow)}
                <CapabilityGroupHeader
                  label={t("settings.globalLevel")}
                  path={GLOBAL_SKILLS_PATH}
                  count={visible.global.length}
                  action={importButton("global")}
                />
                {visible.global.length === 0 ? (
                  <CapabilityEmpty
                    message={t("settings.skillsEmpty")}
                    icon={<IconBookOpen size={18} />}
                    action={
                      <CapabilityButton variant="primary" onClick={openCreate}>
                        <IconPlus size={14} />
                        {t("extensions.skills.add")}
                      </CapabilityButton>
                    }
                  />
                ) : (
                  visible.global.map((skill) => renderRow(skill, "global"))
                )}
              </>
            ) : null}
            {showProject ? (
              <>
                <CapabilityGroupHeader
                  label={t("settings.projectLevel")}
                  path={projectSkillsPath(selectedProjectPath)}
                  count={visible.project.length}
                  action={selectedProjectPath ? importButton("project") : undefined}
                />
                {!selectedProjectPath ? (
                  <CapabilityEmpty message={t("settings.selectProjectFirst")} />
                ) : visible.project.length === 0 ? (
                  <CapabilityEmpty
                    message={t("settings.skillsEmpty")}
                    icon={<IconBookOpen size={18} />}
                  />
                ) : (
                  visible.project.map((skill) => renderRow(skill, "project"))
                )}
              </>
            ) : null}
          </>
        )}
      </CapabilityPanel>

      {editor ? (
        <SkillEditorSheet
          draft={editor.draft}
          setDraft={(draft) => setEditor((current) => (current ? { ...current, draft } : current))}
          editing={editor.editing}
          saving={saving}
          level={editor.level}
          projectName={projectName}
          onClose={() => {
            if (!saving) setEditor(null);
          }}
          onSave={() => void save()}
          onReveal={
            editor.editing
              ? () => void reveal(editor.editing!, editor.level)
              : undefined
          }
        />
      ) : null}
    </AgentCapabilityPage>
  );
}
