import type { PluginRendererErrorCode } from "@pi-desktop/plugin-sdk";

/**
 * A coded refusal the host hands to plugin renderer code: thrown by
 * `pi.slots.register` / `pi.ui.injectStyle`, rejected by `pi.dispatch`.
 * Plugins branch on `code`; the message is for their developer.
 */
export class PluginRendererError extends Error {
  readonly code: PluginRendererErrorCode;
  constructor(code: PluginRendererErrorCode, message: string) {
    super(message);
    this.name = "PluginRendererError";
    this.code = code;
  }
}
