import AppKit
import CoreGraphics

// Post native input only while the isolated Electron fixture owns the desktop.
let arguments = CommandLine.arguments.dropFirst()
guard arguments.count == 6 else { exit(2) }
let values = Array(arguments)
guard let pid = Int32(values[0]),
      let fromX = Double(values[1]), let fromY = Double(values[2]),
      let toX = Double(values[3]), let toY = Double(values[4]),
      CGPreflightPostEventAccess() else {
    fputs("Native drag requires valid fixture bounds and macOS event-post access.\n", stderr)
    exit(2)
}
for _ in 0..<20 {
    if NSWorkspace.shared.frontmostApplication?.processIdentifier == pid { break }
    usleep(50_000)
}
guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else {
    fputs("Native drag requires the isolated fixture to be foregrounded.\n", stderr)
    exit(2)
}

let originalPointer = CGEvent(source: nil)!.location
defer { CGWarpMouseCursorPosition(originalPointer) }
let source = CGPoint(x: fromX, y: fromY)
let target = CGPoint(x: toX, y: toY)

func mouse(_ type: CGEventType, _ point: CGPoint) {
    CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: .left)!
        .post(tap: .cghidEventTap)
}

mouse(.mouseMoved, source)
usleep(80_000)
mouse(.leftMouseDown, source)
usleep(80_000)
for step in 1...30 {
    let progress = Double(step) / 30
    mouse(.leftMouseDragged, CGPoint(
        x: fromX + (toX - fromX) * progress,
        y: fromY + (toY - fromY) * progress
    ))
    usleep(20_000)
}
usleep(180_000)
if values[5] == "cancel" {
    for keyDown in [true, false] {
        CGEvent(keyboardEventSource: nil, virtualKey: 53, keyDown: keyDown)!.post(tap: .cghidEventTap)
    }
    usleep(100_000)
}
mouse(.leftMouseUp, target)
// AppKit consumes the queued mouse-up before the pointer is restored.
usleep(250_000)
