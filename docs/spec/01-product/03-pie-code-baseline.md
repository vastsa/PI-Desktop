# Pie Code first candidate

The first candidate derives from the PI-Desktop official release `v0.23.0`,
commit `95df2e0f9d124ba281fc99e6700ca6649766c77e`. The package version is
`0.23.0`. The candidate retains the tag's three patched Pi packages and
`pnpm-lock.yaml`.

Issue #2 covers the ARM64 Debian package, offline installation and opening a
local project on Galaxy Kylin V10 SP1 (2403) with glibc 2.31. See the
[offline install and acceptance procedure](../06-delivery/kylin-arm64-offline-install.md).

Pie Code is an independent desktop application, described in Simplified Chinese
as “内网 AI 编程工作台”. Its application ID is `io.github.w4yne00.piecode`;
the Linux executable, desktop entry and Debian package are `pie-code`,
`pie-code.desktop` and `pie-code`, respectively. The ARM64 package is named
`pie-code_<version>_arm64.deb`.

Pie Code defaults to `~/.pie-code` for settings and sessions and the
OS application-data directory named `Pie Code` for Chromium state and the
installation lock. Development uses `~/.pie-code-dev` and `Pie Code Dev`.
These defaults do not read, migrate or replace the upstream PI-Desktop
profiles. Explicit profile overrides and relocation keep their existing behavior.
The packaged updater metadata also uses its own `pie-code-updater` cache
and points to Pie Code releases. Offline mode does not check that endpoint;
updates are installed from internally distributed packages.

The included icon uses the selected bitten coral P with exposed gold crust on
a blue-gray tile. The built-in dark theme uses coral for the accent; the
light theme uses a deeper coral for contrast. Primary controls, selected items
and keyboard focus reuse these accents without changing layout or interaction.
