/**
 * The GitHub card on Settings → Connectors (ADR github-connector).
 *
 * It shows who is connected and offers the two ways in: a device code, which
 * reuses the vendor-account login dialog, and a pasted personal access token.
 *
 * The token is never this component's to keep. Main stores it and sends back
 * an account, its scopes, and a state. A pasted token is read from the form
 * field at submit, handed to main once, and the field is cleared before the
 * answer arrives — it is not held in React state, so nothing of it survives
 * the save attempt, whichever way that goes.
 */
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import type { GitHubConnectorStatus } from "@pi-desktop/shared";
import { api } from "../../../lib/api";
import type { OAuthLoginSession } from "../../../lib/oauth-login-session";
import { useAppStore } from "../../../stores/app-store";
import { Button, Checkbox, Field, HelpIcon, PasswordInput, SettingsToggle } from "../../../components/ui";
import { IconTriangleAlert, IconUser } from "../../../components/icons";
import { OAuthLoginDialog } from "../../../components/settings/OAuthLoginDialog";
import { SettingsDisclosure } from "../../../components/settings/SettingsDisclosure";
import { SettingsCard, SettingsRow } from "../primitives";
import { githubAvatarSource } from "./github-avatar";
import { githubErrorText } from "./github-error-message";
import { GITHUB_LOGIN_VENDOR, beginGitHubLogin } from "./github-login-session";
import { useGitHubConnector } from "./use-github-connector";
import "../../../styles/connectors.css";

const TOKEN_FIELD_NAME = "githubToken";

/** A classic or OAuth token that reports scopes but not `repo` cannot push or read private code. */
function lacksRepoScope(status: GitHubConnectorStatus): boolean {
  if (status.tokenKind !== "pat" && status.tokenKind !== "oauth") return false;
  const scopes = status.scopes ?? [];
  return scopes.length > 0 && !scopes.includes("repo");
}

function Avatar({ url }: { url?: string }) {
  const [failed, setFailed] = useState(false);
  // Only GitHub's avatar host is loaded; anything else gets the placeholder.
  const source = githubAvatarSource(url);
  return (
    <span className="connector-avatar" aria-hidden="true">
      {source ? (
        <img src={source} alt="" hidden={failed} onError={() => setFailed(true)} />
      ) : null}
      {!source || failed ? <IconUser size={16} /> : null}
    </span>
  );
}

function GitHubAgentToolsSwitch({ refresh, onError }: { refresh(): Promise<void>; onError(error: unknown): void }) {
  const { t } = useTranslation();
  const enabled = useAppStore((state) => state.settings?.githubAgentTools !== false);
  const [saving, setSaving] = useState(false);
  async function save() {
    const current = useAppStore.getState().settings;
    if (!current) return;
    setSaving(true);
    try {
      const settings = { ...current, githubAgentTools: !enabled };
      await api.setSettings(settings);
      useAppStore.setState({ settings });
      await refresh();
    } catch (error) { onError(error); }
    finally { setSaving(false); }
  }
  return <SettingsRow title={t("settings.connectors.github.agentTools")} description={t("settings.connectors.github.agentToolsHelp")}>
    <SettingsToggle label={t("settings.connectors.github.agentTools")} checked={enabled} disabled={saving} onChange={() => void save()} />
  </SettingsRow>;
}

