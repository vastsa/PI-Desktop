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

1. For the 0.23.1 Offline Office candidate, use the dedicated build below.
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
   dedicated Office build for Kylin Offline Office qualification.
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

## Office Runtime and a self-installed Word Skill

On the Pie Code 0.23.1 maintenance line, the Kylin ARM64 Debian package
ships an Office Runtime extension without any office Skills. To install a
`docx` folder that contains symbolic links, place the complete folder or a link
to it under `~/.agents/skills` or the project Skill directory. If Agent → Skills
finds it in **Scan skills from other tools**, choose **Symlink** and keep the
source in place. **Import Folder** and the scan's **Copy** mode skip symbolic
links inside the folder.

In Extensions, Office Runtime starts disabled, even after upgrading an
enabled legacy Offline Office candidate. Enable it everywhere or choose
local projects. Everywhere includes sessions with no project. Each new
local Bash command resolves the current scope from its session. Linux treats
`project` and `Project` as separate choices. Remote workspaces and system
terminals keep their existing environment. Approved
foreground and background Bash commands search the packaged interpreters
and rendering tools first. CommonJS can resolve `docx` and `pptxgenjs`
through `NODE_PATH`. Packaged Python does not write bytecode caches next to
the user's Skill scripts. The same
Bash permission applies whether a Skill or an ordinary prompt calls it.
An incomplete runtime reports the missing path and how to recover, including
when the launcher exists but its renderer executable is missing. The host
removes temporary rendering profiles after a Bash command exits, times out,
or is stopped.

