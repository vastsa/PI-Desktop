import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { sortStarAiGroupsByRatio, sortStarAiModels, STARAI_CHAT_SERVICES, starAiGroupService, type StarAiCatalog } from "@pi-desktop/shared";
import { SettingsCard, SettingsRow } from "../../features/settings/primitives";
import { StarAiSetupCatalog } from "../../features/startup/star-ai-setup-context";
import { api } from "../../lib/api";
import { starAiGroupRatioLabel } from "../../lib/star-ai-group-ratio";
import { useAppStore } from "../../stores/app-store";
import { IconRefresh } from "../icons";
import { Button, TooltipButton } from "../ui";
import { SettingsMenuSelect } from "./SettingsMenuSelect";
import { SubagentModelPicker } from "./SubagentModelPicker";
import { StarAiServiceCards } from "./StarAiServiceCards";
import { emptyStarAiDraft, starAiDraft, type StarAiDraft } from "./star-ai-selection";

type Action = "refresh" | "login" | "activate" | "logout";
const signedOut: StarAiCatalog = { account: null, groups: [], selection: null };

export function StarAiAccountCard() {
  const { t } = useTranslation("starAi");
  const refreshProviders = useAppStore((state) => state.refreshProviders);
  const showToast = useAppStore((state) => state.showToast);
  const defaultProvider = useAppStore((state) => state.settings?.defaultProviderId);
  const defaultModel = useAppStore((state) => state.settings?.defaultModelId);
  const [catalog, setCatalog] = useState<StarAiCatalog | null>(null);
  const [draft, setDraft] = useState<StarAiDraft>(emptyStarAiDraft);
  const [busy, setBusy] = useState<Action | null>("refresh");
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(false);
  const pending = useRef(false);
  const initialCatalog = useContext(StarAiSetupCatalog);

  useEffect(() => {
    mounted.current = true;
    let active = true;
    const receive = (next: StarAiCatalog) => {
      setError(null);
      setCatalog(next);
      setDraft(starAiDraft(next));
    };
    // An automatic sign-in can finish while this page is waiting for its initial catalog.
    let receivedLogin = false;
    const unsubscribe = api.onStarAiSetupRequired((next) => {
      if (!next) return;
      receivedLogin = true;
      receive(next);
      if (!pending.current) setBusy(null);
    });
    const load = initialCatalog ? Promise.resolve(initialCatalog) : api.starAiCatalog();
    void load.then((next) => {
      if (active && !receivedLogin) receive(next);
    }, () => {
      if (active && !receivedLogin) {
        setError("loadError");
        void refreshProviders().catch(() => {});
      }
    }).finally(() => {
      if (active && !pending.current) setBusy(null);
    });
    return () => { active = false; mounted.current = false; unsubscribe(); };
  }, [initialCatalog, refreshProviders]);

  const services = useMemo(() => STARAI_CHAT_SERVICES.flatMap((id) => {
    const groups = (catalog?.groups ?? []).filter((entry) =>
      (entry.chatModels?.length ?? 0) > 0 && entry.id !== "auto" && starAiGroupService(entry.id) === id,
    );
    return groups.length ? [{ id, count: groups.length, groups: sortStarAiGroupsByRatio(groups) }] : [];
  }), [catalog?.groups]);
  const autoGroup = catalog?.groups.find((entry) => entry.id === "auto" && (entry.chatModels?.length ?? 0) > 0);
  const service = services.find((entry) => entry.id === draft.service);
  const group = draft.group === "auto" ? autoGroup : service?.groups.find((entry) => entry.id === draft.group);
  const chatModels = group?.chatModels;
  const modelChoices = useMemo(() => group ? [{
    providerName: group.id,
    choices: sortStarAiModels(chatModels ?? []).map((modelId) => ({
      value: modelId, modelId,
    })),
  }] : [], [group, chatModels]);
  const saved = catalog?.selection;
  const isDefault = !!saved && draft.group === saved.group && draft.model === saved.model
    && defaultProvider === saved.providerId && defaultModel === saved.model;

  const groupOptions = (service?.groups ?? []).map(({ id, description, ratio }) => {
    const multiplier = starAiGroupRatioLabel(ratio, t("autoRatio"));
    return { id, label: multiplier ? `${id} · ${multiplier}` : id, description };
  });

  const run = async (action: Action, chosenModel?: string) => {
    if (pending.current || busy) return;
    pending.current = true;
    setBusy(action);
    setError(null);
    let errorKey = { refresh: "loadError", login: "loginError", activate: "activateError", logout: "logoutError" }[action];
    try {
      let next: StarAiCatalog;
      if (action === "login") {
        next = await api.starAiLogin();
      } else if (action === "logout") {
        const result = await api.starAiLogout();
        if (!result.ok) throw new Error();
        next = signedOut;
      } else if (action === "activate") {
        if (!catalog?.account || !group || !chosenModel || !chatModels?.includes(chosenModel)) return;
        if (isDefault && chosenModel === saved.model) return;
        const result = await api.starAiActivate({ group: group.id, model: chosenModel });
        next = result.catalog;
      } else {
        next = await api.starAiCatalog();
      }
      if (mounted.current) {
        const sameAccount = action === "refresh" && next.account?.id === catalog?.account?.id;
        setCatalog(next);
        setDraft(starAiDraft(next, sameAccount && (draft.service || draft.group) ? draft : null));
      }
      errorKey = "updateError";
      await refreshProviders();
      if (action === "activate" && group) showToast(t("applied", { group: group.label, model: chosenModel }), { variant: "success" });
    } catch (cause) {
      if (!mounted.current) return;
      const code = (cause as { code?: string } | null)?.code;
      if (code === "STARAI_LOGIN_CANCELLED") return;
      if (errorKey !== "updateError" && (action === "activate" || action === "refresh" || code === "STARAI_LOGIN_REQUIRED")) {
        setDraft(emptyStarAiDraft);
        setCatalog(code === "STARAI_LOGIN_REQUIRED" ? signedOut : catalog && { ...catalog, groups: [], selection: null });
        if (code === "STARAI_MODEL_UNAVAILABLE") {
          const current = await api.starAiCatalog().catch(() => null);
          if (mounted.current && current) {
            setCatalog(current);
            setDraft(starAiDraft(current, draft));
          }
        }
        await refreshProviders().catch(() => {});
      }
      if (!mounted.current) return;
      if (code === "STARAI_LOGIN_REQUIRED") {
        setError("required");
        return;
      }
      setError(errorKey);
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(null);
    }
  };

  return (
    <SettingsCard title={t("title")} caption={t("caption")} action={
      <TooltipButton className="icon-btn" tooltip={t("refresh")} disabled={!!busy} onClick={() => void run("refresh")}>
        <IconRefresh size={15} aria-hidden />
      </TooltipButton>
    }>
      <SettingsRow title={t("account")} detail={catalog?.account?.name || (catalog ? t("signedOut") : t(busy ? "checking" : "unavailable"))}>
        {catalog?.account ? (
          <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void run("logout")}>{t("signOut")}</Button>
        ) : (
          <Button size="sm" variant="primary" disabled={!!busy} onClick={() => void run("login")}>
            {t(busy === "login" ? "signingIn" : "signIn")}
          </Button>
        )}
      </SettingsRow>
      {catalog?.account && (
        <>
          {services.length > 0 || autoGroup ? (
            <div className="starai-account-services">
              <StarAiServiceCards options={services} value={draft.service} disabled={!!busy}
                onChange={(id) => { if (id !== draft.service) setDraft({ service: id, group: "", model: "" }); }}
                auto={autoGroup ? { selected: draft.group === "auto", onChange: () => {
                  if (draft.group !== "auto") setDraft({ service: null, group: "auto", model: "" });
                } } : undefined} />
            </div>
          ) : !error && <SettingsRow title={t("group")}><span className="settings-row-detail">{t("noGroups")}</span></SettingsRow>}
          {(services.length > 0 || autoGroup) && draft.group !== "auto" && (
            <SettingsRow title={t("group")} description={group?.description}>
              <SettingsMenuSelect key={draft.service} label={t("group")} value={draft.group} disabled={!service || !!busy}
                placeholder={t(service ? "chooseGroup" : "selectService")} options={groupOptions}
                onChange={(id) => setDraft({ service: draft.service, group: id, model: "" })} />
            </SettingsRow>
          )}
          {group && (
            <SettingsRow title={t("model")} detail={
              busy === "activate" ? t("applying") : isDefault ? t("currentDefault")
                : group.models.length > (chatModels?.length ?? 0)
                  ? t("chatModelCount", { available: chatModels?.length ?? 0, total: group.models.length }) : undefined
            }>
              <SubagentModelPicker key={group.id} label={t("model")} value={draft.model} emptyLabel={t("chooseModel")}
                groups={modelChoices} orphanPin={null} allowInherit={false} disabled={!!busy}
                onChange={(model) => void run("activate", model)} />
            </SettingsRow>
          )}
        </>
      )}
      {error && <div className="oauth-error" role="alert">{t(error)}</div>}
    </SettingsCard>
  );
}
