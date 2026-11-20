import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { GitHubBranchList, GitHubRepositoryList } from "@pi-desktop/shared";
import { IconChevronDown, IconFolder, IconMonitor, IconServer } from "../../../components/icons";
import { AnchoredMenu } from "../../../components/settings/AnchoredMenu";
import { Button, Input } from "../../../components/ui";
import { api } from "../../../lib/api";
import { filterSwitcherProjects, listSwitcherProjects, normalizeProjectPath } from "../../../lib/sidebar-preferences";
import { useAppStore } from "../../../stores/app-store";
import { useGitHubConnector } from "../../settings/connectors/use-github-connector";
import { EnvironmentEditor } from "./EnvironmentEditor";
import { useSessionTargetStore } from "./session-target-store";
import { useEnvironments } from "./use-environments";
import "./session-target.css";

function Picker({ label, title, icon, open, toggle, close, search, disabled, children }: {
  label: string; title: string; icon?: ReactNode; open: boolean; close(): void; toggle(): void; search?: boolean; disabled?: boolean; children: ReactNode;
}) {
  return <AnchoredMenu open={open} onClose={close} label={title} side="top" role="dialog"
    className="session-target-picker"
    initialFocus={search ? "input" : "selected"} menuClassName="session-target-menu"
    trigger={(ref) => <Button ref={ref} type="button" variant="ghost" disabled={disabled} className="session-target-trigger"
      aria-label={title} aria-description={label === title ? undefined : label} aria-haspopup="dialog" aria-expanded={open} onClick={toggle}>
      {icon}
      <span className="session-target-trigger-label" title={label}>{label}</span>
      <IconChevronDown size={12} aria-hidden="true" />
    </Button>}>
    {children}
  </AnchoredMenu>;
}

