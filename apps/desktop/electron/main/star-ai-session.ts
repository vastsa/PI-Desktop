import { isStarAiChatModel, type StarAiGroup } from "@pi-desktop/shared";

export const STARAI_ORIGIN = "https://starlinkaisite.com";
export const STARAI_COOKIE = "new_api_refresh";
export const STARAI_REFRESH = "/api/user/auth/refresh";

export function starAiError(code: string, message: string) {
  return Object.assign(new Error(message), { errorCode: code });
}

type AccountSession = { account: { id: number; name: string }; token: string; sid: string; expires: number };
type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const invalid = () => starAiError("STARAI_INVALID_RESPONSE", "StarAI returned an invalid response.");
const required = () => starAiError("STARAI_LOGIN_REQUIRED", "Sign in to StarAI.");

export class StarAiSession {
  private current: AccountSession | null = null;
  private pending: Promise<AccountSession | null> | null = null;
  private revision = 0;
  private readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
  private readonly hasCookie: () => Promise<boolean>;

  constructor(
    fetch: (url: string, init: RequestInit) => Promise<Response>,
    hasCookie: () => Promise<boolean>,
  ) {
    this.fetch = fetch;
    this.hasCookie = hasCookie;
  }

  forget() {
    this.revision++;
    this.current = null;
    this.pending = null;
  }

  private request(path: string, init: RequestInit = {}, token?: string) {
    const headers = new Headers(init.headers);
    headers.set("Origin", STARAI_ORIGIN);
    headers.set("Accept", "application/json");
    if (token) headers.set("Authorization", `Bearer ${token}`);
    return this.fetch(STARAI_ORIGIN + path, {
      ...init, headers, redirect: "error", cache: "no-store", credentials: "include",
      signal: init.signal ?? AbortSignal.timeout(15_000),
    });
  }

  private async refresh(epoch: number): Promise<AccountSession | null> {
    if (!await this.hasCookie()) return null;
    const result = await this.request(STARAI_REFRESH, { method: "POST" });
    if (epoch !== this.revision) throw required();
    if (result.status === 401) return null;
    if (!result.ok) throw starAiError("STARAI_UNAVAILABLE", "Unable to refresh the StarAI session.");
    const envelope = record(await result.json());
    const data = record(envelope.data);
    const user = record(data.user);
    const sid = record(data.session).sid;
    if (envelope.success !== true || typeof data.access_token !== "string" || !data.access_token ||
        typeof user.id !== "number" || !Number.isSafeInteger(user.id) || user.id < 1 ||
        typeof sid !== "string" || !sid || typeof data.access_expires_at !== "number") throw invalid();
    if (epoch !== this.revision) throw required();
    const name = [user.display_name, user.username].find((value): value is string => typeof value === "string" && value.trim() !== "");
    return { account: { id: user.id, name: name ?? String(user.id) }, token: data.access_token, sid, expires: data.access_expires_at };
  }

  async session(): Promise<AccountSession | null> {
    if (this.current && this.current.expires > Date.now() / 1000 + 45) return this.current;
    if (!this.pending) {
      const epoch = this.revision;
      this.pending = this.refresh(epoch).then((session) => {
        if (epoch !== this.revision) throw required();
        return this.current = session;
      }).finally(() => { if (epoch === this.revision) this.pending = null; });
    }
    return this.pending;
  }

  private async getEnvelope(path: string, session: AccountSession) {
    const response = await this.request(path, {}, session.token);
    if (response.status === 401) {
      if (this.current === session) this.current = null;
      throw required();
    }
    if (!response.ok) throw starAiError("STARAI_UNAVAILABLE", "Unable to load the StarAI catalog.");
    const result = record(await response.json());
    if (result.success !== true) throw invalid();
    return result;
  }

  async models(group: string, session: AccountSession): Promise<string[]> {
    const { data } = await this.getEnvelope("/api/user/models?group=" + encodeURIComponent(group), session);
    if (data === null) return [];
    if (!Array.isArray(data) || !data.every((v): v is string => typeof v === "string" && v.length > 0)) throw invalid();
    return [...new Set(data)].sort();
  }

