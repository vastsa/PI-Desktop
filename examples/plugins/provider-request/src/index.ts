/**
 * Trusted agent extension: the ready-model catalogue and one authenticated
 * provider request (spec 07-plugins/16 §5.1, ADR 0304 / ADR 0305).
 *
 * `/provider_ping` reads the host's ready models through `ctx.modelRegistry`
 * and issues one `GET` request through `ctx.providers.request` to the provider
 * row the first ready model belongs to. The host supplies the destination
 * origin and the credential header; this module never sees a key.
 *
 * Loaded with jiti, so no build step is needed.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("provider_ping", {
    description: "Ping the first ready provider row",
    async handler(_args, ctx) {
      const ready = ctx.modelRegistry.getAvailable();
      if (!ready.length) {
        ctx.ui.notify("No provider is ready. Add one in Settings > Models.");
        return;
      }
      const model = ready[0];
      const response = await ctx.providers.request({
        providerId: model.provider, // required, never inferred
        modelId: model.id, // optional; must be a model of that row
        path: "/models", // appended to the row's baseUrl
        method: "GET",
      });
      ctx.ui.notify(`${model.provider} answered ${response.status}`);
    },
  });
}
