import { describe, expect, it } from "vitest";
import {
  classifyAgentError,
  describeNetworkFailure,
} from "./agent-errors.js";

describe("classifyAgentError", () => {
  it.each(["context-validation", "context-estimation", "request-preparation"])(
    "keeps explicitly local %s failures terminal, safe and diagnosable", (phase) => {
      const cause = new TypeError("private prompt api_key=test-secret\nprivate stack");
      const error = Object.assign(new Error("502: fetch failed; prompt is too long", { cause }), {
        code: "LOCAL_REQUEST_ERROR", phase,
      });
      const classified = classifyAgentError(error);
      expect(classified).toMatchObject({
        code: "INTERNAL", retriable: false,
        details: { origin: "local", phase, causeName: "TypeError" },
      });
      expect(classified).toHaveProperty("cause", error);
      expect(error.cause).toBe(cause);
      expect(Object.keys(classified)).not.toContain("cause");
      const serialized = JSON.stringify(classified);
      for (const text of ["private prompt", "test-secret", "private stack", "502", "fetch failed"]) {
        expect(serialized).not.toContain(text);
      }
    },
  );

  it.each(["fetch failed", "429: overloaded", "503: unavailable", "aborted field", "prompt is too long"])(
    "classifies local message metadata before provider wording: %s", (errorMessage) => {
      expect(classifyAgentError({
        role: "assistant", stopReason: "error", errorMessage,
        errorDetails: {
          code: "LOCAL_REQUEST_ERROR", phase: "context-estimation",
          message: "private prompt", causeName: "TypeError", stack: "private stack",
        },
      })).toMatchObject({
        code: "INTERNAL", retriable: false,
        details: { origin: "local", phase: "context-estimation", causeName: "TypeError" },
      });
    },
  );

  it("requires the complete local marker, never error names or wording", () => {
    for (const error of [
      new TypeError("fetch failed"),
      "LOCAL_REQUEST_ERROR context-validation fetch failed",
      Object.assign(new Error("fetch failed"), { name: "LocalRequestError" }),
      { errorMessage: "fetch failed", errorDetails: { code: "LOCAL_REQUEST_ERROR", phase: "remote" } },
      { errorMessage: "fetch failed", errorDetails: { phase: "context-validation", message: "failed" } },
      { errorMessage: "fetch failed", errorDetails: { code: "local_request_error", phase: "context-validation" } },
    ]) {
      expect(classifyAgentError(error)).toMatchObject({ code: "NETWORK_ERROR", retriable: true });
    }
  });

  it("takes pi-ai's code+phase marker as provenance even without a message", () => {
    // Upstream's own reader accepts `code` plus a known `phase`; details that lost
    // their message in transit are still explicit provenance and must not fall
    // through to the transport bucket, which would be retried.
    for (const errorDetails of [
      { code: "LOCAL_REQUEST_ERROR", phase: "context-validation" },
      { code: "LOCAL_REQUEST_ERROR", phase: "request-preparation", causeName: "TypeError" },
    ]) {
      const classified = classifyAgentError({
        role: "assistant", stopReason: "error", errorMessage: "fetch failed", errorDetails,
      });
      expect(classified).toMatchObject({
        code: "INTERNAL", retriable: false,
        details: { origin: "local", phase: errorDetails.phase },
      });
      expect(classified.message).toMatch(/^Local request .* failed\.$/);
      expect(JSON.stringify(classified)).not.toContain("fetch failed");
    }
    // The marker is the whole contract: a message alone is not provenance.
    expect(classifyAgentError({
      errorMessage: "fetch failed",
      errorDetails: { code: "LOCAL_REQUEST_ERROR", phase: "network", message: "fetch failed" },
    })).toMatchObject({ code: "NETWORK_ERROR", retriable: true });
  });

  it("does not expose an arbitrary cause name from local metadata", () => {
    const classified = classifyAgentError({
      errorDetails: {
        code: "LOCAL_REQUEST_ERROR", phase: "request-preparation",
        message: "private prompt", causeName: "api_key=test-secret\nprivate stack",
      },
    });
    expect(classified.details).toEqual({ origin: "local", phase: "request-preparation" });
    expect(JSON.stringify(classified)).not.toMatch(/private|test-secret|stack/);
  });

  it("keeps explicit cancellation ahead of local metadata", () => {
    const errorDetails = { code: "LOCAL_REQUEST_ERROR", phase: "context-validation", message: "failed" };
    expect(classifyAgentError({ stopReason: "aborted", errorDetails })).toMatchObject({
      code: "TURN_ABORTED", retriable: false,
    });
    expect(classifyAgentError(Object.assign(new Error("Request aborted"), {
      name: "AbortError", ...errorDetails,
    }))).toMatchObject({ code: "TURN_ABORTED", retriable: false });
  });

  it("keeps a cancelled local cause cancelled however the outer error is named", () => {
    // pi-ai wraps a synchronous AbortError in LocalRequestError before
    // `signal.aborted` flips, so the outer name is not "AbortError": the cause
    // name the marker preserved is the only evidence of the user's Stop.
    const cause = Object.assign(new Error("The operation was aborted"), {
      name: "AbortError",
    });
    const wrapped = Object.assign(new Error("Local request preparation failed."), {
      name: "LocalRequestError", code: "LOCAL_REQUEST_ERROR",
      phase: "request-preparation", cause,
    });
    const classified = classifyAgentError(wrapped);
    expect(classified).toMatchObject({ code: "TURN_ABORTED", retriable: false });
    expect(classified.message).toBe("Request aborted");
    // A cancelled turn is not reported as a local request failure.
    expect(classified.details?.origin).toBeUndefined();
    expect(classified.details?.phase).toBeUndefined();

    // The same cancellation on the wire shape the adapters emit.
    expect(classifyAgentError({
      role: "assistant", stopReason: "error",
      errorMessage: "Local request preparation failed",
      errorDetails: {
        code: "LOCAL_REQUEST_ERROR", phase: "request-preparation",
        message: "Local request preparation failed", causeName: "AbortError",
      },
    })).toMatchObject({ code: "TURN_ABORTED", retriable: false });

    // A wrapped, non-abort local failure stays a terminal local failure.
    expect(classifyAgentError(Object.assign(new Error("wrapped setup failure"), {
      name: "LocalRequestError", code: "LOCAL_REQUEST_ERROR",
      phase: "request-preparation", cause: new TypeError("private prompt"),
    }))).toMatchObject({
      code: "INTERNAL", retriable: false,
      details: { origin: "local", phase: "request-preparation", causeName: "TypeError" },
    });
  });

  it("reads the marker through a bounded, cycle-safe cause chain", () => {
    const marker = Object.assign(new Error("Local request context estimation failed."), {
      name: "LocalRequestError", code: "LOCAL_REQUEST_ERROR",
      phase: "context-estimation", cause: new TypeError("private prompt"),
    });
    expect(classifyAgentError(Object.assign(new TypeError("fetch failed"), {
      cause: marker,
    }))).toMatchObject({
      code: "INTERNAL", retriable: false,
      details: { origin: "local", phase: "context-estimation", causeName: "TypeError" },
    });

    // A cycle without the marker stays a transport failure, and it has to
    // terminate instead of being walked forever.
    const first = new TypeError("fetch failed");
    const second = Object.assign(new Error("socket hang up"), { cause: first });
    (first as any).cause = second;
    expect(classifyAgentError(first)).toMatchObject({ code: "NETWORK_ERROR", retriable: true });

    // The same cycle with the marker on the second node is explicit provenance.
    Object.assign(second, { code: "LOCAL_REQUEST_ERROR", phase: "request-preparation" });
    expect(classifyAgentError(first)).toMatchObject({
      code: "INTERNAL", retriable: false,
      details: { origin: "local", phase: "request-preparation" },
    });

    // A self-referencing marker terminates as well.
    const self = Object.assign(new Error("Local request preparation failed."), {
      code: "LOCAL_REQUEST_ERROR", phase: "request-preparation",
    });
    (self as any).cause = self;
    expect(classifyAgentError(self)).toMatchObject({
      code: "INTERNAL", retriable: false,
      details: { origin: "local", phase: "request-preparation" },
    });

    // Past the traversal bound the marker is out of reach, so the failure keeps
    // its transport classification rather than claiming local provenance.
    let deep: unknown = Object.assign(new Error("Local request preparation failed."), {
      code: "LOCAL_REQUEST_ERROR", phase: "request-preparation",
    });
    for (let depth = 0; depth < 6; depth += 1) {
      deep = Object.assign(new TypeError("fetch failed"), { cause: deep });
    }
    expect(classifyAgentError(deep)).toMatchObject({ code: "NETWORK_ERROR", retriable: true });
  });

  it.each([
    "SELF_SIGNED_CERT_IN_CHAIN",
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
    "CERT_HAS_EXPIRED",
    "CERT_NOT_YET_VALID",
    "ERR_TLS_CERT_ALTNAME_INVALID",
  ])("makes certificate verification failure %s terminal", (code) => {
    const cause = Object.assign(new Error("certificate verification failed"), { code });
    for (const error of [cause, new Error("Connection error.", { cause }), code]) {
      expect(classifyAgentError(error)).toMatchObject({
        code: "NETWORK_ERROR",
        retriable: false,
        details: { networkCategory: "tls", networkCode: code },
      });
    }
  });

  it.each(["EPROTO", "ERR_SSL_PROTOCOL_ERROR", "ECONNRESET"])(
    "keeps non-certificate transport failure %s retryable", (code) => {
      expect(classifyAgentError(new Error("fetch failed", {
        cause: Object.assign(new Error(code), { code }),
      })).retriable).toBe(true);
    },
  );

  it.each(["UND_ERR_SOCKET", "ERR_PROXY_CONNECTION_FAILED"])(
    "keeps the certificate cause terminal beneath %s", (code) => {
      const error = Object.assign(new Error("fetch failed"), {
        code, cause: Object.assign(new Error("certificate failed"), { code: "CERT_HAS_EXPIRED" }),
      });
      expect(classifyAgentError(error)).toMatchObject({
        retriable: false, details: { networkCode: "CERT_HAS_EXPIRED", networkCategory: "tls" },
      });
    },
  );

  it("classifies auth failures from status fields", () => {
    const err = Object.assign(new Error("Incorrect API key provided"), {
      status: 401,
    });
    expect(classifyAgentError(err)).toMatchObject({
      code: "PROVIDER_UNAUTHORIZED",
      retriable: false,
    });
  });

  it("classifies pi-ai '<status>: <body>' errorMessage strings", () => {
    expect(classifyAgentError('429: {"error":{"type":"rate_limit_error"}}'))
      .toMatchObject({ code: "PROVIDER_RATE_LIMITED", retriable: true });
    expect(classifyAgentError('529: {"error":{"type":"overloaded_error"}}'))
      .toMatchObject({ code: "PROVIDER_ERROR", retriable: true });
    expect(classifyAgentError('403 status code (no body)')).toMatchObject({
      code: "PROVIDER_UNAUTHORIZED",
      retriable: false,
    });
  });

  it("treats malformed requests as non-retriable provider errors", () => {
    expect(classifyAgentError('400: {"error":"unknown parameter"}'))
      .toMatchObject({ code: "PROVIDER_ERROR", retriable: false });
  });

  it("detects context overflow from 400 bodies and bare messages", () => {
    expect(
      classifyAgentError(
        "400: This model's maximum context length is 128000 tokens",
      ),
    ).toMatchObject({ code: "CONTEXT_TOO_LARGE", retriable: false });
    expect(classifyAgentError("prompt is too long: 210000 tokens"))
      .toMatchObject({ code: "CONTEXT_TOO_LARGE" });
  });

  it("keeps context checkpoint failures distinct from provider failures", () => {
    expect(
      classifyAgentError(
        "CONTEXT_COMPACTION_FAILED: unable to create a checkpoint before the next model request",
      ),
    ).toMatchObject({
      code: "CONTEXT_COMPACTION_FAILED",
      retriable: false,
    });
  });

  it("classifies network failures via the cause chain", () => {
    const err = new Error("fetch failed");
    (err as any).cause = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
    });
    expect(classifyAgentError(err)).toMatchObject({
      code: "NETWORK_ERROR",
      retriable: true,
      details: { networkCategory: "refused", networkCode: "ECONNREFUSED" },
    });
    expect(classifyAgentError("getaddrinfo ENOTFOUND api.example.com"))
      .toMatchObject({
        code: "NETWORK_ERROR",
        details: {
          networkCategory: "dns",
          networkCode: "ENOTFOUND",
          networkHost: "api.example.com",
        },
      });
  });

  it("names the failing layer behind a nested DNS cause", () => {
    const err = new TypeError("fetch failed");
    (err as any).cause = Object.assign(
      new Error("getaddrinfo ENOTFOUND api.example.com"),
      {
        code: "ENOTFOUND",
        syscall: "getaddrinfo",
        hostname: "api.example.com",
      },
    );

    // `providerCode` repeats the same errno, so it is folded into the
    // network-namespaced key instead of being logged twice.
    expect(classifyAgentError(err).details).toEqual({
      networkCategory: "dns",
      networkCode: "ENOTFOUND",
      networkSyscall: "getaddrinfo",
      networkHost: "api.example.com",
    });
  });

  it("reads the errno out of an undici aggregate cause", () => {
    const aggregate = new AggregateError(
      [
        Object.assign(new Error("connect ECONNREFUSED ::1:443"), {
          code: "ECONNREFUSED",
        }),
        Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), {
          code: "ECONNREFUSED",
        }),
      ],
      "all connection attempts failed",
    );
    const err = Object.assign(new TypeError("fetch failed"), {
      cause: aggregate,
    });

    expect(classifyAgentError(err)).toMatchObject({
      code: "NETWORK_ERROR",
      details: { networkCategory: "refused", networkCode: "ECONNREFUSED" },
    });
  });

  it("separates TLS, timeout and dropped-socket causes", () => {
    const tls = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("self signed certificate"), {
        code: "DEPTH_ZERO_SELF_SIGNED_CERT",
      }),
    });
    const tlsProto = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("write EPROTO"), { code: "EPROTO" }),
    });
    const timeout = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("Connect Timeout Error"), {
        code: "UND_ERR_CONNECT_TIMEOUT",
      }),
    });
    const reset = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("other side closed"), {
        code: "UND_ERR_SOCKET",
      }),
    });
    const proxy = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("proxy connection failed"), {
        code: "ERR_PROXY_CONNECTION_FAILED",
      }),
    });

    expect(classifyAgentError(tls).details).toMatchObject({
      networkCategory: "tls",
      networkCode: "DEPTH_ZERO_SELF_SIGNED_CERT",
    });
    expect(classifyAgentError(tlsProto).details).toMatchObject({
      networkCategory: "tls",
      networkCode: "EPROTO",
    });
    expect(classifyAgentError(timeout).details).toMatchObject({
      networkCategory: "timeout",
      networkCode: "UND_ERR_CONNECT_TIMEOUT",
    });
    expect(classifyAgentError(reset).details).toMatchObject({
      networkCategory: "reset",
      networkCode: "UND_ERR_SOCKET",
    });
    expect(classifyAgentError(proxy).details).toMatchObject({
      networkCategory: "proxy",
      networkCode: "ERR_PROXY_CONNECTION_FAILED",
    });
  });

  it("says the layer is unknown rather than guessing when no cause survives", () => {
    // The reporter's shape: a bare `fetch failed` with no cause chain kept.
    expect(classifyAgentError(new TypeError("fetch failed"))).toMatchObject({
      code: "NETWORK_ERROR",
      retriable: true,
      details: { networkCategory: "unknown" },
    });
  });

  it("never leaks credentials through network diagnostics", () => {
    const err = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(
        new Error(
          "connect ECONNRESET https://api.example.com/v1/chat?api_key=sk-live-secret Authorization: Bearer token-secret",
        ),
        { code: "ECONNRESET", hostname: "user:pass@api.example.com" },
      ),
    });
    const classified = classifyAgentError(err);
    const serialized = JSON.stringify(classified);

    expect(serialized).not.toContain("sk-live-secret");
    expect(serialized).not.toContain("token-secret");
    expect(serialized).not.toContain("user:pass");
    expect(serialized).not.toContain("?api_key");
    // Only the errno survives: no hostname, no port, no URL, no query.
    expect(classified.details).toEqual({
      networkCategory: "reset",
      networkCode: "ECONNRESET",
    });
  });

  it("classifies aborts, timeouts and unknown errors", () => {
    const abortErr = new Error("The operation was aborted");
    abortErr.name = "AbortError";
    expect(classifyAgentError(abortErr)).toMatchObject({
      code: "TURN_ABORTED",
      retriable: false,
    });
    expect(classifyAgentError("agent.prompt timeout")).toMatchObject({
      code: "TIMEOUT",
      retriable: true,
    });
    expect(classifyAgentError("something unexpected")).toMatchObject({
      code: "PROVIDER_ERROR",
      retriable: true,
    });
  });

  it("lets an abort win over a compaction failure it caused", () => {
    const abortErr = new Error(
      "CONTEXT_COMPACTION_FAILED: unable to create a checkpoint before the next model request",
    );
    abortErr.name = "AbortError";
    expect(classifyAgentError(abortErr)).toMatchObject({ code: "TURN_ABORTED" });
    expect(classifyAgentError("Turn aborted while compacting context")).toMatchObject({
      code: "TURN_ABORTED",
      retriable: false,
    });
  });

  it("classifies a provider termination as a retryable stream failure", () => {
    expect(classifyAgentError("terminated")).toMatchObject({
      code: "STREAM_FAILED",
      retriable: true,
    });
  });

  it("keeps provider diagnostics bounded to status and safe error codes", () => {
    const classified = classifyAgentError(
      Object.assign(new Error("terminated"), {
        status: 200,
        code: "ERR_STREAM_PREMATURE_CLOSE",
      }),
    );
    expect(classified.details).toEqual({
      providerStatus: 200,
      providerCode: "ERR_STREAM_PREMATURE_CLOSE",
    });

    const unsafe = classifyAgentError(
      Object.assign(new Error("terminated"), {
        code: "Bearer secret-token",
      }),
    );
    expect(unsafe.details).toBeUndefined();
  });

  it("redacts secrets before exposing provider error details", () => {
    const classified = classifyAgentError(
      '401: {"api_key":"sk-secret","Authorization":"Bearer token-secret"}',
    );

    expect(classified.message).not.toContain("sk-secret");
    expect(classified.message).not.toContain("token-secret");
    expect(classified.message).toContain("[REDACTED]");
  });

  it("truncates oversized provider bodies", () => {
    const { message } = classifyAgentError(`500: ${"x".repeat(5000)}`);
    expect(message.length).toBeLessThan(700);
  });

  it("keeps a pseudo errno out of the reported network code", () => {
    // A long errno-shaped run inside a provider body must not become an
    // unbounded detail: the message is untrusted text.
    const flood = `EDNS${"A".repeat(3_000)}`;
    expect(describeNetworkFailure(flood, flood).code).toBeUndefined();
    expect(classifyAgentError(flood).details).not.toHaveProperty("networkCode");

    // A body word that merely contains "proxy" is not a proxy layer either.
    const bodyWord = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("blocked EBLOCKEDBYPROXY"), {
        code: "EBLOCKEDBYPROXY",
      }),
    });
    const details = classifyAgentError(bodyWord).details ?? {};
    expect(details.networkCategory).toBe("unknown");
    expect(details).not.toHaveProperty("networkCode");
  });

  it("reads a proxy failure as a proxy failure wherever the errno sits", () => {
    // undici reports the proxy's own socket errno as the deeper cause; the
    // proxy is still the layer that failed.
    const err = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("proxy connect ECONNREFUSED"), {
        code: "ERR_PROXY_CONNECTION_FAILED",
        cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:7890"), {
          code: "ECONNREFUSED",
        }),
      }),
    });

    expect(classifyAgentError(err).details).toEqual({
      networkCategory: "proxy",
      networkCode: "ERR_PROXY_CONNECTION_FAILED",
    });
  });

  it("does not turn a credential-shaped message token into a hostname", () => {
    const token = classifyAgentError(
      "getaddrinfo ENOTFOUND sk-live-abcdef012345",
    );
    expect(token.details).toMatchObject({
      networkCategory: "dns",
      networkCode: "ENOTFOUND",
    });
    expect(token.details).not.toHaveProperty("networkHost");

    // Truncating `user:pass@host` at the colon must not report `user` as the
    // host either.
    expect(
      classifyAgentError(
        "getaddrinfo ENOTFOUND user:pass@api.example.com?api_key=sk-1",
      ).details,
    ).not.toHaveProperty("networkHost");
  });
});
