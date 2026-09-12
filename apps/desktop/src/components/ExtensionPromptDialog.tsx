import { useEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { TrustedExtensionUiPrompt } from "@pi-desktop/shared";
import { api } from "../lib/api";
import { useAppStore } from "../stores/app-store";
import { Button, TooltipButton } from "./ui";
import { IconClose, IconPlug } from "./icons";

/**
 * Modal prompts raised by trusted extensions (`ui.confirm` / `ui.select` /
 * `ui.input`, spec 16 §9). Main queues one prompt per session; this host
 * shows whichever arrived first and answers it through
 * `extensions/ui/respond`. Dismissing answers with the abort value.
 */
export function ExtensionPromptHost() {
  const [queue, setQueue] = useState<TrustedExtensionUiPrompt[]>([]);
  // `ui.setStatus` / `ui.setWorkingMessage` texts per session and key.
  const [status, setStatus] = useState<Record<string, Record<string, string>>>({});
  const activeSessionId = useAppStore((state) => state.activeSessionId);

  useEffect(() => {
    const offPrompt = api.onExtensionPrompt((prompt) => {
      setQueue((prev) => (prev.some((p) => p.promptId === prompt.promptId) ? prev : [...prev, prompt]));
    });
    const offStatus = api.onExtensionStatus((event) => {
      setStatus((prev) => {
        const session = { ...(prev[event.sessionId] ?? {}) };
        const key = `${event.extensionId}\u0000${event.key}`;
        if (event.text) session[key] = event.text;
        else delete session[key];
        return { ...prev, [event.sessionId]: session };
      });
    });
    return () => {
      offPrompt();
      offStatus();
    };
  }, []);

  const current = queue[0];
  const statusTexts = activeSessionId ? Object.values(status[activeSessionId] ?? {}) : [];

  const settle = (value?: string | boolean) => {
    if (!current) return;
    void api.respondExtensionPrompt({ promptId: current.promptId, value }).catch(() => undefined);
    setQueue((prev) => prev.filter((p) => p.promptId !== current.promptId));
  };

  return (
    <>
      {statusTexts.length ? (
        <div className="extension-status-line" role="status" aria-live="polite">
          {statusTexts.map((text, index) => (
            <span key={index} className="extension-status-item">
              {text}
            </span>
          ))}
        </div>
      ) : null}
      {current ? (
        <ExtensionPromptDialog key={current.promptId} prompt={current} onSettle={settle} />
      ) : null}
    </>
  );
}

function ExtensionPromptDialog({
  prompt,
  onSettle,
}: {
  prompt: TrustedExtensionUiPrompt;
  onSettle: (value?: string | boolean) => void;
}) {
  const { t } = useTranslation();
  const { request } = prompt;
  const [draft, setDraft] = useState("");
  const [selected, setSelected] = useState<string | undefined>(
    request.kind === "select" ? request.options[0] : undefined,
  );
  const inputRef = useRef<HTMLInputElement | null>(null);
  const dialogId = `extension-prompt-${prompt.promptId}`;

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    requestAnimationFrame(() => inputRef.current?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onSettle(undefined);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [onSettle]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (request.kind === "confirm") onSettle(true);
    else if (request.kind === "select") onSettle(selected);
    else onSettle(draft);
  };

  const title =
    request.kind === "confirm" || request.kind === "select" || request.kind === "input"
      ? request.title
      : "";

  const dialog = (
    <div
      className="overlay session-rename-dialog-overlay extension-prompt-overlay"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onSettle(undefined);
      }}
    >
      <div
        className="dialog session-rename-dialog extension-prompt-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${dialogId}-title`}
        aria-describedby={`${dialogId}-source`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="session-rename-dialog-head">
          <div>
            <h2 id={`${dialogId}-title`} className="session-rename-dialog-title">
              <IconPlug size={16} aria-hidden />
              {title}
            </h2>
            <p id={`${dialogId}-source`} className="session-rename-dialog-description">
              {t("plugins.agentExtension.prompt.source", { label: prompt.extensionLabel })}
              <code className="extension-prompt-source-path">{prompt.extensionId}</code>
            </p>
          </div>
          <TooltipButton
            type="button"
            className="session-rename-dialog-close"
            ariaLabel={t("common.cancel")}
            tooltip={t("common.cancel")}
            onClick={() => onSettle(undefined)}
          >
            <IconClose size={16} />
          </TooltipButton>
        </div>
        <form onSubmit={submit}>
          {request.kind === "confirm" ? (
            <p className="extension-prompt-message">{request.message}</p>
          ) : null}
          {request.kind === "select" ? (
            <div className="extension-prompt-options" role="radiogroup" aria-label={request.title}>
              {request.options.map((option) => (
                <label key={option} className="extension-prompt-option">
                  <input
                    type="radio"
                    name={`${dialogId}-option`}
                    value={option}
                    checked={selected === option}
                    onChange={() => setSelected(option)}
                  />
                  <span>{option}</span>
                </label>
              ))}
            </div>
          ) : null}
          {request.kind === "input" ? (
            <input
              ref={inputRef}
              className="field-input"
              value={draft}
              placeholder={request.placeholder ?? t("plugins.agentExtension.prompt.placeholder")}
              onChange={(event) => setDraft(event.target.value)}
              aria-label={request.title}
              spellCheck={false}
            />
          ) : null}
          <div className="session-rename-dialog-actions">
            <Button type="button" variant="ghost" onClick={() => onSettle(undefined)}>
              {request.kind === "confirm"
                ? t("plugins.agentExtension.prompt.no")
                : t("common.cancel")}
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={request.kind === "select" && !selected}
            >
              {request.kind === "confirm"
                ? t("plugins.agentExtension.prompt.yes")
                : t("plugins.agentExtension.prompt.ok")}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
  return createPortal(dialog, document.body);
}
