import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  GLOBAL_SCOPE,
  type AgentCapabilityLevel,
  type UserSkillRecord,
} from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
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
  IconBookOpen,
  IconDownload,
  IconFolderOpen,
  IconPencil,
  IconPlus,
  IconTrash,
} from "../icons";

const GLOBAL_SKILLS_PATH = "~/.agents/skills";

function projectSkillsPath(projectPath: string | null): string {
  return projectPath ? `${projectPath}/.agents/skills` : "<project-root>/.agents/skills";
}

type SkillEditorState = {
  draft: SkillDraft;
  editing: UserSkillRecord | null;
  level: AgentCapabilityLevel;
};

export function AgentSkillsPage() {
  const { t } = useTranslation();
  const showToast = useAppStore((state) => state.showToast);
  const { selectedProjectPath, setSelectedProjectPath, options } = useAgentProjects();
  const [globalSkills, setGlobalSkills] = useState<UserSkillRecord[]>([]);
  const [projectSkills, setProjectSkills] = useState<UserSkillRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<CapabilityFilter>("all");
  const [search, setSearch] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [editor, setEditor] = useState<SkillEditorState | null>(null);
  const [saving, setSaving] = useState(false);
  const { armed, setArmed } = useArmedDelete();
  // First paint gets skeletons; everything after keeps the rows on screen.
  const hydrated = useRef(false);

  const load = useCallback(async () => {
    if (hydrated.current) setRefreshing(true);
    else setLoading(true);
    try {
      const [global, project] = await Promise.all([
        api.listUserSkills({
          level: "global",
          ...(selectedProjectPath ? { projectPath: selectedProjectPath } : {}),
        }),
        selectedProjectPath
          ? api.listUserSkills({ level: "project", projectPath: selectedProjectPath })
          : Promise.resolve({ skills: [] as UserSkillRecord[] }),
      ]);
      setGlobalSkills(global.skills ?? []);
      setProjectSkills(project.skills ?? []);
      hydrated.current = true;
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
      setGlobalSkills([]);
      setProjectSkills([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [selectedProjectPath, showToast]);

  useEffect(() => {
    void load();
    const offPluginChanged = api.onPluginChanged(() => void load());
    const offHostStatus = api.onHostStatus((status) => {
      if (status.ok) void load();
    });
    return () => {
      offPluginChanged();
      offHostStatus();
    };
  }, [load]);

  const rowKey = (level: AgentCapabilityLevel, id: string) => `${level}:${id}`;

  const patchRow = (
    level: AgentCapabilityLevel,
    id: string,
    patch: Partial<UserSkillRecord>,
  ) => {
    const apply = (rows: UserSkillRecord[]) =>
      rows.map((row) => (row.id === id ? { ...row, ...patch } : row));
    if (level === "global") setGlobalSkills(apply);
    else setProjectSkills(apply);
  };

  const levelQuery = (level: AgentCapabilityLevel) => ({
    level,
    ...(selectedProjectPath ? { projectPath: selectedProjectPath } : {}),
  });

  /**
   * The switch flips locally first and only reverts if the host refuses, so one
   * row's request never blanks the list or freezes the others.
   */
  const toggle = async (skill: UserSkillRecord, level: AgentCapabilityLevel) => {
    const key = rowKey(level, skill.id);
    if (busyId === key) return;
    const next = !skill.enabled;
    setBusyId(key);
    patchRow(level, skill.id, { enabled: next });
    try {
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
      setBusyId(null);
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
    setBusyId(key);
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
      setBusyId(null);
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
    setBusyId(key);
    try {
      await api.removeUserSkill(skill.id, levelQuery(level));
      await load();
      showToast(t("settings.capabilityDeleted", { name: skill.name || skill.id }), {
        variant: "success",
      });
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setBusyId(null);
      setArmed(null);
    }
  };

  const importSkill = async (level: AgentCapabilityLevel = targetLevel) => {
    if (level === "project" && !selectedProjectPath) {
      showToast(t("settings.selectProjectFirst"), { variant: "error" });
      return;
    }
    setBusyId("import");
    try {
      const result = await api.importUserSkill({
        level,
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
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setBusyId(null);
    }
  };

  const visible = useMemo(() => {
    const match = (skill: UserSkillRecord) =>
      matchesCapabilitySearch(search, skill.name, skill.id, skill.description);
    return {
      global: globalSkills.filter(match),
      project: projectSkills.filter(match),
    };
  }, [globalSkills, projectSkills, search]);

  const counts = {
    all: visible.global.length + visible.project.length,
    global: visible.global.length,
    project: visible.project.length,
  };

  const projectName = useMemo(
    () =>
      options.find((project) => project.path === selectedProjectPath)?.name ??
      (selectedProjectPath ? projectDisplayName(selectedProjectPath) : undefined),
    [options, selectedProjectPath],
  );

  const renderRow = (skill: UserSkillRecord, level: AgentCapabilityLevel) => {
    const key = rowKey(level, skill.id);
    const name = skill.name || skill.id;
    const busy = busyId === key;
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
            {skill.source === "imported" ? (
              <span className="agent-capability-badge">{t("settings.imported")}</span>
            ) : null}
          </>
        }
        description={skill.description || t("settings.noCapabilityDescription")}
        actions={
          <>
            <button
              type="button"
              className="settings-icon-button"
              aria-label={t("extensions.skills.rowActions", { name })}
              title={t("extensions.skills.edit")}
              disabled={busy}
              onClick={() => void openEdit(skill, level)}
            >
              <IconPencil size={15} />
            </button>
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

  const showGlobal = filter !== "project";
  const showProject = filter !== "global";
  const newSkillTitle =
    targetLevel === "project"
      ? t("settings.capabilityCreateInProject")
      : t("settings.capabilityCreateInGlobal");
  const importButton = (level: AgentCapabilityLevel) => (
    <CapabilityButton
      busy={busyId === "import"}
      title={
        level === "project"
          ? t("settings.capabilityImportToProject")
          : t("settings.capabilityImportToGlobal")
      }
      onClick={() => void importSkill(level)}
    >
      <IconDownload size={14} />
      {t("settings.importSkill")}
    </CapabilityButton>
  );

  return (
    <AgentCapabilityPage
      description={t("settings.skillsDescription")}
      note={t("settings.capabilityPriority")}
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
            <CapabilityButton variant="primary" title={newSkillTitle} onClick={openCreate}>
              <IconPlus size={14} />
              {t("settings.newSkill")}
            </CapabilityButton>
          }
        />
      }
    >
      <CapabilityPanel
        loading={loading}
        refreshing={refreshing}
        loadingLabel={t("settings.loadingCapabilities")}
      >
        {counts.all === 0 && search.trim() ? (
          <CapabilityEmpty
            message={t("settings.capabilityNoMatches")}
            hint={t("settings.capabilityNoMatchesHint")}
            icon={<IconBookOpen size={18} />}
          />
        ) : (
          <>
            {showGlobal ? (
              <>
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
