import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SubagentDefinition, UserSubagentRecord } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { useHostCollection } from "../../hooks/use-host-collection";
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
  draftFromDefinition,
  draftFromRecord,
  emptySubagentDraft,
  mergeSubagentToolGrant,
  subagentPresetCopyKey,
  type SubagentDraft,
} from "./SubagentEditorSheet";
import { EMPTY_SUBAGENT_PAGE, fetchSubagentPageData } from "./subagent-settings";
import {
  IconBot,
  IconCopy,
  IconFolderOpen,
  IconPencil,
  IconPlus,
  IconTrash,
} from "../icons";
import { TooltipButton } from "../ui";
const GLOBAL_SUBAGENTS_PATH = "~/.agents/subagents";

type SubagentEditorState = {
  draft: SubagentDraft;
  editing: UserSubagentRecord | null;
  /** Selected template chip; set when Copy as mine pre-fills a builtin. */
  presetId?: string;
};

function builtinDisplayName(
  id: string,
  t: (key: string) => string,
): string {
  const key = subagentPresetCopyKey(id, "name");
  return key ? t(key) : id;
}

export function AgentSubagentsPage() {
  const { t } = useTranslation();
  const showToast = useAppStore((state) => state.showToast);
  const {
    data: { owned, builtins },
    setData: setSubagents,
    loading,
    refreshing,
    reload: load,
  } = useHostCollection(fetchSubagentPageData, EMPTY_SUBAGENT_PAGE, (error) =>
    showToast(error instanceof Error ? error.message : String(error), { variant: "error" }),
  );
  const [search, setSearch] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [editor, setEditor] = useState<SubagentEditorState | null>(null);
  const [saving, setSaving] = useState(false);
  const { armed, setArmed } = useArmedDelete();
  const ownedHandles = useMemo(() => new Set(owned.map((row) => row.id)), [owned]);

  /**
   * The switch flips locally first and only reverts if the host refuses, so one
   * row's request never blanks the list or freezes the others.
   */
  const toggle = async (subagent: UserSubagentRecord) => {
    if (busyId === subagent.id) return;
    const next = !subagent.enabled;
    setBusyId(subagent.id);
    setSubagents((current) => ({
      ...current,
      owned: current.owned.map((row) =>
        row.id === subagent.id ? { ...row, enabled: next } : row,
      ),
    }));
    try {
      await api.setUserSubagentEnabled(subagent.id, next);
      showToast(
        t(next ? "settings.capabilityEnabled" : "settings.capabilityDisabled", {
          name: subagent.name || subagent.id,
        }),
        { variant: "success" },
      );
    } catch (error) {
      setSubagents((current) => ({
        ...current,
        owned: current.owned.map((row) =>
          row.id === subagent.id ? { ...row, enabled: subagent.enabled } : row,
        ),
      }));
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

  const copyBuiltin = (definition: SubagentDefinition) => {
    setEditor({
      draft: draftFromDefinition(definition),
      editing: null,
      presetId: definition.name,
    });
  };

  const save = async () => {
    if (!editor) return;
    const { draft, editing } = editor;
    const payload = {
      name: draft.name.trim(),
      description: draft.description.trim(),
      body: draft.body,
      tools: mergeSubagentToolGrant(draft.inheritTools, draft.tools),
      // An empty string clears a pinned model; omitting it would keep the old one.
      model: draft.model.trim(),
      fallbackModels: draft.fallbackModels.map((pin) => pin.trim()),
      thinkingLevel: draft.thinkingLevel,
      // `0` clears the output cap, so the delegate follows the model again.
      maxTokens: draft.maxTokens,
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

  const visibleOwned = useMemo(
    () =>
      owned.filter((subagent) =>
        matchesCapabilitySearch(search, subagent.name, subagent.id, subagent.description),
      ),
    [search, owned],
  );

  const visibleBuiltins = useMemo(
    () =>
      builtins.filter((definition) =>
        matchesCapabilitySearch(
          search,
          builtinDisplayName(definition.name, t),
          definition.name,
          definition.description,
        ),
      ),
    [builtins, search, t],
  );

  const openCreate = () => setEditor({ draft: emptySubagentDraft(), editing: null });
  const searching = Boolean(search.trim());
  const noMatches = searching && visibleOwned.length === 0 && visibleBuiltins.length === 0;
  const showOwnedGroup = !searching || visibleOwned.length > 0;

  const renderBuiltin = (definition: SubagentDefinition) => {
    const handle = definition.name;
    const name = builtinDisplayName(handle, t);
    const canCopy = !ownedHandles.has(handle);
    return (
      <CapabilityRow
        key={`builtin:${handle}`}
        glyph={<IconBot size={16} />}
        name={name}
        command={t("extensions.subagents.handle", { name: handle })}
        badges={
          <span className="agent-capability-badge">{t("extensions.subagents.sourceBuiltin")}</span>
        }
        description={definition.description || t("settings.noCapabilityDescription")}
        meta={
          definition.tools?.length ? (
            <>
              {definition.tools.map((tool) => (
                <code key={tool}>{tool}</code>
              ))}
            </>
          ) : undefined
        }
        actions={
          canCopy ? (
            <TooltipButton
              type="button"
              className="settings-icon-button"
              tooltip={t("extensions.subagents.copy")}
              onClick={() => copyBuiltin(definition)}
            >
              <IconCopy size={15} />
            </TooltipButton>
          ) : null
        }
      />
    );
  };

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
            <TooltipButton
              type="button"
              className="settings-icon-button"
              ariaLabel={t("extensions.subagents.rowActions", { name })}
              tooltip={t("extensions.subagents.edit")}
              disabled={busy}
              onClick={() => void openEdit(subagent)}
            >
              <IconPencil size={15} />
            </TooltipButton>
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
        {noMatches ? (
          <CapabilityEmpty
            message={t("settings.capabilityNoMatches")}
            hint={t("settings.capabilityNoMatchesHint")}
            icon={<IconBot size={18} />}
          />
        ) : (
          <>
            {visibleBuiltins.length > 0 ? (
              <>
                <CapabilityGroupHeader
                  label={t("extensions.subagents.sourceBuiltin")}
                  count={visibleBuiltins.length}
                />
                {visibleBuiltins.map(renderBuiltin)}
              </>
            ) : null}
            {showOwnedGroup ? (
              <>
                <CapabilityGroupHeader
                  label={t("settings.globalLevel")}
                  path={GLOBAL_SUBAGENTS_PATH}
                  count={visibleOwned.length}
                />
                {visibleOwned.length === 0 ? (
                  <CapabilityEmpty
                    message={t("settings.subagentsEmpty")}
                    icon={<IconBot size={18} />}
                    action={addButton}
                  />
                ) : (
                  visibleOwned.map(renderRow)
                )}
              </>
            ) : null}
          </>
        )}
      </CapabilityPanel>

      {editor ? (
        <SubagentEditorSheet
          draft={editor.draft}
          setDraft={(draft) => setEditor((current) => (current ? { ...current, draft } : current))}
          editing={editor.editing}
          initialPresetId={editor.presetId}
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
