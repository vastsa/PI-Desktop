param([Parameter(Mandatory = $true)][int]$targetProcessId)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'window-probe-geometry.ps1')
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public struct ProbePoint { public int X; public int Y; }
public struct ProbeRect { public int Left; public int Top; public int Right; public int Bottom; }
public struct ProbeMonitorInfo { public int Size; public ProbeRect Monitor; public ProbeRect Work; public uint Flags; }
public static class WindowProbe {
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string className, string title);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out ProbeRect rect);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(ProbePoint point);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr window, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);
  [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr monitor, ref ProbeMonitorInfo info);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
}
'@

[void][WindowProbe]::SetThreadDpiAwarenessContext([IntPtr](-4))
$appWindow = [System.Diagnostics.Process]::GetProcessById($targetProcessId).MainWindowHandle
$taskbar = [WindowProbe]::FindWindow('Shell_TrayWnd', $null)
if ($appWindow -eq [IntPtr]::Zero -or $taskbar -eq [IntPtr]::Zero) {
  throw 'Cannot locate the E2E window or taskbar'
}
[void][WindowProbe]::SetForegroundWindow($appWindow)
$focusDeadline = [DateTime]::UtcNow.AddSeconds(5)
while ([WindowProbe]::GetForegroundWindow() -ne $appWindow) {
  if ([DateTime]::UtcNow -gt $focusDeadline) { throw 'E2E window did not become foreground' }
  Start-Sleep -Milliseconds 25
}
$taskbarRect = [ProbeRect]::new()
if (-not [WindowProbe]::GetWindowRect($taskbar, [ref]$taskbarRect)) {
  throw 'Cannot inspect taskbar bounds'
}
$appRect = [ProbeRect]::new()
if (-not [WindowProbe]::GetWindowRect($appWindow, [ref]$appRect)) {
  throw 'Cannot inspect fullscreen window bounds'
}
$monitor = [WindowProbe]::MonitorFromWindow($appWindow, 2)
if ([WindowProbe]::MonitorFromWindow($taskbar, 2) -ne $monitor) {
  throw 'The fullscreen taskbar probe requires the app and taskbar on the same monitor'
}
$monitorInfo = [ProbeMonitorInfo]::new()
$monitorInfo.Size = [Runtime.InteropServices.Marshal]::SizeOf($monitorInfo)
if (-not [WindowProbe]::GetMonitorInfo($monitor, [ref]$monitorInfo)) {
  throw 'Cannot inspect fullscreen monitor bounds'
}
$monitorRect = $monitorInfo.Monitor
$appBounds = @($appRect.Left, $appRect.Top, $appRect.Right, $appRect.Bottom)
$taskbarBounds = @($taskbarRect.Left, $taskbarRect.Top, $taskbarRect.Right, $taskbarRect.Bottom)
$monitorBounds = @($monitorRect.Left, $monitorRect.Top, $monitorRect.Right, $monitorRect.Bottom)
$geometry = Get-FullscreenProbeGeometry $appBounds $monitorBounds $taskbarBounds
$probe = [ProbePoint]::new()
$probe.X = $geometry.point[0]
$probe.Y = $geometry.point[1]
$hit = [WindowProbe]::GetAncestor([WindowProbe]::WindowFromPoint($probe), 2)
@{
  monitorId = $monitor.ToInt64().ToString()
  appCoversTaskbar = $geometry.coversMonitor -and $hit -eq $appWindow
  appBounds = $appBounds
  taskbarBounds = $taskbarBounds
  monitorBounds = $monitorBounds
  probePoint = $geometry.point
  hitRoot = $hit.ToInt64()
  appWindow = $appWindow.ToInt64()
} | ConvertTo-Json -Compress
