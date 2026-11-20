import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import type { LeftoverWorktree, RemoteEnvironment, RemoteHostSummary } from "@pi-desktop/shared";
import { Button } from "../../../components/ui";
import { api } from "../../../lib/api";
import { useAppStore } from "../../../stores/app-store";
import { SettingsCard, SettingsRow } from "../../settings/primitives";
import { EnvironmentEditor } from "./EnvironmentEditor";
import { useEnvironments } from "./use-environments";

function LeftoverWorktrees({ host }: { host: RemoteHostSummary }) {
  const { t } = useTranslation();
  const [worktrees, setWorktrees] = useState<LeftoverWorktree[]>();
  const [busy, setBusy] = useState(false);
  const toast = useAppStore((state) => state.showToast);
  async function run(task: () => Promise<void>) {
    setBusy(true);
    try { await task(); }
    catch (error) { toast(error instanceof Error ? error.message : String(error), { variant: "error" }); }
    finally { setBusy(false); }
  }
  return <div className="session-target-fields">
    <SettingsRow title={host.label}>
      <Button variant="secondary" disabled={busy || !host.connected} onClick={() => void run(async () => {
        setWorktrees((await api.listRemoteLeftoverWorktrees(host.hostKey)).worktrees);
      })}>{t("sessionTarget.refresh")}</Button>
    </SettingsRow>
    {worktrees?.length === 0 && <p>{t("sessionTarget.noLeftovers")}</p>}
    {worktrees?.map((tree) => <SettingsRow key={tree.sessionId} title={`${tree.repository.owner}/${tree.repository.name} · ${tree.workBranch}`}
      detail={t("sessionTarget.deleteAtRisk", { files: tree.uncommittedFiles, commits: tree.unpushedCommits })}>
      <Button variant="secondary" disabled={busy || !host.connected} onClick={() => {
        if (!window.confirm(t("sessionTarget.deleteAtRisk", { files: tree.uncommittedFiles, commits: tree.unpushedCommits }))) return;
        void run(async () => {
          const { ok } = await api.removeRemoteLeftoverWorktree(host.hostKey, tree.sessionId);
          if (ok) setWorktrees((current) => current?.filter((item) => item.sessionId !== tree.sessionId));
        });
      }}>{t("sessionTarget.remove")}</Button>
    </SettingsRow>)}
  </div>;
}

export function RemoteEnvironmentSettings() {
  const { t } = useTranslation();
  const { hosts, environments, error } = useEnvironments();
  const [editor, setEditor] = useState<RemoteEnvironment | "new" | null>(null);
  const close = useCallback(() => setEditor(null), []);
  const toast = useAppStore((state) => state.showToast);
  if (!hosts.length && !error) return null;

  return <>
    <SettingsCard title={t("sessionTarget.environments")}>
      {error && <p role="alert">{t("sessionTarget.loadFailed", { message: error })}</p>}
      {environments.map((environment) => <SettingsRow key={environment.id} title={environment.name}
        detail={hosts.find((host) => host.hostKey === environment.hostKey)?.label}>
        <div className="session-target-row">
          <Button variant="secondary" onClick={() => setEditor(environment)}>{t("sessionTarget.editEnvironment")}</Button>
          {!environment.isDefault && <Button variant="secondary" onClick={() => void api.removeEnvironment(environment.id)
            .catch((cause) => toast(String(cause), { variant: "error" }))}>{t("sessionTarget.remove")}</Button>}
        </div>
      </SettingsRow>)}
      <Button variant="secondary" disabled={!hosts.length} onClick={() => setEditor("new")}>{t("sessionTarget.newEnvironment")}</Button>
    </SettingsCard>
    {hosts.length > 0 && <SettingsCard title={t("sessionTarget.leftoverWorktrees")}>
      {hosts.map((host) => <LeftoverWorktrees key={host.hostKey} host={host} />)}
    </SettingsCard>}
    {editor && <EnvironmentEditor hosts={hosts} environment={editor === "new" ? undefined : editor} onSaved={close} onClose={close} />}
  </>;
}
