import CoreAudio
import Foundation

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

func address(_ selector: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope, _ element: AudioObjectPropertyElement) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: element)
}

func deviceName(_ id: AudioDeviceID) -> String? {
    var a = address(kAudioObjectPropertyName, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain)
    var value: CFString = "" as CFString
    var size = UInt32(MemoryLayout<CFString>.size)
    guard AudioObjectGetPropertyData(id, &a, 0, nil, &size, &value) == noErr else { return nil }
    return value as String
}

func getScalar(_ id: AudioDeviceID, _ element: AudioObjectPropertyElement) -> Float32? {
    var a = address(kAudioDevicePropertyVolumeScalar, kAudioDevicePropertyScopeOutput, element)
    var value: Float32 = 0
    var size = UInt32(MemoryLayout<Float32>.size)
    guard AudioObjectGetPropertyData(id, &a, 0, nil, &size, &value) == noErr else { return nil }
    return value
}

guard CommandLine.arguments.count >= 3 else { fail("Usage: set-device-volume.swift <device name> <percent>") }
let targetName = CommandLine.arguments[1]
guard let percent = Double(CommandLine.arguments[2]), percent >= 0, percent <= 100 else { fail("Volume must be between 0 and 100.") }
let target = Float32(percent / 100.0)

var devicesAddress = address(kAudioHardwarePropertyDevices, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain)
var bytes: UInt32 = 0
guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &devicesAddress, 0, nil, &bytes) == noErr else { fail("Could not list CoreAudio devices.") }
let count = Int(bytes) / MemoryLayout<AudioDeviceID>.size
var devices = [AudioDeviceID](repeating: 0, count: count)
guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &devicesAddress, 0, nil, &bytes, &devices) == noErr else { fail("Could not read CoreAudio devices.") }
guard let id = devices.first(where: { deviceName($0) == targetName }) else { fail("Audio output \(targetName) is not currently available.") }

let possibleElements = [kAudioObjectPropertyElementMain] + (1...16).map { AudioObjectPropertyElement($0) }
var settable: [AudioObjectPropertyElement] = []
for element in possibleElements {
    var a = address(kAudioDevicePropertyVolumeScalar, kAudioDevicePropertyScopeOutput, element)
    var canSet: DarwinBoolean = false
    guard AudioObjectIsPropertySettable(id, &a, &canSet) == noErr, canSet.boolValue, getScalar(id, element) != nil else { continue }
    settable.append(element)
}
// Prefer the device master control; if there is none, set every available output channel.
let elementsToSet: [AudioObjectPropertyElement]
if settable.contains(kAudioObjectPropertyElementMain) {
    elementsToSet = [kAudioObjectPropertyElementMain]
} else {
    elementsToSet = settable.filter { $0 != kAudioObjectPropertyElementMain }
}
guard !elementsToSet.isEmpty else { fail("Audio output \(targetName) exposes no writable output-volume control.") }

for element in elementsToSet {
    var a = address(kAudioDevicePropertyVolumeScalar, kAudioDevicePropertyScopeOutput, element)
    var value = target
    let status = AudioObjectSetPropertyData(id, &a, 0, nil, UInt32(MemoryLayout<Float32>.size), &value)
    guard status == noErr else { fail("Could not set \(targetName) output channel \(element) (CoreAudio \(status)).") }
}
let values = elementsToSet.compactMap { getScalar(id, $0) }
guard values.count == elementsToSet.count else { fail("Could not verify \(targetName) volume.") }
let actual = values.reduce(0, +) / Float32(values.count) * 100
let result: [String: Any] = ["device": targetName, "requestedPercent": percent, "actualPercent": Double(actual)]
guard let data = try? JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]), let output = String(data: data, encoding: .utf8) else { fail("Could not format volume read-back.") }
print(output)
