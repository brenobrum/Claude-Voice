// Tiny background helper: Ctrl+Option+Cmd+Space opens (or brings forward) Claude Voice, even when the
// app isn't running. Uses a Carbon hot key, so it needs no Accessibility permission.
// Built and installed as a LaunchAgent by `claude-voice shortcut` (see bin/shortcut.js).
import AppKit
import Carbon.HIToolbox

let bundleId = "dev.local.claude-voice"
// The iOS builds share the bundle id, so point at the installed Mac app when there is one.
let installed = ["/Applications/Claude Voice.app", NSHomeDirectory() + "/Applications/Claude Voice.app"]
  .first { FileManager.default.fileExists(atPath: $0) }

var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
InstallEventHandler(GetApplicationEventTarget(), { _, _, _ in
  let open = Process()
  open.executableURL = URL(fileURLWithPath: "/usr/bin/open")
  open.arguments = installed.map { [$0] } ?? ["-b", bundleId]
  try? open.run()
  return noErr
}, 1, &spec, nil, nil)

var ref: EventHotKeyRef?
let id = EventHotKeyID(signature: OSType(0x43564F4B), id: 1) // 'CVOK'
let mods = UInt32(controlKey | optionKey | cmdKey)
let status = RegisterEventHotKey(UInt32(kVK_Space), mods, id, GetApplicationEventTarget(), 0, &ref)
if status != noErr {
  FileHandle.standardError.write("Couldn't register Ctrl+Option+Cmd+Space (\(status)); another app may own it.\n".data(using: .utf8)!)
  exit(0) // a clean exit, so launchd doesn't keep restarting it
}

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
app.run()
