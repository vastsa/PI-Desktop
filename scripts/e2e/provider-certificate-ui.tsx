import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import type { UiMessage } from "@pi-desktop/shared";
import { AssistantErrorMessage } from "../../apps/desktop/src/features/chat/transcript/shared";

declare global { var certificateUiProbe: (baseline: boolean) => Promise<unknown>; }
const assert = (value: unknown, message: string) => { if (!value) throw new Error(message); };
globalThis.certificateUiProbe = async (baseline) => {
  const i18n = createInstance();
  await i18n.init({ lng: "zh-CN", resources: { "zh-CN": { translation: catalogs["zh-CN"] } }, interpolation: { escapeValue: false } });
  const container = document.createElement("main");
  container.style.cssText = "max-width:900px;margin:60px auto;padding:24px";
  document.body.append(container);
  const root = createRoot(container);
  const render = (code: string) => {
    const message: UiMessage = {
      id: "certificate-error", role: "assistant", content: "", createdAt: "2026-09-20T00:00:00Z",
      providerId: "fixture-provider", modelId: "fixture-model", status: "error", isError: true,
      error: { code: "NETWORK_ERROR", message: "Connection error.", retriable: false,
        details: { networkCode: code } },
    };
    flushSync(() => root.render(<I18nextProvider i18n={i18n}><AssistantErrorMessage message={message} /></I18nextProvider>));
  };
  for (const code of ["SELF_SIGNED_CERT_IN_CHAIN", "CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID", "EPROTO", "ENOTFOUND"]) {
    render(code);
    const certificate = !baseline && !["EPROTO", "ENOTFOUND"].includes(code);
    assert(container.querySelector("strong")?.textContent === i18n.t(certificate ? "errors.providerCertificate" : "errors.NETWORK_ERROR"), `${code}: wrong summary`);
    assert(container.querySelector("code")?.textContent?.includes(code), "errno disappeared");
  }
  render("SELF_SIGNED_CERT_IN_CHAIN");
  const disclosure = container.querySelector<HTMLButtonElement>("button[aria-expanded]");
  assert(disclosure, "missing details control");
  flushSync(() => disclosure?.click());
  assert(disclosure?.getAttribute("aria-expanded") === "false", "details did not close");
  flushSync(() => disclosure?.click());
  assert(disclosure?.getAttribute("aria-expanded") === "true", "details did not reopen");
  assert(container.textContent?.includes("Connection error."), "raw details lost");
  return { ok: true, baseline, cases: 5, detailsToggle: true };
};
