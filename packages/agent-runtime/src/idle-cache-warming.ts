import {
  CACHE_WARMING_MAX_IDLE_AGE_MS,
  evaluateCacheWarming,
  getCacheWarmingDelayMs,
  getPromptCacheTtlMs,
  isCacheWarmingReplayable,
  type Api,
  type AssistantMessage,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";

const ASSUMED_CACHE_TTL_MS = 5 * 60_000;
const OPENAI_RESPONSES_CACHE_TTL_MS = 30 * 60_000;

type CacheRequest = {
  model: Model<Api>;
  options: SimpleStreamOptions;
  startedAt: number;
  result: AssistantMessage;
  metered: boolean;
  oauth: boolean;
  canResume: () => boolean;
  foregroundRevision: number;
  idleEligible: boolean;
  refresh: (signal: AbortSignal, deadline: number, checkPrefix: boolean) => Promise<AssistantMessage>;
};

type CacheCandidate = {
  request: CacheRequest;
  interval: number;
  margin: number;
  lastStartedAt: number;
  expiresAt: number;
  remaining: number;
};

export class IdleCacheWarming {
  private foreground = false;
  private revision = 0;
  private settled = false;
  private waiting = false;
  private waitingAllowed = false;
  private candidate?: CacheCandidate;
  private timer?: ReturnType<typeof setTimeout>;
  private inFlight?: AbortController;

  constructor(private readonly canRefresh: (waiting: boolean) => boolean) {}

  get isForeground(): boolean {
    return this.foreground;
  }

  get foregroundRevision(): number {
    return this.revision;
  }

  setWaitingAllowed(allowed: boolean): void {
    if (this.waitingAllowed === allowed) return;
    this.waitingAllowed = allowed;
    if (!allowed && this.waiting) this.clear();
    else this.schedule();
  }

  setWaiting(waiting: boolean): void {
    if (this.waiting === waiting) return;
    this.waiting = waiting;
    if (waiting) this.schedule();
    else this.clear();
  }

  setForeground(foreground: boolean): void {
    if (this.foreground === foreground) return;
    this.foreground = foreground;
    if (!foreground) {
      this.revision++;
      if (this.inFlight && !this.waiting) this.clear();
    }
    this.schedule();
  }

  clear(): void {
    this.settled = false;
    this.candidate = undefined;
    this.clearTimer();
    this.inFlight?.abort();
    this.inFlight = undefined;
  }

  remember(request: CacheRequest): void {
    const { model, options, result, startedAt } = request;
    if (options.cacheRetention === "none" ||
        (result.stopReason !== "stop" && result.stopReason !== "toolUse") ||
        !supportsBoundedRefresh(model, request.oauth) ||
        !isCacheWarmingReplayable(model, options)) return;
    const ttl = getPromptCacheTtlMs(model, options) ?? getOpenAiResponsesCacheTtl(model);
    if (ttl === undefined && result.usage.cacheRead + result.usage.cacheWrite <= 0) return;
    const lifetime = ttl ?? ASSUMED_CACHE_TTL_MS;
    const interval = getCacheWarmingDelayMs(lifetime);
    if (interval === undefined || lifetime >= CACHE_WARMING_MAX_IDLE_AGE_MS) return;
    this.candidate = {
      request, interval, margin: Math.floor((lifetime - interval) / 2),
      lastStartedAt: startedAt, expiresAt: startedAt + CACHE_WARMING_MAX_IDLE_AGE_MS,
      remaining: ttl === undefined ? Math.floor(CACHE_WARMING_MAX_IDLE_AGE_MS / interval) : Infinity,
    };
    this.schedule();
  }

  settle(): void {
    this.settled = true;
    this.schedule();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private requiresPrefixCheck(candidate: CacheCandidate): boolean {
    return this.waiting || !candidate.request.idleEligible || candidate.request.foregroundRevision !== this.revision;
  }

  private canReuse(candidate: CacheCandidate): boolean {
    return !this.requiresPrefixCheck(candidate) || candidate.request.canResume();
  }

  private canSend(): boolean {
    return this.waiting ? this.waitingAllowed : this.foreground;
  }

  private schedule(): void {
    this.clearTimer();
    const candidate = this.candidate;
    if (!candidate || this.inFlight) return;
    if (!this.waiting && this.settled &&
        ((!candidate.request.idleEligible && !this.foreground) || candidate.request.result.stopReason !== "stop")) {
      this.clear();
      return;
    }
    const canSend = (this.waiting || this.settled) && this.canSend();
    const now = Date.now();
    const dueAt = candidate.lastStartedAt + candidate.interval;
    const deadline = Math.min(dueAt + candidate.margin, candidate.expiresAt);
    if (candidate.remaining === 0 || dueAt >= candidate.expiresAt || now >= deadline ||
        (canSend && (!this.canReuse(candidate) || !this.isWorthRefreshing(candidate.request)))) {
      this.clear();
      return;
    }
    this.timer = canSend
      ? setTimeout(() => void this.refresh(candidate, deadline), Math.max(dueAt - now, 0))
      : setTimeout(() => this.clear(), deadline - now);
    this.timer.unref();
  }

  private isWorthRefreshing(request: CacheRequest): boolean {
    if (!request.metered) return true;
    const usage = request.result.usage;
    const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
    return evaluateCacheWarming(request.model, promptTokens, this.waiting ? "streaming" : "idle").action === "warm";
  }

  private async refresh(candidate: CacheCandidate, deadline: number): Promise<void> {
    this.timer = undefined;
    if (candidate !== this.candidate || !this.canSend()) return;
    if (!this.canRefresh(this.waiting) || !this.canReuse(candidate) || Date.now() >= deadline) {
      this.clear();
      return;
    }
    const controller = new AbortController();
    this.inFlight = controller;
    candidate.remaining--;
    const startedAt = Date.now();
    try {
      const signal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(Math.max(1, candidate.expiresAt - startedAt)),
      ]);
      const result = await candidate.request.refresh(signal, deadline, this.requiresPrefixCheck(candidate));
      if (candidate !== this.candidate) return;
      if ((result.stopReason !== "stop" && result.stopReason !== "length") ||
          result.usage.cacheRead <= result.usage.input + result.usage.cacheWrite) {
        this.clear();
        return;
      }
      candidate.lastStartedAt = startedAt;
    } catch {
      if (candidate === this.candidate) this.clear();
    } finally {
      if (this.inFlight === controller) {
        this.inFlight = undefined;
        this.schedule();
      }
    }
  }
}

function getOpenAiResponsesCacheTtl(model: Model<Api>): number | undefined {
  const compat = model.compat;
  if (model.api !== "openai-responses" || !compat ||
      !("supportsExplicitPromptCacheMode" in compat) || !compat.supportsExplicitPromptCacheMode ||
      !/^https:\/\/api\.openai\.com(?:\/v1)?\/?$/.test(model.baseUrl)) return undefined;
  // OpenAI's Responses API retains eligible entries at least this long by default.
  return OPENAI_RESPONSES_CACHE_TTL_MS;
}

function supportsBoundedRefresh(model: Model<Api>, oauth: boolean): boolean {
  switch (model.api) {
    case "anthropic-messages":
    case "openai-completions":
    case "azure-openai-responses":
      return true;
    case "openai-responses":
      return !oauth && (!model.compat || !("supportsMaxOutputTokens" in model.compat) ||
        model.compat.supportsMaxOutputTokens !== false);
    default:
      return false;
  }
}
