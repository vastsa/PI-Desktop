import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { GEN_UI_INITIAL_HEIGHT, type GenUiErrorCode, type GenUiReference } from "@pi-desktop/shared";
import { Button, TooltipButton } from "../../../components/ui";
import { IconCircleAlert, IconPanelMaximize } from "../../../components/icons";
import { GenUiDialog } from "./GenUiDialog";
import { GenUiFrame } from "./GenUiFrame";
import { genUiFramePool } from "./gen-ui-frames";
import {
  genUiCardSource,
  genUiUnavailableReasonKey,
  type GenUiOwner,
  type GenUiUnavailableReason,
} from "./gen-ui-source";
import { isGenUiViewportLive, useGenUiViewport } from "./gen-ui-viewport";
import "../../../styles/gen-ui.css";

/** Display name: the model's title, else the referenced file name. */
export function genUiCardTitle(reference: GenUiReference): string {
  if (reference.title) return reference.title;
  if (reference.location) return reference.location.fileName;
  const parts = reference.path.replaceAll("\\", "/").split("/");
  return parts.at(-1) || reference.path;
}

function UnavailableCard({ title, reason }: { title: string; reason: GenUiUnavailableReason }) {
  const { t } = useTranslation();
  return (
    <div className="gen-ui-card is-unavailable" role="note">
      <IconCircleAlert size={14} className="gen-ui-unavailable-icon" />
      <div className="gen-ui-unavailable-text">
        <span className="gen-ui-title">{t("chat.genUi.unavailable", { title })}</span>
        <span className="gen-ui-unavailable-reason">{t(genUiUnavailableReasonKey(reason))}</span>
      </div>
    </div>
  );
}

export function GenUiCard({ reference, ...owner }: { reference: GenUiReference } & GenUiOwner) {
  const title = genUiCardTitle(reference);
  const source = genUiCardSource(reference, owner);
  if (source.kind === "unavailable") return <UnavailableCard title={title} reason={source.reason} />;
  return <LiveGenUiCard key={source.url} url={source.url} title={title} />;
}

/** Shown above a live frame whose fragment script threw. */
export function GenUiScriptErrorNotice({ message }: { message: string }) {
  const { t } = useTranslation();
  return (
    <div className="gen-ui-script-error" role="alert">
      <IconCircleAlert size={14} className="gen-ui-unavailable-icon" />
      <div className="gen-ui-unavailable-text">
        <span>{t("chat.genUi.scriptError")}</span>
        {message ? <code className="gen-ui-script-error-message">{message}</code> : null}
      </div>
    </div>
  );
}

function LiveGenUiCard({ url, title }: { url: string; title: string }) {
  const [error, setError] = useState<GenUiErrorCode | null>(null);
  if (error) return <UnavailableCard title={title} reason={error} />;
  return <PooledGenUiCard url={url} title={title} onError={setError} />;
}

function PooledGenUiCard({
  url,
  title,
  onError,
}: {
  url: string;
  title: string;
  onError: (code: GenUiErrorCode) => void;
}) {
  const { t } = useTranslation();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [viewport, dispatch] = useGenUiViewport(rootRef);
  const [expanded, setExpanded] = useState(false);
  // A fragment script failure. The frame stays mounted (it may still show
  // part of the content); the notice says why the rest is missing.
  const [scriptError, setScriptError] = useState<string | null>(null);
  // The last reported height keeps a released or reloading card from jumping.
  const [height, setHeight] = useState(GEN_UI_INITIAL_HEIGHT);
  const live = isGenUiViewportLive(viewport);
  const slot = useRef(Symbol(url));
  const visible = useRef(viewport.visible);

  useEffect(() => {
    visible.current = viewport.visible;
  }, [viewport.visible]);

  useEffect(() => {
    if (!live) return;
    const id = slot.current;
    genUiFramePool.acquire(id, () => dispatch({ type: "evict" }), visible.current);
    return () => genUiFramePool.release(id);
  }, [live, dispatch]);

  useEffect(() => {
    if (live) genUiFramePool.setVisible(slot.current, viewport.visible);
  }, [live, viewport.visible]);

  const closeDialog = useCallback(() => setExpanded(false), []);
  const frameTitle = t("chat.genUi.frameTitle", { title });

  return (
    <div ref={rootRef} className="gen-ui-card" data-gen-ui-url={url}>
      <header className="gen-ui-header">
        <span className="gen-ui-title">{title}</span>
        <TooltipButton
          type="button"
          className="icon-btn gen-ui-action"
          tooltip={t("chat.genUi.expand")}
          ariaLabel={t("chat.genUi.expand")}
          onClick={() => setExpanded(true)}
        >
          <IconPanelMaximize size={14} />
        </TooltipButton>
      </header>
      {scriptError !== null ? <GenUiScriptErrorNotice message={scriptError} /> : null}
      <div className="gen-ui-body">
        {live ? (
          <GenUiFrame
            url={url}
            title={frameTitle}
            initialHeight={height}
            onHeight={setHeight}
            onError={onError}
            onScriptError={setScriptError}
          />
        ) : (
          <div className="gen-ui-placeholder" style={{ height }}>
            {viewport.evicted ? (
              <Button type="button" variant="ghost" size="sm" onClick={() => dispatch({ type: "load" })}>
                {t("chat.genUi.loadPrompt")}
              </Button>
            ) : null}
          </div>
        )}
      </div>
      {expanded ? <GenUiDialog url={url} inlineSlot={slot.current} title={title} onClose={closeDialog} /> : null}
    </div>
  );
}

/** Cards for the references split out of one completed assistant message. */
export function GenUiCards({
  references,
  sessionId,
  remote,
}: { references: readonly GenUiReference[] } & GenUiOwner) {
  if (references.length === 0) return null;
  return (
    <div className="gen-ui-cards">
      {references.map((reference, index) => (
        // References are positional within an immutable completed message.
        <GenUiCard key={`${index}-${reference.path}`} reference={reference} sessionId={sessionId} remote={remote} />
      ))}
    </div>
  );
}
