import ApplicationServices
import AppKit
import Foundation

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

func axValue(_ element: AXUIElement, _ attribute: CFString) -> Any? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success else { return nil }
    return value
}

func stringValue(_ element: AXUIElement, _ attribute: CFString) -> String? {
    axValue(element, attribute) as? String
}

func children(_ element: AXUIElement) -> [AXUIElement] {
    (axValue(element, kAXChildrenAttribute as CFString) as? [AXUIElement]) ?? []
}

func descendants(_ element: AXUIElement, depth: Int = 0) -> [AXUIElement] {
    guard depth < 16 else { return [] }
    let direct = children(element)
    return direct + direct.flatMap { descendants($0, depth: depth + 1) }
}

func savePanel(_ processName: String) -> (AXUIElement, [AXUIElement])? {
    guard let app = NSWorkspace.shared.runningApplications.first(where: { $0.localizedName == processName }) else {
        return nil
    }
    let appElement = AXUIElementCreateApplication(app.processIdentifier)
    guard let windows = axValue(appElement, kAXWindowsAttribute as CFString) as? [AXUIElement] else { return nil }
    for window in windows {
        let title = stringValue(window, kAXTitleAttribute as CFString) ?? ""
        let subrole = stringValue(window, kAXSubroleAttribute as CFString) ?? ""
        guard title == "Save", subrole == "AXDialog" else { continue }
        return (window, descendants(window))
    }
    return nil
}

func panelData(_ elements: [AXUIElement]) -> (field: AXUIElement?, name: String?, folder: String?, files: [String]) {
    var field: AXUIElement?
    var name: String?
    var folder: String?
    var files = [String]()
    for element in elements {
        let role = stringValue(element, kAXRoleAttribute as CFString) ?? ""
        let identifier = stringValue(element, kAXIdentifierAttribute as CFString) ?? ""
        if identifier == "saveAsNameTextField" { field = element; name = stringValue(element, kAXValueAttribute as CFString) }
        if identifier == "where popup" { folder = stringValue(element, kAXValueAttribute as CFString) }
        if role == kAXTextFieldRole as String, identifier != "saveAsNameTextField" {
            if let value = stringValue(element, kAXValueAttribute as CFString), !value.isEmpty {
                files.append(value)
            }
        }
    }
    return (field, name, folder, files)
}

func emit(_ data: (field: AXUIElement?, name: String?, folder: String?, files: [String])) {
    let object: [String: Any] = [
        "saveName": data.name ?? "",
        "folderName": data.folder ?? "",
        "fileNames": data.files,
    ]
    guard let json = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
          let text = String(data: json, encoding: .utf8) else { fail("Could not encode Save panel accessibility data.") }
    print(text)
}

guard CommandLine.arguments.count >= 3 else { fail("Usage: save-panel-accessibility.swift <Reason process> <read|set> [name]") }
let processName = CommandLine.arguments[1]
let action = CommandLine.arguments[2]
guard let (_, elements) = savePanel(processName) else { fail("Reason's native Save panel is not open.") }
let data = panelData(elements)
guard let field = data.field else { fail("Reason's Save As field is unavailable through Accessibility.") }

if action == "set" {
    guard CommandLine.arguments.count >= 4 else { fail("A generated export name is required.") }
    let expected = CommandLine.arguments[3]
    var settable = DarwinBoolean(false)
    guard AXUIElementIsAttributeSettable(field, kAXValueAttribute as CFString, &settable) == .success, settable.boolValue else {
        fail("Reason's Save As field is not writable through Accessibility.")
    }
    let status = AXUIElementSetAttributeValue(field, kAXValueAttribute as CFString, expected as CFTypeRef)
    guard status == .success else { fail("Could not set Reason's Save As field (Accessibility error \(status.rawValue)).") }
    let updated = panelData(elements)
    guard updated.name == expected else { fail("Reason did not retain the exact generated export name.") }
    emit(updated)
} else if action == "read" {
    emit(data)
} else {
    fail("Unknown Save panel action: \(action)")
}
