param(
  [Parameter(Mandatory = $true)][int]$targetProcessId,
  [Parameter(Mandatory = $true)][int]$cornerRadius
)

$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public struct CornerPoint { public int X; public int Y; }
public struct CornerRect { public int Left; public int Top; public int Right; public int Bottom; }
public static class CornerProbe {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out CornerRect rect);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr window, int index);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(CornerPoint point);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr window, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
}
'@

[void][CornerProbe]::SetThreadDpiAwarenessContext([IntPtr](-4))
$appWindow = [System.Diagnostics.Process]::GetProcessById($targetProcessId).MainWindowHandle
if ($appWindow -eq [IntPtr]::Zero) { throw 'E2E main window is unavailable' }
[void][CornerProbe]::SetForegroundWindow($appWindow)
Start-Sleep -Milliseconds 60
if ([CornerProbe]::GetForegroundWindow() -ne $appWindow) {
  throw 'E2E main window is not foreground'
}
$rect = [CornerRect]::new()
if (-not [CornerProbe]::GetWindowRect($appWindow, [ref]$rect)) { throw 'Cannot read E2E window bounds' }
$dpi = [CornerProbe]::GetDpiForWindow($appWindow)
if ($dpi -eq 0) { throw 'Cannot read E2E window DPI' }
$scaleFactor = $dpi / 96.0
$windowsBuild = [Environment]::OSVersion.Version.Build
$nativeDwm = $windowsBuild -ge 22000
$radiusPixels = $cornerRadius * $scaleFactor

function Test-AppAt([int]$pointX, [int]$pointY) {
  $point = [CornerPoint]::new()
  $point.X = $pointX
  $point.Y = $pointY
  return [CornerProbe]::GetAncestor([CornerProbe]::WindowFromPoint($point), 2) -eq $appWindow
}

function Test-CornerGrid([string]$corner) {
  $mismatches = 0
  $insideSamples = 0
  $outsideSamples = 0
  $observedWindowSamples = 0
  $observedOutsideSamples = 0
  $extent = [int][Math]::Ceiling($radiusPixels + 3)
  # The conservative integer-DIP hit region includes the rasterized AA edge;
  # scale the ignored fringe to physical pixels for high-DPI displays.
  $boundaryTolerance = 1.5 * $scaleFactor
  for ($localY = 0; $localY -le $extent; $localY += 1) {
    for ($localX = 0; $localX -le $extent; $localX += 1) {
      $pixelX = $localX + 0.5
      $pixelY = $localY + 0.5

      if ($cornerRadius -eq 0 -or $pixelX -ge $radiusPixels -or $pixelY -ge $radiusPixels) {
        $expectedInside = $true
        $boundaryDistance = [double]::PositiveInfinity
      } else {
        $dx = $radiusPixels - $pixelX
        $dy = $radiusPixels - $pixelY
        $distance = [Math]::Sqrt($dx * $dx + $dy * $dy)
        $boundaryDistance = [Math]::Abs($distance - $radiusPixels)
        $expectedInside = $distance -lt $radiusPixels
      }

      # Ignore the one-pixel AA fringe, but prove that the inner corner is
      # reachable and that points fully outside the curve fall through.
      if ($boundaryDistance -le $boundaryTolerance) { continue }
      $screenX = $rect.Left + [int][Math]::Floor($pixelX)
      $screenY = $rect.Top + [int][Math]::Floor($pixelY)
      if ($corner -eq 'topRight' -or $corner -eq 'bottomRight') {
        $screenX = $rect.Right - 1 - $localX
      }
      if ($corner -eq 'bottomLeft' -or $corner -eq 'bottomRight') {
        $screenY = $rect.Bottom - 1 - $localY
      }
      $actualInside = Test-AppAt $screenX $screenY
      if ($actualInside) { $observedWindowSamples += 1 } else { $observedOutsideSamples += 1 }
      if ($expectedInside) { $insideSamples += 1 } else { $outsideSamples += 1 }
      if ($actualInside -ne $expectedInside) { $mismatches += 1 }
    }
  }
  return @{
    mismatches = $mismatches
    insideSamples = $insideSamples
    outsideSamples = $outsideSamples
    observedWindowSamples = $observedWindowSamples
    observedOutsideSamples = $observedOutsideSamples
  }
}

$topLeftCutout = -not (Test-AppAt $rect.Left $rect.Top)
$topRightCutout = -not (Test-AppAt ($rect.Right - 1) $rect.Top)
$bottomLeftCutout = -not (Test-AppAt $rect.Left ($rect.Bottom - 1))
$bottomRightCutout = -not (Test-AppAt ($rect.Right - 1) ($rect.Bottom - 1))
$innerOffset = [int][Math]::Ceiling($radiusPixels) + 2
$innerCornerOwned = Test-AppAt ($rect.Left + $innerOffset) ($rect.Top + $innerOffset)
$grid = @{}
$gridMismatches = 0
$insideSamples = 0
$outsideSamples = 0
foreach ($corner in @('topLeft', 'topRight', 'bottomLeft', 'bottomRight')) {
  $result = Test-CornerGrid $corner
  $grid[$corner] = $result
  $gridMismatches += $result.mismatches
  $insideSamples += $result.insideSamples
  $outsideSamples += $result.outsideSamples
}

@{
  topLeftCutout = $topLeftCutout
  topRightCutout = $topRightCutout
  bottomLeftCutout = $bottomLeftCutout
  bottomRightCutout = $bottomRightCutout
  innerCornerOwned = $innerCornerOwned
  thickFrameStyle = ([CornerProbe]::GetWindowLong($appWindow, -16) -band 0x00040000) -ne 0
  windowsBuild = $windowsBuild
  cornerMode = if ($nativeDwm) { 'dwm-native' } else { 'legacy-shape' }
  dpi = $dpi
  scaleFactor = $scaleFactor
  radiusDip = $cornerRadius
  physicalBounds = @{ width = $rect.Right - $rect.Left; height = $rect.Bottom - $rect.Top }
  gridMismatches = $gridMismatches
  insideSamples = $insideSamples
  outsideSamples = $outsideSamples
  nativeHitSampleCount = ($grid.Values | ForEach-Object { $_.observedWindowSamples } | Measure-Object -Sum).Sum
  nativeOutsideSampleCount = ($grid.Values | ForEach-Object { $_.observedOutsideSamples } | Measure-Object -Sum).Sum
  nativeCornerHitBehavior = $grid
  corners = $grid
} | ConvertTo-Json -Compress -Depth 5
