import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { IconChevronLeft, IconChevronRight, IconClose, IconDownload, IconExternal, IconFolder, IconMinus, IconPlus } from "../../../components/icons";
import { Button, TooltipButton } from "../../../components/ui";
import { useOpenChatFileRef } from "../../../hooks/use-preview-target";
import { api } from "../../../lib/api";
import { useBlockingOverlay } from "../../../lib/blocking-overlay";
import { portalToBody } from "../../../lib/portal-visibility";
import { useReferencedImageDataUrl } from "../../../lib/use-referenced-image-data-url";
import { useAppStore } from "../../../stores/app-store";
import { generatedImageDownloadName } from "./generated-image-download";
import { GeneratedImageThumbnail, type GeneratedImageRef } from "./GeneratedImageThumbnail";

export function GeneratedImageViewer({ images, selectedIndex, onSelect, onClose, focusReturnRef }: {
  images: GeneratedImageRef[];
  selectedIndex: number;
  onSelect: (index: number) => void;
  onClose: () => void;
  focusReturnRef: RefObject<HTMLElement | null>;
}) {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const knownNaturalSizesRef = useRef(new Map<string, { width: number; height: number }>());
  const navigationRequestRef = useRef(0);
  const pendingIndexRef = useRef<number | null>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [natural, setNatural] = useState<{ src: string; width: number; height: number } | null>(null);
  const [manualZoom, setManualZoom] = useState<{ src: string; value: number } | null>(null);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const selected = images[selectedIndex];
  const src = useReferencedImageDataUrl(selected?.path, selected?.mimeType);
  const size = selected && src && failedSrc !== src
    ? knownNaturalSizesRef.current.get(selected.path) ?? (natural?.src === src ? natural : null)
    : null;
  const fit = size && viewport.width > 0 && viewport.height > 0
    ? Math.min(1, viewport.width / size.width, viewport.height / size.height)
    : 1;
  const zoom = manualZoom?.src === src ? manualZoom.value : fit;
  const downloadName = generatedImageDownloadName(src, selected?.index ?? 0);
  const openFile = useOpenChatFileRef();
  useBlockingOverlay();

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    return () => {
      navigationRequestRef.current += 1;
      pendingIndexRef.current = null;
      dialog.close();
      focusReturnRef.current?.focus();
    };
  }, [focusReturnRef]);

  useLayoutEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const resize = () => setViewport({ width: element.clientWidth, height: element.clientHeight });
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const selectImage = async (nextIndex: number) => {
    if (nextIndex < 0 || nextIndex >= images.length) return;
    const request = ++navigationRequestRef.current;
    if (nextIndex === selectedIndex) {
      pendingIndexRef.current = null;
      return;
    }
    pendingIndexRef.current = nextIndex;
    const thumbnail = dialogRef.current?.querySelectorAll<HTMLImageElement>(".generated-image-viewer-thumb img")[nextIndex];
    if (thumbnail?.src) {
      try {
        await thumbnail.decode();
      } catch {
        // The viewer will show its existing unavailable state for unreadable images.
      }
      if (request !== navigationRequestRef.current) return;
      if (thumbnail.naturalWidth > 0 && thumbnail.naturalHeight > 0) {
        knownNaturalSizesRef.current.set(images[nextIndex].path, {
          width: thumbnail.naturalWidth,
          height: thumbnail.naturalHeight,
        });
      }
    }
    if (request === navigationRequestRef.current) {
      pendingIndexRef.current = null;
      onSelect(nextIndex);
    }
  };
  const move = (direction: number) => {
    void selectImage((pendingIndexRef.current ?? selectedIndex) + direction);
  };
  const closeViewer = () => {
    navigationRequestRef.current += 1;
    pendingIndexRef.current = null;
    onClose();
  };
  const changeZoom = (value: number) => {
    if (src) setManualZoom({ src, value: Math.min(4, Math.max(Math.min(0.1, fit), value)) });
  };
  const reveal = async () => {
    if (!selected) return;
    try {
      await api.fsReveal(selected.path);
    } catch {
      useAppStore.getState().showToast(t("settings.imageRevealFailed"), { variant: "error" });
    }
  };
  if (!selected) return null;

  return portalToBody(
    <dialog
      ref={dialogRef}
      className="generated-image-viewer"
      aria-label={t("settings.generatedImage", { index: selected.index + 1 })}
      onCancel={(event) => { event.preventDefault(); closeViewer(); }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          move(event.key === "ArrowLeft" ? -1 : 1);
        }
      }}
    >
      <header className="generated-image-viewer-header">
        <TooltipButton type="button" autoFocus onClick={closeViewer} tooltip={t("common.close")}><IconClose size={18} /></TooltipButton>
        <strong>{t("settings.generatedImage", { index: selected.index + 1 })}</strong>
        <div className="generated-image-viewer-header-actions">
          <TooltipButton type="button" onClick={() => { closeViewer(); void openFile(selected.path); }} tooltip={t("chat.previewFile")}><IconExternal size={18} /></TooltipButton>
          <TooltipButton type="button" onClick={() => void reveal()} tooltip={t("settings.revealGeneratedImage")}><IconFolder size={18} /></TooltipButton>
          {src && downloadName ? <a href={src} download={downloadName} aria-label={t("settings.downloadGeneratedImage")} title={t("settings.downloadGeneratedImage")}><IconDownload size={18} /></a> : null}
        </div>
      </header>
      <div className="generated-image-viewer-body">
        {images.length > 1 ? <nav className="generated-image-viewer-thumbs" aria-label={t("chat.imagePreview.title")}>
          {images.map((image, index) => <GeneratedImageThumbnail key={image.path} image={image} selected={index === selectedIndex} onSelect={() => void selectImage(index)} className="generated-image-viewer-thumb" />)}
        </nav> : null}
        <div className="generated-image-viewer-viewport" ref={viewportRef}>
          {src && failedSrc !== src ? <img
            src={src}
            alt={t("settings.generatedImage", { index: selected.index + 1 })}
            draggable={false}
            data-sized={size ? "true" : undefined}
            style={size ? { width: size.width * zoom, height: size.height * zoom } : undefined}
            onLoad={(event) => {
              const { naturalWidth: width, naturalHeight: height } = event.currentTarget;
              if (width > 0 && height > 0) {
                knownNaturalSizesRef.current.set(selected.path, { width, height });
                setNatural({ src, width, height });
              }
            }}
            onError={() => setFailedSrc(src)}
          /> : <p role="status">{t("settings.imagePreviewUnavailable")}</p>}
        </div>
      </div>
      <footer className="generated-image-viewer-footer">
        {images.length > 1 ? <div className="generated-image-viewer-navigation">
          <TooltipButton type="button" disabled={selectedIndex === 0} onClick={() => move(-1)} tooltip={t("chat.imagePreview.previous")}><IconChevronLeft size={18} /></TooltipButton>
          <span role="status">{t("chat.imagePreview.position", { current: selectedIndex + 1, total: images.length })}</span>
          <TooltipButton type="button" disabled={selectedIndex === images.length - 1} onClick={() => move(1)} tooltip={t("chat.imagePreview.next")}><IconChevronRight size={18} /></TooltipButton>
        </div> : null}
        <div className="generated-image-viewer-zoom">
          <TooltipButton type="button" disabled={!size || zoom <= Math.min(0.1, fit)} onClick={() => changeZoom(zoom / 1.25)} tooltip={t("menu.zoomOut")}><IconMinus size={18} /></TooltipButton>
          <output>{Math.round(zoom * 100)}%</output>
          <TooltipButton type="button" disabled={!size || zoom >= 4} onClick={() => changeZoom(zoom * 1.25)} tooltip={t("menu.zoomIn")}><IconPlus size={18} /></TooltipButton>
          <Button type="button" variant="ghost" disabled={!size} onClick={() => setManualZoom(null)}>{t("chat.imagePreview.fit")}</Button>
        </div>
      </footer>
    </dialog>,
  );
}
