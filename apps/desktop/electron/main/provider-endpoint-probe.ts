/**
 * Endpoint resolution against the network.
 *
 * The static layer (`@pi-desktop/shared/provider-endpoint`) decides which base
 * URLs are worth asking and in which discovery style; this module asks them —
 * one at a time, inside one shared time budget, and only on the origin the user
 * typed.
 *
 * Serial probing is a security decision, not a performance one: every candidate
 * carries the user's API key, so the sweep must not fan the credential out to
 * several servers at once. The first candidate that answers wins and the rest
 * are never contacted.
 */

import type {
  CatalogApiStyle,
  DiscoveryStyle,
  EndpointCandidate,
  EndpointEvidence,
} from "@pi-desktop/shared";
import {
  probeModelList,
  type DiscoveredModel,
} from "./model-discovery";

/** Total budget for the whole sweep; each candidate gets what is left. */
export const DISCOVERY_SWEEP_BUDGET_MS = 12_000;

/** What one candidate produced, so a failure can be explained per URL. */
export type DiscoveryAttempt = {
  baseUrl: string;
  discoveryStyle: DiscoveryStyle;
  url: string;
  status?: number;
  error?: string;
};

export type DiscoveryProbeOutcome = {
  models: DiscoveredModel[];
  /** The base URL that answered: what the row should store and display. */
  effectiveBaseUrl: string;
  discoveryStyle: DiscoveryStyle;
  /** Wire style the winning candidate suggested, if it suggested one. */
  apiStyleHint?: CatalogApiStyle;
  evidence: EndpointEvidence;
  attempts: DiscoveryAttempt[];
};

type ProbeOptions = {
  /** The origin the user typed. Nothing outside it is ever contacted. */
  origin: string;
  candidates: readonly EndpointCandidate[];
  apiKey?: string;
  headers?: Record<string, string>;
  /** Overrides the sweep budget; used by tests. */
  budgetMs?: number;
  now?: () => number;
  probe?: typeof probeModelList;
};

type ProbeResult = {
  outcome?: DiscoveryProbeOutcome;
  attempts: DiscoveryAttempt[];
};

/**
 * Ask each candidate, strongest first, and stop at the first usable answer.
 *
 * A candidate whose base URL left the user's origin is refused without a
 * request, as is a credential-bearing redirect to another origin further down.
 * Everything a candidate did is recorded, so the UI can explain both the URL
 * that was chosen and the ones that were not.
 */
export async function probeDiscoveryCandidates(
  options: ProbeOptions,
): Promise<ProbeResult> {
  const now = options.now ?? (() => Date.now());
  const probe = options.probe ?? probeModelList;
  const deadline = now() + (options.budgetMs ?? DISCOVERY_SWEEP_BUDGET_MS);
  const attempts: DiscoveryAttempt[] = [];

  for (const candidate of options.candidates) {
    const remaining = deadline - now();
    if (remaining <= 0) {
      attempts.push({
        baseUrl: candidate.baseUrl,
        discoveryStyle: candidate.discoveryStyle,
        url: candidate.baseUrl,
        error: "sweep budget exhausted",
      });
      continue;
    }
    const attempt: DiscoveryAttempt = {
      baseUrl: candidate.baseUrl,
      discoveryStyle: candidate.discoveryStyle,
      url: candidate.baseUrl,
    };
    attempts.push(attempt);
    // The resolver already dropped cross-origin candidates; this is the guard
    // that survives a caller passing its own list.
    let candidateOrigin: string | undefined;
    try {
      candidateOrigin = new URL(candidate.baseUrl).origin;
    } catch {
      attempt.error = "invalid base URL";
      continue;
    }
    if (candidateOrigin !== options.origin) {
      attempt.error = "refused: candidate left the configured origin";
      continue;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    try {
      const result = await probe({
        baseUrl: candidate.baseUrl,
        apiKey: options.apiKey,
        discoveryStyle: candidate.discoveryStyle,
        headers: options.headers,
        signal: controller.signal,
        allowOrigin: options.origin,
      });
      // `attempt.url` is the URL that finally answered, which a same-origin
      // redirect may have moved. The candidate's own base URL is what the row
      // stores: stripping `/models` off a redirected path would invent a base
      // address this endpoint never named (Anthropic-style bases deliberately
      // exclude `/v1`, and the transport appends it), and a wrong endpoint is
      // worse than an unrefined one.
      attempt.url = result.url;
      attempt.status = result.status;
      if (result.models.length === 0) {
        attempt.error = "the endpoint published no models";
        continue;
      }
      return {
        outcome: {
          models: result.models,
          effectiveBaseUrl: candidate.baseUrl,
          discoveryStyle: candidate.discoveryStyle,
          ...(candidate.apiStyleHint ? { apiStyleHint: candidate.apiStyleHint } : {}),
          evidence: candidate.evidence,
          attempts,
        },
        attempts,
      };
    } catch (error) {
      attempt.error = error instanceof Error ? error.message : String(error);
      const status = (error as { status?: unknown }).status;
      if (typeof status === "number") attempt.status = status;
    } finally {
      clearTimeout(timer);
    }
  }

  return { attempts };
}
