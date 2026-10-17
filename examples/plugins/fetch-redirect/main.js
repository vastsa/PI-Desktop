// No network is accessed until the user explicitly runs a probe.
module.exports = {
  async onLoad() {
    await pi.commands.register({
      id: "redirect.open",
      title: "Fetch Redirect: Open Probe",
      run: () => pi.ui.openPanel(),
    });
  },
  async onUnload() {
    await pi.commands.unregister("redirect.open");
  },
  async onPanelInvoke(channel, input) {
    if (channel !== "probe.fetch") throw new Error("Unknown probe operation");
    if (typeof pi.net.getCapabilities !== "function") {
      throw Object.assign(new Error("Host does not support fetch redirect policies"), { code: "UNSUPPORTED" });
    }
    const capabilities = await pi.net.getCapabilities();
    if (!capabilities.fetchRedirectModes.includes(input.redirect)) {
      throw Object.assign(new Error("Unsupported redirect policy"), { code: "UNSUPPORTED" });
    }
    return pi.net.fetch({ url: input.url, redirect: input.redirect, timeoutMs: 3000 });
  },
};
