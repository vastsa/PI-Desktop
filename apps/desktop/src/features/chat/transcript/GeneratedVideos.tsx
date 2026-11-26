import { useTranslation } from "react-i18next";
import type { UiMessage } from "@pi-desktop/shared";
import { toolResultPayload } from "../../../lib/tool-presentation";
import { useAppStore } from "../../../stores/app-store";
import { Button } from "../../../components/ui";
import { IconDownload } from "../../../components/icons";

function videoDownloadName(path?: string): string {
  if (!path) return "generated-video.mp4";
  const base = path.split(/[\\/]/).pop()?.trim();
  return base && /\.[a-z0-9]{2,5}$/i.test(base) ? base : "generated-video.mp4";
}

export function GeneratedVideos({ message }: { message: UiMessage }) {
  const { t } = useTranslation();
  if (message.toolName !== "GenerateVideo") return null;
  const payload = toolResultPayload(message);
  const record =
    payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
  if (!record) return null;

  if (record.kind === "video-generation-error") {
    const errorCode = typeof record.errorCode === "string" ? record.errorCode : "";
    const detail = typeof record.message === "string" ? record.message : "";
    const needsLogin = errorCode === "STARAI_LOGIN_REQUIRED";
    return (
      <div className="generated-videos" aria-label={t("videoModel", { ns: "starAi" })}>
        <div className="generated-video-notice" role="status">
          <p>{needsLogin ? t("videoSignInHint", { ns: "starAi" }) : detail || t("videoGenerationFailed", { ns: "starAi" })}</p>
          {needsLogin ? (
            <Button
              variant="ghost"
              onClick={() => {
                useAppStore.getState().setSettingsTab("agent");
              }}
            >
              {t("openSettings", { ns: "starAi" })}
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  if (record.kind !== "generated-video") return null;
  const result =
    record.result && typeof record.result === "object"
      ? (record.result as Record<string, unknown>)
      : null;
  if (!result || result.status !== "succeeded") {
    const detail = typeof result?.error === "string" ? result.error : "";
    return (
      <div className="generated-videos" aria-label={t("videoModel", { ns: "starAi" })}>
        <p role="status">
          {t("videoGenerationFailed", { ns: "starAi" })}
          {detail ? `: ${detail}` : ""}
        </p>
      </div>
    );
  }

  const mediaUrl = typeof result.mediaUrl === "string" ? result.mediaUrl : undefined;
  const filePath = typeof result.path === "string" ? result.path : undefined;
  const model =
    typeof result.model === "string"
      ? result.model
      : typeof record.modelId === "string"
        ? record.modelId
        : undefined;
  const downloadName = videoDownloadName(filePath);

  return (
    <div className="generated-videos" aria-label={t("videoModel", { ns: "starAi" })}>
      <figure className="generated-video-card">
        {mediaUrl ? (
          <video
            className="generated-video-player"
            src={mediaUrl}
            controls
            playsInline
            preload="metadata"
            aria-label={t("generatedVideo", { ns: "starAi" })}
          />
        ) : null}
        <figcaption className="generated-video-meta">
          <span className="generated-video-label" title={filePath ?? downloadName}>
            {model ? `${model} · ${downloadName}` : downloadName}
          </span>
          {mediaUrl ? (
            <a
              className="generated-video-download"
              href={mediaUrl}
              download={downloadName}
              aria-label={t("downloadGeneratedVideo", { ns: "starAi" })}
              title={t("downloadGeneratedVideo", { ns: "starAi" })}
            >
              <IconDownload size={16} />
            </a>
          ) : null}
        </figcaption>
      </figure>
    </div>
  );
}
