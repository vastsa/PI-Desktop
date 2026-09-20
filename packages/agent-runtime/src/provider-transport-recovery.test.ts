import { describe, expect, it } from "vitest";
import { activeNodeTransportRoute } from "./node-proxy.js";
import {
  createProviderTransportHealth,
  describeProviderFetchFailure,
  explainsProviderFetchFailure,
  PROVIDER_TRANSPORT_REBUILD_THRESHOLD,
  type ProviderFetchFailure,
  withProviderFetchFailure,
} from "./provider-transport-recovery.js";

/** The reporter's endpoint (issue #234): a provider fetch that never answered. */
const CODEX_URL = "https://chatgpt.com/backend-api/codex/responses";

it("neither rebuilds nor retries a captured certificate rejection after flattening", () => {
  const failure = describeProviderFetchFailure(
    fetchFailed(coded("SELF_SIGNED_CERT_IN_CHAIN")), CODEX_URL,
  );
  expect(failure).toBeDefined();
  if (!failure) throw new Error("missing failure");
  const health = createProviderTransportHealth();
  expect(health.observeFailure(buildFailure(failure.origin, "reset"))).toBe(false);
  for (let attempt = 0; attempt < 4; attempt++) {
    expect(health.observeFailure(failure)).toBe(false);
  }
  expect(withProviderFetchFailure({
    code: "NETWORK_ERROR", message: "Connection error.", retriable: true,
  }, failure)).toMatchObject({
    retriable: false,
    details: { networkCode: "SELF_SIGNED_CERT_IN_CHAIN" },
  });
  const protocol = describeProviderFetchFailure(fetchFailed(coded("EPROTO")), CODEX_URL);
  if (!protocol) throw new Error("missing protocol failure");
  expect(health.observeFailure(protocol)).toBe(false);
  expect(health.observeFailure(protocol)).toBe(true);
});

function fetchFailed(cause?: unknown): TypeError {
  return Object.assign(new TypeError("fetch failed"), {
    ...(cause === undefined ? {} : { cause }),
  });
}

function coded(code: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(`socket failure ${code}`), { code, ...extra });
}

function buildFailure(
  origin: string | undefined,
  category: ProviderFetchFailure["category"],
): ProviderFetchFailure {
  return {
    ...(origin === undefined ? {} : { origin }),
    category,
    fields: { networkCategory: category },
  };
}

describe("describeProviderFetchFailure", () => {
  it("names the transport layer behind a bare fetch failed", () => {
    // Exactly what pi-ai flattens into `errorMessage` before classification can
    // see it: the errno only exists in the cause chain.
    const failure = describeProviderFetchFailure(
      fetchFailed(coded("ECONNRESET", { syscall: "read" })),
      CODEX_URL,
    );

    expect(failure).toEqual({
      origin: "https://chatgpt.com",
      category: "reset",
      fields: {
        networkCategory: "reset",
        networkCode: "ECONNRESET",
        networkSyscall: "read",
        networkRoute: activeNodeTransportRoute(),
      },
    });
  });

  it("reads the errno out of an undici happy-eyeballs aggregate", () => {
    const aggregate = new AggregateError(
      [
        coded("ECONNREFUSED", { hostname: "chatgpt.com" }),
        coded("ECONNREFUSED", { hostname: "chatgpt.com" }),
      ],
      "all connection attempts failed",
    );

    expect(
      describeProviderFetchFailure(fetchFailed(aggregate), CODEX_URL),
    ).toMatchObject({
      category: "refused",
      fields: {
        networkCategory: "refused",
        networkCode: "ECONNREFUSED",
        networkHost: "chatgpt.com",
      },
    });
  });

  it("reads the origin of an object-shaped request input", () => {
    expect(
      describeProviderFetchFailure(fetchFailed(coded("ENOTFOUND")), {
        url: CODEX_URL,
      })?.origin,
    ).toBe("https://chatgpt.com");
  });

  it("treats an abort as a stopped request, not a broken connection", () => {
    // A stop must not count towards a rebuild, and must not be reported as a
    // transport cause: the connection was never the problem.
    expect(
      describeProviderFetchFailure(
        Object.assign(new Error("Request aborted"), { name: "AbortError" }),
        CODEX_URL,
      ),
    ).toBeUndefined();
    expect(
      describeProviderFetchFailure(fetchFailed(coded("ECONNRESET")), {
        url: "not a url",
      })?.origin,
    ).toBeUndefined();
  });

  it("never reports a credential, a URL or a query string", () => {
    const error = fetchFailed(
      Object.assign(
        new Error(
          "connect ECONNRESET https://api.example.com/v1/chat?api_key=sk-live-secret Authorization: Bearer token-secret",
        ),
        {
          code: "ECONNRESET",
          syscall: "read",
          hostname: "user:pass@api.example.com",
        },
      ),
    );

    const failure = describeProviderFetchFailure(
      error,
      "https://user:pass@api.example.com/v1/chat?api_key=sk-live-secret",
    );
    const serialized = JSON.stringify(failure);

    expect(failure?.origin).toBe("https://api.example.com");
    expect(serialized).not.toContain("sk-live-secret");
    expect(serialized).not.toContain("token-secret");
    expect(serialized).not.toContain("user:pass");
    // A `hostname` that is not a bare hostname is dropped rather than trimmed.
    expect(failure?.fields).not.toHaveProperty("networkHost");
  });
});

