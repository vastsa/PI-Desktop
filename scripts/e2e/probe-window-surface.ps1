param(
  [Parameter(Mandatory = $true)][int]$targetProcessId,
  [Parameter(Mandatory = $true)][long]$nativeHandle,
  [Parameter(Mandatory = $true)][int]$cornerRadius,
  [Parameter(Mandatory = $true)][string]$backdropColor,
  [Parameter(Mandatory = $true)][string]$screenshotPath,
  [switch]$nativeRectangle
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public struct SurfaceRect { public int Left; public int Top; public int Right; public int Bottom; }
public struct SurfacePoint { public int X; public int Y; }
public static class SurfaceProbe {
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out SurfaceRect rect);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr window, out SurfaceRect rect);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr window, ref SurfacePoint point);
  [DllImport("user32.dll")] public static extern int GetWindowRgn(IntPtr window, IntPtr region);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr window, int index);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateRectRgn(int l, int t, int r, int b);
  [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr region);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("dwmapi.dll")] public static extern int DwmFlush();
  [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")] public static extern int GetFrameBounds(IntPtr window, int attribute, out SurfaceRect rect, int size);
  [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")] public static extern int GetBorderWidth(IntPtr window, int attribute, out uint width, int size);
}
'@

[void][SurfaceProbe]::SetThreadDpiAwarenessContext([IntPtr](-4))
$window = [IntPtr]$nativeHandle
if ($window -eq [IntPtr]::Zero) { throw 'Surface fixture handle is unavailable' }
$ownerProcessId = [uint32]0
[void][SurfaceProbe]::GetWindowThreadProcessId($window, [ref]$ownerProcessId)
if ($ownerProcessId -ne $targetProcessId) { throw 'Surface fixture window belongs to another process' }
[void][SurfaceProbe]::SetForegroundWindow($window)
$focusDeadline = [DateTime]::UtcNow.AddSeconds(5)
while ([SurfaceProbe]::GetForegroundWindow() -ne $window) {
  if ([DateTime]::UtcNow -gt $focusDeadline) { throw 'Surface fixture window is not foreground' }
  Start-Sleep -Milliseconds 25
}
[void][SurfaceProbe]::DwmFlush()

$rect = [SurfaceRect]::new()
if (-not [SurfaceProbe]::GetWindowRect($window, [ref]$rect)) { throw 'Cannot read surface fixture bounds' }
$dpi = [SurfaceProbe]::GetDpiForWindow($window)
if ($dpi -eq 0) { throw 'Cannot read surface fixture DPI' }
$scaleFactor = $dpi / 96.0
$windowsBuild = [Environment]::OSVersion.Version.Build
$nativeDwm = $windowsBuild -ge 22000 -and -not $nativeRectangle
$cornerMode = if ($nativeDwm) { 'dwm-native' } else { 'native-rectangular' }
$nativeRegionAbsent = $null
$edgeSamples = 0
$thickFrameStyle = ([SurfaceProbe]::GetWindowLong($window, -16) -band 0x00040000) -ne 0
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
$windowBackground = if ($nativeDwm) {
  Convert-HexColor '#7f7f7f'
} else {
  Convert-HexColor '#fafafa'
}
$childInset = [int][Math]::Round(48 * $scaleFactor)
$backgroundHalfWidth = [int][Math]::Ceiling(24 * $scaleFactor)
$extent = [int][Math]::Ceiling(24 * $scaleFactor + 3)
$colorTolerance = 3
$results = @{}
$mismatches = [System.Collections.Generic.List[object]]::new()
$totalMismatches = 0
$edgeBlendPixels = 0
$nativeBackgroundSample = $null
$borderWidth = [uint32]0
$cornerPreference = [uint32]0
$visibleFrame = [SurfaceRect]::new()
if ($nativeDwm -and (
    [SurfaceProbe]::GetFrameBounds($window, 9, [ref]$visibleFrame, 16) -ne 0 -or
    [SurfaceProbe]::GetBorderWidth($window, 37, [ref]$borderWidth, 4) -ne 0 -or
    [SurfaceProbe]::GetBorderWidth($window, 33, [ref]$cornerPreference, 4) -ne 0)) {
  throw 'Cannot inspect the native DWM frame'
}
$insideSamples = 0
$outsideSamples = 0
$bitmap = [System.Drawing.Bitmap]::new($windowWidth, $windowHeight)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
try {
  $graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bitmap.Size, [System.Drawing.CopyPixelOperation]::SourceCopy)
  $bitmap.Save($screenshotPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $client = [SurfaceRect]::new()
  $origin = [SurfacePoint]::new()
  if (-not [SurfaceProbe]::GetClientRect($window, [ref]$client) -or
      -not [SurfaceProbe]::ClientToScreen($window, [ref]$origin)) { throw 'Cannot read client bounds' }
  $clientX = $origin.X - $rect.Left
  $clientY = $origin.Y - $rect.Top
  if (-not $nativeDwm) {
    $region = [SurfaceProbe]::CreateRectRgn(0, 0, 0, 0)
    try { $nativeRegionAbsent = [SurfaceProbe]::GetWindowRgn($window, $region) -eq 0 }
    finally { [void][SurfaceProbe]::DeleteObject($region) }
    # Sample just inside each client edge, beyond any OS corner radius. A
    # content-sized HWND region used to truncate the right and bottom samples.
    $samples = @(
      @{ name = 'left'; x = 2; y = [int]($client.Bottom / 2); color = $lightContent },
      @{ name = 'right'; x = $client.Right - 3; y = [int]($client.Bottom / 2); color = $darkContent },
      @{ name = 'top'; x = [int]($client.Right / 4); y = 2; color = $lightContent },
      @{ name = 'bottom'; x = [int]($client.Right / 4); y = $client.Bottom - 3; color = $lightContent }
    )
    foreach ($sample in $samples) {
      $actual = $bitmap.GetPixel($clientX + $sample.x, $clientY + $sample.y)
      $edgeSamples += 1
      if (Test-ColorNear $actual $sample.color $colorTolerance) { $insideSamples += 1 }
      else {
        $totalMismatches += 1
        $mismatches.Add(@{ edge = $sample.name; actual = $actual.Name })
      }
    }
  }
  if ($nativeDwm) {
    $backgroundPixel = $bitmap.GetPixel($clientX + [int][Math]::Floor($client.Right / 2), $clientY + [int][Math]::Floor($client.Bottom / 2))
    $nativeBackgroundSample = Test-ColorNear $backgroundPixel ([System.Drawing.Color]::FromArgb(127, 127, 127)) $colorTolerance
    # DWM owns the border pixels and can tint them from the desktop wallpaper.
    # Its measured outline is separate from the app's client color contract.
    $frameLeft = $visibleFrame.Left - $rect.Left
    $frameTop = $visibleFrame.Top - $rect.Top
    $frameRight = $visibleFrame.Right - $rect.Left
    $frameBottom = $visibleFrame.Bottom - $rect.Top
  }

  $corners = if ($nativeDwm) { @('topLeft', 'topRight', 'bottomLeft', 'bottomRight') } else { @() }
  foreach ($corner in $corners) {
    $cornerMismatches = 0
    $cornerBlends = 0
    $cornerInside = 0
    $cornerOutside = 0
    $cornerFrame = 0
    for ($localY = 0; $localY -le $extent; $localY += 1) {
      for ($localX = 0; $localX -le $extent; $localX += 1) {
        $fromLeft = $clientX + $localX
        $fromTop = $clientY + $localY
        if ($corner -eq 'topRight' -or $corner -eq 'bottomRight') { $fromLeft = $clientX + $client.Right - 1 - $localX }
        if ($corner -eq 'bottomLeft' -or $corner -eq 'bottomRight') { $fromTop = $clientY + $client.Bottom - 1 - $localY }

        $pixelX = $localX + 0.5
        $pixelY = $localY + 0.5
        $actual = $bitmap.GetPixel($fromLeft, $fromTop)
        if ($fromLeft -ge ($clientX + $client.Right - $childInset) -and $fromTop -ge ($clientY + $client.Bottom - $childInset)) {
          $foreground = $childContent
        } elseif ([Math]::Abs(($fromLeft - $clientX + 0.5) - ($client.Right / 2)) -lt $backgroundHalfWidth) {
          $foreground = $windowBackground
        } elseif ($fromLeft -lt ($clientX + $client.Right / 2)) {
          $foreground = $lightContent
        } else {
          $foreground = $darkContent
        }

        if ($nativeDwm) {
          $nearForeground = Test-ColorNear $actual $foreground $colorTolerance
          $nearBackdrop = Test-ColorNear $actual $backdrop $colorTolerance
          $isBlend = (Test-ColorBlend $actual $foreground $backdrop $colorTolerance) -and
            -not $nearForeground -and -not $nearBackdrop
          if ($nearForeground) {
            $insideSamples += 1
            $cornerInside += 1
            $valid = $true
          } elseif ($cornerRadius -gt 0 -and $nearBackdrop) {
            $outsideSamples += 1
            $cornerOutside += 1
            $valid = $true
          } elseif ($cornerRadius -gt 0 -and $isBlend) {
            $cornerBlends += 1
            $edgeBlendPixels += 1
            $valid = $true
          } else {
            $valid = $false
            if ($borderWidth -gt 0) {
              $reach = [int]$borderWidth + 1
              $atOutline = $fromLeft - $frameLeft -le $reach -or
                $frameRight - 1 - $fromLeft -le $reach -or
                $fromTop - $frameTop -le $reach -or
                $frameBottom - 1 - $fromTop -le $reach
              # A curved border must touch the exterior within its measured
              # thickness; unrelated dark bands in the content still fail.
              if (-not $atOutline -and $cornerRadius -gt 0) {
                for ($dy = -$reach; $dy -le $reach -and -not $atOutline; $dy++) {
                  for ($dx = -$reach; $dx -le $reach; $dx++) {
                    $sampleX = [Math]::Clamp($fromLeft + $dx, 0, $windowWidth - 1)
                    $sampleY = [Math]::Clamp($fromTop + $dy, 0, $windowHeight - 1)
                    if (Test-ColorNear ($bitmap.GetPixel($sampleX, $sampleY)) $backdrop $colorTolerance) {
                      $atOutline = $true
                      break
                    }
                  }
                }
              }
              if ($atOutline) {
                $valid = $true
                $cornerFrame += 1
              }
            }
          }
          $insideCurve = $nearForeground
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
    $results[$corner] = @{
      mismatches = $cornerMismatches; edgeBlendPixels = $cornerBlends
      insideSamples = $cornerInside; outsideSamples = $cornerOutside; nativeFrameSamples = $cornerFrame
    }
    $totalMismatches += $cornerMismatches
  }
} finally {
  $graphics.Dispose()
  $bitmap.Dispose()
}

@{
  dpi = $dpi
  scaleFactor = $scaleFactor
  windowsBuild = $windowsBuild
  cornerMode = $cornerMode
  nativeBackgroundSample = $nativeBackgroundSample
  nativeBorderWidth = $borderWidth
  nativeCornerPreference = $cornerPreference
  nativeRegionAbsent = $nativeRegionAbsent
  thickFrameStyle = $thickFrameStyle
  edgeSamples = $edgeSamples
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
