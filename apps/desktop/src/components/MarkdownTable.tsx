import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useBlockingOverlay } from "../lib/blocking-overlay";
import { useAppStore } from "../stores/app-store";
import { IconClose, IconCopy, IconDownload, IconPanelMaximize } from "./icons";
import { portalOverlay, TooltipButton } from "./ui";
import "../styles/markdown-table.css";

function TablePreview({ children, onClose }: {
  children: ReactNode;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useBlockingOverlay();
  useLayoutEffect(() => {
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);
  const handleKeyDown = (event: KeyboardEvent) => {
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
    if (event.key !== "Tab") return;
    const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
    );
    if (!focusable?.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  return portalOverlay(
    <div
      className="overlay markdown-table-overlay"
      role="presentation"
      onKeyDown={handleKeyDown}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="dialog markdown-table-preview"
        role="dialog"
        aria-modal="true"
        aria-label={t("chat.tablePreview")}
      >
        <header className="markdown-table-preview-head">
          <span>{t("chat.tablePreview")}</span>
          <TooltipButton
            ref={closeRef}
            type="button"
            className="icon-btn"
            tooltip={t("chat.closeTablePreview")}
            onClick={onClose}
          >
            <IconClose size={16} />
          </TooltipButton>
        </header>
        <div className="markdown-table-preview-body prose-chat">{children}</div>
      </div>
    </div>,
  );
}

export function MarkdownTable({ children, markdown, csv }: {
  children: ReactNode;
  markdown: string;
  csv: string;
}) {
  const { t } = useTranslation();
  const showToast = useAppStore((state) => state.showToast);
  const [preview, setPreview] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(markdown);
      showToast(t("chat.tableCopied"), { variant: "success" });
    } catch {
      showToast(t("chat.tableCopyFailed"), { variant: "error" });
    }
  };
  const download = () => {
    let url: string | undefined;
    const link = document.createElement("a");
    try {
      url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
      link.href = url;
      link.download = "table.csv";
      document.body.append(link);
      link.click();
    } catch {
      showToast(t("chat.tableExportFailed"), { variant: "error" });
    } finally {
      link.remove();
      // Keep the URL alive until the browser has consumed the download click.
      if (url) {
        const downloadUrl = url;
        window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
      }
    }
  };
  const toolbar = (expanded = false) => (
    <div className="markdown-table-actions" role="group" aria-label={t("chat.tableActions")}>
      <TooltipButton
        type="button"
        className="icon-btn"
        tooltip={t("chat.copyTableMarkdown")}
        onClick={() => void copy()}
      >
        <IconCopy size={14} />
      </TooltipButton>
      <TooltipButton
        type="button"
        className="icon-btn"
        tooltip={t("chat.exportTableCsv")}
        onClick={download}
      >
        <IconDownload size={14} />
      </TooltipButton>
      {!expanded ? (
        <TooltipButton
          type="button"
          className="icon-btn"
          tooltip={t("chat.tablePreview")}
          onClick={() => setPreview(true)}
        >
          <IconPanelMaximize size={14} />
        </TooltipButton>
      ) : null}
    </div>
  );
  return (
    <div className="markdown-table">
      {toolbar()}
      {children}
      {preview ? (
        <TablePreview onClose={() => setPreview(false)}>
          {toolbar(true)}
          {children}
        </TablePreview>
      ) : null}
    </div>
  );
}