describe("provider transport health", () => {
  it("rebuilds only after the same origin fails unbounded times in a row", () => {
    const health = createProviderTransportHealth();
    const first = buildFailure("https://a.example.com", "reset");
    const other = buildFailure("https://b.example.com", "reset");

    expect(PROVIDER_TRANSPORT_REBUILD_THRESHOLD).toBe(2);
    expect(health.observeFailure(first)).toBe(false);
    // A different origin is a different connection: two unrelated failures must
    // not add up into one rebuild.
    expect(health.observeFailure(other)).toBe(false);
    expect(health.observeFailure(other)).toBe(true);
  });

  it("drops the streak when an attempt reaches the provider", () => {
    const health = createProviderTransportHealth();
    const failure = buildFailure("https://a.example.com", "timeout");

    expect(health.observeFailure(failure)).toBe(false);
    health.observeResponse();
    expect(health.observeFailure(failure)).toBe(false);
    expect(health.observeFailure(failure)).toBe(true);
    // A new turn starts from no evidence at all.
    health.reset();
    expect(health.observeFailure(failure)).toBe(false);
  });

  it("never rebuilds for a name that a fresh pool cannot resolve", () => {
    const health = createProviderTransportHealth();
    const dns = buildFailure("https://a.example.com", "dns");
    const reset = buildFailure("https://a.example.com", "reset");

    expect(health.observeFailure(dns)).toBe(false);
    expect(health.observeFailure(dns)).toBe(false);
    // DNS also clears the streak: a resolution failure is not evidence that the
    // pooled connection is broken.
    expect(health.observeFailure(reset)).toBe(false);
    expect(health.observeFailure(reset)).toBe(true);
  });

  it("spends one rebuild per streak", () => {
    const health = createProviderTransportHealth();
    const failure = buildFailure("https://a.example.com", "reset");

    expect(health.observeFailure(failure)).toBe(false);
    expect(health.observeFailure(failure)).toBe(true);
    // A long outage must not churn the pool on every attempt.
    expect(health.observeFailure(failure)).toBe(false);
    expect(health.observeFailure(failure)).toBe(true);
  });

  it("counts an unparseable origin in one fallback bucket", () => {
    const health = createProviderTransportHealth();

    expect(health.observeFailure(buildFailure(undefined, "reset"))).toBe(false);
    expect(health.observeFailure(buildFailure(undefined, "reset"))).toBe(true);
  });
});

describe("withProviderFetchFailure", () => {
  it("replaces the unknown the text classifier fell back to", () => {
    const classified = {
      code: "NETWORK_ERROR",
      message: "fetch failed",
      retriable: true,
      details: { networkCategory: "unknown" },
    };
    const failure = describeProviderFetchFailure(
      fetchFailed(coded("ECONNRESET")),
      CODEX_URL,
    );

    expect(withProviderFetchFailure(classified, failure)).toEqual({
      code: "NETWORK_ERROR",
      message: "fetch failed",
      retriable: true,
      details: {
        networkCategory: "reset",
        networkCode: "ECONNRESET",
        networkRoute: activeNodeTransportRoute(),
      },
    });
  });

  it("leaves a reached provider and a missing capture untouched", () => {
    const limited = {
      code: "PROVIDER_RATE_LIMITED",
      message: "429: slow down",
      retriable: true,
    };
    const failure = describeProviderFetchFailure(
      fetchFailed(coded("ECONNRESET")),
      CODEX_URL,
    );

    expect(withProviderFetchFailure(limited, failure)).toBe(limited);
    expect(withProviderFetchFailure(limited, undefined)).toBe(limited);
    expect(explainsProviderFetchFailure("NETWORK_ERROR")).toBe(true);
    expect(explainsProviderFetchFailure("PROVIDER_RATE_LIMITED")).toBe(false);
  });
});
