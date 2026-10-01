import { randomUUID } from "node:crypto";
import { ErrorCodes, type LiveBinding } from "@pi-desktop/shared";
import type { LiveAdapter, LiveAdapterContext } from "./types";
import { responseCodeError } from "./websocket-errors";
import { extractCodexSdpAnswer, normalizeCodexSdp, readResponseTextBounded } from "./codex-sdp";

const CODEX_LIVE_BASE = "https://chatgpt.com/backend-api/codex";
const CODEX_MODEL = "gpt-live-1-codex";
const MAX_SDP_BYTES = 256 * 1024;
const MAX_SDP_RESPONSE_BYTES = 256 * 1024;
const STARTUP_INSTRUCTIONS = "You are a voice assistant. Do not claim to execute actions. You have no access to project files, tools, or the coding agent. If asked to perform work, explain that execution is not connected.";

export function buildCodexCallBody(input: { sdp: string; voice: string; workProfile?: { instructions: string; startupContext: string } }): Record<string, unknown> {
  return {
    sdp: input.sdp,
    session: {
      model: CODEX_MODEL,
      instructions: input.workProfile
        ? `${input.workProfile.instructions}\n\n${input.workProfile.startupContext}`
        : STARTUP_INSTRUCTIONS,
      audio: { output: { voice: input.voice } },
      delegation: { type: "client", ack_filler: false },
    },
  };
}

export function createCodexAdapter(context: LiveAdapterContext, deps: {
  fetchImpl?: typeof fetch;
  assertEndpoint: (url: string) => Promise<void>;
}): LiveAdapter {
  let closed = false;
  let requestController: AbortController | null = null;
  const binding = context.binding as Extract<LiveBinding, { adapterId: "codex-live" }>;
  const auth = context.auth;

  return {
    adapterId: "codex-live",
    mediaKind: "webrtc",
    async connect(input) {
      if (!input?.offerSdp) {
        throw Object.assign(new Error("Live SDP offer is invalid or too large"), { errorCode: "LIVE_PROTOCOL_ERROR" });
      }
      const offerSdp = normalizeCodexSdp(input.offerSdp, MAX_SDP_BYTES);
      if (auth.kind !== "codex-oauth") {
        throw Object.assign(new Error("Codex Live requires a signed-in Codex account"), { errorCode: "LIVE_AUTH_KIND_UNSUPPORTED" });
      }
      if (closed || context.signal.aborted) throw Object.assign(new Error("Live call was cancelled"), { errorCode: "LIVE_STALE_CALL" });
      const url = `${CODEX_LIVE_BASE}/realtime/calls?intent=quicksilver&architecture=avas`;
      const controller = new AbortController();
      requestController = controller;
      const onAbort = () => controller.abort(context.signal.reason);
      context.signal.addEventListener("abort", onAbort, { once: true });
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await deps.assertEndpoint(url);
        if (closed || context.signal.aborted) {
          throw Object.assign(new Error("Live call was cancelled"), { errorCode: "LIVE_STALE_CALL" });
        }
        timeout = setTimeout(() => controller.abort(new Error("timeout")), 15_000);
        const headers = {
          Authorization: `Bearer ${auth.accessToken}`,
          "chatgpt-account-id": auth.accountId,
          originator: "pi",
          "x-session-id": randomUUID(),
          "user-agent": "pi-codex-conversion",
          "openai-alpha": "quicksilver=v2",
          "content-type": "application/json",
        };
        const response = await (deps.fetchImpl ?? fetch)(url, {
          method: "POST",
          headers,
          body: JSON.stringify(buildCodexCallBody({ sdp: offerSdp, voice: binding.voice, ...(context.workProfile ? { workProfile: context.workProfile } : {}) })),
          signal: controller.signal,
          redirect: "manual",
        });
        if (response.status !== 201) {
          await response.body?.cancel().catch(() => undefined);
          const mapped = responseCodeError(response.status);
          throw Object.assign(new Error("Codex Live call creation was rejected"), {
            errorCode: mapped.code,
            retriable: mapped.retriable,
          });
        }
        const contentLength = Number(response.headers.get("content-length"));
        if (Number.isFinite(contentLength) && contentLength > MAX_SDP_RESPONSE_BYTES) {
          await response.body?.cancel().catch(() => undefined);
          throw Object.assign(new Error("Live provider SDP answer is too large"), { errorCode: "LIVE_PROTOCOL_ERROR" });
        }
        const answerSdp = extractCodexSdpAnswer(await readResponseTextBounded(response, MAX_SDP_RESPONSE_BYTES));
        if (closed || context.signal.aborted) throw Object.assign(new Error("Live call was cancelled"), { errorCode: "LIVE_STALE_CALL" });
        return { answerSdp };
      } catch (error) {
        if (closed || context.signal.aborted) {
          throw Object.assign(new Error("Live call was cancelled"), { errorCode: "LIVE_STALE_CALL" });
        }
        if (error && typeof error === "object" && "errorCode" in error) throw error;
        if (controller.signal.aborted) {
          throw Object.assign(new Error("Codex Live call creation timed out or was cancelled"), {
            errorCode: "LIVE_TIMEOUT",
          });
        }
        throw Object.assign(new Error("Codex Live connection failed"), {
          errorCode: ErrorCodes.LIVE_NETWORK_ERROR,
          cause: error,
        });
      } finally {
        if (timeout) clearTimeout(timeout);
        context.signal.removeEventListener("abort", onAbort);
        if (requestController === controller) requestController = null;
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      requestController?.abort();
      requestController = null;
    },
  };
}
