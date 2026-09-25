<#
.SYNOPSIS
  Export the ACP feature branch to a portable snapshot.

.DESCRIPTION
  Writes two things to the output folder:

    acp-external-agents.patch   every commit on the branch since `main`,
                                as a single binary-safe patch
    work/                        the new files, laid out as they live in the
                                repo, so they can be read without git

  The patch is produced through `cmd` redirection on purpose. PowerShell's `>`
  re-encodes text, which silently replaces every non-ASCII character with
  U+FFFD - an export that looks fine and is unusable. The same bug cost a full
  patch once already: 1,274 replacement characters, and the file was reported as
  recoverable when it was not.

  So the script verifies its own output and fails loudly rather than leaving a
  corrupt artifact behind.

.EXAMPLE
  powershell -File scripts/snapshot-acp.ps1
  powershell -File scripts/snapshot-acp.ps1 -Out C:\somewhere\else
#>

[CmdletBinding()]
param(
  # Left unset deliberately: $PSScriptRoot is not populated yet while parameter
  # defaults are evaluated, so resolving it here would hand back an empty
  # string instead of the script's folder.
  [string] $Repo = '',
  [string] $Out = 'C:\Users\user\Desktop\PI-Desktop-acp',
  [string] $Base = 'main'
)

$ErrorActionPreference = 'Stop'

if (-not $Repo) { $Repo = Split-Path -Parent $PSScriptRoot }

function Fail($message) {
  Write-Error "snapshot failed: $message"
  exit 1
}

if (-not (Test-Path (Join-Path $Repo '.git'))) { Fail "not a git repository: $Repo" }

$branch = (& git -C $Repo branch --show-current).Trim()
if (-not $branch) { Fail 'cannot determine the current branch' }

$commits = (& git -C $Repo rev-list --count "$Base..HEAD").Trim()
if (-not $commits -or $commits -eq '0') { Fail "no commits on $branch since $Base" }

$files = @(& git -C $Repo diff --name-only "$Base..HEAD")
Write-Host "repo   : $Repo"
Write-Host "branch : $branch ($commits commit(s), $($files.Count) file(s) changed)"

# --- patch -------------------------------------------------------------------
# cmd redirection writes the bytes git produces; nothing re-encodes them.
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$patch = Join-Path $Out 'acp-external-agents.patch'
& cmd /c "git -C `"$Repo`" format-patch $Base..HEAD --stdout --binary > `"$patch`"" | Out-Null
if (-not (Test-Path $patch)) { Fail 'git produced no patch' }

# --- verify before claiming success ------------------------------------------
$bytes = [System.IO.File]::ReadAllBytes($patch)
$text = (New-Object System.Text.UTF8Encoding($false)).GetString($bytes)
$replacement = ([regex]::Matches($text, [string][char]0xFFFD)).Count
$diffBlocks = ([regex]::Matches($text, 'diff --git')).Count
$hasBom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF

if ($replacement -gt 0) { Fail "patch has $replacement replacement characters - it is not restorable" }
if ($hasBom) { Fail 'patch starts with a BOM' }
if ($diffBlocks -eq 0) { Fail 'patch contains no diffs' }
if ($diffBlocks -ne $files.Count) {
  # New files live in the patch too, so a mismatch means something was lost.
  Fail "patch holds $diffBlocks diffs but the branch changed $((($files) | Measure-Object).Count) files"
}

# --- the new files, byte for byte --------------------------------------------
# Copy-Item copies bytes; no text round trip, so no re-encoding happens here.
$work = Join-Path $Out 'work'
if (Test-Path $work) { Remove-Item $work -Recurse -Force }
New-Item -ItemType Directory -Force -Path $work | Out-Null

$added = @(& git -C $Repo diff --name-only --diff-filter=A "$Base..HEAD")
foreach ($relative in $added) {
  $source = Join-Path $Repo $relative
  if (-not (Test-Path $source)) { continue }
  $target = Join-Path $work $relative
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
  Copy-Item $source $target -Recurse -Force
  # A build artefact would follow the source and bloat the snapshot.
  foreach ($artefact in @('node_modules', 'dist', 'dist-bundle', 'out')) {
    $stale = Join-Path $target $artefact
    if (Test-Path $stale) { Remove-Item $stale -Recurse -Force }
  }
}

$size = [math]::Round((Get-Item $patch).Length / 1KB)
Write-Host ""
Write-Host "patch  : $patch ($size KB, $diffBlocks diffs, no replacement characters)"
Write-Host "files  : $($added.Count) new file(s) copied to $work"
Write-Host "OK"
