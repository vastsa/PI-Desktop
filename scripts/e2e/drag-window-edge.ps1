param(
  [Parameter(Mandatory = $true)][int]$targetProcessId,
  [Parameter(Mandatory = $true)][ValidateSet('right', 'left', 'bottom', 'bottom-left', 'left-min', 'bottom-min')][string]$edge
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public struct NativePoint { public int X; public int Y; }
public struct NativeRect { public int Left; public int Top; public int Right; public int Bottom; }
public static class NativePointer {
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out NativePoint point);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out NativeRect rect);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
}
'@

$targetProcess = [System.Diagnostics.Process]::GetProcessById($targetProcessId)
$windowHandle = $targetProcess.MainWindowHandle
if ($windowHandle -eq [IntPtr]::Zero) { throw 'E2E main window is unavailable' }

$before = [NativeRect]::new()
$savedCursor = [NativePoint]::new()
if (-not [NativePointer]::GetWindowRect($windowHandle, [ref]$before)) { throw 'Cannot read E2E window bounds' }
$cursorSaved = $false
foreach ($attempt in 1..3) {
  if ([NativePointer]::GetCursorPos([ref]$savedCursor)) { $cursorSaved = $true; break }
  Start-Sleep -Milliseconds 50
}
if (-not $cursorSaved) { throw 'Cannot save pointer position' }
[void][NativePointer]::SetForegroundWindow($windowHandle)
Start-Sleep -Milliseconds 100
if ([NativePointer]::GetForegroundWindow() -ne $windowHandle) {
  throw 'E2E window could not receive foreground input'
}

$startX = [int](($before.Left + $before.Right) / 2)
$startY = [int](($before.Top + $before.Bottom) / 2)
$deltaX = 0
$deltaY = 0
switch ($edge) {
  'right' { $startX = $before.Right - 1; $deltaX = 100 }
  'left' { $startX = $before.Left + 1; $deltaX = 50 }
  'left-min' { $startX = $before.Left + 1; $deltaX = 600 }
  'bottom' { $startY = $before.Bottom - 1; $deltaY = -40 }
  'bottom-min' { $startY = $before.Bottom - 1; $deltaY = -350 }
  'bottom-left' {
    $startX = $before.Left + 3
    $startY = $before.Bottom - 3
    $deltaX = 30
    $deltaY = -30
  }
}
$pressed = $false
try {
  if (-not [NativePointer]::SetCursorPos($startX, $startY)) { throw 'Cannot position the E2E pointer' }
  Start-Sleep -Milliseconds 80
  [NativePointer]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  $pressed = $true
  Start-Sleep -Milliseconds 30
  if (([int][NativePointer]::GetAsyncKeyState(0x01) -band 0x8000) -eq 0) {
    throw 'E2E mouse down was not registered'
  }
  foreach ($step in 1..5) {
    $moved = [NativePointer]::SetCursorPos(
      [int]($startX + $deltaX * $step / 5),
      [int]($startY + $deltaY * $step / 5)
    )
    if (-not $moved) { throw 'E2E pointer movement was denied' }
    Start-Sleep -Milliseconds 50
  }
  $cursorAtRelease = [NativePoint]::new()
  if (-not [NativePointer]::GetCursorPos([ref]$cursorAtRelease)) {
    throw 'Cannot read the E2E release pointer'
  }
  if ([NativePointer]::GetForegroundWindow() -ne $windowHandle) {
    throw 'E2E window lost foreground during the drag'
  }
} finally {
  if ($pressed) { [NativePointer]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero) }
  [void][NativePointer]::SetCursorPos($savedCursor.X, $savedCursor.Y)
}

Start-Sleep -Milliseconds 100
$after = [NativeRect]::new()
if (-not [NativePointer]::GetWindowRect($windowHandle, [ref]$after)) { throw 'Cannot read resized E2E window bounds' }
$restored = [NativePointer]::SetWindowPos(
  $windowHandle, [IntPtr]::Zero, $before.Left, $before.Top,
  $before.Right - $before.Left, $before.Bottom - $before.Top, 0x0014
)
@{
  restored = $restored
  beforeWidth = $before.Right - $before.Left
  afterWidth = $after.Right - $after.Left
  beforeHeight = $before.Bottom - $before.Top
  afterHeight = $after.Bottom - $after.Top
  beforeX = $before.Left
  afterX = $after.Left
  beforeY = $before.Top
  afterY = $after.Top
  cursorDeltaX = $cursorAtRelease.X - $startX
  cursorDeltaY = $cursorAtRelease.Y - $startY
} | ConvertTo-Json -Compress
