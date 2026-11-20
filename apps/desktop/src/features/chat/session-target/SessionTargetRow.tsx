import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { GitHubBranchList, GitHubRepositoryList } from "@pi-desktop/shared";
import { AnchoredMenu } from "../../../components/settings/AnchoredMenu";
import { Button, Input } from "../../../components/ui";
import { api } from "../../../lib/api";
import { useAppStore } from "../../../stores/app-store";
import { useGitHubConnector } from "../../settings/connectors/use-github-connector";
import { EnvironmentEditor } from "./EnvironmentEditor";
import { useSessionTargetStore } from "./session-target-store";
import { useEnvironments } from "./use-environments";
import "./session-target.css";

function Picker({ label, title, open, toggle, close, search, children }: {
  label: string; title: string; open: boolean; close(): void; toggle(): void; search?: boolean; children: ReactNode;
}) {
  return <AnchoredMenu open={open} onClose={close} label={title} side="top" role="dialog"
    initialFocus={search ? "input" : "selected"} menuClassName="session-target-menu"
    trigger={(ref) => <Button ref={ref} variant="secondary" aria-label={title} aria-expanded={open} onClick={toggle}>{label}</Button>}>
    {children}
  </AnchoredMenu>;
}

export function SessionTargetRow() {
  const { t } = useTranslation();
  const { environments, hosts, loaded, error: environmentError } = useEnvironments();
  const { status } = useGitHubConnector();
  const target = useSessionTargetStore();
  const openSettings = useAppStore((state) => state.openSettings);
  const [menu, setMenu] = useState<"environment" | "repository" | "branch" | null>(null);
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

  useEffect(() => {
    if (loaded && target.environmentId !== "local" && !environment) target.setEnvironment("local");
  }, [loaded, environment, target]);
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
  const matches = (value: string) => value.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  const search = (label: string) => <Input aria-label={label} placeholder={label} value={query} onChange={(event) => setQuery(event.target.value)} />;
  const errorRow = <>{error && <p role="alert">{t("sessionTarget.loadFailed", { message: error })}</p>}</>;
  return <div className="session-target-row">
    <Picker label={environment?.name ?? t("sessionTarget.thisComputer")} title={t("sessionTarget.environmentHost")} open={menu === "environment"} toggle={() => open("environment")} close={close}>
      <Button variant="secondary" onClick={() => { target.setEnvironment("local"); close(); }}>{t("sessionTarget.thisComputer")}</Button>
      {hosts.map((host) => <div className="session-target-fields" key={host.hostKey}>
        <span>{host.connected ? host.label : t("sessionTarget.hostOffline", { host: host.label })}</span>
        {environments.filter((item) => item.hostKey === host.hostKey).map((item) => <Button key={item.id} variant="secondary"
          onClick={() => { target.setEnvironment(item.id); close(); }}>{item.name}</Button>)}
      </div>)}
      {hosts.length > 0 && <Button variant="secondary" onClick={() => { close(); setEditorOpen(true); }}>{t("sessionTarget.newEnvironment")}</Button>}
      <Button variant="secondary" onClick={() => { close(); openSettings("remoteHosts"); }}>{t("sessionTarget.addRemoteHost")}</Button>
      {environmentError && <p role="alert">{t("sessionTarget.loadFailed", { message: environmentError })}</p>}
    </Picker>
    {environment && (connected ? <Picker label={repository ? `${repository.owner}/${repository.name}` : t("sessionTarget.chooseRepository")} title={t("sessionTarget.chooseRepository")}
      open={menu === "repository"} toggle={() => open("repository")} close={close} search>
      {search(t("sessionTarget.searchRepositories"))}
      <Button variant="secondary" onClick={() => { setError(undefined); setRevision((value) => value + 1); }}>{t("sessionTarget.refresh")}</Button>
      {errorRow}
      {repositories?.truncated && <span>{t("sessionTarget.truncated")}</span>}
      {repositories?.ssoPartial && <span>{t("sessionTarget.ssoPartial")}</span>}
      {repositories?.repositories.filter((item) => matches(item.fullName)).map((item) => <Button variant="secondary" key={item.fullName}
        onClick={() => { target.setRepository({ owner: item.owner, name: item.name, defaultBranch: item.defaultBranch }); setBranches(undefined); close(); }}>{item.fullName}</Button>)}
    </Picker> : <Button variant="secondary" onClick={() => openSettings("connectors")}>
      {t(status?.needsReauthentication ? "sessionTarget.reconnectGitHub" : "sessionTarget.connectGitHub")}
    </Button>)}
    {environment && connected && repository && <Picker label={target.baseBranch ?? t("sessionTarget.chooseBranch")} title={t("sessionTarget.chooseBranch")}
      open={menu === "branch"} toggle={() => open("branch")} close={close} search>
      {search(t("sessionTarget.searchBranches"))}{errorRow}
      {branches?.ssoPartial && <span>{t("sessionTarget.ssoPartial")}</span>}
      {branches?.branches.filter((item) => matches(item.name)).map((item) => <Button variant="secondary" key={item.name}
        onClick={() => { target.setBaseBranch(item.name); close(); }}>{item.name}</Button>)}
    </Picker>}
    {editorOpen && <EnvironmentEditor hosts={hosts} onSaved={(value) => { target.setEnvironment(value.id); closeEditor(); }} onClose={closeEditor} />}
  </div>;
}