export function GitHubConnectorCard() {
  const { t } = useTranslation();
  const showToast = useAppStore((state) => state.showToast);
  const { status, loading, error, refresh } = useGitHubConnector();
  const [allowWorkflow, setAllowWorkflow] = useState(false);
  const [login, setLogin] = useState<OAuthLoginSession | null>(null);
  const [busy, setBusy] = useState<"token" | "disconnect" | null>(null);
  const [hasToken, setHasToken] = useState(false);
  // A login that reached `done` or `cancelled` is over in main as well; one
  // still open when this card goes away is not, and has to be cancelled.
  const settledLogin = useRef<OAuthLoginSession | null>(null);

  useEffect(() => {
    if (!login) return undefined;
    return () => {
      if (settledLogin.current !== login) {
        // Otherwise main would keep polling GitHub for a code nobody can see.
        void login.cancel().catch(() => undefined).finally(() => login.dispose());
        return;
      }
      login.dispose();
    };
  }, [login]);

  // Main reports a code with its English message; the user reads the catalog's.
  const fail = (cause: unknown) => {
    showToast(githubErrorText(t, cause), { variant: "error" });
  };

  // Started from the click, never from an effect: StrictMode would begin two.
  const connect = () => {
    if (login || busy) return;
    setLogin(beginGitHubLogin(api, { allowWorkflowScope: allowWorkflow, t }));
  };

  const closeLogin = () => {
    settledLogin.current = login;
    setLogin(null);
  };

  const saveToken = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const field = event.currentTarget.elements.namedItem(TOKEN_FIELD_NAME);
    if (!(field instanceof HTMLInputElement)) return;
    const token = field.value;
    // Cleared before main answers: the page keeps nothing of the token.
    field.value = "";
    setHasToken(false);
    if (!token.trim()) return;
    setBusy("token");
    try {
      await api.setGithubToken({ token });
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async () => {
    if (busy) return;
    setBusy("disconnect");
    try {
      await api.disconnectGithub();
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(null);
    }
  };

  const connected = status?.connected === true;
  const needsReauth = connected && status?.needsReauthentication === true;
  const scopes = status?.scopes ?? [];

  return (
    <SettingsCard
      title={t("settings.connectors.github.name")}
      caption={t("settings.connectors.github.description")}
    >
      <div className="connector-card">
        {!status ? (
          <div className="settings-recovery" role="status" aria-live="polite">
            {loading ? (
              <>
                <span className="route-pending-indicator" aria-hidden />
                <span>{t("common.loading")}</span>
              </>
            ) : (
              <>
                <span>{error ?? t("errors.HOST_UNAVAILABLE")}</span>
                <Button variant="secondary" onClick={() => void refresh()}>
                  {t("errors.action.retry")}
                </Button>
              </>
            )}
          </div>
        ) : null}

        {status && connected ? (
          <>
            <div className="connector-account">
              <Avatar key={status.account?.avatarUrl ?? ""} url={status.account?.avatarUrl} />
              <SettingsRow
                title={t("settings.connectors.github.connectedAs", {
                  login: status.account?.login ?? "",
                })}
                detail={
                  scopes.length > 0
                    ? t("settings.connectors.github.scopes", { scopes: scopes.join(", ") })
                    : undefined
                }
              >
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => void disconnect()}
                >
                  {t("settings.connectors.github.disconnect")}
                </Button>
              </SettingsRow>
            </div>
            {needsReauth ? (
              <div className="connector-alert" role="alert">
                <IconTriangleAlert aria-hidden size={16} />
                <span>{t("settings.connectors.github.needsReauth")}</span>
              </div>
            ) : null}
            {lacksRepoScope(status) ? (
              <p className="connector-warning" role="status">
                {t("settings.connectors.github.missingRepoScope")}
              </p>
            ) : null}
            <p className="connector-note">
              {/* A pasted token has no app to remove; it is revoked by deleting it. */}
              {t(
                status.tokenKind === "pat"
                  ? "settings.connectors.github.disconnectNoteToken"
                  : "settings.connectors.github.disconnectNote",
              )}
            </p>
          </>
        ) : null}

        {connected && !needsReauth && (status?.agentTools === "shadowed"
          ? <p>{t("settings.connectors.github.agentToolsShadowed")}</p>
          : <GitHubAgentToolsSwitch refresh={refresh} onError={fail} />)}

        {status && (!connected || needsReauth) ? (
          <>
            {status.deviceLoginAvailable ? (
              <div className="connector-signin">
                <div className="connector-signin-option">
                  <Checkbox
                    label={t("settings.connectors.github.allowWorkflow")}
                    checked={allowWorkflow}
                    disabled={login !== null}
                    onChange={(event) => setAllowWorkflow(event.target.checked)}
                  />
                  <HelpIcon label={t("settings.connectors.github.allowWorkflowHelp")} />
                </div>
                <Button
                  variant="primary"
                  disabled={login !== null || busy !== null}
                  onClick={connect}
                >
                  {t("settings.connectors.github.connect")}
                </Button>
              </div>
            ) : (
              <p className="connector-note">
                {t("settings.connectors.github.deviceUnavailable")}
              </p>
            )}
            <SettingsDisclosure title={t("settings.connectors.github.useToken")}>
              <form className="connector-token-form" onSubmit={(event) => void saveToken(event)}>
                <Field label={t("settings.connectors.github.tokenLabel")}>
                  <PasswordInput
                    name={TOKEN_FIELD_NAME}
                    autoComplete="off"
                    disabled={busy !== null}
                    showLabel={t("settings.configSync.showPassword")}
                    hideLabel={t("settings.configSync.hidePassword")}
                    onChange={(event) => setHasToken(event.target.value.trim().length > 0)}
                  />
                </Field>
                <div className="connector-token-actions">
                  <Button type="submit" variant="primary" disabled={!hasToken || busy !== null}>
                    {t("settings.connectors.github.tokenSave")}
                  </Button>
                </div>
              </form>
            </SettingsDisclosure>
          </>
        ) : null}
      </div>

      {login ? (
        <OAuthLoginDialog
          vendor={GITHUB_LOGIN_VENDOR}
          session={login}
          onDone={() => {
            closeLogin();
            // Main also pushes the new status; this read covers a missed push.
            void refresh();
          }}
          onClose={closeLogin}
        />
      ) : null}
    </SettingsCard>
  );
}
