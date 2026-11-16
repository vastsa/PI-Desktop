import { useTranslation } from "react-i18next";
import { fileReferenceLabel } from "@pi-desktop/shared";
import { IconFolder, IconX } from "../../components/icons";
import { Button } from "../../components/ui";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";

export function DirectoryReferenceCard({
  path,
  name = fileReferenceLabel(path),
  sessionId,
  onRemove,
  disabled,
}: {
  path: string;
  name?: string;
  sessionId?: string;
  onRemove?: () => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const details = (
    <>
      <IconFolder size={20} />
      <span className="directory-reference-details">
        <span className="directory-reference-name">{name}</span>
        <span className="directory-reference-type">{t("chat.directoryReference")}</span>
      </span>
    </>
  );
  return (
    <span className="directory-reference-card" title={path}>
      {sessionId ? (
        <Button
          type="button"
          variant="ghost"
          className="directory-reference-main"
          onClick={() => void api.fsRevealDirectory(path, sessionId).catch((error: unknown) => {
            useAppStore.getState().showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
          })}
        >
          {details}
        </Button>
      ) : <span className="directory-reference-main">{details}</span>}
      {onRemove ? (
        <Button
          type="button"
          variant="ghost"
          className="directory-reference-remove"
          aria-label={t("chat.removeFileReference", { name })}
          disabled={disabled}
          onMouseDown={(event) => event.preventDefault()}
          onClick={onRemove}
        >
          <IconX size={13} />
        </Button>
      ) : null}
    </span>
  );
}
