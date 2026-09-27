import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AppSettings, NetworkProxyMode, NetworkProxySettings } from "@pi-desktop/shared";
import {
  DEFAULT_NETWORK_PROXY_BYPASS,
  parseProxyUrl,
  validateNetworkProxy,
} from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { Button, Input, cx } from "../ui";

function SettingsRow({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="settings-row">
      <div className="settings-row-copy">
        <div className="settings-row-title">{title}</div>
        {description ? <div className="settings-row-desc">{description}</div> : null}
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  );
}

const MODES: NetworkProxyMode[] = ["system", "direct", "custom"];

function currentProxy(settings: AppSettings): NetworkProxySettings {
  return settings.networkProxy ?? { mode: "system" };
}

export function NetworkProxySection({
  settings,
  saveSettings,
}: {
  settings: AppSettings;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const saved = currentProxy(settings);
  const [urlDraft, setUrlDraft] = useState(saved.url ?? "");
  const [bypassDraft, setBypassDraft] = useState(
    saved.bypass ?? DEFAULT_NETWORK_PROXY_BYPASS,
  );
  const [urlError, setUrlError] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [testState, setTestState] = useState<"idle" | "busy" | "ok" | "fail">(
    "idle",
  );
  const [testMessage, setTestMessage] = useState("");

  useEffect(() => {
    setUrlDraft(saved.url ?? "");
    setBypassDraft(saved.bypass ?? DEFAULT_NETWORK_PROXY_BYPASS);
    setUrlError(false);
  }, [saved.url, saved.bypass]);

  const persist = async (next: NetworkProxySettings) => {
    const validated = validateNetworkProxy(next);
    if (!validated.ok) {
      setUrlError(true);
      return;
    }
    setUrlError(false);
    setSaveError(false);
    try {
      await saveSettings({ networkProxy: validated.value });
    } catch {
      setSaveError(true);
    }
  };

  const chooseMode = (mode: NetworkProxyMode) => {
    if (mode === saved.mode) return;
    setTestState("idle");
    if (mode !== "custom") {
      void persist({ mode });
      return;
    }
    const parsed = parseProxyUrl(urlDraft);
    const url = parsed.ok ? parsed.value.href : "socks5://127.0.0.1:1080";
    if (!parsed.ok) setUrlDraft(url);
    void persist({
      mode: "custom",
      url,
      bypass: bypassDraft.trim() || undefined,
    });
  };

  const commitUrl = () => {
    if (saved.mode !== "custom") return;
    const parsed = parseProxyUrl(urlDraft);
    if (!parsed.ok) {
      setUrlError(true);
      return;
    }
    if (parsed.value.href === saved.url) {
      setUrlError(false);
      return;
    }
    void persist({
      mode: "custom",
      url: parsed.value.href,
      bypass: bypassDraft.trim() || undefined,
    });
  };

  const commitBypass = () => {
    if (saved.mode !== "custom") return;
    const next = bypassDraft.trim() || DEFAULT_NETWORK_PROXY_BYPASS;
    setBypassDraft(next);
    if (next === (saved.bypass ?? DEFAULT_NETWORK_PROXY_BYPASS)) return;
    if (!saved.url) return;
    void persist({ mode: "custom", url: saved.url, bypass: next });
  };

  const runTest = async () => {
    setTestState("busy");
    setTestMessage("");
    const payload: NetworkProxySettings =
      saved.mode === "custom"
        ? {
            mode: "custom",
            url: urlDraft.trim() || saved.url,
            bypass: bypassDraft.trim() || undefined,
          }
        : { mode: saved.mode };
    try {
      const result = await api.testNetworkProxy(payload);
      if (result.ok) {
        setTestState("ok");
        setTestMessage(t("settings.proxyTestOk"));
      } else {
        setTestState("fail");
        setTestMessage(
          t("settings.proxyTestFail", { message: result.error ?? "" }),
        );
      }
    } catch (error) {
      setTestState("fail");
      setTestMessage(
        t("settings.proxyTestFail", {
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  };

  return (
    <section className="settings-card-block">
      <h3 className="settings-card-heading">{t("settings.network")}</h3>
      <div className="settings-panel">
        <SettingsRow
          title={t("settings.proxy")}
          description={t("settings.proxyDesc")}
        >
          <div
            className="settings-segment"
            role="radiogroup"
            aria-label={t("settings.proxy")}
          >
            {MODES.map((mode) => (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={saved.mode === mode}
                className={cx(
                  "settings-segment-item",
                  saved.mode === mode && "active",
                )}
                onClick={() => chooseMode(mode)}
              >
                {t(`settings.proxy${mode[0]!.toUpperCase()}${mode.slice(1)}`)}
              </button>
            ))}
          </div>
        </SettingsRow>

        {saved.mode === "custom" ? (
          <>
            <SettingsRow title={t("settings.proxyUrl")}>
              <div className="settings-proxy-control">
                <Input
                  value={urlDraft}
                  placeholder={t("settings.proxyUrlPlaceholder")}
                  aria-label={t("settings.proxyUrl")}
                  aria-invalid={urlError}
                  onChange={(event) => {
                    setUrlDraft(event.target.value);
                    setUrlError(false);
                    setTestState("idle");
                  }}
                  onBlur={commitUrl}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      event.currentTarget.blur();
                    }
                  }}
                />
                {urlError ? (
                  <span className="settings-command-shell-state error" role="status">
                    {t("settings.proxyInvalid")}
                  </span>
                ) : null}
              </div>
            </SettingsRow>
            <SettingsRow
              title={t("settings.proxyBypass")}
              description={t("settings.proxyBypassDesc")}
            >
              <Input
                value={bypassDraft}
                aria-label={t("settings.proxyBypass")}
                onChange={(event) => setBypassDraft(event.target.value)}
                onBlur={commitBypass}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    event.currentTarget.blur();
                  }
                }}
              />
            </SettingsRow>
            <SettingsRow title={t("settings.proxyTest")}>
              <div className="settings-proxy-control">
                <Button
                  variant="secondary"
                  disabled={testState === "busy"}
                  onClick={() => void runTest()}
                >
                  {testState === "busy" ? t("settings.proxyTesting") : t("settings.proxyTest")}
                </Button>
                {testState === "ok" || testState === "fail" ? (
                  <span
                    className={cx(
                      "settings-command-shell-state",
                      testState === "fail" && "error",
                    )}
                    role="status"
                  >
                    {testMessage}
                  </span>
                ) : null}
              </div>
            </SettingsRow>
          </>
        ) : null}

        {saveError ? (
          <span className="settings-command-shell-state error" role="status">
            {t("settings.proxySaveError")}
          </span>
        ) : null}
      </div>
    </section>
  );
}
