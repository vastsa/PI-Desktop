import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  GLOBAL_SCOPE,
  type AgentCapabilityLevel,
  type McpServerRecord,
  type McpServerStatus,
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
  draftFromRecord,
  draftToInput,
  emptyMcpDraft,
  McpEditorSheet,
  type McpDraft,
} from "../extensions/McpEditorSheet";
import { IconPencil, IconPlay, IconPlus, IconServer, IconTerminal, IconTrash } from "../icons";
import { cx } from "../ui";

const GLOBAL_MCP_PATH = "~/.agents/servers";

function projectMcpPath(projectPath: string | null): string {
  return projectPath ? `${projectPath}/.agents/servers` : "<project-root>/.agents/servers";
}

function statusFor(
  statuses: readonly McpServerStatus[],
  server: McpServerRecord,
): McpServerStatus | undefined {
  return statuses.find((status) => status.serverId === server.id);
}

type McpEditorState = {
  draft: McpDraft;
  editing: McpServerRecord | null;
  level: AgentCapabilityLevel;
};

export function AgentMcpPage() {
  const { t } = useTranslation();
  const showToast = useAppStore((state) => state.showToast);
  const { selectedProjectPath, setSelectedProjectPath, options } = useAgentProjects();
  const [globalServers, setGlobalServers] = useState<McpServerRecord[]>([]);
  const [projectServers, setProjectServers] = useState<McpServerRecord[]>([]);
  const [statuses, setStatuses] = useState<McpServerStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<CapabilityFilter>("all");
  const [search, setSearch] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [editor, setEditor] = useState<McpEditorState | null>(null);
  const [saving, setSaving] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const { armed, setArmed } = useArmedDelete();
  // Skeletons belong to the first paint only; later reloads dim the list instead
  // of tearing it down, so toggling a server never blinks the page away.
  const hydrated = useRef(false);

  const load = useCallback(async () => {
    if (hydrated.current) setRefreshing(true);
    else setLoading(true);
    try {
      const [global, project] = await Promise.all([
        api.listMcpServers({
          level: "global",
          ...(selectedProjectPath ? { projectPath: selectedProjectPath } : {}),
        }),
        selectedProjectPath
          ? api.listMcpServers({ level: "project", projectPath: selectedProjectPath })
          : Promise.resolve({
              servers: [] as McpServerRecord[],
              statuses: [] as McpServerStatus[],
            }),
      ]);
      setGlobalServers(global.servers ?? []);
      setProjectServers(project.servers ?? []);
      setStatuses([...(global.statuses ?? []), ...(project.statuses ?? [])]);
      hydrated.current = true;
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
      setGlobalServers([]);
      setProjectServers([]);
      setStatuses([]);
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
  const levelQuery = (level: AgentCapabilityLevel) => ({
    level,
    ...(selectedProjectPath ? { projectPath: selectedProjectPath } : {}),
  });

  const patchRow = (
    level: AgentCapabilityLevel,
    id: string,
    patch: Partial<McpServerRecord>,
  ) => {
    const setter = level === "global" ? setGlobalServers : setProjectServers;
    setter((rows) => rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  };

  /** New servers land at whichever level the filter is pointing at. */
  const targetLevel: AgentCapabilityLevel = filter === "project" ? "project" : "global";

  const openCreate = () => {
    if (targetLevel === "project" && !selectedProjectPath) {
      showToast(t("settings.selectProjectFirst"), { variant: "error" });
      return;
    }
    setEditor({
      draft: {
        ...emptyMcpDraft(),
        scope:
          targetLevel === "global"
            ? GLOBAL_SCOPE
            : { mode: "projects", projects: [selectedProjectPath!] },
      },
      editing: null,
      level: targetLevel,
    });
  };

  const openEdit = (server: McpServerRecord, level: AgentCapabilityLevel) => {
    setMenuFor(null);
    setEditor({ draft: draftFromRecord(server), editing: server, level });
  };

  const save = async () => {
    if (!editor) return;
    const projectPath = editor.level === "project" ? selectedProjectPath ?? undefined : undefined;
    const candidateId = editor.draft.id.trim();
    const candidateLabel = editor.draft.label.trim().toLocaleLowerCase();
    const sameLevel = (editor.level === "global" ? globalServers : projectServers).some(
      (server) =>
        server.id !== editor.editing?.id &&
        (server.id === candidateId ||
          (!!candidateLabel && server.label.trim().toLocaleLowerCase() === candidateLabel)),
    );
    if (sameLevel) {
      showToast(t("settings.mcpDuplicate"), { variant: "error" });
      return;
    }
    setSaving(true);
    try {
      await api.upsertMcpServer(draftToInput(editor.draft, { level: editor.level, projectPath }));
      await load();
      showToast(
        t(editor.editing ? "settings.mcpSaved" : "settings.mcpAdded", {
          name: editor.draft.label || editor.draft.id,
        }),
        { variant: "success" },
      );
      setEditor(null);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (server: McpServerRecord, level: AgentCapabilityLevel) => {
    const key = rowKey(level, server.id);
    if (busyId) return;
    const next = !server.enabled;
    setBusyId(key);
    // Flip locally first: the host is the authority, but a round-trip of latency
    // on a switch reads as a broken control.
    patchRow(level, server.id, { enabled: next });
    try {
      await api.setMcpServerEnabled(server.id, next, levelQuery(level));
      showToast(
        t(next ? "settings.capabilityEnabled" : "settings.capabilityDisabled", {
          name: server.label || server.id,
        }),
        { variant: "success" },
      );
    } catch (error) {
      patchRow(level, server.id, { enabled: server.enabled });
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setBusyId(null);
    }
  };

  const testConnection = async (server: McpServerRecord, level: AgentCapabilityLevel) => {
    if (testingId) return;
    setTestingId(server.id);
    try {
      const result = await api.testMcpServer(server.id, {
        level,
        ...(level === "project" && selectedProjectPath
          ? { projectPath: selectedProjectPath }
          : {}),
      });
      setStatuses((current) => [
        ...current.filter((status) => status.serverId !== server.id),
        result.status,
      ]);
      if (result.status.state === "ready") {
        showToast(t("extensions.mcp.testReady", { count: result.status.toolCount }), {
          variant: "success",
        });
      } else if (result.status.state === "failed") {
        showToast(result.status.message || t("extensions.mcp.testFailed"), { variant: "error" });
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setTestingId(null);
    }
  };

  const remove = async (server: McpServerRecord, level: AgentCapabilityLevel) => {
    const key = rowKey(level, server.id);
    setBusyId(key);
    try {
      await api.removeMcpServer(server.id, levelQuery(level));
      await load();
      showToast(t("settings.capabilityDeleted", { name: server.label || server.id }), {
        variant: "success",
      });
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setBusyId(null);
      setArmed(null);
    }
  };

  const visible = useMemo(() => {
    const match = (server: McpServerRecord) =>
      matchesCapabilitySearch(
        search,
        server.label,
        server.id,
        server.description,
        server.transport === "http" ? server.url : server.command,
      );
    return {
      global: globalServers.filter(match),
      project: projectServers.filter(match),
    };
  }, [globalServers, projectServers, search]);

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

  const renderRow = (server: McpServerRecord, level: AgentCapabilityLevel) => {
    const key = rowKey(level, server.id);
    const name = server.label || server.id;
    const status = statusFor(statuses, server);
    const busy = busyId === key;
    const testing = testingId === server.id;
    const isArmed = armed === key;
    const items: CapabilityMenuItem[] = [
      {
        key: "test",
        label: t("extensions.mcp.test"),
        icon: <IconPlay size={14} />,
        disabled: testing,
        onSelect: () => {
          setMenuFor(null);
          void testConnection(server, level);
        },
      },
      {
        key: "remove",
        label: isArmed ? t("settings.capabilityRemoveConfirm") : t("extensions.mcp.remove"),
        icon: <IconTrash size={14} />,
        danger: true,
        onSelect: () => {
          if (isArmed) {
            setMenuFor(null);
            void remove(server, level);
          } else {
            setArmed(key);
          }
        },
      },
    ];
    return (
      <CapabilityRow
        key={key}
        glyph={server.transport === "http" ? <IconServer size={16} /> : <IconTerminal size={16} />}
        glyphState={status?.state}
        name={name}
        off={!server.enabled}
        menuOpen={menuFor === key}
        command={server.transport === "http" ? server.url : server.command}
        badges={
          <>
            <span className="agent-capability-badge is-level">
              {level === "global"
                ? t("settings.capabilityFilterGlobal")
                : t("settings.capabilityFilterProject")}
            </span>
            <span className="agent-capability-badge">
              {server.transport === "http"
                ? t("settings.transportHttp")
                : t("settings.transportStdio")}
            </span>
            {status && status.state !== "idle" ? (
              <span className={cx("agent-capability-badge", "is-status", `is-${status.state}`)}>
                <span className="agent-capability-status-dot" aria-hidden="true" />
                {status.state === "ready"
                  ? t("extensions.mcp.toolCount", { count: status.toolCount })
                  : t(`extensions.mcp.state.${status.state}`)}
              </span>
            ) : null}
          </>
        }
        description={server.description || t("settings.noCapabilityDescription")}
        actions={
          <>
            <button
              type="button"
              className="settings-icon-button"
              aria-label={t("settings.editMcpOf", { name })}
              title={t("settings.editMcp")}
              disabled={busy}
              onClick={() => openEdit(server, level)}
            >
              <IconPencil size={15} />
            </button>
            <CapabilityRowMenu
              label={t("extensions.mcp.rowActions", { name })}
              items={items}
              disabled={busy}
              open={menuFor === key}
              onOpenChange={(open) => {
                setMenuFor(open ? key : null);
                if (!open) setArmed(null);
              }}
            />
            <CapabilityToggle
              checked={server.enabled}
              busy={busy || testing}
              label={t("settings.toggleCapability", { name })}
              onChange={() => void toggle(server, level)}
            />
          </>
        }
      />
    );
  };

  const showGlobal = filter !== "project";
  const showProject = filter !== "global";
  const addButton = (
    <CapabilityButton
      variant="primary"
      title={
        targetLevel === "project"
          ? t("settings.capabilityCreateInProject")
          : t("settings.capabilityCreateInGlobal")
      }
      onClick={openCreate}
    >
      <IconPlus size={14} />
      {t("settings.addMcp")}
    </CapabilityButton>
  );

  return (
    <AgentCapabilityPage
      description={t("settings.mcpDescription")}
      note={t("settings.capabilityPriority")}
      toolbar={
        <CapabilityToolbar
          filter={filter}
          onFilterChange={setFilter}
          counts={counts}
          search={search}
          onSearchChange={setSearch}
          searchPlaceholder={t("extensions.mcp.searchPlaceholder")}
          projectPicker={
            <AgentProjectPicker
              value={selectedProjectPath}
              options={options}
              label={t("settings.selectProject")}
              onChange={setSelectedProjectPath}
            />
          }
          actions={addButton}
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
            icon={<IconServer size={18} />}
          />
        ) : (
          <>
            {showGlobal ? (
              <>
                <CapabilityGroupHeader
                  label={t("settings.globalLevel")}
                  path={GLOBAL_MCP_PATH}
                  count={visible.global.length}
                />
                {visible.global.length === 0 ? (
                  <CapabilityEmpty
                    message={t("settings.mcpEmpty")}
                    icon={<IconServer size={18} />}
                    action={addButton}
                  />
                ) : (
                  visible.global.map((server) => renderRow(server, "global"))
                )}
              </>
            ) : null}
            {showProject ? (
              <>
                <CapabilityGroupHeader
                  label={t("settings.projectLevel")}
                  path={projectMcpPath(selectedProjectPath)}
                  count={visible.project.length}
                />
                {!selectedProjectPath ? (
                  <CapabilityEmpty message={t("settings.selectProjectFirst")} />
                ) : visible.project.length === 0 ? (
                  <CapabilityEmpty
                    message={t("settings.mcpEmpty")}
                    icon={<IconServer size={18} />}
                  />
                ) : (
                  visible.project.map((server) => renderRow(server, "project"))
                )}
              </>
            ) : null}
          </>
        )}
      </CapabilityPanel>

      {editor ? (
        <McpEditorSheet
          draft={editor.draft}
          setDraft={(draft) => setEditor((current) => (current ? { ...current, draft } : current))}
          editing={editor.editing}
          saving={saving}
          status={editor.editing ? statusFor(statuses, editor.editing) : undefined}
          testing={testingId === editor.editing?.id}
          projects={[]}
          currentProjectPath={selectedProjectPath}
          managementLevel={editor.level}
          managementProjectName={projectName}
          onClose={() => {
            if (!saving && !testingId) setEditor(null);
          }}
          onSave={() => void save()}
          onTest={() => {
            if (editor.editing) void testConnection(editor.editing, editor.level);
          }}
        />
      ) : null}
    </AgentCapabilityPage>
  );
}
