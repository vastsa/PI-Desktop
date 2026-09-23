export function createPnpmInvocation(platform, builderArgs) {
  return {
    command: platform === "win32" ? "pnpm.cmd" : "pnpm",
    args: ["exec", "electron-builder", ...builderArgs],
    options: {
      stdio: "inherit",
      // Windows package managers are .cmd shims and require a shell when
      // launched through Node's child_process API.
      shell: platform === "win32",
    },
  };
}
