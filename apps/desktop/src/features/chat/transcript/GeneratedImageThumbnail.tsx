import { useTranslation } from "react-i18next";
import { TooltipButton } from "../../../components/ui";
import { useReferencedImageDataUrl } from "../../../lib/use-referenced-image-data-url";

export type GeneratedImageRef = { path: string; mimeType?: string; index: number };

export function GeneratedImageThumbnail({ image, selected, onSelect, className }: {
  image: GeneratedImageRef;
  selected: boolean;
  onSelect: () => void;
  className: string;
}) {
  const { t } = useTranslation();
  const src = useReferencedImageDataUrl(image.path, image.mimeType);
  return (
    <TooltipButton
      type="button"
      className={className}
      tooltip={t("settings.generatedImage", { index: image.index + 1 })}
      aria-current={selected ? "true" : undefined}
      onClick={onSelect}
    >
      {src ? <img src={src} alt="" /> : <span aria-hidden="true">{image.index + 1}</span>}
    </TooltipButton>
  );
}
