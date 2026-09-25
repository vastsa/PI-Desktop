import { useTranslation } from "react-i18next";
import type { CatalogApiStyle } from "@pi-desktop/shared";
import { Button } from "../ui";
import { API_STYLE_LABEL_KEYS } from "./provider-api-style";
import { endpointSuggestion } from "./provider-endpoint-guidance";

export function ProviderEndpointGuidance({ baseUrl, apiStyle, disabled, onApply }: {
  baseUrl: string;
  apiStyle: CatalogApiStyle;
  disabled: boolean;
  onApply: (suggestion: { baseUrl: string; apiStyle: CatalogApiStyle }) => void;
}) {
  const { t } = useTranslation();
  const suggestion = endpointSuggestion(baseUrl, apiStyle);
  if (!suggestion) return null;
  return <div className="provider-endpoint-guidance" role="status">
    <span>{t("settings.endpointFormatGuidance", {
      format: t(API_STYLE_LABEL_KEYS[suggestion.apiStyle]),
    })}</span>
    <Button type="button" disabled={disabled} onClick={() => onApply(suggestion)}>
      {t("settings.applyEndpointFormat")}
    </Button>
  </div>;
}
