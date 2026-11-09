import AppKit
import CoreGraphics
import Foundation

func number(_ value: Any?) -> Double? {
    if let n = value as? NSNumber { return n.doubleValue }
    return nil
}

let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
let reasonWindows = windows.compactMap { window -> (Double, [String: Any])? in
    guard (window[kCGWindowOwnerName as String] as? String) == "Reason",
          let bounds = window[kCGWindowBounds as String] as? [String: Any],
          let width = number(bounds["Width"]),
          let height = number(bounds["Height"]),
          let id = number(window[kCGWindowNumber as String]) else { return nil }
    return (width * height, ["id": id, "x": number(bounds["X"]) ?? 0, "y": number(bounds["Y"]) ?? 0, "width": width, "height": height])
}.sorted { $0.0 > $1.0 }

guard let best = reasonWindows.first else {
    FileHandle.standardError.write(Data("Reason main window is not visible.\n".utf8))
    exit(1)
}
let screen = NSScreen.main?.frame ?? .zero
var result = best.1
result["screenWidth"] = screen.width
result["screenHeight"] = screen.height
let data = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
print(String(data: data, encoding: .utf8) ?? "{}")
