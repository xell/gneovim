// Grammarly stand-in for the Markdown island.
//
// Grammarly Desktop reaches a WKWebView island through two channels only:
// macOS Accessibility (AXSelectedTextRange on the focused AXTextArea) and
// posted keyboard events. This tool drives exactly those channels against the
// running dev build, so the Accessibility path can be exercised without
// Grammarly itself. It needs Accessibility permission for the terminal.
//
//   swiftc -O scripts/ax-driver.swift -o /tmp/ax-driver
//   /tmp/ax-driver activate            # bring the dev app forward, print pids
//   /tmp/ax-driver probe               # focused AX element, value, selection
//   /tmp/ax-driver select 8 5          # AXSelectedTextRange = (8, 5)
//   /tmp/ax-driver type 'people' 3     # post keys, 3 ms apart (0 is dropped)
//   /tmp/ax-driver axtext 'people'     # set AXSelectedText (no effect in WKWebView)
//   /tmp/ax-driver refocus <pid>       # hand focus back
//
// `type` understands \n (Return), \e (Escape), and \b (Backspace). Offsets are
// UTF 16 offsets into the AXValue string, which is the island's DOM text.
import AppKit
import ApplicationServices

let args = CommandLine.arguments
func die(_ m: String) -> Never { print("ERR", m); exit(1) }

func pidOfApp() -> pid_t {
    for app in NSWorkspace.shared.runningApplications {
        if let url = app.executableURL, url.path.hasSuffix("target/debug/app") { return app.processIdentifier }
    }
    die("gneovim dev app not running")
}

