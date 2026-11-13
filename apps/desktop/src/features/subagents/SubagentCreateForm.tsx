import type { AgentSubagentControlResponse } from "@pi-desktop/shared";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Button, Field, Select, Textarea } from "../../components/ui";
import { SubagentModelPicker } from "../../components/settings/SubagentModelPicker";
import { groupSubagentModelChoices, subagentModelChoices, subagentModelOrphanPin,
  subagentModelSelectValue } from "../../components/settings/subagent-models";
import { useAppStore } from "../../stores/app-store";
import { clearSubagentControlDraft, prepareSubagentControlOperation, writeSubagentControlDraft } from "./control-drafts";
import { useSubagentControl, useSubagentControlCatalog, useSubagentControlDraft } from "./use-subagent-control";
import { ControlFeedback } from "./ControlFeedback";

/** Creates one task with authoritative Main/runtime launch resolution. */
export function SubagentCreateForm({ sessionId, onStarted }: {
  sessionId: string; onStarted: (response: AgentSubagentControlResponse) => void;
}) {
  const { t } = useTranslation();
  const address = { sessionId };
  const draft = useSubagentControlDraft(address);
  const control = useSubagentControl(sessionId);
  const catalog = useSubagentControlCatalog(sessionId, control.allowed);
  const providers = useAppStore((state) => state.providers);
  const choices = useMemo(() => subagentModelChoices(providers), [providers]);
  const groups = useMemo(() => groupSubagentModelChoices(choices), [choices]);
  const selectedAgent = draft.agent || catalog.subagents[0]?.name || "";
  const definition = catalog.subagents.find((entry) => entry.name === selectedAgent);
  const orphanModel = subagentModelOrphanPin(draft.model, choices);
  const canSend = control.allowed && !catalog.loading && !catalog.error && Boolean(definition) &&
    !orphanModel && Boolean(draft.text.trim()) && draft.text.length <= 100_000;
  const submit = async () => {
    if (!canSend || control.busy) return;
    // Bind the implicit first definition before allocating an operation id.
    writeSubagentControlDraft(address, { agent: selectedAgent });
    const operation = prepareSubagentControlOperation(address);
    const response = await control.send({ sessionId, operationId: operation.operationId,
      action: "start", agent: operation.agent, task: operation.text,
      ...(operation.model ? { model: operation.model } : {}) });
    if (!response) return;
    clearSubagentControlDraft(address, operation.revision);
    if (useAppStore.getState().activeSessionId === sessionId) onStarted(response);
  };
  if (!control.allowed) return null;
  return <form className="session-subagents-create" data-testid="subagent-create-form"
    aria-label={t("panel.sessionSubagents.control.new")} aria-busy={control.busy || catalog.loading}
    onSubmit={(event) => { event.preventDefault(); void submit(); }}>
    <div className="session-subagents-create-fields">
      <Field label={t("panel.sessionSubagents.control.agent")}>
        <Select value={selectedAgent} disabled={catalog.loading || Boolean(catalog.error) || catalog.subagents.length === 0}
          aria-label={t("panel.sessionSubagents.control.agent")}
          onChange={(event) => writeSubagentControlDraft(address, { agent: event.target.value })}>
          {!selectedAgent && <option value="">{t("panel.sessionSubagents.control.chooseAgent")}</option>}
          {draft.agent && !definition && <option value={draft.agent} disabled>{draft.agent}</option>}
          {catalog.subagents.map((entry) => <option key={entry.name} value={entry.name}>{entry.name}</option>)}
        </Select>
      </Field>
      <Field label={t("panel.sessionSubagents.control.model")}>
        <SubagentModelPicker value={subagentModelSelectValue(draft.model, choices)} groups={groups}
          orphanPin={orphanModel} label={t("panel.sessionSubagents.control.model")}
          inheritLabel={t("panel.sessionSubagents.control.definitionModel")}
          onChange={(model) => writeSubagentControlDraft(address, { model })} />
      </Field>
    </div>
    {definition && <p className="session-subagents-control-description">{definition.description}</p>}
    {catalog.loading && <p role="status">{t("common.loading")}</p>}
    {catalog.error && <div className="session-subagents-control-feedback" role="alert">
      <span>{t("panel.sessionSubagents.control.catalogFailed")}</span>
      <details><summary>{t("panel.sessionSubagents.errorDetails")}</summary><p>{catalog.error.message}</p></details>
      <Button type="button" size="sm" onClick={catalog.reload}>{t("panel.sessionSubagents.retry")}</Button>
    </div>}
    {!catalog.loading && !catalog.error && catalog.subagents.length === 0 && <div role="status">
      <p>{t("panel.sessionSubagents.control.noAgents")}</p>
      <Button type="button" size="sm" onClick={catalog.reload}>{t("panel.sessionSubagents.retry")}</Button>
    </div>}
    {orphanModel && <p role="status">{t("panel.sessionSubagents.control.modelUnavailable")}</p>}
    <Field label={t("panel.sessionSubagents.control.task")}>
      <Textarea rows={3} value={draft.text} maxLength={100_000}
        aria-label={t("panel.sessionSubagents.control.task")} placeholder={t("panel.sessionSubagents.control.taskPlaceholder")}
        onChange={(event) => writeSubagentControlDraft(address, { text: event.target.value })} />
    </Field>
    <ControlFeedback error={control.error} delivery={control.delivery} busy={control.busy || !canSend}
      retry={() => void submit()} />
    <div className="session-subagents-control-actions">
      <Button type="submit" variant="primary" size="sm" disabled={!canSend || control.busy}>
        {t(control.busy ? "panel.sessionSubagents.control.sending" : "panel.sessionSubagents.control.start")}
      </Button>
    </div>
  </form>;
}
