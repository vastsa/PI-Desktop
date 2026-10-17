function Get-FullscreenProbeGeometry {
  param(
    [int[]]$WindowBounds,
    [int[]]$MonitorBounds,
    [int[]]$TaskbarBounds
  )

  foreach ($bounds in @($WindowBounds, $MonitorBounds, $TaskbarBounds)) {
    if ($bounds.Count -ne 4 -or $bounds[2] -le $bounds[0] -or $bounds[3] -le $bounds[1]) {
      throw 'Window probe requires non-empty screen rectangles'
    }
  }

  # Auto-hidden taskbars can extend beyond the display. Keep the hit-test
  # point on its physical screen, including monitors with negative origins.
  $x = [int][Math]::Floor(($TaskbarBounds[0] + $TaskbarBounds[2]) / 2)
  $y = [int][Math]::Floor(($TaskbarBounds[1] + $TaskbarBounds[3]) / 2)
  @{
    point = @(
      [Math]::Clamp($x, $MonitorBounds[0], $MonitorBounds[2] - 1)
      [Math]::Clamp($y, $MonitorBounds[1], $MonitorBounds[3] - 1)
    )
    coversMonitor = $WindowBounds[0] -le $MonitorBounds[0] -and
      $WindowBounds[1] -le $MonitorBounds[1] -and
      $WindowBounds[2] -ge $MonitorBounds[2] -and
      $WindowBounds[3] -ge $MonitorBounds[3]
  }
}