  private async marketplace(session: AccountSession) {
    const directory = await this.getEnvelope("/api/pricing", session);
    if (!Array.isArray(directory.data) || !Array.isArray(directory.vendors)) throw invalid();
    const vendors = new Map<number, string>();
    for (const entry of directory.vendors) {
      const { id, name } = record(entry);
      if (typeof id === "number" && typeof name === "string" && name.trim()) vendors.set(id, name.trim());
    }
    const groups = new Map<string, Map<string, { vendor?: string; chat: boolean }>>();
    for (const entry of directory.data) {
      const { model_name: id, enable_groups, vendor_id, tags, supported_endpoint_types: endpoints } = record(entry);
      if (typeof id !== "string" || !id || !Array.isArray(enable_groups)) continue;
      const vendor = typeof vendor_id === "number" ? vendors.get(vendor_id) : undefined;
      const media = typeof tags === "string" && tags.split(/[,;|\s]+/).some(tag =>
        /^(?:生图|绘图|图像生成|图生视频|文生视频|视频|image|video|image-generation|video-generation|embedding|rerank|tts)$/i.test(tag));
      const chatEndpoint = !Array.isArray(endpoints) || endpoints.length === 0 ||
        endpoints.some(endpoint => ["openai", "anthropic", "gemini"].includes(endpoint));
      const model = { vendor, chat: !media && chatEndpoint && isStarAiChatModel(id) };
      // The marketplace's group filter uses exact membership, including case and punctuation.
      for (const group of enable_groups) {
        if (typeof group !== "string" || !group) continue;
        let models = groups.get(group);
        if (!models) groups.set(group, models = new Map());
        models.set(id, model);
      }
    }
    return groups;
  }

  async groups(session: AccountSession): Promise<StarAiGroup[]> {
    const [{ data }, market] = await Promise.all([
      this.getEnvelope("/api/user/self/groups", session), this.marketplace(session),
    ]);
    if (!data || Array.isArray(data) || typeof data !== "object") throw invalid();
    const items = Object.entries(data).map(([id, value]): Omit<StarAiGroup, "models"> => {
      const { desc, ratio } = record(value);
      const description = typeof desc === "string" ? desc.replace(/[\s\p{Cc}]+/gu, " ").trim() : "";
      const effectiveRatio = typeof ratio === "number" && Number.isFinite(ratio) && ratio >= 0 ? ratio
        : ratio === "自动" || ratio === "auto" ? "auto" : undefined;
      return { id, label: id, ...(description && { description }), ...(effectiveRatio !== undefined && { ratio: effectiveRatio }) };
    });
    const groups: StarAiGroup[] = [];
    // Only the site's published groups require an entitlement request. Limit concurrency for large accounts.
    const visibleGroups = items.filter((group) => market.has(group.id));
    for (let i = 0; i < visibleGroups.length; i += 4) {
      const batch = await Promise.all(visibleGroups.slice(i, i + 4).map(async (group) => {
        const published = market.get(group.id)!;
        const authorized = await this.models(group.id, session);
        const models = authorized.filter((id) => published.has(id));
        const chatModels = models.filter((id) => published.get(id)?.chat);
        const vendorPairs = models.flatMap((id) => {
          const vendor = published.get(id)?.vendor;
          return vendor ? [[id, vendor]] : [];
        });
        return { ...group, models, chatModels, ...(vendorPairs.length && { modelVendors: Object.fromEntries(vendorPairs) }) };
      }));
      groups.push(...batch.filter((group) => group.models.length > 0));
    }
    return groups;
  }

  async submitChat(route: {accountId: number; group: string; model: string}, body: RecordValue, signal: AbortSignal) {
    const session = await this.session();
    if (!session || session.account.id !== route.accountId) throw required();
    const result = await this.request("/pg/chat/completions", {
      method: "POST", headers: { "Content-Type": "application/json" }, signal,
      body: JSON.stringify({ ...body, model: route.model, group: route.group }),
    }, session.token);
    if (result.status === 401 && this.current === session) this.current = null;
    return result;
  }

  async revoke() {
    const sid = this.current?.sid;
    this.forget();
    if (await this.hasCookie()) {
      const response = await this.request("/api/user/auth/logout", {
        method: "POST", headers: sid ? { "X-Auth-Session": sid } : {},
      });
      await response.body?.cancel();
    }
  }
}
