/**
 * Enhancement model and reasoning rows (ADR 0121).
 *
 * Which model rewrites the Composer draft, and with how much reasoning, live
 * on the Settings → AI Prompt enhancement card, as rows below the custom-template
 * switch. They are rows rather than a second card so the template, model, and
 * reasoning for the same action share one heading.
 *
 * The rows themselves are the shared `OneShotModelRows` (also used by session
 * title generation, ADR 0322); this wrapper binds the prompt-enhancement
 * settings keys and copy.
 */
import { useTranslation } from "react-i18next";
import { OneShotModelRows } from "./OneShotModelRows";

export function EnhancementModelCard() {
  const { t } = useTranslation();
  return (
    <OneShotModelRows
      config={{
        providerKey: "promptEnhancementProviderId",
        modelKey: "promptEnhancementModelId",
        thinkingKey: "promptEnhancementThinkingLevel",
        labels: {
          model: t("settings.promptEnhancementModel"),
          follow: t("settings.promptEnhancementModelFollow"),
          unavailable: t("settings.promptEnhancementModelUnavailable"),
          thinking: t("settings.promptEnhancementThinking"),
          thinkingDesc: t("settings.promptEnhancementThinkingDesc"),
          thinkingOff: t("settings.promptEnhancementThinkingOff"),
        },
      }}
    />
  );
}