func attr(_ el: AXUIElement, _ name: String) -> AnyObject? {
    var v: AnyObject?
    let r = AXUIElementCopyAttributeValue(el, name as CFString, &v)
    return r == .success ? v : nil
}
func rangeAttr(_ el: AXUIElement, _ name: String) -> CFRange? {
    guard let v = attr(el, name) else { return nil }
    var r = CFRange()
    if AXValueGetType(v as! AXValue) == .cfRange, AXValueGetValue(v as! AXValue, .cfRange, &r) { return r }
    return nil
}
func focused(_ pid: pid_t) -> AXUIElement {
    let app = AXUIElementCreateApplication(pid)
    guard let f = attr(app, kAXFocusedUIElementAttribute as String) else { die("no focused element") }
    return f as! AXUIElement
}
func probe(_ pid: pid_t) {
    let el = focused(pid)
    print("role:", attr(el, kAXRoleAttribute as String) ?? "nil", "subrole:", attr(el, kAXSubroleAttribute as String) ?? "nil")
    print("desc:", attr(el, kAXRoleDescriptionAttribute as String) ?? "nil")
    if let n = attr(el, kAXNumberOfCharactersAttribute as String) { print("chars:", n) }
    if let r = rangeAttr(el, kAXSelectedTextRangeAttribute as String) { print("selRange:", r.location, r.length) }
    if let t = attr(el, kAXSelectedTextAttribute as String) { print("selText:", String(describing: t).debugDescription) }
    if let v = attr(el, kAXValueAttribute as String) as? String { print("value:", v.debugDescription) }
    var names: CFArray?
    if AXUIElementCopyAttributeNames(el, &names) == .success { print("attrs:", (names as! [String]).joined(separator: ",")) }
    var settable = DarwinBoolean(false)
    AXUIElementIsAttributeSettable(el, kAXSelectedTextAttribute as CFString, &settable)
    print("selTextSettable:", settable.boolValue)
    AXUIElementIsAttributeSettable(el, kAXSelectedTextRangeAttribute as CFString, &settable)
    print("selRangeSettable:", settable.boolValue)
}
func setRange(_ pid: pid_t, _ loc: Int, _ len: Int) {
    let el = focused(pid)
    var r = CFRange(location: loc, length: len)
    let v = AXValueCreate(.cfRange, &r)!
    let res = AXUIElementSetAttributeValue(el, kAXSelectedTextRangeAttribute as CFString, v)
    print("setRange:", res.rawValue)
    if let r2 = rangeAttr(el, kAXSelectedTextRangeAttribute as String) { print("now:", r2.location, r2.length) }
}
func setText(_ pid: pid_t, _ text: String) {
    let el = focused(pid)
    let res = AXUIElementSetAttributeValue(el, kAXSelectedTextAttribute as CFString, text as CFString)
    print("setSelectedText:", res.rawValue)
}
// ANSI virtual key codes
let keyCodes: [Character: (UInt16, Bool)] = {
    var m: [Character: (UInt16, Bool)] = [:]
    let lower = "abcdefghijklmnopqrstuvwxyz"
    let codes: [UInt16] = [0,11,8,2,14,3,5,4,34,38,40,37,46,45,31,35,12,15,1,17,32,9,13,7,16,6]
    for (c, k) in zip(lower, codes) { m[c] = (k, false); m[Character(c.uppercased())] = (k, true) }
    let digits = "1234567890"; let dcodes: [UInt16] = [18,19,20,21,23,22,26,28,25,29]
    let shifted = "!@#$%^&*()"
    for (i, c) in digits.enumerated() { m[c] = (dcodes[i], false) }
    for (i, c) in shifted.enumerated() { m[c] = (dcodes[i], true) }
    let punct: [(Character, UInt16, Bool)] = [(" ",49,false),(",",43,false),("<",43,true),(".",47,false),(">",47,true),("/",44,false),("?",44,true),(";",41,false),(":",41,true),("'",39,false),("\"",39,true),("-",27,false),("_",27,true),("=",24,false),("+",24,true),("[",33,false),("]",30,false),("\\",42,false),("`",50,false),("~",50,true)]
    for (c,k,s) in punct { m[c] = (k,s) }
    return m
}()
func postKey(_ pid: pid_t, code: UInt16, shift: Bool, char: Character?, delayMs: UInt32) {
    let src = CGEventSource(stateID: .hidSystemState)
    for down in [true, false] {
        let e = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: down)!
        if shift { e.flags = .maskShift }
        if let c = char { var u = Array(String(c).utf16); e.keyboardSetUnicodeString(stringLength: u.count, unicodeString: &u) }
        e.postToPid(pid)
        usleep(delayMs * 1000)
    }
}
func typeString(_ pid: pid_t, _ s: String, delayMs: UInt32) {
    for c in s {
        if c == "\n" { postKey(pid, code: 36, shift: false, char: nil, delayMs: delayMs); continue }
        if c == "\u{1b}" { postKey(pid, code: 53, shift: false, char: nil, delayMs: delayMs); continue }
        if c == "\u{8}" { postKey(pid, code: 51, shift: false, char: nil, delayMs: delayMs); continue }
        guard let (code, shift) = keyCodes[c] else { die("no keycode for \(c)") }
        postKey(pid, code: code, shift: shift, char: c, delayMs: delayMs)
    }
}

let pid = pidOfApp()
switch args[1] {
case "activate":
    let prev = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
    NSRunningApplication(processIdentifier: pid)!.activate(options: [.activateIgnoringOtherApps])
    usleep(400_000)
    print("prev:", prev, "front:", NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0)
case "refocus": NSRunningApplication(processIdentifier: pid_t(args[2])!)?.activate(options: [.activateIgnoringOtherApps])
case "probe": probe(pid)
case "select": setRange(pid, Int(args[2])!, Int(args[3])!)
case "axtext": setText(pid, args[2])
case "type": typeString(pid, args[2].replacingOccurrences(of: "\\n", with: "\n").replacingOccurrences(of: "\\e", with: "\u{1b}").replacingOccurrences(of: "\\b", with: "\u{8}"), delayMs: UInt32(args.count > 3 ? args[3] : "20")!)
default: die("usage")
}
