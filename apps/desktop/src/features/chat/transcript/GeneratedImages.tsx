import { useTranslation } from "react-i18next";
import type { UiMessage } from "@pi-desktop/shared";
import { useReferencedImageDataUrl } from "../../../lib/use-referenced-image-data-url";
import { toolResultPayload } from "../../../lib/tool-presentation";
import { useOpenChatFileRef } from "../../../hooks/use-preview-target";
import { useAppStore } from "../../../stores/app-store";
import { Button } from "../../../components/ui";

function ImageResult({
  path,
  index,
  mimeType,
}: {
  path: string;
  index: number;
  mimeType?: string;
}) {
  const { t } = useTranslation();
  const dataUrl = useReferencedImageDataUrl(path, mimeType);
  const open = useOpenChatFileRef();
  return (
    <figure>
      <button
        type="button"
        className="generated-image-preview"
        onClick={() => void open(path)}
        aria-label={t("settings.generatedImage", { index: index + 1 })}
      >
        {dataUrl ? (
          <img src={dataUrl} alt={t("settings.generatedImage", { index: index + 1 })} />
        ) : (
          <span>{t("settings.imagePreviewUnavailable")}</span>
        )}
      </button>
    </figure>
  );
}

export function GeneratedImages({ message }: { message: UiMessage }) {
  const { t } = useTranslation();
  if (message.toolName !== "GenerateImages") return null;
  const payload = toolResultPayload(message);
  const record =
    payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
  const results =
    record?.kind === "generated-images" && Array.isArray(record.results) ? record.results : [];
  const needsSetup =
    record?.kind === "image-generation-error" &&
    [
      "IMAGE_NOT_CONFIGURED",
      "IMAGE_MODEL_UNAVAILABLE",
      "IMAGE_AUTH_FAILED",
      "IMAGE_AUTH_UNSUPPORTED",
    ].includes(String(record.errorCode));
  return (
    <div className="generated-images" aria-label={t("settings.imageModel")}>
      {needsSetup ? (
        <div>
          <p>{t("settings.imageModelSetupHint")}</p>
          <Button
            variant="ghost"
            onClick={() => {
              const state = useAppStore.getState();
              state.setSettingsTab("agent");
              state.setSettingsAnchor("settings.imageModel");
              state.setPage("settings");
            }}
          >
            {t("settings.configureImageModel")}
          </Button>
        </div>
      ) : null}
      {results.map((raw, index) => {
        if (!raw || typeof raw !== "object") return null;
        const item = raw as Record<string, unknown>;
        return item.status === "succeeded" && typeof item.path === "string" ? (
          <ImageResult
            key={index}
            path={item.path}
            index={index}
            mimeType={typeof item.mimeType === "string" ? item.mimeType : undefined}
          />
        ) : (
          <p key={index} role="status">
            {t("settings.imageGenerationFailed", { index: index + 1 })}{" "}
            {typeof item.errorCode === "string" ? item.errorCode : ""}
          </p>
        );
      })}
    </div>
  );
}
