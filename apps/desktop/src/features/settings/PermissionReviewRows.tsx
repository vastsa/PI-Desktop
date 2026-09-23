import { useCallback, useEffect, useRef, useState } from "react";
import {
  imageGenerationBindings,
  MAX_PERMISSION_REVIEW_POLICY_CHARS,
  type AppSettings,
  type ProviderPublic,
} from "@pi-desktop/shared";
import { useTranslation } from "react-i18next";
import { SettingsMenuSelect } from "../../components/settings/SettingsMenuSelect";
import { defaultModelOptions } from "../../components/settings/default-model";
import { useAppStore } from "../../stores/app-store";
import { SettingsRow } from "./primitives";
import { syncPermissionPolicyDraft } from "./permission-policy-draft";
import { reviewThinkingLevels, selectedReviewThinkingLevel } from "./permission-review-model";

export function PermissionReviewRows({ settings, providers, saveSettings }: {
  settings: AppSettings;
  providers: ProviderPublic[];
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const providerModels = useAppStore((state) => state.providerModels);
  const binding = settings.autoReview;
  const savedPolicy = binding?.policyPrompt ?? "";
  const [policyDraft, setPolicyDraft] = useState(savedPolicy);
  const policyDraftRef = useRef(savedPolicy);
  const previousSavedPolicy = useRef(savedPolicy);
  const saveSettingsRef = useRef(saveSettings);
  saveSettingsRef.current = saveSettings;
  const mountedRef = useRef(true);
  const writeQueue = useRef(Promise.resolve());
  const [savingPolicy, setSavingPolicy] = useState(false);
  const [savingBinding, setSavingBinding] = useState(false);
  const [policySaveFailed, setPolicySaveFailed] = useState(false);
  const [bindingSaveFailed, setBindingSaveFailed] = useState(false);
  const busy = savingPolicy || savingBinding;
  const policyLength = [...policyDraft].length;
  const policyInvalid = policyLength > MAX_PERMISSION_REVIEW_POLICY_CHARS;

  const enqueueWrite = useCallback((write: () => Promise<void>) => {
    writeQueue.current = writeQueue.current.then(write).catch(() => {
      if (mountedRef.current) setBindingSaveFailed(true);
    });
  }, []);

  const queuePolicySave = useCallback((text: string) => {
    if ([...text].length > MAX_PERMISSION_REVIEW_POLICY_CHARS) return;
    const policyPrompt = text.trim() ? text : undefined;
    enqueueWrite(async () => {
      if (policyDraftRef.current !== text) return;
      const currentBinding = useAppStore.getState().settings?.autoReview;
      if ((currentBinding?.policyPrompt ?? "") === (policyPrompt ?? "")) {
        if (!policyPrompt && mountedRef.current) {
          policyDraftRef.current = "";
          setPolicyDraft("");
        }
        return;
      }
      if (mountedRef.current) setSavingPolicy(true);
      try {
        await saveSettingsRef.current({ autoReview: { ...currentBinding, policyPrompt } });
        if (mountedRef.current) {
          setPolicySaveFailed(false);
          if (!policyPrompt && policyDraftRef.current === text) {
            policyDraftRef.current = "";
            setPolicyDraft("");
          }
        }
      } catch {
        if (mountedRef.current && policyDraftRef.current === text) setPolicySaveFailed(true);
      } finally {
        if (mountedRef.current) setSavingPolicy(false);
      }
    });
  }, [enqueueWrite]);

  // Provider refreshes and remote settings updates must not erase unsaved edits.
  useEffect(() => {
    const previous = previousSavedPolicy.current;
    setPolicyDraft((current) => {
      const next = syncPermissionPolicyDraft(current, previous, savedPolicy);
      policyDraftRef.current = next;
      return next;
    });
    previousSavedPolicy.current = savedPolicy;
  }, [savedPolicy]);

  useEffect(() => {
    if (policyDraft === savedPolicy || policyInvalid) return;
    const timer = window.setTimeout(() => queuePolicySave(policyDraft), 650);
    return () => window.clearTimeout(timer);
  }, [policyDraft, savedPolicy, policyInvalid, queuePolicySave]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (policyDraftRef.current !== previousSavedPolicy.current) {
        queuePolicySave(policyDraftRef.current);
      }
    };
  }, [queuePolicySave]);

  const persistReviewSetting = (patch: Partial<AppSettings>) => {
    setSavingBinding(true);
    setBindingSaveFailed(false);
    enqueueWrite(async () => {
      try {
        const currentBinding = useAppStore.getState().settings?.autoReview;
        await saveSettingsRef.current(patch.autoReview
          ? { ...patch, autoReview: { ...currentBinding, ...patch.autoReview } }
          : patch);
      } catch {
        if (mountedRef.current) setBindingSaveFailed(true);
      } finally {
        if (mountedRef.current) setSavingBinding(false);
      }
    });
  };
  const availableProviders = providers.filter((provider) => provider.enabled && (
    provider.hasSecret || provider.hasOauth || provider.authKind === "none"
  ));
  const images = imageGenerationBindings(settings.imageGenerationModels, settings.imageGeneration);
  const models = defaultModelOptions(availableProviders, images).map(({ provider, modelId }) => ({
    id: JSON.stringify([provider.id, modelId]),
    label: `${provider.name} / ${modelId}`,
    provider,
    modelId,
  }));
  const selected = binding?.providerId && binding.modelId
    ? JSON.stringify([binding.providerId, binding.modelId]) : "follow";
  const selectedModel = models.find((model) => model.id === selected);
  const thinkingLevels = selectedModel
    ? reviewThinkingLevels(selectedModel.provider, selectedModel.modelId,
        providerModels[selectedModel.provider.id])
    : (["off"] as const);
  const selectedThinking = selectedReviewThinkingLevel(binding?.thinkingLevel, thinkingLevels);

  return (
    <>
      <SettingsRow title={t("settings.approvalReviewer")} description={t("settings.approvalReviewerDesc")}>
        <SettingsMenuSelect
          label={t("settings.approvalReviewer")}
          value={settings.approvalReviewer ?? "user"}
          busy={busy}
          options={[
            { id: "user", label: t("settings.reviewByUser") },
            { id: "auto_review", label: t("settings.reviewByModel") },
          ]}
          onChange={(value) => void persistReviewSetting({ approvalReviewer: value === "auto_review" ? "auto_review" : "user" })}
        />
      </SettingsRow>
      <>
          <SettingsRow title={t("settings.reviewModel")} description={t("settings.reviewModelDesc")}>
            <SettingsMenuSelect
              label={t("settings.reviewModel")}
              value={selected}
              busy={busy}
              searchPlaceholder={t("settings.defaultModelSearch")}
              emptyLabel={t("settings.noModelMatches")}
              options={[{ id: "follow", label: t("settings.reviewFollowSession") }, ...models,
                ...(selected !== "follow" && !models.some((model) => model.id === selected)
                  ? [{ id: selected, label: t("settings.reviewModelUnavailable"), disabled: true }]
                  : []),
              ]}
              onChange={(value) => {
                const model = models.find((candidate) => candidate.id === value);
                if (value !== "follow" && !model) return;
                const levels = model
                  ? reviewThinkingLevels(model.provider, model.modelId, providerModels[model.provider.id])
                  : (["off"] as const);
                void persistReviewSetting({ autoReview: {
                  providerId: model?.provider.id,
                  modelId: model?.modelId,
                  thinkingLevel: selectedReviewThinkingLevel(binding?.thinkingLevel, levels),
                } });
              }}
            />
          </SettingsRow>
          <SettingsRow title={t("settings.reviewThinking")} description={t("settings.reviewThinkingDesc")}>
            <SettingsMenuSelect
              label={t("settings.reviewThinking")}
              value={selectedThinking}
              disabled={!selectedModel || thinkingLevels.length === 1}
              busy={busy}
              options={thinkingLevels.map((level) => ({ id: level, label: level }))}
              onChange={(value) => {
                if (!thinkingLevels.some((level) => level === value)) return;
                void persistReviewSetting({ autoReview: {
                  thinkingLevel: thinkingLevels.find((level) => level === value),
                } });
              }}
            />
          </SettingsRow>
          <p className="settings-description">{t("settings.reviewCostCaution")}</p>
          {bindingSaveFailed ? <p role="alert">{t("settings.reviewSettingsSaveFailed")}</p> : null}
          <div className="settings-row permission-review-policy">
            <label className="settings-row-title" htmlFor="permission-review-policy-draft">{t("settings.reviewPolicyTitle")}</label>
            <textarea
              id="permission-review-policy-draft"
              className="field-textarea"
              rows={7}
              value={policyDraft}
              placeholder={t("settings.reviewPolicyDesc")}
              onChange={(event) => {
                policyDraftRef.current = event.target.value;
                setPolicyDraft(event.target.value);
                setPolicySaveFailed(false);
              }}
              onBlur={() => queuePolicySave(policyDraftRef.current)}
              aria-invalid={policyInvalid}
              aria-describedby={policyInvalid ? "permission-review-policy-invalid"
                : policySaveFailed ? "permission-review-policy-save-error" : undefined}
            />
            {policyInvalid ? <p id="permission-review-policy-invalid" role="alert">{t("settings.reviewPolicyInvalid")}</p> : null}
            {policySaveFailed ? <p id="permission-review-policy-save-error" role="alert">{t("settings.reviewPolicySaveFailed")}</p> : null}
          </div>
      </>
    </>
  );
}
