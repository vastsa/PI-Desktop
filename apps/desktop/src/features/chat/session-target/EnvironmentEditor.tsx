import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import type { RemoteEnvironment, RemoteHostSummary } from "@pi-desktop/shared";
import { Button, Field, Input, Select, Textarea } from "../../../components/ui";
import { api } from "../../../lib/api";
import { WorktreeDialogFrame } from "../../worktree/WorktreeDialogFrame";

export function EnvironmentEditor({ hosts, environment, onSaved, onClose }: {
  hosts: RemoteHostSummary[];
  environment?: RemoteEnvironment;
  onSaved(environment: RemoteEnvironment): void;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(environment?.name ?? "");
  const [hostKey, setHostKey] = useState(environment?.hostKey ?? hosts[0]?.hostKey ?? "");
  const [script, setScript] = useState(environment?.setupScript ?? "");
  const [variables, setVariables] = useState(() => (environment?.variables ?? []).map((row) => ({ ...row, id: crypto.randomUUID() })));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const close = useCallback(() => onClose(), [onClose]);

  async function save() {
    setBusy(true);
    setError(undefined);
    try {
      const result = await api.upsertEnvironment({
        id: environment?.id, name: name.trim(), hostKey, setupScript: script,
        variables: variables.map(({ name, value }) => ({ name: name.trim(), value })),
      });
      onSaved(result.environment);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  function edit(id: string, key: "name" | "value", value: string) {
    setVariables((rows) => rows.map((item) => item.id === id ? { ...item, [key]: value } : item));
  }
  return <WorktreeDialogFrame id="remote-environment" title={t(environment ? "sessionTarget.editEnvironment" : "sessionTarget.newEnvironment")} busy={busy} onClose={close}
    actions={<Button disabled={busy || !name.trim() || !hostKey} onClick={() => void save()}>{t("sessionTarget.save")}</Button>}>
    <Field label={t("sessionTarget.environmentName")}><Input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} /></Field>
    <Field label={t("sessionTarget.environmentHost")}><Select disabled={Boolean(environment)} value={hostKey} onChange={(event) => setHostKey(event.target.value)}>
      {hosts.map((host) => <option key={host.hostKey} value={host.hostKey}>{host.label}</option>)}
    </Select></Field>
    <Field label={t("sessionTarget.setupScript")} hint={t("sessionTarget.setupScriptHint")}>
      <Textarea value={script} maxLength={65_536} rows={5} onChange={(event) => setScript(event.target.value)} />
    </Field>
    <Field label={t("sessionTarget.variables")}>
      <div className="session-target-fields">
        {variables.map((variable) => <div className="session-target-row" key={variable.id}>
          <Input aria-label={t("sessionTarget.variableName")} value={variable.name} maxLength={128} onChange={(event) => edit(variable.id, "name", event.target.value)} />
          <Input aria-label={t("sessionTarget.variableValue")} value={variable.value} maxLength={8192} onChange={(event) => edit(variable.id, "value", event.target.value)} />
          <Button variant="secondary" onClick={() => setVariables((rows) => rows.filter((row) => row.id !== variable.id))}>{t("sessionTarget.remove")}</Button>
        </div>)}
        <Button variant="secondary" disabled={variables.length >= 64} onClick={() => setVariables((rows) => [...rows, { name: "", value: "", id: crypto.randomUUID() }])}>{t("sessionTarget.addVariable")}</Button>
      </div>
    </Field>
    {error && <p role="alert">{error}</p>}
  </WorktreeDialogFrame>;
}
