import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { UiMessage } from "@pi-desktop/shared";
import { useReferencedImageDataUrl } from "../../../lib/use-referenced-image-data-url";
import { toolResultPayload } from "../../../lib/tool-presentation";
import { useAppStore } from "../../../stores/app-store";
import { Button, TooltipButton } from "../../../components/ui";
import { IconDownload } from "../../../components/icons";
import { GeneratedImageViewer } from "./GeneratedImageViewer";
import { GeneratedImageThumbnail, type GeneratedImageRef } from "./GeneratedImageThumbnail";
import { generatedImageDownloadName } from "./generated-image-download";

function ImageResult({
  path,
  index,
  mimeType,
  onOpen,
}: {
  path: string;
  index: number;
  mimeType?: string;
  onOpen: (trigger: HTMLButtonElement) => void;
}) {
  const { t } = useTranslation();
  const dataUrl = useReferencedImageDataUrl(path, mimeType);
  const downloadName = generatedImageDownloadName(dataUrl, index);
  return (
    <figure className="generated-image-card">
      <TooltipButton
        type="button"
        className="generated-image-preview"
        onClick={(event) => onOpen(event.currentTarget)}
        tooltip={t("settings.generatedImage", { index: index + 1 })}
      >
        {dataUrl ? (
          <img src={dataUrl} alt={t("settings.generatedImage", { index: index + 1 })} />
        ) : (
          <span>{t("settings.imagePreviewUnavailable")}</span>
        )}
      </TooltipButton>
      <figcaption className="generated-image-actions">
        {downloadName && dataUrl ? (
          <a href={dataUrl} download={downloadName} aria-label={t("settings.downloadGeneratedImage")} title={t("settings.downloadGeneratedImage")}>
            <IconDownload size={18} />
          </a>
        ) : null}
      </figcaption>
    </figure>
  );
}

export function GeneratedImages({ message }: { message: UiMessage }) {
  const { t } = useTranslation();
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [selectedImageIndex, setSelectedImageIndex] = useState(0);
  const focusReturnRef = useRef<HTMLElement | null>(null);
  if (message.toolName !== "GenerateImages") return null;
  const payload = toolResultPayload(message);
  const record =
    payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
  const results =
    record?.kind === "generated-images" && Array.isArray(record.results) ? record.results : [];
  const images: GeneratedImageRef[] = results.flatMap((raw, index) => {
    if (!raw || typeof raw !== "object") return [];
    const item = raw as Record<string, unknown>;
    return item.status === "succeeded" && typeof item.path === "string"
      ? [{ path: item.path, index, mimeType: typeof item.mimeType === "string" ? item.mimeType : undefined }]
      : [];
  });
  const selectedPosition = Math.min(selectedImageIndex, Math.max(0, images.length - 1));
  const selectedImage = images[selectedPosition];
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
      {selectedImage ? (
        <div className={`generated-image-set${images.length > 1 ? " is-multiple" : ""}`}>
          <ImageResult
            path={selectedImage.path}
            index={selectedImage.index}
            mimeType={selectedImage.mimeType}
            onOpen={(trigger) => {
              focusReturnRef.current = trigger;
              setViewerIndex(selectedPosition);
            }}
          />
          {images.length > 1 ? (
            <nav className="generated-image-thumbnails" aria-label={t("chat.imagePreview.title")}>
              {images.map((image, position) => (
                <GeneratedImageThumbnail
                  key={`${image.index}:${image.path}`}
                  image={image}
                  selected={position === selectedPosition}
                  onSelect={() => setSelectedImageIndex(position)}
                  className="generated-image-thumb"
                />
              ))}
            </nav>
          ) : null}
        </div>
      ) : null}
      {results.map((raw, index) => {
        if (!raw || typeof raw !== "object") return null;
        const item = raw as Record<string, unknown>;
        return item.status === "succeeded" && typeof item.path === "string" ? null : (
          <p key={index} role="status">
            {t("settings.imageGenerationFailed", { index: index + 1 })}{" "}
            {typeof item.errorCode === "string" ? item.errorCode : ""}
          </p>
        );
      })}
      {viewerIndex !== null && images[viewerIndex] ? (
        <GeneratedImageViewer
          images={images}
          selectedIndex={viewerIndex}
          onSelect={(index) => {
            setViewerIndex(index);
            setSelectedImageIndex(index);
          }}
          onClose={() => setViewerIndex(null)}
          focusReturnRef={focusReturnRef}
        />
      ) : null}
    </div>
  );
}
