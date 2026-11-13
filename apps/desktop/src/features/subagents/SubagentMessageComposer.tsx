import { useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button, Textarea } from "../../components/ui";
import { SubagentModelPicker } from "../../components/settings/SubagentModelPicker";
import { groupSubagentModelChoices, subagentMessageModelChoices, subagentModelLabel, subagentModelOrphanPin,
  subagentModelSelectValue } from "../../components/settings/subagent-models";
import { useAppStore } from "../../stores/app-store";
import { clearSubagentControlDraft, prepareSubagentControlOperation, readSubagentControlDraft,
  writeSubagentControlDraft } from "./control-drafts";
import { useSubagentControl, useSubagentControlDraft } from "./use-subagent-control";
import { ControlFeedback } from "./ControlFeedback";

/** The user speaks to the child; no parent prompt or synthetic tool call. */
export function SubagentMessageComposer({ sessionId, delegationId, draftKey, running, ready, modelId = "", modelKey, thinkingLevel, children, onDelivered }: {
  sessionId: string; delegationId: string; draftKey: string; running: boolean; ready: boolean;
  modelId?: string; modelKey?: string; thinkingLevel?: string; children?: ReactNode; onDelivered?: () => void;
}) {
  const { t } = useTranslation();
  const address = { sessionId, delegationId: draftKey };
  const draft = useSubagentControlDraft(address);
  const control = useSubagentControl(sessionId);
  const providers = useAppStore((state) => state.providers);
  const choices = useMemo(() => subagentMessageModelChoices(providers), [providers]);
  const recordedModel = useMemo(() => subagentModelLabel({ modelId, modelKey }, providers), [modelId, modelKey, providers]);
  const inheritedModel = [recordedModel.text || "—", thinkingLevel && thinkingLevel !== "off" ? thinkingLevel : ""]
    .filter(Boolean).join(" · ");
  const groups = useMemo(() => groupSubagentModelChoices(choices), [choices]);
  const orphanModel = subagentModelOrphanPin(draft.model, choices);
  const editable = control.allowed && ready;
  const canSend = editable && !orphanModel && Boolean(draft.text.trim()) && draft.text.length <= 100_000;
  const submit = async () => {
    if (!canSend || control.busy) return;
    const operation = prepareSubagentControlOperation(address, delegationId);
    const response = await control.send({ sessionId, operationId: operation.operationId, action: "message",
      delegationId: operation.operationDelegationId ?? delegationId, content: operation.text,
      ...(operation.model ? { model: operation.model } : {}) });
    if (!response) return;
    const matching = readSubagentControlDraft(address).revision === operation.revision;
    clearSubagentControlDraft(address, operation.revision);
    // Keep the explicit choice while the queued request waits to apply it.
    if (matching && operation.model) writeSubagentControlDraft(address, { model: operation.model });
    if (useAppStore.getState().activeSessionId === sessionId) onDelivered?.();
  };
  return <footer className="subagent-transcript-composer">
    <form data-testid="subagent-message-form" aria-busy={control.busy}
      onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <Textarea disabled={!editable} rows={2} maxLength={100_000} value={editable ? draft.text : ""}
        aria-label={t("panel.sessionSubagents.control.message")}
        placeholder={t(!editable ? "panel.sessionSubagents.control.unavailable" : running
          ? "panel.sessionSubagents.control.messagePlaceholder" : "panel.sessionSubagents.control.continuePlaceholder")}
        onChange={(event) => writeSubagentControlDraft(address, { text: event.target.value })} />
      {editable && <p className="session-subagents-control-description">{t(running && !draft.model
        ? "panel.sessionSubagents.control.safeSteering" : "panel.sessionSubagents.control.modelNextMessage")}</p>}
      {editable && orphanModel && <p role="status">{t("panel.sessionSubagents.control.modelUnavailable")}</p>}
      {editable && <ControlFeedback error={control.error} delivery={control.delivery} busy={control.busy || !canSend}
        retry={() => void submit()} />}
      <div className="subagent-transcript-composer-controls">
        <div className="subagent-transcript-model-picker">
          <SubagentModelPicker value={subagentModelSelectValue(draft.model, choices)} groups={groups}
            orphanPin={orphanModel} disabled={!editable} label={t("panel.sessionSubagents.control.model")}
            inheritLabel={t("panel.sessionSubagents.control.keepModel", { model: inheritedModel })}
            onChange={(model) => writeSubagentControlDraft(address, { model })} />
        </div>
        {children}
        {editable && <Button type="submit" variant="primary" size="sm" disabled={!canSend || control.busy}>
          {t(control.busy ? "panel.sessionSubagents.control.sending" : running
            ? "panel.sessionSubagents.control.send" : "panel.sessionSubagents.control.continue")}
        </Button>}
      </div>
    </form>
  </footer>;
}
