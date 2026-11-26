# Kylin ARM64 offline installation and acceptance

Test the actual `pie-code_<version>_arm64.deb` on a Galaxy Kylin V10 SP1
(2403) ARM64 desktop. Record whether the desktop is an existing installation
or a clean image. Only a clean-image test can establish what a stock system
provides. A Debian 11 smoke test cannot establish Kylin desktop behavior.

The first Pie Code release delivers only the validated Kylin ARM64 Debian
package and any offline dependencies it needs. Use “Pie Code · Ars longa, vita brevis.”
in the release notes and check the same subtitle in the package description.
The inherited multi-platform tag workflow is not the
first-release delivery procedure.

1. For the Word-enabled 0.23.1 candidate, use the dedicated build below.
   The generic Linux package workflow does not have the approved Office Runtime.
   For generic validation, use the `pie-code-linux-arm64-generic-deb` workflow artifact or
   build on an ARM64 Linux runner with Docker
   using `pnpm --filter @pi-desktop/desktop run dist:linux --linux deb --arm64`.
   Run `node scripts/check-linux-deb.mjs arm64 <package.deb>` on the build
   host, with workspace dependencies installed and `pnpm build:js` completed.
   The packager needs access to models.dev and records the catalog fetch time
   inside the package. Keep the candidate commit, inspection output (including
   the catalog date), and package together.
   The workflow names its downloaded package `*_generic.deb`; use the
   dedicated Office build for Kylin Word qualification.
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
6. Check the Pie Code name and the subtitle “Ars longa, vita brevis.” on the
   startup screen and in About. Switch the app language and confirm the
   subtitle still matches. From the application menu, create a desktop
   shortcut and pin Pie Code to the taskbar. Quit the app and verify that all
   three launchers show the Pie Code icon and reopen the app. Compare the
   desktop shortcut with neighboring apps at the normal, large, and huge
   desktop icon settings. Check the 16, 24, and 32 pixel menu and taskbar icons.
   The Debian package ships native 48, 64, and 96 pixel desktop icons in
   `hicolor`, plus `/usr/share/pixmaps/pie-code.png` when theme lookup fails.
   In both built-in themes, check the primary action, a selected item, and
   the focus indicator when reaching the Settings search by Tab.

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
verify the version, existing settings, and saved sessions. After signing out
and back in to reload the desktop and panel, verify that the existing desktop
shortcut and taskbar pin show the Pie Code icon without recreating them. The
app does not check GitHub or download its own update.

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

## Offline Office — Word and Excel

On the Pie Code maintenance line, the ARM64 Debian package includes one
shared Office Runtime and the built-in Offline Office extension. In a
fresh profile the extension is off. Enable it in Extensions to expose
`pie.offline-office/word` and `pie.offline-office/excel` in local Agent
sessions. Both skills use ordinary Bash approval and the packaged executables;
neither installs dependencies nor uses a system Node, Python, or LibreOffice.

Before building, stage the approved ARM64 Office Runtime 1.0.2
`python-runtime`, `python-dependencies`, `node-runtime`, and
`libreoffice-runtime` layers into one directory on a case-sensitive Linux
filesystem, preserving permissions and relative links that resolve inside it.
Overlay the complete `node_modules` from the locked docx 9.16.0 build into
`node/lib/node_modules`. In `python/lib/python3.12/site-packages`, unpack the
pre-staged pandas 3.1.1 CPython 3.12 manylinux AArch64 wheel and
python-dateutil 2.9.0.post0 universal wheel, including their `.dist-info`
directories. These two wheels have no `.data` directory and can be unpacked
with the bundled `python3.12 -I -m zipfile -e WHEEL SITE_PACKAGES` on ARM64
Linux. Reuse the bundled NumPy, six, and openpyxl. Neither installation nor
first use downloads dependencies. Keep the LibreOffice entry point at
`libreoffice/program/soffice`. Retain the source manifest as
`metadata/runtime-source.json`, the Node dependency lock as
`metadata/package-lock.json`, and the components' licenses. Set
`PI_CODE_OFFICE_RUNTIME_DIR` to the absolute path of this staging directory.
The candidate build fails when this input is missing; the installed app
never needs the original archive or Cheese. On an ARM64 Linux runner with
Docker, run the dedicated build and require Office in the package check:

```sh
export PI_CODE_OFFICE_RUNTIME_DIR=/absolute/path/to/staged/office-runtime
pnpm --filter @pi-desktop/desktop run dist:kylin
deb=apps/desktop/release/kylin-offline-office/pie-code_0.23.1_arm64.deb
node scripts/check-linux-deb.mjs arm64 "$deb" --with-offline-office
```

The package check inspects the extracted payload and uses its own Node and
Python to read back a newly created Word document and pandas Excel table.
Keep the exact Office Debian package, the candidate commit, the package
inspection output, and the Kylin run output together. Link those results in the PR or release record;
generic CI artifacts and results from a different package do not qualify.

With no public route, install that package in a clean application test
environment and run the Office scenario against the installed binary. Build
the shared JS package beforehand and use Node 22+ to run the scenario
(the bundled Node can run it). The scenario enables the extension through
the UI, loads both skills through a loopback model, and checks that Bash is
held for approval. It reads back the Word and Excel results independently
with python-docx and openpyxl and checks that both sources are unchanged.
It disables the extension and verifies both skills are absent from new
sessions after restarting.

```sh
PI_CODE_E2E_APP_BIN='/opt/Pie Code/pie-code' \
  node scripts/e2e-offline-office.mjs
```

Word edits replace a unique literal within one main-document paragraph
and save a new file. The skill reads the main part of transitional and
Strict DOCX files. Tabs and other layout markers interrupt literal matches.
Replacement text inherits the first matched run's formatting. Existing output files, including the source, are never
overwritten.

Excel reads a sheet with pandas, using the first row as column names and the
stored values for formulas. Elapsed durations are numeric seconds.
New tables use JSON records and pandas. An edit
replaces an existing plain value cell in a fresh `.xlsx` copy and leaves
formulas, cached results, styles, and other sheets intact. An explicit
recalculation creates another copy and updates only the formula caches. It
gives bundled LibreOffice a separate workbook with plain values and supported
workbook-local scalar formulas, including whole-row and whole-column ranges.
External references, named ranges, array formulas, iterative calculation,
precision as displayed, and unsupported functions fail without producing a
copy. If LibreOffice times out or Bash is cancelled during conversion, the
calculation processes are stopped and no copy is published. The sample keeps both `SUM` formulas;
each reads back as 250 after editing and 260 after recalculation.
