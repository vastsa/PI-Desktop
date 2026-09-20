[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$PortableExe,
  [string]$SecondPortableExe,
  [string]$UnpackDirName = "PI-Desktop-Portable",
  [switch]$RequireTaskbarPin
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Wait-Until {
  param(
    [Parameter(Mandatory = $true)] [scriptblock]$Condition,
    [int]$TimeoutSeconds = 60,
    [int]$PollMilliseconds = 500
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    $value = & $Condition
    if ($value) { return $value }
    Start-Sleep -Milliseconds $PollMilliseconds
  } while ((Get-Date) -lt $deadline)
  return $null
}

function Get-PortableProcess {
  param([Parameter(Mandatory = $true)] [string]$ExecutablePath)

  Get-CimInstance Win32_Process -Filter "Name = 'PI-Desktop.exe'" |
    Where-Object { $_.ExecutablePath -eq $ExecutablePath } |
    Select-Object -First 1
}

function Get-TaskbarLinks {
  $pinDirectory = Join-Path $env:APPDATA "Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar"
  if (-not (Test-Path -LiteralPath $pinDirectory)) { return @() }

  $wsh = New-Object -ComObject WScript.Shell
  try {
    @(
      Get-ChildItem -LiteralPath $pinDirectory -Filter "*.lnk" -File -ErrorAction SilentlyContinue |
        ForEach-Object {
          $shortcut = $null
          try {
            $shortcut = $wsh.CreateShortcut($_.FullName)
            [pscustomobject]@{
              Path = $_.FullName
              TargetPath = $shortcut.TargetPath
              IconLocation = $shortcut.IconLocation
            }
          } finally {
            if ($null -ne $shortcut) {
              [Runtime.InteropServices.Marshal]::ReleaseComObject($shortcut) | Out-Null
            }
          }
        }
    )
  } finally {
    [Runtime.InteropServices.Marshal]::ReleaseComObject($wsh) | Out-Null
  }
}

function Invoke-PinToTaskbar {
  param([Parameter(Mandatory = $true)] [string]$ExecutablePath)

  $shell = New-Object -ComObject Shell.Application
  $folder = $null
  $item = $null
  $verb = $null
  try {
    $folder = $shell.Namespace((Split-Path -Parent $ExecutablePath))
    if ($null -eq $folder) { return $false }
    $item = $folder.ParseName((Split-Path -Leaf $ExecutablePath))
    if ($null -eq $item) { return $false }

    $verb = @($item.Verbs()) |
      Where-Object {
        $name = ($_.Name -replace "&", "").Trim()
        $name -match "(?i)(pin.*taskbar|taskbar.*pin)" -and $name -notmatch "(?i)unpin"
      } |
      Select-Object -First 1
    if ($null -eq $verb) { return $false }
    $verb.DoIt()
    return $true
  } finally {
    foreach ($comObject in @($verb, $item, $folder, $shell)) {
      if ($null -ne $comObject) {
        [Runtime.InteropServices.Marshal]::ReleaseComObject($comObject) | Out-Null
      }
    }
  }
}

function Stop-PortableRun {
  param(
    [Parameter(Mandatory = $false)] $Wrapper,
    [Parameter(Mandatory = $false)] $Child
  )

  if ($null -ne $Child) {
    Stop-Process -Id $Child.ProcessId -Force -ErrorAction SilentlyContinue
  }
  if ($null -ne $Wrapper) {
    Wait-Process -Id $Wrapper.Id -Timeout 30 -ErrorAction SilentlyContinue
    Stop-Process -Id $Wrapper.Id -Force -ErrorAction SilentlyContinue
  }
}

$portablePath = (Resolve-Path -LiteralPath $PortableExe).Path
$secondPortablePath = if ($SecondPortableExe) {
  (Resolve-Path -LiteralPath $SecondPortableExe).Path
} else {
  $portablePath
}
$tempRoot = (Resolve-Path -LiteralPath $env:TEMP).Path
$unpackRoot = Join-Path $tempRoot $UnpackDirName
$appPath = Join-Path $unpackRoot "PI-Desktop.exe"

if (-not $unpackRoot.StartsWith($tempRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to use an unpack path outside TEMP: $unpackRoot"
}

if (@(Get-PortableProcess $appPath).Count -gt 0) {
  throw "A stale portable app is already running at $appPath"
}
Remove-Item -LiteralPath $unpackRoot -Recurse -Force -ErrorAction SilentlyContinue
if (Test-Path -LiteralPath $unpackRoot) {
  throw "Portable extraction directory was not removed before the test: $unpackRoot"
}
$pinCreated = $false
$pinWasPresent = $false
$baselinePinPaths = @()
$baselinePinsCaptured = $false
$createdPinPaths = @()
$childPids = @()
$runs = @()

try {
  Write-Host "PORTABLE_EXE=$portablePath"
  Write-Host "SECOND_PORTABLE_EXE=$secondPortablePath"
  Write-Host "EXPECTED_APP_PATH=$appPath"

  # One launch verifies extraction, the taskbar pin target, and cleanup.
  $firstWrapper = Start-Process -FilePath $portablePath -PassThru
  $runs += $firstWrapper
  $firstChild = Wait-Until { Get-PortableProcess $appPath }
  if ($null -eq $firstChild) { throw "Portable app did not start at $appPath" }
  $childPids += $firstChild.ProcessId
  Write-Host "RUNNING_APP_PATH=$($firstChild.ExecutablePath)"

  $pinnedBefore = @(
    Get-TaskbarLinks | Where-Object { $_.TargetPath -eq $appPath }
  )
  $baselinePinPaths = @($pinnedBefore | ForEach-Object { $_.Path })
  $baselinePinsCaptured = $true
  $pinWasPresent = $pinnedBefore.Count -gt 0
  $pinCreated = $pinWasPresent -or (Invoke-PinToTaskbar $appPath)
  Write-Host "TASKBAR_PIN_CREATED=$pinCreated"
  if (-not $pinCreated -and $RequireTaskbarPin) {
    throw "Windows shell did not expose a Pin to taskbar verb for $appPath"
  }

  $pinnedWhileRunning = @()
  if ($pinCreated) {
    $pinnedWhileRunning = Wait-Until {
      $matches = @(Get-TaskbarLinks | Where-Object { $_.TargetPath -eq $appPath })
      if ($matches.Count -gt 0) { return $matches }
      return $null
    }
    $pinnedWhileRunning = @($pinnedWhileRunning)
  }
  Write-Host "TASKBAR_PIN_TARGET_COUNT_RUNNING=$($pinnedWhileRunning.Count)"
  if ($pinnedWhileRunning.Count -gt 0) {
    Write-Host "TASKBAR_PIN_ICON_RUNNING=$($pinnedWhileRunning[0].IconLocation)"
    if ([string]::IsNullOrWhiteSpace([string]$pinnedWhileRunning[0].IconLocation)) {
      throw "Running taskbar pin has no icon location"
    }
    if (-not $pinWasPresent) {
      $createdPinPaths = @($pinnedWhileRunning | ForEach-Object { $_.Path })
    }
  }
  if ($RequireTaskbarPin -and $pinnedWhileRunning.Count -eq 0) {
    throw "Pin to taskbar did not create a shortcut targeting $appPath"
  }

  Stop-PortableRun -Wrapper $firstWrapper -Child $firstChild
  $removed = Wait-Until { -not (Test-Path -LiteralPath $appPath) }
  Write-Host "EXTRACTION_REMOVED_AFTER_EXIT=$([bool]$removed)"
  if (-not $removed) { throw "Portable launcher did not remove $appPath after exit" }

  $pinnedWhileStopped = @(
    Get-TaskbarLinks | Where-Object { $_.TargetPath -eq $appPath }
  )
  Write-Host "TASKBAR_PIN_TARGET_COUNT_STOPPED=$($pinnedWhileStopped.Count)"
  if ($pinnedWhileStopped.Count -gt 0) {
    Write-Host "TASKBAR_PIN_ICON_STOPPED=$($pinnedWhileStopped[0].IconLocation)"
  }
  Write-Host "TASKBAR_PIN_MAY_BE_BLANK_WHILE_STOPPED=true"

  # A relaunch verifies the same build; the second package below verifies that
  # a later build also resolves to the explicit unpack path.
  $secondWrapper = Start-Process -FilePath $portablePath -PassThru
  $runs += $secondWrapper
  $secondChild = Wait-Until { Get-PortableProcess $appPath }
  if ($null -eq $secondChild) { throw "Portable app did not recreate $appPath" }
  $childPids += $secondChild.ProcessId
  Write-Host "RELAUNCH_APP_PATH=$($secondChild.ExecutablePath)"
  if ($secondChild.ExecutablePath -ne $appPath) {
    throw "Portable relaunch used an unexpected path: $($secondChild.ExecutablePath)"
  }

  $pinnedAfterRelaunch = @()
  if ($pinCreated) {
    $pinnedAfterRelaunch = Wait-Until {
      $matches = @(Get-TaskbarLinks | Where-Object { $_.TargetPath -eq $appPath })
      if ($matches.Count -gt 0) { return $matches }
      return $null
    }
    $pinnedAfterRelaunch = @($pinnedAfterRelaunch)
  }
  Write-Host "TASKBAR_PIN_TARGET_COUNT_RELAUNCH=$($pinnedAfterRelaunch.Count)"
  if ($pinnedAfterRelaunch.Count -gt 0) {
    Write-Host "TASKBAR_PIN_ICON_RELAUNCH=$($pinnedAfterRelaunch[0].IconLocation)"
  }
  if ($RequireTaskbarPin) {
    if ($pinnedAfterRelaunch.Count -eq 0) {
      throw "Taskbar pin did not resolve after relaunch"
    }
    if ([string]::IsNullOrWhiteSpace([string]$pinnedAfterRelaunch[0].IconLocation)) {
      throw "Taskbar pin has no icon location after relaunch"
    }
  }
  Stop-PortableRun -Wrapper $secondWrapper -Child $secondChild

  $buildBWrapper = Start-Process -FilePath $secondPortablePath -PassThru
  $runs += $buildBWrapper
  $buildBChild = Wait-Until { Get-PortableProcess $appPath }
  if ($null -eq $buildBChild) { throw "Second portable build did not start at $appPath" }
  $childPids += $buildBChild.ProcessId
  Write-Host "SECOND_BUILD_APP_PATH=$($buildBChild.ExecutablePath)"
  if ($buildBChild.ExecutablePath -ne $appPath) {
    throw "Second portable build used an unexpected path: $($buildBChild.ExecutablePath)"
  }
  Stop-PortableRun -Wrapper $buildBWrapper -Child $buildBChild

  # A second wrapper while the first one is alive is intentionally unsupported:
  # both wrappers use the same directory and the second one removes it first.
  $concurrencyWrapper = Start-Process -FilePath $portablePath -PassThru
  $runs += $concurrencyWrapper
  $concurrencyChild = Wait-Until { Get-PortableProcess $appPath }
  if ($null -eq $concurrencyChild) { throw "Concurrency probe could not start the first wrapper" }
  $childPids += $concurrencyChild.ProcessId
  $concurrencyPid = $concurrencyChild.ProcessId
  $concurrencyBeforeHash = (Get-FileHash -LiteralPath $appPath -Algorithm SHA256).Hash
  $probeWrapper = Start-Process -FilePath $secondPortablePath -PassThru
  $runs += $probeWrapper
  $probeExit = Wait-Process -Id $probeWrapper.Id -Timeout 15 -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 3
  $concurrencyAfterPath = Test-Path -LiteralPath $appPath
  $concurrencyAfterHash = ""
  if ($concurrencyAfterPath) {
    try {
      $concurrencyAfterHash = (Get-FileHash -LiteralPath $appPath -Algorithm SHA256).Hash
    } catch {
      Write-Host "CONCURRENT_WRAPPERS_HASH_ERROR=$($_.Exception.Message)"
    }
  }
  $firstProcessAfter = Get-Process -Id $concurrencyPid -ErrorAction SilentlyContinue
  $concurrencyChildren = @(
    Get-CimInstance Win32_Process -Filter "Name = 'PI-Desktop.exe'" |
      Where-Object { $_.ExecutablePath -eq $appPath }
  )
  $concurrencyPathChanged = -not $concurrencyAfterPath -or $concurrencyBeforeHash -ne $concurrencyAfterHash
  Write-Host "CONCURRENT_WRAPPER_EXITED=$([bool]$probeExit)"
  Write-Host "CONCURRENT_WRAPPERS_SHARED_PATH=$concurrencyAfterPath"
  Write-Host "CONCURRENT_WRAPPERS_PATH_CHANGED=$concurrencyPathChanged"
  Write-Host "CONCURRENT_FIRST_PROCESS_ALIVE=$($null -ne $firstProcessAfter)"
  Write-Host "CONCURRENT_APP_PROCESS_COUNT=$($concurrencyChildren.Count)"
  Write-Host "CONCURRENT_WRAPPERS_SUPPORTED=false"
  $probeChild = $concurrencyChildren |
    Where-Object { $_.ProcessId -ne $concurrencyPid } |
    Select-Object -First 1
  if ($null -ne $probeChild) {
    $childPids += $probeChild.ProcessId
  }
  Stop-PortableRun -Wrapper $probeWrapper -Child $probeChild
  Stop-PortableRun -Wrapper $concurrencyWrapper -Child $concurrencyChild
}
finally {
  foreach ($childId in @($childPids | Select-Object -Unique)) {
    Stop-Process -Id $childId -Force -ErrorAction SilentlyContinue
  }
  foreach ($run in $runs) {
    Stop-Process -Id $run.Id -Force -ErrorAction SilentlyContinue
  }
  $cleanupPinPaths = @($createdPinPaths)
  if ($baselinePinsCaptured) {
    try {
      foreach ($link in @(Get-TaskbarLinks | Where-Object { $_.TargetPath -eq $appPath })) {
        if ($baselinePinPaths -notcontains $link.Path) {
          $cleanupPinPaths += $link.Path
        }
      }
    } catch {
      Write-Host "TASKBAR_PIN_CLEANUP_SCAN_ERROR=$($_.Exception.Message)"
    }
  }
  foreach ($pinPath in @($cleanupPinPaths | Select-Object -Unique)) {
    Remove-Item -LiteralPath $pinPath -Force -ErrorAction SilentlyContinue
  }
  Remove-Item -LiteralPath $unpackRoot -Recurse -Force -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $unpackRoot) {
    Write-Host "PORTABLE_CLEANUP_WARNING=extraction directory remains after cleanup"
  }
}

Write-Host "WINDOWS_PORTABLE_E2E=PASS"
