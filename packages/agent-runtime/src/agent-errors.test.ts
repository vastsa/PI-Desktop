import { describe, expect, it } from "vitest";
import { classifyAgentError } from "./agent-errors.js";

describe("classifyAgentError", () => {
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
    });
    expect(classifyAgentError("getaddrinfo ENOTFOUND api.example.com"))
      .toMatchObject({ code: "NETWORK_ERROR" });
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
});
