# Kylin ARM64 offline installation and acceptance

Test the actual `pie-code_<version>_arm64.deb` on a Galaxy Kylin V10 SP1
(2403) ARM64 desktop. Record whether the desktop is an existing installation
or a clean image. Only a clean-image test can establish what a stock system
provides. A Debian 11 smoke test cannot establish Kylin desktop behavior.

The first Pie Code release delivers only the validated Kylin ARM64 Debian
package and any offline dependencies it needs. Use “Pie Code · 内网 AI 编程工作台”
in the release notes. The inherited multi-platform tag workflow is not the
first-release delivery procedure.

1. Use the `pie-code-linux-arm64-deb` artifact from Linux package validation.
   If the workflow is unavailable, build on an ARM64 Linux runner with Docker
   using `pnpm --filter @pi-desktop/desktop run dist:linux --linux deb --arm64`.
   Run `node scripts/check-linux-deb.mjs arm64 <package.deb>` on the build
   host, with workspace dependencies installed and `pnpm build:js` completed.
   The packager needs access to models.dev and records the catalog fetch time
   inside the package. Keep the candidate commit, inspection output (including
   the catalog date), and package together.
   The optional microphone binaries are reported separately and are outside this
   candidate's scope.
2. On the target, record `uname -m`, `getconf GNU_LIBC_VERSION`, and
   `dpkg-deb -f pie-code_<version>_arm64.deb Package Version Architecture Depends`.
   Compare the package's Depends and their runtime library providers with
   `dpkg-query -W`. If the target is missing packages, use a separate
   matching Kylin system with access to its package source to obtain the
   actual ARM64 dependency packages, including any missing transitive
   dependencies. Record their names, versions and installation order.
3. Disconnect public networking and ensure no package sources are usable on
   the target. Copy the main package and, if needed, the dependency
   packages. Install the supplied dependencies in the recorded order before
   running `sudo dpkg -i ./pie-code_<version>_arm64.deb`. Confirm `dpkg -s
   pie-code` reports `install ok installed`. Record the exact inputs used,
   or record that this installation required no extra packages.
4. Launch Pie Code from the application menu. Confirm the window renders,
   the local core connects, and the application opens a local project and
   shows a known file from its tree. Save the result with the candidate
   commit, package filename, and target OS image. Do not mark the candidate
   qualified if any step has not run.
5. Install a Kylin-compatible PI-Desktop baseline package on the same test
   machine. Record its source and version alongside the Pie Code candidate;
   distinguish a rebuilt compatible package from an official upstream release.
   Confirm both package identities report `install ok installed` and launch
   both through their system application menu entries. Create a distinct local session and set a
   different theme in each app. Quit both, launch both again, and verify
   that each restores its own settings and session without seeing the other's.
   Use default data directories under a disposable home for this check.
6. Open About in Pie Code and check the name and Simplified Chinese tagline
   “内网 AI 编程工作台”. Check the installed launcher icon at 16, 24 and
   32 pixels on the Kylin desktop and record each size. In both built-in
   themes, check the primary action, a selected item, and the focus indicator
   when reaching the Settings search by Tab.

7. With public networking still disconnected, use an isolated app profile and
   a disposable Git project. In Settings → Model configuration, confirm the
   bundled catalog shows a model count and the recorded fetch time. Add a
   custom OpenAI-compatible service on the local machine or intranet. Verify
   the discovered IDs are the endpoint's, leave the API key blank for a
   no-auth service, and add another ID the service accepts but does not list.
8. In that project, select the manually entered ID and send a coding task in
   Ask mode. Observe
   model output before the turn finishes. Verify the file is unchanged while
   edit approval is pending; approve the edit and the local test command,
   then inspect the passing test result and the change in the desktop review
   panel. Start a second streaming turn and stop it from the composer. Restart
   the app in the same profile and reopen the first turn and its saved results.
   Verify that no more text appears in the stopped turn after cancellation.
9. For optional intranet MCP, open Settings → MCP → Add and choose HTTP
   endpoint. Enter the name and full MCP URL supplied by the Milku or other
   internal service operator. Save, reopen the server, and choose Test
   connection to see the available tools. In a project session using the
   internal model, choose a harmless tool from the composer's `/mcp:` entries.
   In Ask mode, approve it once and expand the tool row to check its result.
   Steps 7–8 must also work in a profile with no MCP servers configured.

For Pie Code, check the same package identity and architecture when replacing
an existing installation. Quit the app and install the newer internally
distributed package with `sudo dpkg -i ./<newer-package>.deb`. Restart and
verify the version, existing settings, and saved sessions. The app does not
check GitHub or download its own update.

Run the offline workbench scenario on the installed candidate as a normal
desktop user in a Linux network namespace with only loopback enabled. Prepare
Node.js, the scenario sources and built shared package, and `strace` before
disconnecting. In that namespace, capture socket calls from the desktop and
all children; a TCP connection or datagram send counts even when it fails.
Chromium's UDP route lookup does not send a packet and is reported separately:

```sh
export PI_CODE_E2E_APP_BIN='/opt/Pie Code/pie-code'
export PI_DESKTOP_HOST_BIN='/opt/Pie Code/resources/bin/pi-desktop-host-core'
strace -f -yy -s 0 -e trace=connect,sendto,sendmsg,sendmmsg,write,writev -o /tmp/pie-workbench.trace \
  node scripts/e2e-pie-code-offline.mjs --require-isolated-network
node scripts/e2e-pie-code-offline.mjs --check-egress-trace /tmp/pie-workbench.trace
```

Verify the tracer separately with a direct test connection to the reserved
address `192.0.2.1` in the same isolated namespace; the trace checker must
reject it. Record the two results with the actual candidate package. A
loopback proxy alone can miss direct connections from child processes.
