import { createHash } from "node:crypto";
import { STARAI_PROVIDER_ID, type StarAiCatalog, type StarAiGroup, type StarAiSelection } from "@pi-desktop/shared";
import type { BrowserWindow } from "electron";
import type { HostProcess } from "./host-process";
import { hasStarAiCookie, openStarAiLogin, starAiPartition } from "./star-ai-login";
import { StarAiSession, starAiError } from "./star-ai-session";
import { createStarAiTransport } from "./star-ai-transport";

type Route = StarAiGroup & { providerId: string };
type Choice = { group: string; model: string };
type Directory = { accountId: string; groups: Route[]; selection: StarAiSelection | null };
type Legacy = { accountId: string; group: string; model: string; models: string[] };
const signedOut: StarAiCatalog = { account: null, selection: null, groups: [] };

function normalizeSaved(value: Directory | Legacy | null): Directory | null {
  if (!value) return null;
  if ("groups" in value) {
    // Older directories stored the description in label. Keep it as help text
    // while restoring the exact billing name even before an online refresh.
    return { ...value, groups: value.groups.map((group) => ({
      ...group, label: group.id,
      ...(!group.description && group.label !== group.id && { description: group.label }),
    })) };
  }
  return {
    accountId: value.accountId,
    groups: [{ id: value.group, label: value.group, models: value.models, providerId: STARAI_PROVIDER_ID }],
    selection: { group: value.group, model: value.model, providerId: STARAI_PROVIDER_ID },
  };
}