Stage the approved ARM64 Office Runtime 1.0.2 Python, Python dependencies,
and Node layers on a case-sensitive Linux filesystem, preserving relative
links. Overlay the locked docx 9.16.0 production package tree under
`node/lib/node_modules`. Before building, stage the [PowerPoint](#self-installed-powerpoint-skill),
[Excel](#self-installed-excel-skill), and [PDF and Office export](#self-installed-pdf-skill-and-office-export)
inputs in the same tree. Every scenario uses the same DEB. Place the original
runtime provenance at `metadata/runtime-source.json`. Packaging selects the
interpreters, Python standard library, and approved Office and PDF dependencies and licenses.
It does not ship Skill launchers, templates, WX archives, or unrelated
language packages. This Word
scenario uses the Skill's XML extraction route; optional pandoc-based
conversion, legacy formats, PDF rendering, and tracked-change acceptance
are outside this Word qualification.

```sh
export PI_CODE_OFFICE_RUNTIME_DIR=/absolute/path/to/staged/office-runtime
pnpm --filter @pi-desktop/desktop run dist:kylin
deb=apps/desktop/release/kylin-offline-office/pie-code_0.23.1_arm64.deb
node scripts/check-linux-deb.mjs arm64 "$deb" --with-offline-office
```

Install that exact DEB with no public route or extra system dependency
installation. Supply the original, complete user Skill separately, then
run the scenario with a built shared package, Node 22+, and a display in
the loopback-only namespace:

```sh
PI_CODE_E2E_APP_BIN='/opt/Pie Code/pie-code' \
PI_CODE_E2E_DOCX_SKILL=/absolute/path/to/original/docx \
  node scripts/e2e-offline-office.mjs
```

The scenario loads the installed Skill from the real Agent tool, approves
Bash and Edit through the existing permission broker, and reads back the
new and edited DOCX files. It uses the Skill's unpack, validate and pack
scripts using the Skill's original Python commands without `-B`, and its
CommonJS docx-js authoring path. It checks that the document, the linked Skill
source and link targets stay unchanged and that no Python cache files are
added. It checks global Bash in an unbound session, then adds and removes two
case-variant folders through the Extensions project picker and checks Bash in
each folder. It checks both projects after switching back to Everywhere, then
restarts with only the Word project selected. It selects each project in the
sidebar, opens a New Task, and verifies the new chat's project. The unselected
and unbound chats load the Skill and run Bash in the same turn. Their
`PATH` and `NODE_PATH` match the baseline recorded with Office Runtime off,
as do the system terminal's. The denial and Word workflow run in the selected
project. After disabling
the runtime, the scenario checks Bash in the existing session and then in a new
session in the same project after another restart. For upgrades, use two
separate disposable installations with the same original docx Skill. Run the
same command with `--seed-0.23.0` against the published 0.23.0 DEB and with
`--seed-legacy` against the old 0.23.1 DEB containing Offline Office. For each
run, set `PI_CODE_E2E_UPGRADE_STATE` to a new disposable directory. The legacy
seed enables the old extension for one project. Install the final DEB over
each source and run without a seed flag, keeping the corresponding state
directory. Verify the saved theme, completed conversation and user Skill
survive. The legacy extension is gone and Office Runtime starts off with
its default scope.

Run the separate loopback remote-workspace fixture after `pnpm build:js`, using
the inspected package's resources and its matching Host binary:

```sh
export PI_CODE_E2E_OFFICE_RESOURCES='/opt/Pie Code/resources'
PI_HOST_CORE_BINARY="$PI_CODE_E2E_OFFICE_RESOURCES/bin/pi-desktop-host-core" \
  node scripts/e2e-local-agent-remote-tools.mjs
```

The fixture uses the same loopback model, relay and remote Host to compare
remote Bash's `PATH` and `NODE_PATH` before and after enabling Office Runtime
globally on the local Host. It uses a temporary login profile and requires no
external host.

Keep the candidate revision, DEB digest, package inspection, and target
result together. Earlier candidates with built-in Skills are not evidence
for this package.

## Self-installed PowerPoint Skill

Stage these inputs in the same runtime tree before running `dist:kylin`:

| Workflow | Staged input |
| --- | --- |
| Create an editable presentation | PptxGenJS 4.0.1 and its CommonJS runtime dependencies alongside docx-js. Keep the combined `metadata/package-lock.json` and package licenses. |
| Extract text from PPTX | MarkItDown 0.1.9 with the `pptx` extra (python-pptx 1.0.2) and its runtime dependencies, including Magika's model. Keep the Python distributions, their licenses, and `metadata/python-dependencies.json`. |
| Edit and save a copy | The same defusedxml and lxml used by Word, with the unpack, clean, and pack scripts supplied by the user's original Skill. |
| Render a thumbnail | Pillow 12.3.0, AlmaLinux 8.10 LibreOffice Impress 7.1.8.1 and Poppler 20.11.0 with vendor security updates. Stage the headless payload under `libreoffice/` and `poppler/`; the package supplies the launchers. Keep component versions, source references, and license notices in `metadata/native-office/`. |

Stage the headless Impress payload and its libraries, plus only the
`pdftoppm` executable and its libraries from Poppler. Each native RPM represented
in the payload needs its version, exact source RPM reference, and readable
license notices. The shared package check requires `libreoffice-core`,
`libreoffice-writer`, `libreoffice-impress`, `libreoffice-calc`, `poppler`, and `poppler-utils`.

Use an ARM64 renderer build that fits the target's glibc 2.31 and is approved
for redistribution. The earlier LibreOffice 6.4 runtime does not qualify.
Before public distribution, inspect the exact DEB's payload and hand off the
corresponding source RPMs referenced in its `metadata/native-office/sources.json`,
including applicable patches. Check the source files against the recorded
digests and keep the sources and notices with the same release candidate.
Inspect all packaged ELF files with `check-linux-deb.mjs` before testing the
installed DEB. In the same Kylin loopback-only environment used for Word, run:

```sh
PI_CODE_E2E_APP_BIN='/opt/Pie Code/pie-code' \
PI_CODE_E2E_PPTX_SKILL=/absolute/path/to/original/pptx \
  node scripts/e2e-offline-office.mjs --pptx
```

The scenario exercises the original Skill through the local Agent tools and
the existing permission prompt. The Chinese, space-containing source deck
is read without changes; both generated files are read back as editable text
shapes, and the second slide remains in order after editing the first. The
thumbnail must be generated by the packaged tools. Keep the packaged
dependency manifests and the results with the exact tested DEB.

## Self-installed Excel Skill

In the same staging tree, add these Excel dependencies and retain their
distribution metadata, license notices, and source references:

| Workflow | Staged input |
| --- | --- |
| Read and analyze the workbook | pandas 3.1.1 and python-dateutil 2.9.0.post0; reuse NumPy 2.5.3 and six 1.17.0. |
| Read, create, and save an editable XLSX copy | openpyxl 3.1.5 and et-xmlfile 2.0.0. |
| Recalculate the saved file | AlmaLinux 8.10 LibreOffice Calc 7.1.8.1 from the same build and source RPM as the packaged LibreOffice core. The original Skill uses the target's GNU `timeout` and local Unix sockets, which are available on the acceptance image. |

Add the four Python distributions to `metadata/python-dependencies.json`
and the Calc RPM and notices to `metadata/native-office/`. Keep the
dateutil time zone data used by pandas. Overlay the Calc
payload onto the staged LibreOffice tree. Keep LibreOffice's standard
`presets/basic` files so a fresh profile has a registered Basic module.
The user's Skill supplies the recalc script and its macro. No compiler is
needed when local Unix sockets are available.

After creating or saving a copy, run the original Skill's recalc command
on the output with the usual Bash approval:

```sh
python '/absolute/path/to/xlsx/scripts/recalc.py' '另存 工作簿.xlsx'
```

In enabled local Bash sessions, the bundled `python` and `python3` give this
script its own temporary LibreOffice profile. Both Calc calls share it;
ordinary Python commands still use the usual home directory. The Skill's GNU
`timeout` stays in the Bash process group so Stop can end recalculation.
Read formula values back: the script can report success with an empty cache.

Test the installed candidate in the same loopback-only Kylin setup:

```sh
PI_CODE_E2E_APP_BIN='/opt/Pie Code/pie-code' \
PI_CODE_E2E_XLSX_SKILL=/absolute/path/to/original/xlsx \
  node scripts/e2e-offline-office.mjs --xlsx
```

The scenario checks denied and approved Bash, pandas readback, editable
creation and save-as, and independent cache readback of 250 and 260 after
explicit recalculation. It checks representative styles and the untouched
sheet before and after recalculation. The source workbook and complete
Skill must stay unchanged. If the supplied Skill cannot complete a step,
record the failure without changing it or using a replacement.

## Self-installed PDF Skill and Office export

Install the complete, unmodified user `pdf` Skill through the same user
Skill directory as Word and PowerPoint. Enable Office Runtime for the local
session. Use the sample's `pypdf` route to extract text from a regular PDF
and combine documents in the requested order. For PDF export, use the same
packaged headless LibreOffice with Writer, Impress and Calc. Export into a
new output directory and leave the input files in place.

In the staged Python 3.12 runtime, include the `pypdf` 7.1.1 distribution
(BSD-3-Clause) and its license notice. Record the wheel source, version and
digest in `metadata/python-dependencies.json` (`url` and `sha256`). The package
check requires both fields and a nonblank license notice. Add the headless
Writer and Calc filters and their required libraries and registry data from
the same AlmaLinux build as Impress. Keep `libforuilo.so`: Calc links to it even
when exporting without a display. Include the `libreoffice-writer` and
`libreoffice-calc` entries with their source RPM and notices in
`metadata/native-office/sources.json`. Reuse existing system fonts; the
export test checks Chinese text on the target image. No additional PDF
command line tool or PDF Skill file is needed for these workflows.

Run against the inspected and installed Debian package in the same
loopback-only Kylin environment:

```sh
PI_CODE_E2E_APP_BIN='/opt/Pie Code/pie-code' \
PI_CODE_E2E_PDF_SKILL=/absolute/path/to/original/pdf \
  node scripts/e2e-offline-office.mjs --pdf
```

The scenario denies one Bash write and loads the actual user Skill. It checks
that the loaded Skill documents both the pypdf text extraction and ordered merge
recipes in Python examples before approving Bash. The fixture runs those API
operations with its own inputs and reads back the resulting page order. It
creates the DOCX, PPTX and XLSX inputs before the export turn, independently
of the other Office issues. Check all three PDFs for their expected text and confirm that
the Chinese and space-containing sources and the installed Skill are intact.
This qualifies the original PDF sample's plain-text and merge recipes, and
the separate LibreOffice export route. The Excel sample documents formula
recalculation; it does not supply an Excel-to-PDF recipe. PDF table
extraction via pdfplumber, OCR and optional PDF command line alternatives
are outside this qualification.

## Self-installed WX Skill

Extract the complete user-provided Linux ARM64 `wx-doc-format` offline
archive (qualified sample: 0.21.3) into `~/.agents/skills/wx-doc-format`.
Keep its scripts, template and wheel archive together. Use a writable user
directory: the original launcher generates `.deps` and `.deps.lock` on first
use. It leaves the supplied Skill files alone and needs no CheeseAgent link.

Enable Office Runtime for the local session so the Skill's `python3` resolves
to Pie's existing Python 3.12. Run the Skill's documented `sh scripts/run.sh`
workflow with absolute paths and `WX_DOC_FORMAT_RELEASE=1`. Use a separate
output and audit report for each ordinary conversion; run `--review` separately
on the original DOCX with its own report path. The Skill's wheelhouse supplies
its Python packages offline. Pie adds no WX dependency, template, script or
archive to the Debian package.

In the same loopback-only Kylin environment, use the already inspected and
installed DEB and a fresh extraction of the user's offline archive. Pass the
extracted directory itself. The scenario rejects a linked root, absolute links,
and relative links that are broken or resolve outside the copied Skill.
From the checkout supplying the scenario, record the harness commit and its
base separately from the DEB build commit and SHA-256. Record any local
changes and keep the run output with this evidence.

```sh
PI_CODE_E2E_APP_BIN='/opt/Pie Code/pie-code' \
PI_CODE_E2E_WX_SKILL=/absolute/path/to/original/wx-doc-format \
  node scripts/e2e-offline-office.mjs --wx
```

The scenario discovers and loads the original Skill, denies a Bash write,
and checks that `.deps`, `.deps.lock`, and conversion outputs are absent.
It then approves Markdown and DOCX conversion with the packaged Python
and checks that the launcher created the offline dependencies. It reads
the output text, WX style, and public conversion audits back through Bash,
and reads the independent review score and remediation through the Agent's
Read tool. Both inputs and all supplied Skill files must stay unchanged.
Expand the same DEB and inspect its resources and `app.asar` contents,
including nested archives, for WX launchers, `wx-doc-format`,
`wx_template.docx`, and the WX wheel archive.
Record their absence alongside the package's runtime and license checks.

## Issue #22: 0.23.1 qualification — 2026-11-27

Build commit and maintenance base: `3a6bc1f35790b278aee228204e420b4ab06f888e`
(`origin/pie-code`). The ARM64 Debian build used Electron 43.6.0 and a
Debian 11 Host toolchain. This change adds acceptance checks and leaves
the packaged application sources unchanged.

- Package: `pie-code_0.23.1_arm64.deb`, 305,255,816 bytes
  (76,043,636 bytes smaller than the 381,299,452-byte reference).
- SHA-256: `ae9605579a88faa6f54d8602512c9ff5b700dd0fa5f36c0780bebfe978301300`.
  This matches the DEB used for the clean install and both upgrades.
- Office harness base: the same maintenance commit. Script blobs:
  `b7b40874030b3facc33bdc5812a9d94ee951af03` for the clean install and
  `e36919a441979a0dc39ec4efa8a5fe639a438a25` for the final upgrade reruns.
- Upgrade source SHA-256: published 0.23.0
  `4078e13c28d90123e65440a6ae2808c1d839391297328d26f60721e9ff7e4fbb`;
  legacy 0.23.1 `3770cc9f977d7e33c0b8b3b067ccc0368d80fd6333ffb74ea07a0c95f48d3e44`.
- Target: UTM Kylin Desktop V10 SP1 (2403), build 20240407/54202,
  ARM64, glibc 2.31 and system Python 3.8.10. Installs used disposable
  package databases and read-only application directories during tests.
  No additional operating-system packages were installed. The network
  namespace had only loopback, and no CheeseAgent was available.

| Check | Outcome |
| --- | --- |
| Package inspection | Passed. Checked the actual DEB, `app.asar`, and the nested dateutil time-zone archive. The package carries the disabled Office Runtime extension without contributed Skills, old launchers, templates, or the WX offline archive. Verified 523 ARM64 ELF files at glibc 2.31 or below; optional microphone add-ons are excluded from that count. |
| Office Skills | Passed. All five original Skills ran independently through local Agent sessions with the usual Bash denial and approval flow. Readback covered editable DOCX and PPTX, thumbnails, XLSX formula caches of 250 and 260, ordered PDF merge and all three Office exports, and WX conversion audits and independent review. Inputs and supplied Skill files were preserved. |
| Runtime scope and network | Passed. Verified default off, Everywhere including an unbound session, selected projects and switching, restart, disablement, and matching terminal environment. System Python, glibc, and system-shell PATH matched before and after. The Word process tree made only loopback requests; the checker rejected a separate non-loopback negative control. The remote Bash scope fixture passed in an isolated Debian 11 ARM64 container using this DEB's Host and resources. |
| Upgrades | Passed from the published 0.23.0 and a legacy 0.23.1 candidate enabled for a project. Both retained the theme, completed conversation and original user Skill. The old extension was absent and the new runtime started disabled with an empty project list. Bash in the still-existing old project could not see the runtime. |
| User plugins | Passed. Saved a setting from the plugin's configuration sheet, changed and reloaded the development source, and removed the plugin without deleting its source. The native file picker accepted versions 1.0.0 and 1.0.1 of the same local plugin ID; the replacement kept the selected project and stayed enabled. Uninstall removed the installed package from the plugin list. |

JavaScript: 9,659 passed, 37 skipped, no failures. Host: 1,329 passed,
one ignored, no failures. Desktop typecheck and lint passed. A pristine
Kylin OS image, physical hardware, the native UKUI launcher, optional
microphone add-ons, and live intranet endpoints were not tested.

The Office payload uses AlmaLinux LibreOffice 7.1.8.1
(`7.1.8.1-3.el8_10.alma.1`) and Poppler 20.11.0
(`20.11.0-14.el8_10`), with packaged notices and source references. The
only Office font is OpenSymbol from that LibreOffice build. KaTeX fonts
remain part of the desktop renderer. The DEB does not include LibreOffice
6.4 or the separate CheeseAgent fonts layer. Release handoff still requires
verification and provision of the complete corresponding source set and
confirmation of redistribution coverage for the staged runtime and fonts.
