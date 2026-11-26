import type { StarAiService } from "@pi-desktop/shared";
import { Aperture, Asterisk, Boxes, Check, Clapperboard, Layers3, Orbit, Sparkle, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import "../../styles/star-ai-service-cards.css";

const serviceIcons = { gpt: Aperture, claude: Asterisk, gemini: Sparkle, domestic: Boxes, grok: Orbit, media: Clapperboard, other: Layers3 };

export function StarAiServiceCards({ options, value, onChange, disabled, showLabel = true, auto }: {
  options: ReadonlyArray<{ id: StarAiService; count: number }>;
  value: StarAiService | null;
  onChange: (service: StarAiService) => void;
  disabled?: boolean;
  showLabel?: boolean;
  auto?: { selected: boolean; onChange: () => void };
}) {
  const { t } = useTranslation("starAi");
  return (
    <div className="starai-services" role="group" aria-label={t("selectService")}>
      {showLabel && <span className="starai-service-label">{t("selectService")}</span>}
      <div className="starai-service-grid" role="radiogroup" aria-label={t("selectService")}>
        {options.map(({ id, count }) => {
          const Icon = serviceIcons[id];
          const label = t(`services.${id}`);
          return (
            <button type="button" key={id} role="radio" className="composer-service-card" data-service={id} data-service-id={id}
              aria-checked={value === id} aria-label={label} title={label} disabled={disabled} onClick={() => onChange(id)}>
              <span className="starai-service-icon" aria-hidden="true"><Icon size={17} /></span>
              <span className="starai-service-copy">
                <span className="starai-service-name">{label}</span>
                <span className="composer-service-count">{t("serviceGroupCount", { count })}</span>
              </span>
              {value === id && <Check size={13} className="starai-service-check" aria-hidden="true" />}
            </button>
          );
        })}
      </div>
      {auto && <button type="button" className="starai-auto-route" data-service="auto" aria-pressed={auto.selected}
        disabled={disabled} onClick={auto.onChange}>
        <Sparkles size={15} aria-hidden="true" />{t("autoRoute")}
        {auto.selected && <Check size={13} className="starai-service-check" aria-hidden="true" />}
      </button>}
    </div>
  );
}
