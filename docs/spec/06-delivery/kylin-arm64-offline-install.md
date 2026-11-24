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
   Run `node scripts/check-linux-deb.mjs arm64 <package.deb>` on the result.
   Keep the candidate commit, build and inspection output, and package together.
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
5. With an upstream `pi-desktop` package installed on the same test account,
   confirm both package identities still report `install ok installed` and
   launch both menu entries. Create a distinct local session and set a
   different theme in each app. Quit both, launch both again, and verify
   that each restores its own settings and session without seeing the other's.
   Use default data directories under a disposable home for this check.
6. Open About in Pie Code and check the name and Simplified Chinese tagline
   “内网 AI 编程工作台”. Check the installed launcher icon at 16, 24 and
   32 pixels on the Kylin desktop. In both built-in themes, check the primary
   action, a selected item and the focus indicator reached by keyboard.
