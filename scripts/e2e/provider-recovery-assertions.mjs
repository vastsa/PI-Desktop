import assert from "node:assert/strict";
export function verifyProviderRecovery(cases) {
  assert.equal(cases.length, 5);
  const expectedCounts = [3, 2, 3, 11, 24];
  const expectedDelays = [1000, 2000, 4000, 8000, 8000, 8000, 8000, 8000, 8000, 8000];
  const summary = cases.map((result, index) => {
    const events = result.events
      .filter((e) => e.sessionId === result.sessionId)
      .map((e) => e.event);
    const errors = events.filter((e) => e.type === "error");
    const retries = events
      .filter((e) => e.type === "status" && e.status.activity?.phase === "retrying")
      .map((e) => e.status.activity);
    const assistants = result.detail.session.messages.filter(
      (m) => m.role === "assistant",
    );
    const tools = result.detail.session.messages.filter((m) => m.role === "tool");
    assert.equal(result.requests.length, expectedCounts[index], result.name);
    assert.equal(result.retryShot, true, `${result.name}: retry countdown visible`);
    assert.equal(
      events.filter((e) => e.type === "agent_end").length,
      1,
      `${result.name}: one terminal lifecycle`,
    );
    if (index !== 3) {
      assert.equal(errors.length, 0);
      assert.equal(assistants.length, index === 4 ? 12 : 1);
      assert(assistants.every((m) => m.status === "complete"));
      assert.equal(assistants.at(-1).content, "RECOVERED_699");
      assert(result.text.includes("RECOVERED_699"));
      assert(!result.text.includes("NETWORK_ERROR"));
    } else {
      assert.equal(errors.length, 1);
      assert.equal(errors[0].error.code, "NETWORK_ERROR");
      assert.equal(errors[0].error.details.retryAttempt, 10);
      assert.equal(assistants.filter((m) => m.status === "error").length, 1);
      assert.deepEqual(
        retries.map((r) => r.attempt),
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      );
      assert.deepEqual(
        retries.map((r) => r.retryDelayMs),
        expectedDelays,
      );
      assert(result.text.includes("NETWORK_ERROR") && result.text.includes("继续"));
    }
    if (index === 3) {
      const gaps = result.requests.slice(1).map((r, i) => r.at - result.requests[i].at);
      assert(
        gaps.every((gap, i) => gap >= expectedDelays[i] - 50),
        "real backoff timing",
      );
    }
    if (index === 4) {
      assert.equal(tools.length, 11, "eleven actual tools preserved");
      assert(
        tools.every((m) => m.toolName === "read" && m.toolStatus === "success"),
        "all real Reads succeeded",
      );
      assert.equal(
        result.requests.at(-1).toolResults,
        11,
        "successful tool context retained at final response",
      );
      assert.deepEqual(
        retries.map((r) => r.attempt),
        Array(12).fill(1),
      );
      assert.deepEqual(
        retries.map((r) => r.retryDelayMs),
        Array(12).fill(1000),
      );
    }
    return {
      name: result.name,
      requests: result.requests.length,
      retries: retries.length,
      durationMs: result.requests.at(-1).at - result.requests[0].at,
      successfulTools: tools.filter((m) => m.toolStatus === "success").length,
      terminalError: errors[0]?.error ?? null,
      behaviorVerified: true,
      exhaustedRetryDiagnosticPresent:
        index === 3 ? errors[0].error.details.retryAttempt === 10 : null,
    };
  });
  return summary;
}
