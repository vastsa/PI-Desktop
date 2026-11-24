# Kylin ARM64 offline installation and acceptance

Test the actual `pi-desktop_0.23.0_arm64.deb` on a Galaxy Kylin V10 SP1
(2403) ARM64 desktop. Record whether the desktop is an existing installation
or a clean image. Only a clean-image test can establish what a stock system
provides. A Debian 11 smoke test cannot establish Kylin desktop behavior.

1. Use the `pi-desktop-linux-arm64-deb` artifact from Linux package validation.
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
   `dpkg-deb -f pi-desktop_0.23.0_arm64.deb Package Version Architecture Depends`.
   Compare the package's Depends and their runtime library providers with
   `dpkg-query -W`. If the target is missing packages, use a separate
   matching Kylin system with access to its package source to obtain the
   actual ARM64 dependency packages, including any missing transitive
   dependencies. Record their names, versions and installation order.
3. Disconnect public networking and ensure no package sources are usable on
   the target. Copy the main package and, if needed, the dependency
   packages. Install the supplied dependencies in the recorded order before
   running `sudo dpkg -i ./pi-desktop_0.23.0_arm64.deb`. Confirm `dpkg -s
   pi-desktop` reports `install ok installed`. Record the exact inputs used,
   or record that this installation required no extra packages.
4. Launch PI-Desktop from the application menu. Confirm the window renders,
   the local core connects, and the application opens a local project and
   shows a known file from its tree. Save the result with the candidate
   commit, package filename, and target OS image. Do not mark the candidate
   qualified if any step has not run.
5. With public networking still disconnected, use an isolated app profile and
   a disposable Git project. In Settings → Model configuration, confirm the
   bundled catalog shows a model count and the recorded fetch time. Add a
   custom OpenAI-compatible service on the local machine or intranet. Verify
   the discovered IDs are the endpoint's, leave the API key blank for a
   no-auth service, and add another ID the service accepts but does not list.
6. In that project, select the manually entered ID and send a coding task in
   Ask mode. Observe
   model output before the turn finishes. Verify the file is unchanged while
   edit approval is pending; approve the edit and the local test command,
   then inspect the passing test result and the change in the desktop review
   panel. Start a second streaming turn and stop it from the composer. Restart
   the app in the same profile and reopen the first turn and its saved results.
   Verify that no more text appears in the stopped turn after cancellation.

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
export PI_CODE_E2E_APP_BIN=/opt/PI-Desktop/pi-desktop
export PI_DESKTOP_HOST_BIN=/opt/PI-Desktop/resources/bin/pi-desktop-host-core
strace -f -yy -s 0 -e trace=connect,sendto,sendmsg,sendmmsg,write,writev -o /tmp/pie-workbench.trace \
  node scripts/e2e-pie-code-offline.mjs --require-isolated-network
node scripts/e2e-pie-code-offline.mjs --check-egress-trace /tmp/pie-workbench.trace
```

Verify the tracer separately with a direct test connection to the reserved
address `192.0.2.1` in the same isolated namespace; the trace checker must
reject it. Record the two results with the actual candidate package. A
loopback proxy alone can miss direct connections from child processes.
