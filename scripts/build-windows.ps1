# Build local Windows x64 NSIS/ZIP/portable artifacts from this checkout.
[CmdletBinding()]
param(
    [switch]$Check,
    [switch]$Dir,
    [switch]$Install,
    [switch]$CargoMirror,
    [switch]$DryRun,
    [switch]$Help
)
$ErrorActionPreference = 'Stop'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'Node.js 22.19+ is required. Install Node.js, then reopen PowerShell.'
}
$buildArgs = @((Join-Path $PSScriptRoot 'build-platform-app.mjs'), 'win')
if ($Check) { $buildArgs += '--check' }
if ($Dir) { $buildArgs += '--dir' }
if ($Install) { $buildArgs += '--install' }
if ($CargoMirror) { $buildArgs += '--cargo-mirror' }
if ($DryRun) { $buildArgs += '--dry-run' }
if ($Help) { $buildArgs += '--help' }
& node @buildArgs
exit $LASTEXITCODE
