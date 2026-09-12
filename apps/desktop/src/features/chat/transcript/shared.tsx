import {
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import type {
  MessageAttachment,
  MessageUsage,
  UiMessage,
} from "@pi-desktop/shared";
import {
  THINKING_LEVELS,
  type ThinkingLevel,
} from "@pi-desktop/shared";
import { useOpenChatFileRef, useOpenPreviewTarget } from "../../../hooks/use-preview-target";
import { messageThinking as thinkingText } from "../../../lib/assistant-turns";
import { useReferencedImageDataUrl } from "../../../lib/use-referenced-image-data-url";
import { isHtmlFilePath, splitChatText } from "../../../lib/chat-links";
import { getToolAction, type ToolAction } from "../../../lib/tool-display";
import { calculateTokenRate } from "../../../lib/context-usage";
import { useAppStore } from "../../../stores/app-store";
import { Markdown, useCopy } from "../../../components/Markdown";
import {
  IconArchive,
  IconAudio,
  IconBot,
  IconBranch,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconCircleAlert,
  IconCode,
  IconCopy,
  IconFileText,
  IconFolder,
  IconGlobe,
  IconImage,
  IconPencil,
  IconSearch,
  IconSheet,
  IconSparkles,
  IconTerminal,
  IconVideo,
  IconWrench,
} from "../../../components/icons";
import { TooltipButton } from "../../../components/ui";

type Translate = (key: string, options?: Record<string, unknown>) => string;

export function CopyButton({
  text,
  label,
  withLabel = false,
}: {
  text: string;
  label: string;
  withLabel?: boolean;
}) {
  const { copied, copy } = useCopy();
  const { t } = useTranslation();
  const tip = copied ? t("chat.copied") : label;
  if (withLabel) {
    return (
      <button
        className={`copy-btn ${copied ? "copied" : ""}`}
        title={tip}
        aria-label={label}
        onClick={() => copy(text)}
      >
        {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
        <span>{tip}</span>
      </button>
    );
  }
  return (
    <TooltipButton
      className={`copy-btn icon ${copied ? "copied" : ""}`}
      tooltip={tip}
      ariaLabel={label}
      onClick={() => copy(text)}
    >
      {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
    </TooltipButton>
  );
}


export function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 10_000) return `${Math.round(value / 1000)}k`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
}


export function MessageMeta({
  modelId,
  usage,
  responseDurationMs,
  responseOutputTokens,
}: {
  modelId?: string;
  usage?: MessageUsage;
  responseDurationMs?: number;
  responseOutputTokens?: number;
}) {
  const { t } = useTranslation();
  const throughput = calculateTokenRate(
    responseOutputTokens ?? usage?.outputTokens ?? 0,
    responseDurationMs,
  );
  const showThroughput = !usage && throughput !== undefined;
  if (!modelId && !showThroughput) {
    return null;
  }
  return (
    <div className="message-meta">
      {modelId ? (
        <span className="message-meta-chip model" title={modelId}>
          {modelId}
        </span>
      ) : null}
      {showThroughput ? (
        <span className="message-meta-chip throughput">
          {t("chat.usageThroughputEstimated", {
            count: formatTokenCount(throughput),
          })}
        </span>
      ) : null}
    </div>
  );
}

export function AssistantErrorMessage({ message }: { message: UiMessage }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(true);
  const detailsId = useId();
  const error = message.error;
  if (!error) return null;
  const localizedKey = `errors.${error.code}`;
  const localized = t(localizedKey);
  const summary = localized === localizedKey ? t("chat.responseFailed") : localized;
  const configurationError = [
    "MODEL_NOT_CONFIGURED",
    "PROVIDER_SECRET_MISSING",
    "PROVIDER_UNAUTHORIZED",
  ].includes(error.code);

  return (
    <section className="message-error" aria-label={t("chat.responseError")}>
      <div className="message-error-heading">
        <span className="message-error-icon" aria-hidden>
          <IconCircleAlert size={16} />
        </span>
        <div className="message-error-copy">
          <strong>{summary}</strong>
          <code>{error.code}</code>
        </div>
        <div className="message-error-actions">
          <button
            type="button"
            className="message-error-toggle"
            aria-expanded={open}
            aria-controls={detailsId}
            onClick={() => setOpen((value) => !value)}
          >
            <IconChevronRight size={12} aria-hidden />
            {open ? t("chat.hideErrorDetails") : t("chat.showErrorDetails")}
          </button>
          <button
            type="button"
            className="copy-btn primary"
            onClick={() =>
              void useAppStore
                .getState()
                .sendPrompt(t("chat.continueCurrentTaskPrompt"))
            }
          >
            {t("errors.action.continue")}
          </button>
          {configurationError ? (
            <button
              type="button"
              className="copy-btn"
              onClick={() => {
                useAppStore.getState().setSettingsTab("agent");
                useAppStore.getState().setPage("settings");
              }}
            >
              {t("errors.action.openSettings")}
            </button>
          ) : null}
        </div>
      </div>
      <div
        id={detailsId}
        className={`message-error-details ${open ? "open" : ""}`}
        hidden={!open}
      >
        <dl>
          {message.providerId ? (
            <>
              <dt>{t("chat.errorProvider")}</dt>
              <dd>{message.providerId}</dd>
            </>
          ) : null}
          {message.modelId ? (
            <>
              <dt>{t("chat.errorModel")}</dt>
              <dd>{message.modelId}</dd>
            </>
          ) : null}
        </dl>
        <div className="message-error-raw">
          <pre className="selectable">{error.message}</pre>
          <CopyButton text={error.message} label={t("chat.copyErrorDetails")} />
        </div>
      </div>
    </section>
  );
}

export const TOOL_ACTION_KEYS: Record<ToolAction, string> = {
  read: "chat.toolRead",
  list: "chat.toolListed",
  search: "chat.toolSearched",
  write: "chat.toolWrote",
  edit: "chat.toolEdited",
  run: "chat.toolRan",
  fetch: "chat.toolFetched",
  fork: "chat.toolUsed",
  delegate: "chat.toolDelegated",
  use: "chat.toolUsed",
};

/**
 * A lifecycle row says what it did to subagents, not that it "delegated":
 * `Task` is the only call that delegates (ADR 0062, ADR 0089, D268).
 */
export const LIFECYCLE_LABEL_KEYS: Record<"wait" | "list" | "stop", string> = {
  wait: "chat.subagentWaited",
  list: "chat.subagentListed",
  stop: "chat.subagentStopped",
};

/** A wait in progress is the one lifecycle row that visibly takes time. */
export const LIFECYCLE_RUNNING_KEYS: Record<"wait" | "list" | "stop", string> = {
  wait: "chat.subagentWaiting",
  list: "chat.subagentListing",
  stop: "chat.subagentStopping",
};

export const TOOL_RUNNING_KEYS: Record<ToolAction, string> = {
  read: "chat.toolReading",
  list: "chat.toolListing",
  search: "chat.toolSearching",
  write: "chat.toolWriting",
  edit: "chat.toolEditing",
  run: "chat.toolRunning",
  fetch: "chat.toolFetching",
  fork: "chat.toolUsing",
  delegate: "chat.toolDelegating",
  use: "chat.toolUsing",
};

export function ToolActionIcon({ action }: { action: ToolAction }) {
  const props = { size: 15, "aria-hidden": true };
  switch (action) {
    case "read":
      return <IconFileText {...props} />;
    case "list":
      return <IconFolder {...props} />;
    case "search":
      return <IconSearch {...props} />;
    case "write":
    case "edit":
      return <IconPencil {...props} />;
    case "run":
      return <IconTerminal {...props} />;
    case "fetch":
      return <IconGlobe {...props} />;
    case "fork":
      return <IconBranch {...props} />;
    case "delegate":
      return <IconBot {...props} />;
    default:
      return <IconWrench {...props} />;
  }
}

/**
 * Automatic disclosure is deliberately separate from user disclosure state.
 * A running process may open its latest details and close them when it settles,
 * but one user click takes ownership for the rest of that component's lifetime.
 * Layout effects keep the automatic transition from moving the transcript for a
 * painted frame.
 */
export function useAutomaticDisclosure(automaticOpen: boolean) {
  const [open, setOpen] = useState(automaticOpen);
  const userInteractedRef = useRef(false);
  const previousAutomaticOpenRef = useRef(automaticOpen);

  useLayoutEffect(() => {
    if (userInteractedRef.current) return;
    if (previousAutomaticOpenRef.current === automaticOpen) return;
    previousAutomaticOpenRef.current = automaticOpen;
    setOpen(automaticOpen);
  }, [automaticOpen]);

  const claim = useCallback(() => {
    userInteractedRef.current = true;
  }, []);

  const toggle = useCallback(() => {
    claim();
    setOpen((value) => !value);
  }, [claim]);

  const collapse = useCallback(() => {
    claim();
    setOpen(false);
  }, [claim]);

  return { open, toggle, collapse, claim };
}

/** Actions whose path/url argument makes sense to preview in the panel. */
export const PREVIEWABLE_ACTIONS = new Set<ToolAction>(["read", "write", "edit", "fetch"]);

export function fileChipIcon(name: string, kind?: "image" | "file") {
  if (kind === "image" || /\.(avif|bmp|gif|heic|jpe?g|png|tiff?|webp)$/i.test(name)) {
    return IconImage;
  }
  if (
    /\.(cjs|css|go|html?|java|js|json|jsx|kt|mjs|php|py|rb|rs|sh|sql|svelte|swift|toml|ts|tsx|vue|ya?ml)$/i.test(
      name,
    )
  ) {
    return IconCode;
  }
  if (/\.(7z|bz2|gz|jar|rar|tar|zip)$/i.test(name)) return IconArchive;
  if (/\.(csv|ods|xls|xlsx)$/i.test(name)) return IconSheet;
  if (/\.(flac|m4a|mp3|ogg|wav)$/i.test(name)) return IconAudio;
  if (/\.(avi|mkv|m4v|mov|mp4|webm)$/i.test(name)) return IconVideo;
  return IconFileText;
}

/** Compact leaf-name chip matching the composer file node (D320). */
export function FileRefChip({
  name,
  path,
  kind,
  onOpen,
}: {
  name: string;
  path: string;
  kind?: "image" | "file";
  onOpen: (path: string) => void;
}) {
  const { t } = useTranslation();
  const Icon = fileChipIcon(name, kind);
  const html = isHtmlFilePath(path) || isHtmlFilePath(name);
  return (
    <button
      type="button"
      className="composer-chip chat-file-chip"
      title={`${html ? t("chat.previewUrl") : t("chat.openFile")} — ${path}`}
      aria-label={`${name} — ${path}`}
      onClick={() => onOpen(path)}
    >
      <span className="composer-chip-icon" aria-hidden>
        <Icon size={13} />
      </span>
      <span className="composer-chip-name">{name}</span>
    </button>
  );
}

/**
 * User-message image attachment as a thumbnail. The host resolves the ref
 * into a bounded data URL; an unresolvable load falls back to the file chip.
 * Clicking opens the files viewer on the same contained ref.
 */
export function MessageAttachmentImage({
  attachment,
  onOpenFile,
}: {
  attachment: MessageAttachment;
  onOpenFile: (path: string) => void;
}) {
  const dataUrl = useReferencedImageDataUrl(attachment.ref, attachment.mimeType);
  if (!dataUrl) {
    return (
      <FileRefChip
        name={attachment.name}
        path={attachment.ref}
        kind="image"
        onOpen={onOpenFile}
      />
    );
  }
  return (
    <button
      type="button"
      className="message-attachment-image"
      role="listitem"
      title={`${attachment.name} — ${attachment.ref}`}
      onClick={() =>
        useAppStore.getState().openFileInWorkPanel(attachment.ref, attachment.mimeType)
      }
    >
      <img src={dataUrl} alt={attachment.name} />
    </button>
  );
}

/** Plain user text: @paths become composer-like chips; URLs stay text links. */
export function LinkifiedText({ text }: { text: string }) {
  const { t } = useTranslation();
  const root = useAppStore((s) => s.workspace?.path);
  const openTarget = useOpenPreviewTarget();
  const openFileRef = useOpenChatFileRef();
  const segments = useMemo(() => splitChatText(text, root), [text, root]);
  return (
    <>
      {segments.map((segment, index) =>
        segment.kind === "text" ? (
          <span key={index}>{segment.text}</span>
        ) : segment.target.kind === "file" ? (
          <FileRefChip
            key={index}
            name={segment.label}
            path={segment.target.path}
            onOpen={openFileRef}
          />
        ) : (
          <TooltipButton
            key={index}
            type="button"
            className="chat-text-link"
            tooltip={t("chat.previewUrl")}
            ariaLabel={segment.text}
            onClick={() => openTarget(segment.target)}
          >
            {segment.text}
          </TooltipButton>
        ),
      )}
    </>
  );
}

/** Definition name a `Task` row delegated to, from the rows it produced or,
 * before any arrived, from the call's own argument. */

export function ToolCommandCopy({ command }: { command: string }) {
  const { t } = useTranslation();
  const { copied, copy } = useCopy();
  return (
    <TooltipButton
      className={`tool-row-head-copy${copied ? " copied" : ""}`}
      ariaLabel={`${t("chat.copy")} ${t("chat.toolBlockCommand")}`}
      tooltip={copied ? t("chat.copied") : t("chat.copy")}
      onClick={() => copy(command)}
    >
      {copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
    </TooltipButton>
  );
}

export function DisclosureCollapseRail({
  label,
  onCollapse,
}: {
  label: string;
  onCollapse: () => void;
}) {
  return (
    <TooltipButton
      type="button"
      className="disclosure-collapse-rail"
      ariaLabel={label}
      tooltip={label}
      onClick={onCollapse}
    />
  );
}

/** A thinking segment rendered like a tool row: one-line summary, expandable. */
export function ThinkingRow({
  message,
  streaming,
  autoOpen = false,
  onUserInteraction,
}: {
  message: UiMessage;
  streaming: boolean;
  autoOpen?: boolean;
  onUserInteraction?: () => void;
}) {
  const { t } = useTranslation();
  const detailsId = useId();
  const { open, toggle: toggleDisclosure, collapse: collapseDisclosure } =
    useAutomaticDisclosure(autoOpen);
  const toggleRow = useCallback(() => {
    onUserInteraction?.();
    toggleDisclosure();
  }, [onUserInteraction, toggleDisclosure]);
  const collapseRow = useCallback(() => {
    onUserInteraction?.();
    collapseDisclosure();
  }, [collapseDisclosure, onUserInteraction]);
  const text = thinkingText(message);
  const summary = text.replace(/\s+/g, " ").trim();
  return (
    <div className={`tool-row thinking ${open ? "open" : ""}`}>
      <button
        className="tool-row-header"
        aria-expanded={open}
        aria-controls={detailsId}
        aria-label={t(open ? "chat.thinkingHide" : "chat.thinkingShow")}
        onClick={toggleRow}
      >
        <span className="tool-row-icon">
          <IconSparkles size={15} aria-hidden />
        </span>
        <span className={`tool-row-name ${streaming ? "running" : ""}`}>
          {t("chat.thinking", { defaultValue: "Thinking" })}
        </span>
        <span className="tool-row-summary">{summary}</span>
        <span className="tool-row-caret" aria-hidden>
          <IconChevronRight size={12} />
        </span>
      </button>
      {open ? (
        <div className="tool-row-body" id={detailsId}>
          <DisclosureCollapseRail
            label={t("chat.thinkingHide")}
            onCollapse={collapseRow}
          />
          <div className="prose-chat thinking-prose">
            <Markdown source={text} renderDiagrams={false} />
          </div>
        </div>
      ) : null}
    </div>
  );
}
