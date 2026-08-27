import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { UserSubagentRecord } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import {
  AgentCapabilityPage,
  CapabilityButton,
  CapabilityEmpty,
  CapabilityGroupHeader,
  CapabilityPanel,
  CapabilityRow,
  CapabilityRowMenu,
  CapabilityToggle,
  CapabilityToolbar,
  matchesCapabilitySearch,
  useArmedDelete,
  type CapabilityMenuItem,
} from "./AgentCapabilityLayout";
import {
  SubagentEditorSheet,
  draftFromRecord,
  emptySubagentDraft,
  type SubagentDraft,
} from "./SubagentEditorSheet";
import { IconBot, IconFolderOpen, IconPencil, IconPlus, IconTrash } from "../icons";

const GLOBAL_SUBAGENTS_PATH = "~/.agents/subagents";

type SubagentEditorState = {
  draft: SubagentDraft;
  editing: UserSubagentRecord | null;
};

export function AgentSubagentsPage() {
  const { t } = useTranslation();
  const showToast = useAppStore((state) => state.showToast);
  const [subagents, setSubagents] = useState<UserSubagentRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [editor, setEditor] = useState<SubagentEditorState | null>(null);
  const [saving, setSaving] = useState(false);
  const { armed, setArmed } = useArmedDelete();
  // First paint gets skeletons; everything after keeps the rows on screen.
  const hydrated = useRef(false);

  const load = useCallback(async () => {
    if (hydrated.current) setRefreshing(true);
    else setLoading(true);
    try {
      const result = await api.listUserSubagents({ level: "global" });
      setSubagents(result.subagents ?? []);
      hydrated.current = true;
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
      setSubagents([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [showToast]);

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

  /**
   * The switch flips locally first and only reverts if the host refuses, so one
   * row's request never blanks the list or freezes the others.
   */
  const toggle = async (subagent: UserSubagentRecord) => {
    if (busyId === subagent.id) return;
    const next = !subagent.enabled;
    setBusyId(subagent.id);
    setSubagents((rows) =>
      rows.map((row) => (row.id === subagent.id ? { ...row, enabled: next } : row)),
    );
    try {
      await api.setUserSubagentEnabled(subagent.id, next);
      showToast(
        t(next ? "settings.capabilityEnabled" : "settings.capabilityDisabled", {
          name: subagent.name || subagent.id,
        }),
        { variant: "success" },
      );
    } catch (error) {
      setSubagents((rows) =>
        rows.map((row) =>
          row.id === subagent.id ? { ...row, enabled: subagent.enabled } : row,
        ),
      );
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setBusyId(null);
    }
  };

  const openEdit = async (subagent: UserSubagentRecord) => {
    setBusyId(subagent.id);
    try {
      const result = await api.readUserSubagent(subagent.id);
      setEditor({
        draft: draftFromRecord(result.subagent ?? subagent, result.body ?? ""),
        editing: result.subagent ?? subagent,
      });
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setBusyId(null);
    }
  };

  const save = async () => {
    if (!editor) return;
    const { draft, editing } = editor;
    const payload = {
      name: draft.name.trim(),
      description: draft.description.trim(),
      body: draft.body,
      tools: draft.tools,
      // An empty string clears a pinned model; omitting it would keep the old one.
      model: draft.model.trim(),
      thinkingLevel: draft.thinkingLevel,
      maxTurns: draft.maxTurns,
      enabled: draft.enabled,
      scope: draft.scope,
    };
    setSaving(true);
    try {
      if (editing) await api.updateUserSubagent(editing.id, payload);
      else await api.createUserSubagent(payload);
      await load();
      showToast(
        t(editing ? "settings.subagentSaved" : "settings.subagentCreated", {
          name: payload.name,
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

  const reveal = async (subagent: UserSubagentRecord) => {
    try {
      await api.revealSubagent({ id: subagent.id, path: subagent.path });
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    }
  };

  const remove = async (subagent: UserSubagentRecord) => {
    setBusyId(subagent.id);
    try {
      await api.removeUserSubagent(subagent.id);
      await load();
      showToast(t("settings.capabilityDeleted", { name: subagent.name || subagent.id }), {
        variant: "success",
      });
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setBusyId(null);
      setArmed(null);
    }
  };

  const visible = useMemo(
    () =>
      subagents.filter((subagent) =>
        matchesCapabilitySearch(search, subagent.name, subagent.id, subagent.description),
      ),
    [search, subagents],
  );

  const openCreate = () => setEditor({ draft: emptySubagentDraft(), editing: null });

  const renderRow = (subagent: UserSubagentRecord) => {
    const name = subagent.name || subagent.id;
    const busy = busyId === subagent.id;
    const isArmed = armed === subagent.id;
    const items: CapabilityMenuItem[] = [
      {
        key: "reveal",
        label: t("extensions.subagents.reveal"),
        icon: <IconFolderOpen size={14} />,
        onSelect: () => {
          setMenuFor(null);
          void reveal(subagent);
        },
      },
      {
        key: "remove",
        label: isArmed
          ? t("settings.capabilityRemoveConfirm")
          : t("extensions.subagents.remove"),
        icon: <IconTrash size={14} />,
        danger: true,
        onSelect: () => {
          if (isArmed) {
            setMenuFor(null);
            void remove(subagent);
          } else {
            setArmed(subagent.id);
          }
        },
      },
    ];
    return (
      <CapabilityRow
        key={subagent.id}
        glyph={<IconBot size={16} />}
        name={name}
        off={!subagent.enabled}
        menuOpen={menuFor === subagent.id}
        badges={<span className="agent-capability-badge">{t("settings.globalOnly")}</span>}
        description={subagent.description || t("settings.noCapabilityDescription")}
        meta={
          subagent.tools?.length ? (
            <>
              {subagent.tools.map((tool) => (
                <code key={tool}>{tool}</code>
              ))}
            </>
          ) : undefined
        }
        actions={
          <>
            <button
              type="button"
              className="settings-icon-button"
              aria-label={t("extensions.subagents.rowActions", { name })}
              title={t("extensions.subagents.edit")}
              disabled={busy}
              onClick={() => void openEdit(subagent)}
            >
              <IconPencil size={15} />
            </button>
            <CapabilityRowMenu
              label={t("extensions.subagents.rowActions", { name })}
              items={items}
              disabled={busy}
              open={menuFor === subagent.id}
              onOpenChange={(open) => {
                setMenuFor(open ? subagent.id : null);
                if (!open) setArmed(null);
              }}
            />
            <CapabilityToggle
              checked={subagent.enabled}
              busy={busy}
              label={t("settings.toggleCapability", { name })}
              onChange={() => void toggle(subagent)}
            />
          </>
        }
      />
    );
  };

  const addButton = (
    <CapabilityButton variant="primary" onClick={openCreate}>
      <IconPlus size={14} />
      {t("extensions.subagents.add")}
    </CapabilityButton>
  );

  return (
    <AgentCapabilityPage
      className="agent-subagents-page"
      description={t("settings.subagentsDescription")}
      note={t("settings.subagentsOnlyGlobal")}
      toolbar={
        <CapabilityToolbar
          search={search}
          onSearchChange={setSearch}
          searchPlaceholder={t("extensions.subagents.searchPlaceholder")}
          actions={addButton}
        />
      }
    >
      <CapabilityPanel
        loading={loading}
        refreshing={refreshing}
        loadingLabel={t("settings.loadingCapabilities")}
      >
        <CapabilityGroupHeader
          label={t("settings.globalLevel")}
          path={GLOBAL_SUBAGENTS_PATH}
          count={visible.length}
        />
        {visible.length === 0 ? (
          search.trim() ? (
            <CapabilityEmpty
              message={t("settings.capabilityNoMatches")}
              hint={t("settings.capabilityNoMatchesHint")}
              icon={<IconBot size={18} />}
            />
          ) : (
            <CapabilityEmpty
              message={t("settings.subagentsEmpty")}
              icon={<IconBot size={18} />}
              action={addButton}
            />
          )
        ) : (
          visible.map(renderRow)
        )}
      </CapabilityPanel>

      {editor ? (
        <SubagentEditorSheet
          draft={editor.draft}
          setDraft={(draft) => setEditor((current) => (current ? { ...current, draft } : current))}
          editing={editor.editing}
          saving={saving}
          onClose={() => {
            if (!saving) setEditor(null);
          }}
          onSave={() => void save()}
          onReveal={editor.editing ? () => void reveal(editor.editing!) : undefined}
        />
      ) : null}
    </AgentCapabilityPage>
  );
}
