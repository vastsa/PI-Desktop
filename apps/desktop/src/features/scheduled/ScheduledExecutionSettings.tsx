import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  type GlobalPermissionMode,
  type ProjectRecord,
  type SessionThinkingLevel,
} from "@pi-desktop/shared";
import { IconFolder } from "../../components/icons";
import { SettingsMenuSelect } from "../../components/settings/SettingsMenuSelect";
import { useAppStore } from "../../stores/app-store";
import { ScheduledModelPicker } from "./ScheduledModelPicker";
import { ComposerPermissionPicker } from "../chat/composer/ComposerPermissionPicker";


export type ScheduledModelSelection = {
  providerId?: string;
  modelId?: string;
  thinkingLevel?: SessionThinkingLevel;
};

function projectLabel(path: string, name?: string): string {
  if (name?.trim()) return name.trim();
  const segments = path.replaceAll("\\", "/").split("/").filter(Boolean);
  return segments.at(-1) || path;
}

export function ScheduledExecutionSettings({
  workspacePath,
  projects,
  permissionMode,
  modelSelection,
  busy,
  onWorkspaceChange,
  onPermissionChange,
  onModelChange,
}: {
  workspacePath: string;
  projects: readonly ProjectRecord[];
  permissionMode: GlobalPermissionMode;
  modelSelection: ScheduledModelSelection;
  busy: boolean;
  onWorkspaceChange: (path: string) => void;
  onPermissionChange: (mode: GlobalPermissionMode) => void;
  onModelChange: (selection: ScheduledModelSelection) => void;
}) {
  const { t } = useTranslation();
  const [permissionOpen, setPermissionOpen] = useState(false);
  useEffect(() => { if (busy) setPermissionOpen(false); }, [busy]);
  const currentWorkspacePath = useAppStore((state) => state.workspace?.path ?? "");
  const projectOptions = useMemo(() => {
    const seen = new Set<string>();
    const result: Array<{ id: string; label: string }> = [];
    const add = (path: string | null | undefined, name?: string) => {
      const value = path?.trim();
      if (!value) return;
      const key = value.replaceAll("\\", "/").toLocaleLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      result.push({ id: value, label: projectLabel(value, name) });
    };
    add(workspacePath);
    add(currentWorkspacePath);
    for (const project of projects) add(project.path, project.name);
    return result;
  }, [currentWorkspacePath, projects, workspacePath]);

  return (
    <div className="composer-toolbar scheduled-execution-toolbar">
      <div className="composer-left">
        <SettingsMenuSelect
          className="scheduled-execution-project"
          triggerClassName="icon-btn mode-chip scheduled-execution-trigger"
          leading={<IconFolder size={14} />}
          label={t("settings.selectProject")}
          value={workspacePath}
          disabled={busy || projectOptions.length === 0}
          options={
            projectOptions.length
              ? projectOptions
              : [{ id: "", label: t("settings.noProjects"), disabled: true }]
          }
          onChange={onWorkspaceChange}
        />
        <ComposerPermissionPicker t={t} mode="agent"
          composerPermissionMode={permissionMode}
          effectiveReviewer={useAppStore.getState().settings?.approvalReviewer ?? "user"}
          sessionReviewer="inherit"
          hasActiveSession={false}
          permissionOpen={permissionOpen} setPermissionOpen={setPermissionOpen}
          controlsBlocked={busy} onCloseOtherMenus={() => {}}
          onSelect={onPermissionChange} onSelectReviewer={() => {}} />
      </div>
      <div className="composer-right">
        <ScheduledModelPicker value={modelSelection} disabled={busy} onChange={onModelChange} />
      </div>
    </div>
  );
}