export function SessionTargetRow() {
  const { t } = useTranslation();
  const { environments, hosts, loaded, error: environmentError } = useEnvironments();
  const { status } = useGitHubConnector();
  const target = useSessionTargetStore();
  const openSettings = useAppStore((state) => state.openSettings);
  const workspace = useAppStore((state) => state.workspace);
  const activeSessionId = useAppStore((state) => state.activeSessionId);
  const openProjectPaths = useAppStore((state) => state.openProjectPaths);
  const openProjects = useAppStore((state) => state.openProjects);
  const projectMeta = useAppStore((state) => state.projectMeta);
  const projectSort = useAppStore((state) => state.projectSort);
  const choosingProject = useAppStore((state) => state.choosingLocalTaskProject);
  const [menu, setMenu] = useState<"environment" | "localProject" | "repository" | "branch" | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [repositories, setRepositories] = useState<GitHubRepositoryList>();
  const [branches, setBranches] = useState<GitHubBranchList>();
  const [query, setQuery] = useState("");
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState<string>();
  const close = useCallback(() => setMenu(null), []);
  const closeEditor = useCallback(() => setEditorOpen(false), []);
  const environment = environments.find((entry) => entry.id === target.environmentId);
  const repository = target.repository;
  const connected = status?.connected && !status.needsReauthentication;
  const localWorkspace = workspace && !workspace.remote && !workspace.path.startsWith("remote-project:") ? workspace : null;
  const localProjectKey = normalizeProjectPath(localWorkspace?.path);
  const localProjects = useMemo(() => listSwitcherProjects({
    openProjectPaths,
    openProjects,
    workspace: localWorkspace,
    projectMeta,
    projectSort,
  }).filter((project) => !project.path.startsWith("remote-project:")), [
    openProjectPaths, openProjects, localWorkspace, projectMeta, projectSort,
  ]);

  useEffect(() => {
    if (!loaded || target.environmentId === "local" || environment) return;
    const fallback = environments.find((entry) => entry.id === target.defaultEnvironmentId);
    if (fallback) target.setEnvironment(fallback.id, fallback.hostKey);
  }, [loaded, environment, environments, target]);
  useEffect(() => {
    if (menu !== "repository" || !connected) return;
    let current = true;
    void api.listGithubRepositories({ refresh: revision > 0 }).then(
      (value) => { if (current) setRepositories(value); },
      (cause) => { if (current) setError(cause instanceof Error ? cause.message : String(cause)); },
    );
    return () => { current = false; };
  }, [menu, connected, revision]);
  useEffect(() => {
    if (menu !== "branch" || !repository || !connected) return;
    let current = true;
    void api.listGithubBranches({ owner: repository.owner, name: repository.name }).then(
      (value) => { if (current) setBranches(value); },
      (cause) => { if (current) setError(cause instanceof Error ? cause.message : String(cause)); },
    );
    return () => { current = false; };
  }, [menu, repository, connected]);

  function open(next: NonNullable<typeof menu>) {
    setQuery("");
    setError(undefined);
    setMenu(menu === next ? null : next);
  }
  function selectLocalProject(path?: string | null) {
    close();
    const store = useAppStore.getState();
    void store.chooseLocalTaskProject(path).catch((cause) => {
      store.showToast(cause instanceof Error ? cause.message : String(cause), { variant: "error" });
    });
  }

  const matches = (value: string) => value.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  const search = (label: string) => <Input aria-label={label} placeholder={label} value={query} onChange={(event) => setQuery(event.target.value)} />;
  const errorRow = <>{error && <p role="alert">{t("sessionTarget.loadFailed", { message: error })}</p>}</>;
  return <div className="session-target-row session-target-controls">
    <Picker label={environment?.name ?? t(target.environmentId === "local"
      ? "sessionTarget.thisComputer" : "sessionTarget.environmentUnavailable")} title={t("sessionTarget.environmentHost")}
      icon={environment ? <IconServer size={14} aria-hidden="true" /> : <IconMonitor size={14} aria-hidden="true" />}
      open={menu === "environment"} toggle={() => open("environment")} close={close} disabled={choosingProject}>
      <Button variant="secondary" onClick={() => { target.setEnvironment("local"); close(); }}>{t("sessionTarget.thisComputer")}</Button>
      {hosts.map((host) => <div className="session-target-fields" key={host.hostKey}>
        <span>{host.connected ? host.label : t("sessionTarget.hostOffline", { host: host.label })}</span>
        {environments.filter((item) => item.hostKey === host.hostKey).map((item) => <Button key={item.id} variant="secondary"
          onClick={() => { target.setEnvironment(item.id, item.hostKey); close(); }}>{item.name}</Button>)}
      </div>)}
      {hosts.length > 0 && <Button variant="secondary" onClick={() => { close(); setEditorOpen(true); }}>{t("sessionTarget.newEnvironment")}</Button>}
      <Button variant="secondary" onClick={() => { close(); openSettings("remoteHosts"); }}>{t("sessionTarget.addRemoteHost")}</Button>
      {environmentError && <p role="alert">{t("sessionTarget.loadFailed", { message: environmentError })}</p>}
    </Picker>
    {target.environmentId === "local" && !activeSessionId && (
      <Picker label={localWorkspace?.name ?? t("permission.temporarySession")} title={t("nav.localProjects")}
        icon={<IconFolder size={14} aria-hidden="true" />}
        open={menu === "localProject"} toggle={() => open("localProject")} close={close}
        search={localProjects.length > 0} disabled={choosingProject}>
        {localProjects.length > 0 && search(t("project.searchPlaceholder"))}
        <Button variant="secondary" aria-pressed={localProjectKey === null} onClick={() => selectLocalProject(null)}>
          {t("permission.temporarySession")}
        </Button>
        {filterSwitcherProjects(localProjects, query).map((project) => (
          <Button variant="secondary" key={project.key} title={project.path}
            aria-pressed={localProjectKey === project.key} onClick={() => selectLocalProject(project.path)}>
            {project.name}
          </Button>
        ))}
        <Button variant="secondary" onClick={() => selectLocalProject()}>{t("project.openFolder")}</Button>
      </Picker>
    )}
    {environment && <Picker label={repository ? `${repository.owner}/${repository.name}` : t("sessionTarget.noRepository")} title={t("sessionTarget.chooseRepository")}
      open={menu === "repository"} toggle={() => open("repository")} close={close} search={Boolean(connected)}>
      <Button variant="secondary" onClick={() => { target.setRepository(); setBranches(undefined); close(); }}>
        {t("sessionTarget.noRepository")}
      </Button>
      {connected ? <>
        {search(t("sessionTarget.searchRepositories"))}
        <Button variant="secondary" onClick={() => { setError(undefined); setRevision((value) => value + 1); }}>{t("sessionTarget.refresh")}</Button>
        {errorRow}
        {repositories?.truncated && <span>{t("sessionTarget.truncated")}</span>}
        {repositories?.ssoPartial && <span>{t("sessionTarget.ssoPartial")}</span>}
        {repositories?.repositories.filter((item) => matches(item.fullName)).map((item) => <Button variant="secondary" key={item.fullName}
          onClick={() => { target.setRepository({ owner: item.owner, name: item.name, defaultBranch: item.defaultBranch }); setBranches(undefined); close(); }}>{item.fullName}</Button>)}
      </> : <Button variant="secondary" onClick={() => { close(); openSettings("connectors"); }}>
        {t(status?.needsReauthentication ? "sessionTarget.reconnectGitHub" : "sessionTarget.connectGitHub")}
      </Button>}
    </Picker>}
    {environment && !repository && (environment.setupScript || environment.variables.length > 0) &&
      <span className="session-target-note">{t("sessionTarget.repositorySetupOnly")}</span>}
    {environment && connected && repository && <Picker label={target.baseBranch ?? t("sessionTarget.chooseBranch")} title={t("sessionTarget.chooseBranch")}
      open={menu === "branch"} toggle={() => open("branch")} close={close} search>
      {search(t("sessionTarget.searchBranches"))}{errorRow}
      {branches?.ssoPartial && <span>{t("sessionTarget.ssoPartial")}</span>}
      {branches?.branches.filter((item) => matches(item.name)).map((item) => <Button variant="secondary" key={item.name}
        onClick={() => { target.setBaseBranch(item.name); close(); }}>{item.name}</Button>)}
    </Picker>}
    {editorOpen && <EnvironmentEditor hosts={hosts} onSaved={(value) => { target.setEnvironment(value.id, value.hostKey); closeEditor(); }} onClose={closeEditor} />}
  </div>;
}