export function createStarAiAccount(getHost: () => HostProcess | null, getWindow: () => BrowserWindow | null) {
  const partition = starAiPartition();
  const account = new StarAiSession((url, init) => partition.fetch(url, init), () => hasStarAiCookie(partition));
  const makeTransport = () => createStarAiTransport((route, body, signal) => account.submitChat(route, body, signal));
  type Bound = { accountId: string; route: Route; transport: ReturnType<typeof makeTransport>; baseUrl: string; secretValue: string };
  let active = new Map<string, Bound>();
  const host = () => {
    const current = getHost();
    if (!current) throw starAiError("HOST_UNAVAILABLE", "Host unavailable.");
    return current;
  };
  const saved = async () => normalizeSaved((await host().call<{ selection: Directory | Legacy | null }>("providers.starAiSelection", {})).selection);
  const close = () => { for (const binding of active.values()) binding.transport.close(); active.clear(); };
  const disconnect = async () => { close(); await host().call("providers.starAiDisconnect", {}); };
  const suspend = async () => { close(); await host().call("providers.starAiSuspend", {}); };
  let tail: Promise<unknown> = Promise.resolve();
  function serial<T>(op: () => Promise<T>) {
    const next = tail.then(op, op);
    tail = next.catch(() => {});
    return next;
  }

  async function configure(directory: Directory, forceDefault: boolean) {
    const next = new Map<string, Bound>();
    const prepared: { transport: ReturnType<typeof makeTransport>; commit: () => void }[] = [];
    try {
      for (const route of directory.groups) {
        const old = active.get(route.providerId);
        const chatModels = route.chatModels ?? [];
        if (old?.accountId === directory.accountId && old.route.id === route.id &&
            old.route.chatModels?.length === chatModels.length && old.route.chatModels.every((id, i) => id === chatModels[i])) {
          next.set(route.providerId, { ...old, route });
          continue;
        }
        const transport = makeTransport();
        const binding = await transport.bind({ accountId: Number(directory.accountId), group: route.id, models: chatModels });
        prepared.push({ transport, commit: binding.commit });
        next.set(route.providerId, { accountId: directory.accountId, route, transport, baseUrl: binding.baseUrl, secretValue: binding.secretValue });
      }
      await host().call("providers.starAiConfigure", {
        ...directory, forceDefault,
        groups: [...next.values()].map(({ route, baseUrl, secretValue }) => ({ ...route, baseUrl, secretValue })),
      });
      for (const binding of prepared) binding.commit();
      for (const [id, binding] of active) if (next.get(id)?.transport !== binding.transport) binding.transport.close();
      active = next;
    } catch (error) {
      for (const binding of prepared) binding.transport.close();
      throw error;
    }
  }

  async function catalog(choice?: Choice): Promise<StarAiCatalog> {
    const session = await account.session().catch(async (error) => { await suspend(); throw error; });
    const accountId = String(session?.account.id);
    let previous = await saved();
    if (previous && previous.accountId !== accountId) { await disconnect(); previous = null; }
    if (!session) return signedOut;
    const groups = await account.groups(session).catch(async (error) => { await suspend(); throw error; });
    const routes = groups.filter((group) => group.models.length).map((group): Route => ({
      ...group, providerId: previous?.groups.find((old) => old.id === group.id)?.providerId ??
        `${STARAI_PROVIDER_ID}-${createHash("sha256").update(accountId + "\0" + group.id).digest("hex")}`,
    }));
    const settings = await host().call<{ defaultProviderId?: string; defaultModelId?: string }>("settings.get");
    const find = (group: Route | undefined, model?: string): StarAiSelection | null =>
      group && model && group.chatModels?.includes(model)
        ? { providerId: group.providerId, group: group.id, model } : null;
    const byGroup = (id?: string) => routes.find((group) => group.id === id);
    let selection = choice ? find(byGroup(choice.group), choice.model) : null;
    const choiceAvailable = selection !== null;
    selection ??= find(routes.find((group) => group.providerId === settings.defaultProviderId), settings.defaultModelId);
    selection ??= find(byGroup(previous?.selection?.group), previous?.selection?.model);
    for (const group of [byGroup(previous?.selection?.group), byGroup("default"), ...routes]) {
      selection ??= find(group, group?.chatModels?.[0]);
    }
    await configure({ accountId, groups: routes, selection }, choiceAvailable)
      .catch(async (error) => { await suspend(); throw error; });
    if (choice && !choiceAvailable) throw starAiError("STARAI_MODEL_UNAVAILABLE", "This chat model is unavailable in this group.");
    return { account: session.account, groups, selection };
  }

  let pendingLogin: Promise<StarAiCatalog> | null = null;
  let manualLoginCount = 0;
  function login(canOpen?: () => boolean) {
    if (pendingLogin) return pendingLogin;
    pendingLogin = serial(async () => {
      if (!await account.session().catch(async (error) => { await suspend(); throw error; })) {
        if (active.size || await saved()) await disconnect();
        await openStarAiLogin(getWindow(), partition, canOpen);
        account.forget();
        await partition.cookies.flushStore();
      }
      return catalog();
    }).finally(() => { pendingLogin = null; });
    return pendingLogin;
  }

  return {
    catalog: () => serial(() => catalog()),
    login: () => { manualLoginCount++; return login(); },
    setupOnOpen: async (canOpen: () => boolean): Promise<StarAiCatalog | null> => {
      if (pendingLogin) return null;
      if (!canOpen()) throw starAiError("STARAI_LOGIN_DEFERRED", "The main window is not active.");
      const manualCount = manualLoginCount;
      try {
        const result = await login(canOpen);
        return manualCount === manualLoginCount ? result : null;
      } catch (error) {
        if (manualCount !== manualLoginCount) return null;
        throw error;
      }
    },
    activate: (input: unknown) => serial(async () => {
      const choice = input as Partial<Choice> | null;
      if (typeof choice?.group !== "string" || !choice.group || typeof choice.model !== "string" || !choice.model) {
        throw starAiError("INVALID_ARGUMENT", "Choose a StarAI group and model.");
      }
      const next = await catalog({ group: choice.group, model: choice.model });
      const { selection } = next;
      if (!selection) throw starAiError("STARAI_LOGIN_REQUIRED", "Sign in to StarAI.");
      return { providerId: selection.providerId, model: selection.model, catalog: next };
    }),
    restore: () => serial(async () => {
      const previous = await saved();
      if (!previous) return;
      if (!await hasStarAiCookie(partition)) { await disconnect(); return; }
      // A previous session's model list can be broader than today's published directory.
      // Withdraw it before the first renderer/agent can load providers. Startup sync
      // republishes only after the current account and marketplace both answer.
      await suspend();
    }),
    logout: () => serial(async () => {
      close();
      try { await account.revoke().catch(() => {}); }
      finally {
        account.forget();
        try { await partition.clearStorageData(); await partition.cookies.flushStore(); }
        finally { await host().call("providers.starAiDisconnect", {}); }
      }
      return { ok: true };
    }),
    close,
  };
}
export type StarAiAccount = ReturnType<typeof createStarAiAccount>;
