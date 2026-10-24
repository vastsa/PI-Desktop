import { useTranslation } from "react-i18next";
import { downloadMermaidSvg, standaloneMermaidSvg } from "../lib/mermaid-export";
import { useAppStore } from "../stores/app-store";
import { IconDownload, IconImage } from "./icons";
import { TooltipButton } from "./ui";

export function MermaidSvgActions({ svg }: { svg: string }) {
  const { t } = useTranslation();
  const showToast = useAppStore((state) => state.showToast);
  const copy = async () => {
    if (!svg) return;
    try {
      await navigator.clipboard.writeText(standaloneMermaidSvg(svg));
      showToast(t("chat.diagramSvgCopied"), { variant: "success" });
    } catch {
      showToast(t("chat.copyFailed"), { variant: "error" });
    }
  };
  const download = () => {
    if (!svg) return;
    try {
      downloadMermaidSvg(standaloneMermaidSvg(svg));
    } catch {
      showToast(t("chat.diagramSvgExportFailed"), { variant: "error" });
    }
  };
  return (
    <>
      <TooltipButton
        type="button"
        className="mermaid-action-btn"
        tooltip={t("chat.copyDiagramSvg")}
        disabled={!svg}
        onClick={() => void copy()}
      >
        <IconImage size={13} />
      </TooltipButton>
      <TooltipButton
        type="button"
        className="mermaid-action-btn"
        tooltip={t("chat.exportDiagramSvg")}
        disabled={!svg}
        onClick={download}
      >
        <IconDownload size={13} />
      </TooltipButton>
    </>
  );
}
