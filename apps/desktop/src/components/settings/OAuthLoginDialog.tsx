/**
 * Vendor-account login (ADR 0098). Every flow — PKCE with a local callback,
 * device code, a pasted code — arrives through the same event stream, so this
 * dialog renders whatever the vendor asked for rather than a per-vendor script.
 *
 * The attempt itself belongs to the caller: the dialog only watches it. Opening
 * a login is not something an effect may do twice, and StrictMode does exactly
 * that; subscribing is, because a session replays what a new subscriber missed.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { OAuthPromptRequest, OAuthVendor } from "@pi-desktop/shared";
import type { OAuthLoginSession } from "../../lib/oauth-login-session";
import { canSubmitOAuthPrompt } from "../../lib/oauth-login-prompt";
import { Button, Input, TooltipButton, cx } from "../ui";
import { IconCheck, IconCopy, IconExternal } from "../icons";

type AuthUrlState = { url: string; instructions?: string; opened: boolean };

type DeviceCodeState = {
  userCode: string;
  verificationUri: string;
};

export function OAuthLoginDialog({
  vendor,
  session,
  onDone,
  onClose,
}: {
  vendor: OAuthVendor;
  /** The attempt this dialog reports on, already begun by the caller. */
  session: OAuthLoginSession;
  /** The login succeeded; the provider row is ready to use. */
  onDone: (accountLabel?: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<string>(t("settings.vendorLoginStarting"));
  const [authUrl, setAuthUrl] = useState<AuthUrlState | null>(null);
  const [deviceCode, setDeviceCode] = useState<DeviceCodeState | null>(null);
  const [prompt, setPrompt] = useState<OAuthPromptRequest | null>(null);
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  // Callers pass fresh closures on every render, so they are read through a ref
  // rather than re-running the subscription. `settled` keeps a replayed outcome
  // from closing the dialog, or toasting, a second time.
  const handlers = useRef({ onDone, onClose });
  handlers.current = { onDone, onClose };
  const settled = useRef(false);

  useEffect(() => {
    return session.subscribe((event) => {
      switch (event.kind) {
        case "info":
        case "progress":
          setStatus(event.message);
          break;
        case "authUrl":
          setAuthUrl({
            url: event.url,
            instructions: event.instructions,
            opened: event.opened,
          });
          break;
        case "deviceCode":
          setDeviceCode({
            userCode: event.userCode,
            verificationUri: event.verificationUri,
          });
          break;
        case "prompt":
          setAnswer("");
          setPrompt(event.request);
          break;
        case "promptCancelled":
          // The flow answered the step itself — a callback that beat the
          // paste box — so the input has to go away on its own.
          setPrompt((current) =>
            current?.promptId === event.promptId ? null : current,
          );
          break;
        case "done":
          if (settled.current) break;
          settled.current = true;
          handlers.current.onDone(event.accountLabel);
          break;
        case "error":
          setPrompt(null);
          setError(event.message);
          break;
        case "cancelled":
          if (settled.current) break;
          settled.current = true;
          handlers.current.onClose();
          break;
      }
    });
  }, [session]);

  const cancel = useCallback(async () => {
    if (closing) return;
    setClosing(true);
    try {
      // Aborts the local callback server or the device-code polling. The
      // `cancelled` event closes this dialog; a login main no longer knows
      // about is already over, so close directly.
      const cancelled = await session.cancel();
      if (!cancelled) onClose();
    } catch {
      onClose();
    }
  }, [closing, onClose, session]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (error) onClose();
      else void cancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cancel, error, onClose]);

  const copy = (value: string) => {
    void navigator.clipboard.writeText(value).then(
      () => {
        setCopied(value);
        setTimeout(() => setCopied((current) => (current === value ? null : current)), 1500);
      },
      () => undefined,
    );
  };

  const submitAnswer = (value: string) => {
    if (!prompt) return;
    const promptId = prompt.promptId;
    setPrompt(null);
    void session
      .respond(promptId, value)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };
  const canSubmitAnswer = canSubmitOAuthPrompt(prompt, answer);

  return (
    <div className="overlay provider-dialog-overlay" role="presentation">
      <div
        className="dialog oauth-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="oauth-dialog-title"
      >
        <h3 id="oauth-dialog-title" className="provider-dialog-title">
          {vendor.loginLabel || t("settings.vendorSignInTo", { vendor: vendor.name })}
        </h3>

        {error ? (
          <div className="oauth-error">{error}</div>
        ) : (
          <>
            <div className="oauth-status">{status}</div>

            {authUrl ? (
              <div className="oauth-block">
                <div className="oauth-block-text">
                  {authUrl.instructions ||
                    t(
                      authUrl.opened
                        ? "settings.vendorBrowserOpened"
                        : "settings.vendorBrowserFailed",
                    )}
                </div>
                <div className="oauth-inline-actions">
                  <Button size="sm" variant="ghost" onClick={() => copy(authUrl.url)}>
                    <span className="oauth-btn-inner">
                      {copied === authUrl.url ? (
                        <IconCheck size={13} />
                      ) : (
                        <IconCopy size={13} />
                      )}
                      <span>{t("settings.vendorCopyLink")}</span>
                    </span>
                  </Button>
                  <a
                    className="oauth-link"
                    href={authUrl.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <IconExternal size={13} />
                    <span>{t("settings.vendorOpenAgain")}</span>
                  </a>
                </div>
              </div>
            ) : null}

            {deviceCode ? (
              <div className="oauth-block">
                <div className="oauth-block-text">
                  {t("settings.vendorDeviceCodeHint")}
                </div>
                <TooltipButton
                  type="button"
                  className="oauth-device-code font-mono"
                  tooltip={t("settings.vendorCopyCode")}
                  ariaLabel={t("settings.vendorCopyCode")}
                  onClick={() => copy(deviceCode.userCode)}
                >
                  <span>{deviceCode.userCode}</span>
                  {copied === deviceCode.userCode ? (
                    <IconCheck size={14} />
                  ) : (
                    <IconCopy size={14} />
                  )}
                </TooltipButton>
                <a
                  className="oauth-link"
                  href={deviceCode.verificationUri}
                  target="_blank"
                  rel="noreferrer"
                >
                  <IconExternal size={13} />
                  <span>{deviceCode.verificationUri}</span>
                </a>
              </div>
            ) : null}

            {prompt ? (
              <div className="oauth-block">
                <div className="oauth-block-text">{prompt.message}</div>
                {prompt.type === "select" ? (
                  <div className="oauth-options">
                    {(prompt.options ?? []).map((option) => (
                      <button
                        key={option.id}
                        type="button"
                        className="oauth-option"
                        onClick={() => submitAnswer(option.id)}
                      >
                        <span className="oauth-option-label">{option.label}</span>
                        {option.description ? (
                          <span className="oauth-option-desc">{option.description}</span>
                        ) : null}
                      </button>
                    ))}
                  </div>
                ) : (
                  <form
                    className="oauth-answer"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (canSubmitAnswer) submitAnswer(answer.trim());
                    }}
                  >
                    <Input
                      type={prompt.type === "secret" ? "password" : "text"}
                      value={answer}
                      onChange={(event) => setAnswer(event.target.value)}
                      placeholder={prompt.placeholder}
                      className={cx(
                        prompt.type === "manual_code" && "font-mono text-sm-plus",
                      )}
                      autoComplete="off"
                      autoFocus
                    />
                    <Button type="submit" variant="primary" disabled={!canSubmitAnswer}>
                      {t("settings.vendorSubmit")}
                    </Button>
                  </form>
                )}
              </div>
            ) : null}
          </>
        )}

        <div className="provider-dialog-actions">
          {error ? (
            <Button variant="ghost" onClick={onClose}>
              {t("settings.close")}
            </Button>
          ) : (
            <Button variant="ghost" disabled={closing} onClick={() => void cancel()}>
              {t("settings.cancel")}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
