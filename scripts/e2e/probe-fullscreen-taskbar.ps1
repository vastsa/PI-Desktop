param([Parameter(Mandatory = $true)][int]$targetProcessId)

$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public struct ProbePoint { public int X; public int Y; }
public struct ProbeRect { public int Left; public int Top; public int Right; public int Bottom; }
public static class WindowProbe {
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string className, string title);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out ProbeRect rect);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(ProbePoint point);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr window, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
'@

$appWindow = [System.Diagnostics.Process]::GetProcessById($targetProcessId).MainWindowHandle
$taskbar = [WindowProbe]::FindWindow('Shell_TrayWnd', $null)
if ($appWindow -eq [IntPtr]::Zero -or $taskbar -eq [IntPtr]::Zero) {
  throw 'Cannot locate the E2E window or taskbar'
}
[void][WindowProbe]::SetForegroundWindow($appWindow)
Start-Sleep -Milliseconds 100
if ([WindowProbe]::GetForegroundWindow() -ne $appWindow) {
  throw 'E2E fullscreen window is not foreground'
}
$taskbarRect = [ProbeRect]::new()
if (-not [WindowProbe]::GetWindowRect($taskbar, [ref]$taskbarRect)) {
  throw 'Cannot inspect taskbar bounds'
}
$appRect = [ProbeRect]::new()
if (-not [WindowProbe]::GetWindowRect($appWindow, [ref]$appRect)) {
  throw 'Cannot inspect fullscreen window bounds'
}
$probe = [ProbePoint]::new()
$probe.X = [int](($taskbarRect.Left + $taskbarRect.Right) / 2)
$probe.Y = [int](($taskbarRect.Top + $taskbarRect.Bottom) / 2)
$hit = [WindowProbe]::GetAncestor([WindowProbe]::WindowFromPoint($probe), 2)
@{
  appCoversTaskbar = $hit -eq $appWindow
  appBounds = @($appRect.Left, $appRect.Top, $appRect.Right, $appRect.Bottom)
  taskbarBounds = @($taskbarRect.Left, $taskbarRect.Top, $taskbarRect.Right, $taskbarRect.Bottom)
  hitRoot = $hit.ToInt64()
  appWindow = $appWindow.ToInt64()
} | ConvertTo-Json -Compress
