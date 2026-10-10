param(
  [Parameter(Mandatory = $true)][int]$targetProcessId,
  [Parameter(Mandatory = $true)][string]$windowTitle,
  [Parameter(Mandatory = $true)][int]$cornerRadius,
  [Parameter(Mandatory = $true)][string]$backdropColor,
  [Parameter(Mandatory = $true)][string]$screenshotPath
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public struct SurfaceRect { public int Left; public int Top; public int Right; public int Bottom; }
public static class SurfaceProbe {
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string className, string windowName);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out SurfaceRect rect);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("dwmapi.dll")] public static extern int DwmFlush();
}
'@

[void][SurfaceProbe]::SetThreadDpiAwarenessContext([IntPtr](-4))
$window = [SurfaceProbe]::FindWindow($null, $windowTitle)
if ($window -eq [IntPtr]::Zero) { throw "Cannot find surface fixture window: $windowTitle" }
$ownerProcessId = [uint32]0
[void][SurfaceProbe]::GetWindowThreadProcessId($window, [ref]$ownerProcessId)
if ($ownerProcessId -ne $targetProcessId) { throw 'Surface fixture window belongs to another process' }
[void][SurfaceProbe]::SetForegroundWindow($window)
if ([SurfaceProbe]::GetForegroundWindow() -ne $window) {
  throw 'Surface fixture window is not foreground'
}
[void][SurfaceProbe]::DwmFlush()

$rect = [SurfaceRect]::new()
if (-not [SurfaceProbe]::GetWindowRect($window, [ref]$rect)) { throw 'Cannot read surface fixture bounds' }
$dpi = [SurfaceProbe]::GetDpiForWindow($window)
if ($dpi -eq 0) { throw 'Cannot read surface fixture DPI' }
$scaleFactor = $dpi / 96.0
$radiusPixels = $cornerRadius * $scaleFactor
$windowWidth = $rect.Right - $rect.Left
$windowHeight = $rect.Bottom - $rect.Top

function Convert-HexColor([string]$value) {
  if ($value -notmatch '^#?([0-9a-fA-F]{6})$') { throw "Invalid probe color: $value" }
  $hex = $Matches[1]
  return [System.Drawing.Color]::FromArgb(
    [Convert]::ToInt32($hex.Substring(0, 2), 16),
    [Convert]::ToInt32($hex.Substring(2, 2), 16),
    [Convert]::ToInt32($hex.Substring(4, 2), 16)
  )
}

function Test-ColorNear($actual, $expected, [int]$tolerance) {
  return [Math]::Abs($actual.R - $expected.R) -le $tolerance -and
    [Math]::Abs($actual.G - $expected.G) -le $tolerance -and
    [Math]::Abs($actual.B - $expected.B) -le $tolerance
}

function Test-ColorBlend($actual, $foreground, $background, [int]$tolerance) {
  foreach ($channel in @('R', 'G', 'B')) {
    $minimum = [Math]::Min($foreground.$channel, $background.$channel) - $tolerance
    $maximum = [Math]::Max($foreground.$channel, $background.$channel) + $tolerance
    if ($actual.$channel -lt $minimum -or $actual.$channel -gt $maximum) { return $false }
  }
  return $true
}

