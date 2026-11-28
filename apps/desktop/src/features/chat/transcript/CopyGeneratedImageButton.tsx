import { useCallback, type MouseEvent as ReactMouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { ContextMenu, useContextMenu } from "../../../components/ContextMenu";
import { IconCopy, IconDownload } from "../../../components/icons";
import { TooltipButton } from "../../../components/ui";
import { useAppStore } from "../../../stores/app-store";
import { copyImageDataUrlToClipboard } from "../../../lib/image-clipboard";
import { generatedImageDownloadName } from "./generated-image-download";

/**
 * Receives the copy outcome. Surfaces that render above the toast stack (the
 * modal viewer lives in the top layer) report it inline instead of by toast.
 */
export type GeneratedImageCopyReporter = (copied: boolean) => void;

/** Copies an already-loaded generated image and reports the outcome. */
export function useCopyGeneratedImage(report?: GeneratedImageCopyReporter) {
  const { t } = useTranslation();
  return useCallback(async (dataUrl: string) => {
    let copied = true;
    try {
      await copyImageDataUrlToClipboard(dataUrl);
    } catch {
      copied = false;
    }
    if (report) {
      report(copied);
      return;
    }
    const { showToast } = useAppStore.getState();
    if (copied) showToast(t("chat.copied"));
    else showToast(t("chat.copyFailed"), { variant: "error" });
  }, [report, t]);
}

export function CopyGeneratedImageButton({ dataUrl, onCopied }: {
  dataUrl: string;
  onCopied?: GeneratedImageCopyReporter;
}) {
  const { t } = useTranslation();
  const copy = useCopyGeneratedImage(onCopied);
  return (
    <TooltipButton type="button" onClick={() => void copy(dataUrl)} tooltip={t("settings.copyGeneratedImage")}>
      <IconCopy size={18} />
    </TooltipButton>
  );
}

/**
 * Right-click menu for a generated image (card and viewer). It replaces the
 * enclosing turn's menu on the image itself, so a right-click on the picture
 * offers the picture's own actions, as in a browser.
 */
export function useGeneratedImageContextMenu(dataUrl: string | null, index: number, options: {
  /** Portal target for the menu; the modal viewer passes its `<dialog>`. */
  container?: HTMLElement | null;
  onCopied?: GeneratedImageCopyReporter;
} = {}) {
  const { t } = useTranslation();
  const copy = useCopyGeneratedImage(options.onCopied);
  const { contextMenu, openContextMenu, closeContextMenu } = useContextMenu();
  const downloadName = generatedImageDownloadName(dataUrl, index);
  const onContextMenu = (event: ReactMouseEvent<HTMLElement>) => {
    if (!dataUrl || !downloadName) return;
    openContextMenu(event, {
      label: t("settings.generatedImage", { index: index + 1 }),
      items: [
        {
          id: "copy-image",
          label: t("settings.copyGeneratedImage"),
          icon: <IconCopy size={16} />,
          onSelect: () => void copy(dataUrl),
        },
        {
          id: "download-image",
          label: t("settings.downloadImage"),
          icon: <IconDownload size={16} />,
          onSelect: () => {
            const link = document.createElement("a");
            link.href = dataUrl;
            link.download = downloadName;
            link.click();
          },
        },
      ],
    });
  };
  const menu = <ContextMenu state={contextMenu} onClose={closeContextMenu} container={options.container} />;
  return { onContextMenu, menu };
}
