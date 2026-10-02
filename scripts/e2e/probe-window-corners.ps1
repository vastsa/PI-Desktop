param([Parameter(Mandatory = $true)][int]$targetProcessId)

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
}
'@

$appWindow = [System.Diagnostics.Process]::GetProcessById($targetProcessId).MainWindowHandle
if ($appWindow -eq [IntPtr]::Zero) { throw 'E2E main window is unavailable' }
[void][CornerProbe]::SetForegroundWindow($appWindow)
Start-Sleep -Milliseconds 60
if ([CornerProbe]::GetForegroundWindow() -ne $appWindow) {
  throw 'E2E main window is not foreground'
}
$rect = [CornerRect]::new()
if (-not [CornerProbe]::GetWindowRect($appWindow, [ref]$rect)) { throw 'Cannot read E2E window bounds' }

function Test-AppAt([int]$pointX, [int]$pointY) {
  $point = [CornerPoint]::new()
  $point.X = $pointX
  $point.Y = $pointY
  return [CornerProbe]::GetAncestor([CornerProbe]::WindowFromPoint($point), 2) -eq $appWindow
}

@{
  topLeftCutout = -not (Test-AppAt $rect.Left $rect.Top)
  bottomRightCutout = -not (Test-AppAt ($rect.Right - 1) ($rect.Bottom - 1))
  innerCornerOwned = Test-AppAt ($rect.Left + 4) ($rect.Top + 4)
  thickFrameStyle = ([CornerProbe]::GetWindowLong($appWindow, -16) -band 0x00040000) -ne 0
} | ConvertTo-Json -Compress