$backdrop = Convert-HexColor $backdropColor
$lightContent = Convert-HexColor '#f6f6f6'
$darkContent = Convert-HexColor '#181818'
$childContent = Convert-HexColor '#d61f69'
$childInset = [int][Math]::Round(48 * $scaleFactor)
$extent = [int][Math]::Ceiling($radiusPixels + 3)
$boundaryTolerance = [Math]::Max(1.25, $scaleFactor * 0.75)
$colorTolerance = 3
$results = @{}
$mismatches = [System.Collections.Generic.List[object]]::new()
$totalMismatches = 0
$edgeBlendPixels = 0
$insideSamples = 0
$outsideSamples = 0
$bitmap = [System.Drawing.Bitmap]::new($windowWidth, $windowHeight)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
try {
  $graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bitmap.Size, [System.Drawing.CopyPixelOperation]::SourceCopy)
  $bitmap.Save($screenshotPath, [System.Drawing.Imaging.ImageFormat]::Png)

  foreach ($corner in @('topLeft', 'topRight', 'bottomLeft', 'bottomRight')) {
    $cornerMismatches = 0
    $cornerBlends = 0
    for ($localY = 0; $localY -le $extent; $localY += 1) {
      for ($localX = 0; $localX -le $extent; $localX += 1) {
        $fromLeft = $localX
        $fromTop = $localY
        if ($corner -eq 'topRight' -or $corner -eq 'bottomRight') { $fromLeft = $windowWidth - 1 - $localX }
        if ($corner -eq 'bottomLeft' -or $corner -eq 'bottomRight') { $fromTop = $windowHeight - 1 - $localY }

        $pixelX = $localX + 0.5
        $pixelY = $localY + 0.5
        if ($cornerRadius -eq 0 -or $pixelX -ge $radiusPixels -or $pixelY -ge $radiusPixels) {
          $insideCurve = $true
          $boundaryDistance = [double]::PositiveInfinity
        } else {
          $dx = $radiusPixels - $pixelX
          $dy = $radiusPixels - $pixelY
          $distance = [Math]::Sqrt($dx * $dx + $dy * $dy)
          $insideCurve = $distance -lt $radiusPixels
          $boundaryDistance = [Math]::Abs($distance - $radiusPixels)
        }

        $actual = $bitmap.GetPixel($fromLeft, $fromTop)
        if (-not $insideCurve) {
          $outsideSamples += 1
          $valid = Test-ColorNear $actual $backdrop $colorTolerance
        } else {
          $insideSamples += 1
          if ($fromLeft -ge ($windowWidth - $childInset) -and $fromTop -ge ($windowHeight - $childInset)) {
            $foreground = $childContent
          } elseif ($fromLeft -lt ($windowWidth / 2)) {
            $foreground = $lightContent
          } else {
            $foreground = $darkContent
          }
          if ($boundaryDistance -le $boundaryTolerance) {
            $valid = Test-ColorBlend $actual $foreground $backdrop $colorTolerance
            if ($valid -and -not (Test-ColorNear $actual $foreground $colorTolerance) -and
              -not (Test-ColorNear $actual $backdrop $colorTolerance)) {
              $cornerBlends += 1
              $edgeBlendPixels += 1
            }
          } else {
            $valid = Test-ColorNear $actual $foreground $colorTolerance
          }
        }

        if (-not $valid) {
          $cornerMismatches += 1
          if ($mismatches.Count -lt 32) {
            $mismatches.Add(@{
              corner = $corner
              x = $fromLeft
              y = $fromTop
              expectedSurface = if ($insideCurve) { 'content' } else { 'backdrop' }
              actual = "#$($actual.R.ToString('X2'))$($actual.G.ToString('X2'))$($actual.B.ToString('X2'))"
            })
          }
        }
      }
    }
    $results[$corner] = @{ mismatches = $cornerMismatches; edgeBlendPixels = $cornerBlends }
    $totalMismatches += $cornerMismatches
  }
} finally {
  $graphics.Dispose()
  $bitmap.Dispose()
}

@{
  dpi = $dpi
  scaleFactor = $scaleFactor
  radiusDip = $cornerRadius
  physicalBounds = @{ width = $windowWidth; height = $windowHeight }
  backdropColor = $backdropColor
  totalMismatches = $totalMismatches
  cornerResults = $results
  insideSamples = $insideSamples
  outsideSamples = $outsideSamples
  edgeBlendPixels = $edgeBlendPixels
  mismatches = @($mismatches)
  screenshotPath = $screenshotPath
} | ConvertTo-Json -Compress -Depth 6
