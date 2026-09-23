import { expect, it } from "vitest";
import type { TrustedExtensionUiRequestEnvelope, TrustedExtensionUiResponse } from "@pi-desktop/shared";
import { requestExtensionUi } from "./ui-request.js";

it("retires the exact admitted request on abort and removes its listener after settlement", async () => {
  const sent: TrustedExtensionUiRequestEnvelope[] = [];
  let release!: (response: TrustedExtensionUiResponse) => void;
  const owner = new AbortController();
  const pending = requestExtensionUi(async (envelope) => {
    sent.push(envelope);
    if (envelope.request.kind === "cancel") return { kind: "cancel" };
    return new Promise((resolve) => { release = resolve; });
  }, { sessionId: "s", extensionId: "e", extensionLabel: "E", request: { kind: "confirm", title: "?", message: "" } }, owner.signal);
  owner.abort();
  expect(sent[1]).toMatchObject({ sessionId: "s", extensionId: "e",
    request: { kind: "cancel", requestId: sent[0]?.requestId } });
  release({ kind: "confirm", value: false });
  expect(await pending).toEqual({ kind: "confirm", value: false });
  expect(sent).toHaveLength(2);
});
