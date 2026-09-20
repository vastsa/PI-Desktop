import { useTranslation } from "react-i18next";
import { IconClose, IconImage } from "../../../components/icons";
import type { ComposerImagePreviewController } from "./hooks/useComposerImagePreview";

/** Attachment controls stay outside both the editable draft and its shell. */
export function ComposerImageAttachments({ controller, onRemove, disabled }: {
  controller: ComposerImagePreviewController;
  onRemove: (id: string) => void;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  if (!controller.images.length) return null;
  return (
    <div className="composer-image-attachments">
      {controller.images.map((reference) => {
        const source = controller.sources?.get(reference.id);
        return (
          <div key={reference.id} className="composer-image-attachment">
            <button
              type="button"
              className="composer-image-attachment-open"
              title={reference.path}
              aria-label={`${reference.name} — ${reference.path}`}
              onMouseDown={(event) => { if (event.button === 0) event.preventDefault(); }}
              onClick={() => controller.open(reference)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                controller.open(reference);
              }}
            >
              <IconImage size={24} />
              {source?.status === "ready" ? <img src={source.src} alt="" draggable={false} onError={(event) => { event.currentTarget.hidden = true; }} /> : null}
            </button>
            <button
              type="button"
              className="composer-image-attachment-remove"
              disabled={disabled}
              aria-label={t("chat.removeFileReference", { name: reference.name })}
              title={t("chat.removeFileReference", { name: reference.name })}
              onClick={() => onRemove(reference.id)}
            ><IconClose size={12} /></button>
          </div>
        );
      })}
    </div>
  );
}
