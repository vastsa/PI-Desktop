# Kylin ARM64 offline installation and acceptance

Qualify the actual `pi-desktop_0.23.0_arm64.deb` on a clean Galaxy Kylin
V10 SP1 (2403) ARM64 desktop. An ARM64 Debian 11 smoke test exercises the
glibc 2.31 build but cannot establish the Kylin system's installed packages
or desktop behavior.

1. Build the candidate with the Linux package validation workflow
   (`pi-desktop-linux-arm64-deb` artifact). The package job runs
   `node scripts/check-linux-deb.mjs arm64 <package.deb>` to check the control
   metadata and the architecture and glibc requirements of the packaged ELF
   files. The optional microphone vendor binaries are reported separately;
   microphone support is outside this candidate's scope.
2. On a clean target, record `uname -m`, `getconf GNU_LIBC_VERSION`, and
   `dpkg-deb -f pi-desktop_0.23.0_arm64.deb Package Version Architecture Depends`.
   Compare the package's Depends and their runtime library providers with
   `dpkg-query -W`. If the target is missing packages, use a separate
   matching Kylin system with access to its package source to obtain the
   actual ARM64 dependency packages, including any missing transitive
   dependencies. Record their names, versions and installation order.
3. Disconnect public networking and ensure no package sources are usable on
   the clean target. Copy the main package and, if needed, the dependency
   packages. Install the supplied dependencies in the recorded order before
   running `sudo dpkg -i ./pi-desktop_0.23.0_arm64.deb`. Confirm `dpkg -s
   pi-desktop` reports `install ok installed`. Record the exact inputs used,
   or record that the stock image required no extra packages.
4. Launch PI-Desktop from the application menu. Confirm the window renders,
   the local core connects, and the application opens a local project and
   shows a known file from its tree. Save the result with the candidate
   commit, package filename, and target OS image. Do not mark the candidate
   qualified if any step has not run.
