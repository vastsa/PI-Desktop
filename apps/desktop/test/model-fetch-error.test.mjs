/**
 * Classified copy for a failed live model-list probe.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { describeModelsFetchError } from "../src/components/settings/model-fetch-error.ts";

test("HTTP 401/403 become an unauthorized summary without the raw status line", () => {
  const view = describeModelsFetchError("model list request failed (401)");
  assert.equal(view.kind, "unauthorized");
  assert.equal(view.summaryKey, "errors.PROVIDER_UNAUTHORIZED");
  assert.equal(view.detail, undefined);
  assert.equal(describeModelsFetchError("HTTP 403 Forbidden").kind, "unauthorized");
});

test("HTTP 404 and 429 map to dedicated keys", () => {
  assert.deepEqual(describeModelsFetchError("model list request failed (404)"), {
    kind: "notFound",
    summaryKey: "settings.modelsFetchNotFound",
  });
  assert.deepEqual(describeModelsFetchError("HTTP 429"), {
    kind: "rateLimited",
    summaryKey: "errors.PROVIDER_RATE_LIMITED",
  });
});

test("timeouts, network failures, and HTML JSON dumps stay compact", () => {
  assert.equal(describeModelsFetchError("The operation was aborted.").kind, "timeout");
  assert.equal(describeModelsFetchError("Failed to fetch").kind, "network");
  assert.equal(describeModelsFetchError("fetch failed").kind, "network");
  const html = describeModelsFetchError(
    'Unexpected token \'<\', "<!DOCTYPE html>" is not valid JSON',
  );
  assert.equal(html.kind, "invalidResponse");
  assert.equal(html.detail, undefined);
  assert.equal(html.summaryKey, "settings.modelsFetchInvalidResponse");
});

test("other HTTP statuses keep the code; unknown errors keep a short detail", () => {
  const http = describeModelsFetchError("model list request failed (502)");
  assert.equal(http.kind, "http");
  assert.equal(http.summaryKey, "settings.modelsFetchFailedStatus");
  assert.deepEqual(http.summaryParams, { status: 502 });
  assert.equal(http.detail, undefined);

  const unknown = describeModelsFetchError("provider unavailable: upstream reset");
  assert.equal(unknown.kind, "unknown");
  assert.equal(unknown.summaryKey, "settings.modelsFetchFailed");
  assert.equal(unknown.detail, "provider unavailable: upstream reset");

  const dump = describeModelsFetchError(`<html>${"x".repeat(400)}</html>`);
  assert.equal(dump.kind, "unknown");
  assert.equal(dump.detail, undefined);

  assert.equal(describeModelsFetchError("").kind, "unknown");
  assert.equal(describeModelsFetchError().kind, "unknown");
});
