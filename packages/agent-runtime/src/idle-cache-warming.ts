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

type CacheRequest = {
  model: Model<Api>;
  options: SimpleStreamOptions;
  startedAt: number;
  result: AssistantMessage;
  metered: boolean;
  oauth: boolean;
  canResume: () => boolean;
  foregroundRevision: number;
  refresh: (signal: AbortSignal, deadline: number) => Promise<AssistantMessage>;
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
  private candidate?: CacheCandidate;
  private timer?: ReturnType<typeof setTimeout>;
  private inFlight?: AbortController;

  constructor(private readonly canRefresh: () => boolean) {}

  get isForeground(): boolean {
    return this.foreground;
  }

  get foregroundRevision(): number {
    return this.revision;
  }

  setForeground(foreground: boolean): void {
    if (this.foreground === foreground) return;
    this.foreground = foreground;
    if (!foreground) {
      this.revision++;
      if (this.inFlight) this.clear();
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
    if (options.cacheRetention === "none" || result.stopReason !== "stop" ||
        !supportsBoundedRefresh(model, request.oauth) ||
        !isCacheWarmingReplayable(model, options)) return;
    const ttl = getPromptCacheTtlMs(model, options);
    if (ttl === undefined && result.usage.cacheRead + result.usage.cacheWrite <= 0) return;
    const promptTokens = result.usage.input + result.usage.cacheRead + result.usage.cacheWrite;
    if (request.metered && evaluateCacheWarming(model, promptTokens, "idle").action !== "warm") return;
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

  private canReuse(candidate: CacheCandidate): boolean {
    return candidate.request.foregroundRevision === this.revision || candidate.request.canResume();
  }

  private schedule(): void {
    this.clearTimer();
    const candidate = this.candidate;
    if (!candidate || !this.settled || this.inFlight) return;
    const now = Date.now();
    const dueAt = candidate.lastStartedAt + candidate.interval;
    const deadline = Math.min(dueAt + candidate.margin, candidate.expiresAt);
    if (candidate.remaining === 0 || dueAt >= candidate.expiresAt || now >= deadline ||
        (this.foreground && !this.canReuse(candidate))) {
      this.clear();
      return;
    }
    this.timer = this.foreground
      ? setTimeout(() => void this.refresh(candidate, deadline), Math.max(dueAt - now, 0))
      : setTimeout(() => this.clear(), deadline - now);
    this.timer.unref();
  }

  private async refresh(candidate: CacheCandidate, deadline: number): Promise<void> {
    this.timer = undefined;
    if (candidate !== this.candidate || !this.foreground) return;
    if (!this.canRefresh() || !this.canReuse(candidate) || Date.now() >= deadline) {
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
      const result = await candidate.request.refresh(signal, deadline);
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
