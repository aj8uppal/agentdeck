// Agentdeck: a floating deck over WezTerm for every running Claude Code / Codex agent.
// All agent state comes from `ag stream`, and replies go through `ag send`. This file is only the window, the hotkey,
// the menu-bar count, notifications, and the few things the page may ask for.
import AppKit
import Carbon.HIToolbox
import ServiceManagement
import UserNotifications
import WebKit

let debug = ProcessInfo.processInfo.environment["AGENTDECK_DEBUG"] == "1"
let debugToken = UUID().uuidString  // debug URL commands must carry it, so only the script that launched us can use them
let logFile: FileHandle? = {
    let path = NSHomeDirectory() + "/Library/Logs/Agentdeck.log"
    if ((try? FileManager.default.attributesOfItem(atPath: path))?[.size] as? Int ?? 0) > 512_000 { try? FileManager.default.removeItem(atPath: path) }
    if !FileManager.default.fileExists(atPath: path) { FileManager.default.createFile(atPath: path, contents: nil) }
    let handle = FileHandle(forWritingAtPath: path)
    handle?.seekToEndOfFile()
    return handle
}()
func log(_ s: String) {
    let line = (ISO8601DateFormatter().string(from: Date()) + " " + s + "\n").data(using: .utf8)!
    logFile?.write(line)
    if debug { FileHandle.standardError.write((s + "\n").data(using: .utf8)!) }
}

/// A JS literal for any string: agent text and replies cross into the page only through this.
func literal(_ s: String) -> String {
    let data = try! JSONSerialization.data(withJSONObject: [s])
    return String(String(data: data, encoding: .utf8)!.dropFirst().dropLast())
}

final class DeckPanel: NSPanel {
    var takesKeyboard = true  // off while it is only the pinned strip
    override var canBecomeKey: Bool { takesKeyboard }  // borderless panels refuse the keyboard otherwise
}

/// The app's own banner. macOS only lets apps with a real signing identity post notifications, and one posted through
/// osascript belongs to Script Editor (click it and Script Editor opens). This one is ours: a click goes to the agent.
final class BannerView: NSVisualEffectView {
    var onClick: (() -> Void)?
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func mouseUp(with event: NSEvent) { onClick?() }
    override func resetCursorRects() { addCursorRect(bounds, cursor: .pointingHand) }
}

final class DeckWeb: WKWebView {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }  // one click works even while another app has focus
}

/// Runs a short command and waits at most `timeout`: `wezterm cli` can stall for seconds on a loaded machine.
/// Nothing here can block past the deadline: stdin is written and both pipes are drained on other threads.
func run(_ exe: String, _ args: [String], stdin: String? = nil, env: [String: String] = [:], timeout: TimeInterval = 5, cap: Int = 1_000_000) -> (ok: Bool, out: String, err: String) {
    final class Collected { let lock = NSLock(); var out = Data(), err = Data() }
    let p = Process(), input = Pipe(), out = Pipe(), err = Pipe(), got = Collected(), exited = DispatchSemaphore(value: 0), readers = DispatchGroup()
    p.executableURL = URL(fileURLWithPath: exe)
    p.arguments = args
    if !env.isEmpty { p.environment = env }  // a full replacement, not an addition
    p.standardInput = stdin == nil ? FileHandle.nullDevice : input
    p.standardOutput = out
    p.standardError = err
    p.terminationHandler = { _ in exited.signal() }
    do { try p.run() } catch { return (false, "", error.localizedDescription) }
    for (pipe, isOut) in [(out, true), (err, false)] {
        readers.enter()
        DispatchQueue.global().async {
            var data = Data()  // read in pieces and stop keeping them past `cap`: a huge diff must not become a huge string
            while let piece = try? pipe.fileHandleForReading.read(upToCount: 65_536), !piece.isEmpty {
                if data.count < cap { data.append(piece.prefix(cap - data.count)) } else if p.isRunning { p.terminate() }
            }
            got.lock.lock(); if isOut { got.out = data } else { got.err = data }; got.lock.unlock()
            readers.leave()
        }
    }
    if let stdin {
        DispatchQueue.global().async {  // a child that never reads cannot hang us: the deadline below still fires
            try? input.fileHandleForWriting.write(contentsOf: Data(stdin.utf8))
            try? input.fileHandleForWriting.close()
        }
    }
    var timedOut = false
    if exited.wait(timeout: .now() + timeout) == .timedOut {
        timedOut = true
        p.terminate()
        if exited.wait(timeout: .now() + 1) == .timedOut { kill(p.processIdentifier, SIGKILL); _ = exited.wait(timeout: .now() + 1) }
    }
    _ = readers.wait(timeout: .now() + 1)
    got.lock.lock(); let outData = got.out, errData = got.err; got.lock.unlock()
    let text = { (d: Data) in (String(data: d, encoding: .utf8) ?? "").trimmingCharacters(in: .whitespacesAndNewlines) }
    return (!timedOut && p.terminationStatus == 0, text(outData), timedOut ? "it took too long" : text(errData))
}

final class App: NSObject, NSApplicationDelegate, NSWindowDelegate, WKScriptMessageHandler, WKNavigationDelegate,
    UNUserNotificationCenterDelegate {
    let paletteSize = NSSize(width: 900, height: 580)
    let stripWidth: CGFloat = 320
    enum Shape { case pill, strip, deck }
    let ui = ProcessInfo.processInfo.environment["AGENTDECK_UI"].map { URL(fileURLWithPath: $0) }
        ?? Bundle.main.url(forResource: "deck", withExtension: "html")!
    let ag = NSHomeDirectory() + "/.local/bin/ag"
    let cli = DispatchQueue(label: "agentdeck.cli")  // serial: a jump or a send never overtakes the one before it
    let peeks = DispatchQueue(label: "agentdeck.peeks")  // screen reads wait in their own line, never in front of an action
    var peeking = false
    var diffing = false
    var nativeBanners = false  // until macOS says this app may post notifications, it shows its own banner instead
    var bannerPanel: NSPanel?
    /// The dashboard: the same page, moved into an ordinary resizable window while you want the detail.
    var board: NSWindow?
    var boardOpen: Bool { board?.isVisible == true }
    /// When you last opened it; the feed marks what happened since. Kept across restarts.
    var looked = UserDefaults.standard.object(forKey: "looked") as? Date ?? Date()
    var boardSince: Double = 0
    var synced = false  // the first snapshot only establishes who is running; nothing in it is news
    var moving = false  // the page is being moved between the panel and the dashboard window
    var known = Set<String>()  // every agent seen since launch, so one that drops out of a snapshot is not "started" twice
    var talking = false
    var ticks = 0
    /// What happened (hand-backs, blocks, runs starting and ending), oldest first; kept across restarts.
    let eventsFile = NSHomeDirectory() + "/Library/Application Support/Agentdeck/events.json"
    lazy var events: [[String: Any]] = {
        guard let data = FileManager.default.contents(atPath: eventsFile), let list = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return [] }
        return list
    }()
    var bannerHide: DispatchWorkItem?
    var bannerAction: (() -> Void)?
    let hotkey = (UserDefaults.standard.string(forKey: "hotkey") ?? "option+space").lowercased()
    let hotkeyNext = (UserDefaults.standard.string(forKey: "hotkey-next") ?? "option+shift+space").lowercased()

    var panel: DeckPanel!
    var web: DeckWeb!
    var status: NSStatusItem!
    var feed: Process?
    var buffer = Data()
    var latest = "{\"rows\":[]}"
    var rows: [[String: Any]] = []
    var states: [String: String] = [:]
    var lastFeed = Date()
    var ready = false
    /// Pinned = a strip that is always on screen; `expanded` is that strip opened into the full deck while you use it.
    var pinned = UserDefaults.standard.bool(forKey: "pinned")
    var folded = UserDefaults.standard.bool(forKey: "folded")  // pinned, but folded down to a pill of counts
    var expanded = false
    var stripHeight: CGFloat = 300  // the page reports how tall its agent list is
    var pillWidth: CGFloat = 150    // and how wide its counts are
    /// Top-right corner of the pinned strip/pill, wherever you dragged it; nil = top-right of the screen.
    var corner: NSPoint? = UserDefaults.standard.object(forKey: "cornerX") == nil ? nil
        : NSPoint(x: UserDefaults.standard.double(forKey: "cornerX"), y: UserDefaults.standard.double(forKey: "cornerY"))
    var shape: Shape { !pinned || expanded ? .deck : folded ? .pill : .strip }
    var commands: [String: String] {  // what "New agent" runs; yours to change in the form
        ["claude": UserDefaults.standard.string(forKey: "command-claude") ?? "claude --dangerously-skip-permissions",
         "codex": UserDefaults.standard.string(forKey: "command-codex") ?? "personalcodex --yolo"]
    }
    /// Hand-backs you have dealt with: agent id -> the moment it stopped. A new stop makes it fresh again.
    var seen = (UserDefaults.standard.dictionary(forKey: "seen") as? [String: Double]) ?? [:]

    var hotkeyLabel: String { label(hotkey) }
    func label(_ keys: String) -> String {
        keys.split(separator: "+").map { ["option": "⌥", "alt": "⌥", "ctrl": "⌃", "control": "⌃", "cmd": "⌘", "command": "⌘", "shift": "⇧", "space": "Space"][String($0)] ?? $0.uppercased() }.joined()
    }

    // MARK: launch

    func applicationDidFinishLaunching(_ note: Notification) {
        if ProcessInfo.processInfo.environment["AGENTDECK_PROBE"] == "1" {  // diagnostic: what does macOS think of this bundle's notifications?
            UNUserNotificationCenter.current().getNotificationSettings {
                log("probe \(Bundle.main.bundleIdentifier ?? "-"): notification status \($0.authorizationStatus.rawValue) (0 not asked, 1 denied, 2 allowed)")
                exit(0)
            }
            return
        }
        let me = NSRunningApplication.current
        if NSRunningApplication.runningApplications(withBundleIdentifier: Bundle.main.bundleIdentifier ?? "-").contains(where: { $0 != me }) {
            exit(0)  // already running
        }
        buildEditMenu()
        buildPanel()
        buildStatus()
        registerHotKeys()
        startFeed()
        log("debug token: \(debugToken)")
        Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in self?.checkFreshness() }
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.requestAuthorization(options: [.alert, .sound]) { granted, error in
            self.nativeBanners = granted
            log("notifications allowed: \(granted) \(error?.localizedDescription ?? "")")
            center.getNotificationSettings { log("notification status: \($0.authorizationStatus.rawValue) (0 not asked, 1 denied, 2 allowed)") }
        }
        if pinned { show() }
    }

    func applicationWillTerminate(_ note: Notification) {
        feed?.terminationHandler = nil
        feed?.terminate()
    }

    /// Shown only while the dashboard window is open (the app is menu-bar-only otherwise). It also exists for a plainer
    /// reason: ⌘C ⌘V ⌘X ⌘A ⌘Z ⌘W only reach a text field or a window through menu items.
    func buildEditMenu() {
        let main = NSMenu()
        func add(_ title: String, _ items: [(String, Selector, String)]) {
            let menu = NSMenu(title: title), holder = NSMenuItem()
            for (name, action, key) in items { menu.addItem(withTitle: name, action: action, keyEquivalent: key) }
            holder.submenu = menu
            main.addItem(holder)
        }
        add("Agentdeck", [("Hide Agentdeck", #selector(NSApplication.hide(_:)), "h"), ("Quit Agentdeck", #selector(NSApplication.terminate(_:)), "q")])
        add("File", [("Close Window", #selector(NSWindow.performClose(_:)), "w")])
        add("Edit", [("Undo", Selector(("undo:")), "z"), ("Redo", Selector(("redo:")), "Z"), ("Cut", #selector(NSText.cut(_:)), "x"),
                     ("Copy", #selector(NSText.copy(_:)), "c"), ("Paste", #selector(NSText.paste(_:)), "v"),
                     ("Select All", #selector(NSText.selectAll(_:)), "a")])
        NSApp.mainMenu = main
    }

    func buildPanel() {
        panel = DeckPanel(contentRect: NSRect(origin: .zero, size: paletteSize), styleMask: [.borderless, .nonactivatingPanel],
                          backing: .buffered, defer: false)
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]  // over full-screen WezTerm too
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.hidesOnDeactivate = false
        panel.delegate = self

        let blur = NSVisualEffectView(frame: panel.contentView!.bounds)
        blur.material = .hudWindow
        blur.blendingMode = .behindWindow
        blur.state = .active
        blur.wantsLayer = true
        blur.layer?.cornerRadius = 14
        blur.layer?.masksToBounds = true

        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "deck")
        web = DeckWeb(frame: blur.bounds, configuration: config)
        web.setValue(false, forKey: "drawsBackground")  // let the blur show through
        web.autoresizingMask = [.width, .height]
        web.navigationDelegate = self
        blur.addSubview(web)
        panel.contentView = blur
        web.loadFileURL(ui, allowingReadAccessTo: ui.deletingLastPathComponent())
    }

    /// The page is one local file. Anything else (a link in agent text, a redirect) is refused.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        decisionHandler(action.request.url == ui ? .allow : .cancel)
    }

    // MARK: menu bar

    func buildStatus() {
        status = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        status.button?.target = self
        status.button?.action = #selector(statusClicked)
        status.button?.sendAction(on: [.leftMouseUp, .rightMouseUp])
        status.button?.toolTip = "Agentdeck (\(hotkeyLabel))"
        drawStatus()
    }

    func isFresh(_ row: [String: Any]) -> Bool {  // needs you, and you have not dealt with it since it stopped
        guard let id = row["id"] as? String, let state = row["state"] as? String, state == "blocked" || state == "yours" else { return false }
        return seen[id] != row["since"] as? Double
    }

    /// Counts only what is new: an agent you already looked at stops nagging until it stops again.
    func drawStatus() {
        let fresh = rows.filter(isFresh)
        let blocked = fresh.filter { $0["state"] as? String == "blocked" }.count, yours = fresh.count - blocked
        let title = NSMutableAttributedString()
        let font = NSFont.monospacedDigitSystemFont(ofSize: NSFont.systemFontSize(for: .small) + 1, weight: .medium)
        func part(_ s: String, _ color: NSColor) {
            if title.length > 0 { title.append(NSAttributedString(string: " ")) }
            title.append(NSAttributedString(string: s, attributes: [.foregroundColor: color, .font: font]))
        }
        if feed == nil || Date().timeIntervalSince(lastFeed) > 8 { part("◇ ?", .systemRed) } else {
            if blocked > 0 { part("●\(blocked)", .systemRed) }
            if yours > 0 { part("◆\(yours)", .systemYellow) }
            if title.length == 0 { part("◇\(rows.filter { $0["state"] as? String == "working" }.count)", .secondaryLabelColor) }
        }
        status.button?.attributedTitle = title
    }

    @objc func statusClicked() {
        let e = NSApp.currentEvent
        guard e?.type == .rightMouseUp || e?.modifierFlags.contains(.control) == true else { return toggle() }
        let menu = NSMenu()
        menu.addItem(withTitle: "Show deck   \(hotkeyLabel)", action: #selector(showFromMenu), keyEquivalent: "").target = self
        menu.addItem(withTitle: "Dashboard", action: #selector(boardFromMenu), keyEquivalent: "").target = self
        menu.addItem(withTitle: "Go to whoever needs me   \(label(hotkeyNext))", action: #selector(nextFromMenu), keyEquivalent: "").target = self
        let pin = menu.addItem(withTitle: "Keep a strip on screen", action: #selector(togglePin), keyEquivalent: "")
        pin.target = self
        pin.state = pinned ? .on : .off
        let login = menu.addItem(withTitle: "Open at login", action: #selector(toggleLogin), keyEquivalent: "")
        login.target = self
        login.state = SMAppService.mainApp.status == .enabled ? .on : .off
        if !nativeBanners {
            menu.addItem(withTitle: "Use macOS notifications…", action: #selector(openNotificationSettings), keyEquivalent: "").target = self
        }
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit Agentdeck", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        status.menu = menu
        status.button?.performClick(nil)
        status.menu = nil
    }

    @objc func showFromMenu() { expanded = pinned; show() }
    @objc func nextFromMenu() { nextAttention() }
    @objc func boardFromMenu() { openBoard() }
    @objc func openNotificationSettings() {
        NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=\(Bundle.main.bundleIdentifier ?? "")")!)
    }
    @objc func togglePin() { setPinned(!pinned) }
    @objc func toggleLogin() {
        let service = SMAppService.mainApp
        if service.status == .enabled { try? service.unregister() } else { try? service.register() }
    }

    // MARK: hotkey

    /// Option+Space opens the deck; Option+Shift+Space takes you straight to whoever needs you most.
    /// Override: `defaults write dev.agentdeck.app hotkey "ctrl+option+a"` / `hotkey-next "…"`.
    func registerHotKeys() {
        let keys: [String: Int] = [
            "space": kVK_Space, "`": kVK_ANSI_Grave, "tab": kVK_Tab, "a": kVK_ANSI_A, "b": kVK_ANSI_B, "c": kVK_ANSI_C,
            "d": kVK_ANSI_D, "e": kVK_ANSI_E, "f": kVK_ANSI_F, "g": kVK_ANSI_G, "h": kVK_ANSI_H, "i": kVK_ANSI_I,
            "j": kVK_ANSI_J, "k": kVK_ANSI_K, "l": kVK_ANSI_L, "m": kVK_ANSI_M, "n": kVK_ANSI_N, "o": kVK_ANSI_O,
            "p": kVK_ANSI_P, "q": kVK_ANSI_Q, "r": kVK_ANSI_R, "s": kVK_ANSI_S, "t": kVK_ANSI_T, "u": kVK_ANSI_U,
            "v": kVK_ANSI_V, "w": kVK_ANSI_W, "x": kVK_ANSI_X, "y": kVK_ANSI_Y, "z": kVK_ANSI_Z,
        ]
        let mods: [String: Int] = ["option": optionKey, "alt": optionKey, "ctrl": controlKey, "control": controlKey,
                                   "cmd": cmdKey, "command": cmdKey, "shift": shiftKey]
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, event, _ -> OSStatus in
            var pressed = EventHotKeyID()
            GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil,
                              MemoryLayout<EventHotKeyID>.size, nil, &pressed)
            let which = pressed.id
            DispatchQueue.main.async {
                guard let app = NSApp.delegate as? App else { return }
                if which == 1 { app.toggle() } else { app.nextAttention() }
            }
            return noErr
        }, 1, &spec, nil, nil)
        for (id, combo) in [(UInt32(1), hotkey), (UInt32(2), hotkeyNext)] {
            let parts = combo.split(separator: "+").map(String.init)
            guard let key = parts.last.flatMap({ keys[$0] }) else { log("hotkey: unknown key in \(combo)"); continue }
            let mask = parts.dropLast().compactMap { mods[$0] }.reduce(0, |)
            var ref: EventHotKeyRef?
            let err = RegisterEventHotKey(UInt32(key), UInt32(mask), EventHotKeyID(signature: 0x4147_444B, id: id), GetApplicationEventTarget(), 0, &ref)
            log("hotkey \(combo) registered: \(err == noErr)")
        }
    }

    /// Straight to the agent that needs you most, without opening anything. Each press moves on to the next one.
    func nextAttention() {
        guard Date().timeIntervalSince(lastFeed) < 8, let row = rows.first(where: { isFresh($0) && $0["pane"] as? Int != nil }) else {
            NSSound.beep(); return log("next: nothing needs you")
        }
        jump(row)
    }

    // MARK: showing and hiding

    func frame() -> NSRect {
        let mouse = NSEvent.mouseLocation
        let at = pinned ? (corner ?? mouse) : mouse  // pinned shapes live where their corner is; the plain deck opens where the mouse is
        let v = (NSScreen.screens.first { $0.frame.contains(at) } ?? NSScreen.main ?? NSScreen.screens[0]).visibleFrame
        guard pinned else {
            let w = min(paletteSize.width, v.width - 20), h = min(paletteSize.height, v.height - 20)
            return NSRect(x: v.midX - w / 2, y: min(v.midY - h / 2 + v.height * 0.05, v.maxY - h - 10), width: w, height: h)
        }
        if corner == nil {  // first time pinned: its home is the top-right of the display it was pinned on
            corner = NSPoint(x: v.maxX - 10, y: v.maxY - 10)
            UserDefaults.standard.set(Double(corner!.x), forKey: "cornerX"); UserDefaults.standard.set(Double(corner!.y), forKey: "cornerY")
        }
        let size: NSSize
        switch shape {
        case .pill: size = NSSize(width: pillWidth, height: 34)
        case .strip: size = NSSize(width: stripWidth, height: min(stripHeight, v.height - 20))
        case .deck: size = NSSize(width: min(paletteSize.width, v.width - 20), height: min(paletteSize.height, v.height - 20))  // grows out of the same corner
        }
        var top = corner ?? NSPoint(x: v.maxX - 10, y: v.maxY - 10)
        top.x = min(max(top.x, v.minX + size.width + 4), v.maxX - 4)  // never off the screen
        top.y = min(max(top.y, v.minY + size.height + 4), v.maxY - 4)
        return NSRect(x: top.x - size.width, y: top.y - size.height, width: size.width, height: size.height)
    }

    func openBoard(select: String? = nil) {
        if board == nil {
            let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1320, height: 860),
                             styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
            w.title = "Agentdeck"
            w.appearance = NSAppearance(named: .darkAqua)
            w.backgroundColor = NSColor(srgbRed: 0.094, green: 0.094, blue: 0.145, alpha: 1)
            w.minSize = NSSize(width: 980, height: 600)
            w.isReleasedWhenClosed = false
            w.delegate = self
            w.center()
            w.setFrameAutosaveName("AgentdeckBoard")
            board = w
        }
        guard let board, let content = board.contentView else { return }
        if boardOpen {  // already open: just bring it forward, leaving your place in it alone
            NSApp.activate(ignoringOtherApps: true)
            board.makeKeyAndOrderFront(nil)
            if let select { js("document.getElementById('row-' + \(literal(select)))?.click()") }
            return
        }
        moving = true
        defer { moving = false }
        do {
            panel.orderOut(nil)
            expanded = false
            web.removeFromSuperview()  // one page, so drafts and queued replies are the same wherever you look at them
            web.frame = content.bounds
            content.addSubview(web)
            NSApp.setActivationPolicy(.regular)  // while it is open the app is an ordinary one: Dock, ⌘Tab, ⌘W
        }
        NSApp.activate(ignoringOtherApps: true)
        board.makeKeyAndOrderFront(nil)
        board.makeFirstResponder(web)
        let since = looked.timeIntervalSince1970
        looked = Date()
        UserDefaults.standard.set(looked, forKey: "looked")
        boardSince = since
        let commandsJSON = String(data: try! JSONSerialization.data(withJSONObject: commands), encoding: .utf8)!
        js("deck.show('board', {looked: \(since), hotkey: \(literal(hotkeyLabel)), commands: \(commandsJSON)\(select.map { ", select: " + literal($0) } ?? "")})")
        pushEvents()
    }

    func windowWillClose(_ note: Notification) {
        guard (note.object as? NSWindow) === board, let home = panel.contentView else { return }
        web.removeFromSuperview()
        web.frame = home.bounds
        home.addSubview(web)
        NSApp.setActivationPolicy(.accessory)
        js("deck.hidden()")
        DispatchQueue.main.async { if self.pinned && !self.boardOpen { self.show() } }  // once the window is really gone, the pill or strip comes back
    }

    func pushEvents() {
        guard let data = try? JSONSerialization.data(withJSONObject: Array(events.suffix(120))) else { return }
        js("deck.events(\(String(data: data, encoding: .utf8)!))")
    }

    func record(_ row: [String: Any], _ state: String, _ text: String) {
        let title = (row["title"] as? String ?? "agent").components(separatedBy: " · ").first ?? "agent"
        events.append(["at": Date().timeIntervalSince1970, "id": row["id"] as? String ?? "", "state": state, "title": title,
                       "proj": row["proj"] as? String ?? "", "text": text])
        if events.count > 300 { events.removeFirst(events.count - 300) }
        try? FileManager.default.createDirectory(atPath: (eventsFile as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        if let data = try? JSONSerialization.data(withJSONObject: events) { try? data.write(to: URL(fileURLWithPath: eventsFile), options: .atomic) }
    }

    /// The strip never takes the keyboard; the full deck does.
    func show(select: String? = nil) {
        if boardOpen { return openBoard(select: select) }  // the page lives in the dashboard window while that is open
        panel.setFrame(frame(), display: true)
        panel.orderFrontRegardless()
        panel.takesKeyboard = shape == .deck
        if shape == .deck {
            panel.makeKey()
            panel.makeFirstResponder(web)
        }
        let commandsJSON = String(data: try! JSONSerialization.data(withJSONObject: commands), encoding: .utf8)!
        let opts = "{pinned: \(pinned), hotkey: \(literal(hotkeyLabel)), commands: \(commandsJSON)\(select.map { ", select: " + literal($0) } ?? "")}"
        js("deck.show('\(shape == .deck ? "palette" : shape == .strip ? "dock" : "pill")', \(opts))")
    }

    /// Closing the full deck leaves the strip behind when pinned.
    func hide() {
        if boardOpen { return }
        js("deck.hidden()")
        if pinned {
            expanded = false
            panel.orderOut(nil)  // drops the keyboard back to the app underneath
            show()
        } else {
            panel.orderOut(nil)
        }
    }

    func toggle() {
        if boardOpen { return openBoard() }  // brings the dashboard forward
        if pinned {
            if expanded { hide() } else { expanded = true; show() }  // from the pill or the strip, straight to the full deck and back
        } else if panel.isVisible {
            hide()
        } else {
            show()
        }
    }

    func setPinned(_ on: Bool) {
        if boardOpen { return }
        pinned = on
        expanded = false
        UserDefaults.standard.set(on, forKey: "pinned")
        panel.orderOut(nil)
        if on { show() } else { js("deck.hidden()") }
    }

    func windowDidResignKey(_ note: Notification) {
        if debug || moving || (note.object as? NSWindow) !== panel || boardOpen { return }
        if !pinned || expanded { hide() }  // clicking elsewhere dismisses the deck
    }

    // MARK: the feed

    func startFeed() {
        let p = Process(), out = Pipe()
        p.executableURL = URL(fileURLWithPath: ag)
        p.arguments = ["stream"]
        p.standardInput = FileHandle.nullDevice
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        out.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil; return }
            DispatchQueue.main.async { self?.consume(data) }
        }
        p.terminationHandler = { [weak self] _ in  // ag was killed or crashed: start it again
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) { self?.feed = nil; self?.drawStatus(); self?.startFeed() }
        }
        do { try p.run(); feed = p } catch {
            log("cannot start \(ag): \(error)")
            DispatchQueue.main.asyncAfter(deadline: .now() + 10) { [weak self] in self?.startFeed() }
        }
    }

    func consume(_ data: Data) {
        buffer.append(data)
        while let newline = buffer.firstIndex(of: 10) {
            let line = buffer.subdata(in: buffer.startIndex..<newline)
            buffer.removeSubrange(buffer.startIndex...newline)
            guard let object = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
                  let fresh = object["rows"] as? [[String: Any]], let text = String(data: line, encoding: .utf8) else { continue }
            latest = text
            rows = fresh
            lastFeed = Date()
            let live = Set(rows.compactMap { $0["id"] as? String })
            if seen.keys.contains(where: { !live.contains($0) }) { seen = seen.filter { live.contains($0.key) }; saveSeen() }
            push()
            drawStatus()
            notifyHandBacks()
        }
    }

    /// States older than a few seconds are shown as such, and the page stops offering replies.
    func checkFreshness() {
        ticks += 1
        if ticks % 5 == 0 {  // you may allow notifications at any time (the system prompt, or System Settings); notice within ~15 s
            UNUserNotificationCenter.current().getNotificationSettings { settings in
                DispatchQueue.main.async {
                    let allowed = settings.authorizationStatus == .authorized
                    if allowed != self.nativeBanners { log("notifications allowed: \(allowed)") }
                    self.nativeBanners = allowed
                }
            }
        }
        let age = Date().timeIntervalSince(lastFeed)
        if age > 8 { js("deck.stale(\(Int(age)))"); drawStatus() }
    }

    func saveSeen() { UserDefaults.standard.set(seen, forKey: "seen") }

    func push() {  // ag writes ASCII-only JSON, which is a valid JS literal
        guard ready, let seenJSON = try? JSONSerialization.data(withJSONObject: seen) else { return }
        js("deck.update(\(latest), \(String(data: seenJSON, encoding: .utf8)!))")
    }

    func js(_ code: String) {
        guard ready else { return }  // the page announces itself, then gets the current state in one go
        web.evaluateJavaScript(code) { _, error in if let error { log("js: \(error)") } }
    }

    // MARK: what the page may ask for

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let m = message.body as? [String: Any], let cmd = m["cmd"] as? String else { return }
        let id = m["id"] as? String
        log("page: \(cmd) \(id ?? "")")
        switch cmd {
        case "ready":
            ready = true
            if let kept = UserDefaults.standard.dictionary(forKey: "drafts") as? [String: String], let data = try? JSONSerialization.data(withJSONObject: kept) {
                js("deck.restore(\(String(data: data, encoding: .utf8)!))")
            }
            push()
            if boardOpen {  // opened before the page had loaded: tell it now what it is
                let commandsJSON = String(data: try! JSONSerialization.data(withJSONObject: commands), encoding: .utf8)!
                js("deck.show('board', {looked: \(boardSince), hotkey: \(literal(hotkeyLabel)), commands: \(commandsJSON)})")
                pushEvents()
            } else if panel.isVisible { show() }
        case "hide": hide()
        case "pin": setPinned(m["on"] as? Bool ?? !pinned)
        case "expand": if pinned { expanded = true; show(select: id) }
        case "height":
            if let h = m["height"] as? Double, shape == .strip { stripHeight = CGFloat(h); panel.setFrame(frame(), display: true) }
        case "width":
            if let w = m["width"] as? Double, shape == .pill { pillWidth = CGFloat(w); panel.setFrame(frame(), display: true) }
        case "fold":  // strip <-> pill
            folded = m["on"] as? Bool ?? !folded
            UserDefaults.standard.set(folded, forKey: "folded")
            if pinned { expanded = false; show() }
        case "move":  // dragged by its header
            guard pinned, let dx = m["dx"] as? Double, let dy = m["dy"] as? Double else { break }
            let f = panel.frame
            corner = NSPoint(x: f.maxX + CGFloat(dx), y: f.maxY - CGFloat(dy))
            panel.setFrame(frame(), display: true)
        case "moved":
            if let c = corner { UserDefaults.standard.set(Double(c.x), forKey: "cornerX"); UserDefaults.standard.set(Double(c.y), forKey: "cornerY") }
        case "banner":  // a queued reply that could not be delivered while you were elsewhere
            if let row = row(id) { cli.async { self.banner(row, title: m["title"] as? String ?? "Agentdeck", body: m["body"] as? String ?? "", sound: false) } }
        case "launch": launch(m)
        case "seen":
            guard let id else { break }
            seen[id] = m["since"] as? Double
            saveSeen()
            drawStatus()
        case "jump": if let row = row(id) { jump(row) } else { js("deck.failed('That agent is no longer running')") }
        case "send":  // every send gets an answer, tagged with the request it answers
            let req = m["req"] as? Int ?? 0
            if let row = row(id), let text = m["text"] as? String {
                send(text, to: row, submit: m["submit"] as? Bool ?? true, req: req, sid: m["sid"] as? String ?? "")
            } else { js("deck.sent(\(literal(id ?? "")), false, 'Not sent: that agent is no longer running', \(req))") }
        case "keep":  // drafts and queued replies, so quitting the app cannot lose words you wrote
            if let drafts = m["drafts"] as? [String: String] { UserDefaults.standard.set(drafts, forKey: "drafts") }
        case "changes": if let row = row(id) { readChanges(row) }
        case "board": if m["on"] as? Bool ?? !boardOpen { openBoard() } else { board?.close() }
        case "talk": if let row = row(id) { readTalk(row) }
        case "diff": if let row = row(id), let file = m["file"] as? String { readDiff(row, file, untracked: m["untracked"] as? Bool ?? false) }
        case "screen": if let row = row(id) { readScreen(row) }
        case "open": if let s = m["url"] as? String { open(s) }
        default: break
        }
    }

    /// Only agents in the latest feed are ever acted on, whatever the page sends.
    func row(_ id: String?) -> [String: Any]? { rows.first { $0["id"] as? String == id && id != nil } }

    var wezterm: (app: NSRunningApplication, cli: String)? {
        guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: "com.github.wez.wezterm").first,
              let exe = app.executableURL else { return nil }
        return (app, exe.deletingLastPathComponent().appendingPathComponent("wezterm").path)
    }

    func jump(_ row: [String: Any]) {
        guard let wez = wezterm, let pane = row["pane"] as? Int, let tab = row["tabid"] as? Int else {
            return js("deck.failed('That agent has no WezTerm tab')")
        }
        if panel.isVisible && shape == .deck { hide() }
        // The CLI can switch tabs but not raise a WezTerm window. A hook in ~/.wezterm.lua reads this file and brings the
        // window showing that pane forward; that is what makes a jump into another WezTerm window land in the right one.
        let request = NSHomeDirectory() + "/.cache/agentdeck-focus"
        cli.async {
            try? "\(pane)".write(toFile: request, atomically: true, encoding: .utf8)
            let ok = run(wez.cli, ["cli", "activate-tab", "--tab-id", "\(tab)"]).ok && run(wez.cli, ["cli", "activate-pane", "--pane-id", "\(pane)"]).ok
            log("jump pane \(pane): \(ok)")
            DispatchQueue.main.async {
                if !ok { return self.js("deck.failed('WezTerm did not switch to that tab')") }
                if let id = row["id"] as? String, let since = row["since"] as? Double, self.isFresh(row) {  // you are there now: it stops counting
                    self.seen[id] = since; self.saveSeen(); self.push(); self.drawStatus()
                }
            }
            DispatchQueue.global().asyncAfter(deadline: .now() + 3) {  // if the hook never took it, do not leave a stale request behind
                if (try? String(contentsOfFile: request, encoding: .utf8)) == "\(pane)" { try? FileManager.default.removeItem(atPath: request) }
            }
        }
        if let url = wez.app.bundleURL {  // brings WezTerm forward even when you summoned the deck from another app
            NSWorkspace.shared.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration())
        }
    }

    /// `ag send` re-reads the agent's state at this moment and refuses unless it is waiting for a prompt, so a reply
    /// can't land in a dialog, a busy turn, or a shell left behind by an agent that exited.
    func send(_ text: String, to row: [String: Any], submit: Bool, req: Int, sid: String) {
        guard let id = row["id"] as? String else { return }
        cli.async {
            let args = ["send", id] + (sid.isEmpty ? [] : ["--sid", sid]) + (submit ? [] : ["--no-submit"])
            let result = run(self.ag, args, stdin: text, timeout: 12)
            log("send \(id) submit=\(submit): \(result.ok) \(result.err)")
            DispatchQueue.main.async {
                self.js("deck.sent(\(literal(id)), \(result.ok), \(literal(result.err.isEmpty ? "Not delivered" : "Not sent: " + result.err)), \(req))")
                if result.ok && !submit { self.jump(row) }  // pasted, not submitted: go and look at it
            }
        }
    }

    /// Starts an agent in a new WezTerm tab, in the background: you stay on the tab you were on.
    func launch(_ m: [String: Any]) {
        let dir = ((m["dir"] as? String ?? "") as NSString).expandingTildeInPath
        let command = (m["command"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let prompt = m["prompt"] as? String ?? "", kind = m["kind"] as? String == "codex" ? "codex" : "claude", rev = m["rev"] as? Int ?? 0
        func answer(_ ok: Bool, _ text: String) { js("deck.launched(\(ok), \(literal(text)), \(rev))") }
        var isDir: ObjCBool = false
        guard let wez = wezterm else { return answer(false, "WezTerm is not running") }
        guard FileManager.default.fileExists(atPath: dir, isDirectory: &isDir), isDir.boolValue else { return answer(false, "No such folder") }
        guard let last = command.last, !command.contains("\n"), !";&|(`\\".contains(last) else {
            return answer(false, "That command is unfinished (it ends in a shell separator)")  // the prompt must stay an argument, never a command
        }
        UserDefaults.standard.set(command, forKey: "command-" + kind)
        cli.async {
            var before: Int?
            if let data = run(wez.cli, ["cli", "list-clients", "--format", "json"]).out.data(using: .utf8),
               let clients = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] {
                before = clients.min { ($0["idle_time"] as? [String: Any])?["secs"] as? Int ?? 0 < ($1["idle_time"] as? [String: Any])?["secs"] as? Int ?? 0 }?["focused_pane_id"] as? Int
            }
            // The prompt rides in the environment and is only ever referenced as "$AGENTDECK_PROMPT" after "--":
            // the shell never parses it, and the agent's CLI cannot mistake it for an option.
            let script = prompt.isEmpty ? command : command + " -- \"$AGENTDECK_PROMPT\""
            // WezTerm hands the caller's environment to the new tab, so give it a plain login environment and nothing of ours.
            var env = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "AGENTDECK_PROMPT": prompt]
            for key in ["HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "SSH_AUTH_SOCK"] { env[key] = ProcessInfo.processInfo.environment[key] }
            let began = Date()
            let origin = before.map { ["--pane-id", "\($0)"] } ?? []  // the new tab opens in the window you were typing in
            let started = run(wez.cli, ["cli", "spawn", "--cwd", dir] + origin + ["--", "/bin/zsh", "-lic", script], env: env, timeout: 8)
            // Back to where you were, unless this took so long that you may have moved on yourself.
            if started.ok, let before, Date().timeIntervalSince(began) < 1.5 { _ = run(wez.cli, ["cli", "activate-pane", "--pane-id", "\(before)"]) }
            log("launch \(kind) in \(dir): \(started.ok) \(started.err)")
            let name = URL(fileURLWithPath: dir).lastPathComponent
            DispatchQueue.main.async { answer(started.ok, started.ok ? "Started \(kind) in \(name)" : "Could not start it: " + started.err) }
        }
    }

    /// The recent conversation with an agent, for the dashboard (`ag talk` reads it from the agent's own log).
    func readTalk(_ row: [String: Any]) {
        guard !talking, let id = row["id"] as? String else { return }
        talking = true
        peeks.async {
            let result = run(self.ag, ["talk", id], timeout: 8)
            DispatchQueue.main.async {
                self.talking = false
                if result.ok, result.out.hasPrefix("{") { self.js("((d) => deck.talk(d.id, d.turns))(\(result.out))") }  // ag prints ASCII-only JSON
            }
        }
    }

    /// How git is always called here: against repositories agents write to, so nothing a repository's own config names may
    /// run (external diff tools, text converters, file-system monitors), no lock is taken, and paths are never patterns.
    func git(_ root: String, _ args: [String], timeout: TimeInterval = 5) -> String {
        run("/usr/bin/git", ["--literal-pathspecs", "--no-optional-locks", "-C", root, "-c", "core.fsmonitor=false", "-c", "diff.external="] + args, timeout: timeout).out
    }

    /// One file's diff where an agent is working. The path is one that `git status` reported for this repository.
    func readDiff(_ row: [String: Any], _ file: String, untracked: Bool) {
        guard let cwd = row["cwd"] as? String, let id = row["id"] as? String, !file.isEmpty else { return }
        peeks.async {
            let root = self.git(cwd, ["rev-parse", "--show-toplevel"])
            let target = URL(fileURLWithPath: root).appendingPathComponent(file).standardizedFileURL.path
            var text = ""
            if !root.isEmpty, target.hasPrefix(root + "/") {  // never a path that climbs out of the repository
                text = untracked
                    ? self.git(root, ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-index", "--", "/dev/null", target])
                    : self.git(root, ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "HEAD", "--", file])
            }
            let shown = text.count > 60_000 ? String(text.prefix(60_000)) + "\n… cut here: the diff is longer than this view shows" : text
            DispatchQueue.main.async { self.js("deck.diff(\(literal(id)), \(literal(file)), \(literal(shown)))") }
        }
    }

    /// What changed where an agent is working: uncommitted files, and the commits made since you last prompted it.
    func readChanges(_ row: [String: Any]) {
        guard !diffing, let cwd = row["cwd"] as? String, let id = row["id"] as? String, !cwd.isEmpty else { return }
        let asked = row["asked"] as? Double
        diffing = true
        peeks.async {
            var info: [String: Any] = ["files": [], "commits": [], "more": 0]
            let root = self.git(cwd, ["rev-parse", "--show-toplevel"])
            if !root.isEmpty {
                // NUL-separated, so a file name can contain anything; a rename is followed by its old name, which is skipped.
                let entries = self.git(root, ["status", "--porcelain=v1", "--branch", "-z", "--untracked-files=all"]).components(separatedBy: "\0")
                var files: [[String: String]] = [], skip = false
                for entry in entries where !entry.isEmpty {
                    if skip { skip = false; continue }
                    if entry.hasPrefix("## ") { info["branch"] = String(entry.dropFirst(3)); continue }
                    guard entry.count > 3 else { continue }
                    let code = String(entry.prefix(2))
                    if code.contains("R") || code.contains("C") { skip = true }
                    files.append(["code": code, "path": String(entry.dropFirst(3))])
                }
                info["more"] = max(0, files.count - 400)
                info["files"] = Array(files.prefix(400))
                if let asked {
                    info["commits"] = self.git(root, ["log", "--since=@\(Int(asked))", "--format=%h %s", "-n", "30"]).split(separator: "\n").map(String.init)
                }
            }
            let data = (try? JSONSerialization.data(withJSONObject: info)) ?? Data("{}".utf8)
            DispatchQueue.main.async {
                self.diffing = false
                self.js("deck.changes(\(literal(id)), \(String(data: data, encoding: .utf8)!))")
            }
        }
    }

    /// What is on the agent's terminal right now, for the page's "On its screen now".
    func readScreen(_ row: [String: Any]) {
        guard !peeking, let wez = wezterm, let pane = row["pane"] as? Int, let id = row["id"] as? String else { return }
        peeking = true  // one at a time: a slow terminal must not pile up reads
        peeks.async {
            let result = run(wez.cli, ["cli", "get-text", "--pane-id", "\(pane)"], timeout: 3)
            DispatchQueue.main.async {
                self.peeking = false
                self.js("deck.screen(\(literal(id)), \(literal(result.ok ? result.out : "Could not read that terminal.")))")
            }
        }
    }

    /// Links come from agent text, so: web pages open, local files are shown in Finder, everything else is ignored.
    func open(_ target: String) {
        if let url = URL(string: target), ["http", "https"].contains(url.scheme ?? "") {
            NSWorkspace.shared.open(url)
        } else if target.hasPrefix("/"), FileManager.default.fileExists(atPath: target) {
            NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: target)])
        }
    }

    // MARK: notifications

    /// One banner per blocker; several ordinary hand-backs in the same moment share one. Nothing for the agent you are looking at.
    func notifyHandBacks() {
        var now: [String: String] = [:], stopped: [[String: Any]] = [], logged = false
        for row in rows {
            guard let id = row["id"] as? String, let state = row["state"] as? String else { continue }
            now[id] = state
            let was = states[id]  // stopped working, or a new dialog on an agent that was merely waiting
            if (state == "yours" && was == "working") || (state == "blocked" && was != nil && was != "blocked") { stopped.append(row) }
            let said = (row["said"] as? String ?? "").split(separator: "\n").first.map(String.init) ?? ""
            let note = row["note"] as? String ?? ""
            if synced && was != state {  // the same moments, written down for the dashboard's feed
                if was == nil && state == "working" && !known.contains(id) { record(row, "working", "started"); logged = true }
                else if state == "yours" && was == "working" { record(row, "yours", note.contains("interrupted") ? "you interrupted it" : said); logged = true }
                else if state == "blocked" { record(row, "blocked", row["note"] as? String ?? ""); logged = true }
                else if state == "done" { record(row, "done", said); logged = true }
            }
        }
        states = now
        known.formUnion(now.keys)
        synced = true
        if logged && boardOpen { pushEvents() }
        guard !stopped.isEmpty, let wez = wezterm else { return }
        let frontmost = NSWorkspace.shared.frontmostApplication == wez.app
        cli.async {
            var watching: Int?
            if frontmost, let data = run(wez.cli, ["cli", "list-clients", "--format", "json"]).out.data(using: .utf8),
               let clients = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] {
                watching = clients.first?["focused_pane_id"] as? Int
            }
            let news = stopped.filter { ($0["pane"] as? Int) == nil || ($0["pane"] as? Int) != watching }
            let blockers = news.filter { $0["state"] as? String == "blocked" }, finished = news.filter { $0["state"] as? String != "blocked" }
            if let row = blockers.last {  // one banner at a time: the blocker wins, and says if others are waiting too
                let others = blockers.count + finished.count - 1
                return self.banner(row, title: "Blocked: " + (row["title"] as? String ?? "agent"),
                                   body: others > 0 ? "\(row["note"] as? String ?? "") · and \(others) more waiting" : nil, sound: true)
            }
            if finished.count == 1 {
                self.banner(finished[0], title: "Your turn: " + (finished[0]["title"] as? String ?? "agent"), sound: false)
            } else if let firstRow = finished.first {
                let names = finished.compactMap { $0["title"] as? String }.joined(separator: ", ")
                self.banner(firstRow, title: "\(finished.count) agents are waiting for you", body: names, sound: false)
            }
        }
    }

    /// `body` nil = one agent handed back (a click drops into it); otherwise a summary or a notice (a click opens the deck on it).
    func banner(_ row: [String: Any], title: String, body: String? = nil, sound: Bool) {
        let text = body ?? { let note = row["note"] as? String ?? ""; return note.isEmpty ? ((row["said"] as? String ?? "").split(separator: "\n").first.map(String.init) ?? "") : note }()
        let id = row["id"] as? String
        guard nativeBanners else {
            log("banner (own): \(title)")
            return ownBanner(title: title, body: text, urgent: sound) { [weak self] in
                guard let self else { return }
                if body == nil, let row = self.row(id) { self.jump(row) } else { self.expanded = self.pinned; self.show(select: id) }
            }
        }
        let content = UNMutableNotificationContent()
        content.title = title
        content.subtitle = body == nil ? (row["proj"] as? String ?? "") : ""
        content.body = text
        if sound { content.sound = .default }
        content.userInfo = ["id": id ?? ""]
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)) { error in
            log("banner: \(title) \(error.map { "FAILED \($0.localizedDescription)" } ?? "posted")")
        }
    }

    /// A small panel beside the pinned pill or strip (or in the top-right corner). It never takes the keyboard; a click
    /// runs `action` and it fades after a few seconds (longer when an agent is blocked).
    func ownBanner(title: String, body: String, urgent: Bool, action: @escaping () -> Void) {
        DispatchQueue.main.async {
            let width: CGFloat = 340, height: CGFloat = body.isEmpty ? 44 : 66
            let tint = urgent ? NSColor(srgbRed: 0.953, green: 0.545, blue: 0.659, alpha: 1) : NSColor(srgbRed: 0.976, green: 0.886, blue: 0.686, alpha: 1)
            let view = BannerView(frame: NSRect(x: 0, y: 0, width: width, height: height))
            view.material = .hudWindow; view.blendingMode = .behindWindow; view.state = .active
            view.wantsLayer = true
            view.layer?.cornerRadius = 12; view.layer?.masksToBounds = true
            view.layer?.borderWidth = 1; view.layer?.borderColor = tint.withAlphaComponent(0.65).cgColor
            let mark = NSView(frame: NSRect(x: 14, y: height - 27, width: 9, height: 9))  // round = blocked, diamond = your turn
            mark.wantsLayer = true; mark.layer?.backgroundColor = tint.cgColor; mark.layer?.cornerRadius = urgent ? 4.5 : 1.5
            if !urgent { mark.frameCenterRotation = 45 }
            let head = NSTextField(labelWithString: title)
            head.font = .systemFont(ofSize: 13, weight: .semibold); head.textColor = NSColor(srgbRed: 0.804, green: 0.839, blue: 0.957, alpha: 1)
            head.lineBreakMode = .byTruncatingTail; head.frame = NSRect(x: 34, y: height - 32, width: width - 48, height: 18)
            let detail = NSTextField(wrappingLabelWithString: body)
            detail.font = .systemFont(ofSize: 12); detail.textColor = NSColor(srgbRed: 0.651, green: 0.678, blue: 0.784, alpha: 1)
            detail.maximumNumberOfLines = 2; detail.lineBreakMode = .byWordWrapping; detail.cell?.truncatesLastVisibleLine = true
            detail.frame = NSRect(x: 34, y: 6, width: width - 48, height: 32)
            detail.isHidden = body.isEmpty
            for sub in [mark, head, detail] { view.addSubview(sub) }
            view.onClick = { [weak self] in self?.hideBanner(); action() }
            self.bannerAction = action

            let banner = self.bannerPanel ?? {
                let p = NSPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
                p.isFloatingPanel = true; p.level = .floating; p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
                p.isOpaque = false; p.backgroundColor = .clear; p.hasShadow = true; p.hidesOnDeactivate = false
                self.bannerPanel = p
                return p
            }()
            banner.contentView = view
            // Beside the pinned pill or strip if it is showing, so the two never cover each other; otherwise the top-right corner.
            let v = ((self.panel.isVisible ? self.panel.screen : nil) ?? NSScreen.main ?? NSScreen.screens[0]).visibleFrame
            var origin = NSPoint(x: v.maxX - width - 10, y: v.maxY - height - 10)
            if self.panel.isVisible && self.shape != .deck {
                let f = self.panel.frame
                origin = NSPoint(x: f.minX - width - 8, y: f.maxY - height)
                if origin.x < v.minX + 4 { origin.x = min(f.maxX + 8, v.maxX - width - 4) }
            }
            banner.setFrame(NSRect(origin: origin, size: NSSize(width: width, height: height)), display: true)
            if !banner.isVisible { banner.alphaValue = 0 }
            banner.orderFrontRegardless()
            NSAnimationContext.runAnimationGroup { $0.duration = 0.18; banner.animator().alphaValue = 1 }
            if urgent { NSSound(named: "Glass")?.play() }
            self.bannerHide?.cancel()
            let hide = DispatchWorkItem { [weak self] in self?.hideBanner() }
            self.bannerHide = hide
            DispatchQueue.main.asyncAfter(deadline: .now() + (urgent ? 20 : 8), execute: hide)
        }
    }

    func hideBanner() {
        bannerHide?.cancel()
        guard let banner = bannerPanel, banner.isVisible else { return }
        NSAnimationContext.runAnimationGroup({ $0.duration = 0.25; banner.animator().alphaValue = 0 }, completionHandler: { banner.orderOut(nil) })
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
        done([.banner, .sound])
    }

    /// Clicking a banner drops into that agent if it still exists, looked up fresh.
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler done: @escaping () -> Void) {
        let id = response.notification.request.content.userInfo["id"] as? String
        DispatchQueue.main.async {
            guard let row = self.row(id) else { self.expanded = self.pinned; return self.show() }
            self.jump(row)
        }
        done()
    }

    // MARK: agentdeck:// (the WezTerm key binding and the tests drive the app through this)

    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls {
            let query = Dictionary((URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []).map { ($0.name, $0.value ?? "") },
                                   uniquingKeysWith: { a, _ in a })
            log("url: \(url.host ?? "") \(query)")
            switch url.host {
            case "toggle": toggle()
            case "show": expanded = pinned; show()
            case "hide": hide()
            case "pin": setPinned(!pinned)
            case "next": nextAttention()
            case "board": if boardOpen { board?.close() } else { openBoard() }
            case "fold": folded.toggle(); UserDefaults.standard.set(folded, forKey: "folded"); if pinned { expanded = false; show() }
            default: if debug && query["t"] == debugToken { debugCommand(url.host ?? "", query) }
            }
        }
    }

    /// Only with AGENTDECK_DEBUG set: lets a script press keys, fill the reply box and photograph the page.
    func debugCommand(_ name: String, _ q: [String: String]) {
        switch name {
        case "press": js("deck.press(\(literal(q["key"] ?? "")), {meta: \(q["meta"] == "1"), shift: \(q["shift"] == "1")})")
        case "fill": js("((id, t) => { const r = document.getElementById(id); r.focus(); r.value = t; r.dispatchEvent(new Event('input')); })(\(literal(q["el"] ?? "r")), \(literal(q["text"] ?? "")))")
        case "banner":
            if let row = row(q["id"]) { banner(row, title: (row["state"] as? String == "blocked" ? "Blocked: " : "Your turn: ") + (row["title"] as? String ?? ""), sound: row["state"] as? String == "blocked") }
        case "banner-click":
            log("banner click: visible \(bannerPanel?.isVisible ?? false) frame \(bannerPanel?.frame ?? .zero)")
            (bannerPanel?.contentView as? BannerView)?.onClick?()
        case "banner-snapshot":
            if let view = bannerPanel?.contentView, let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) {
                view.cacheDisplay(in: view.bounds, to: rep)
                try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: NSTemporaryDirectory() + "agentdeck-banner.png"))
                log("banner snapshot: frame \(bannerPanel?.frame ?? .zero) deck \(panel.frame) shape \(shape)")
            }
        case "click": js("document.querySelector(\(literal(q["sel"] ?? "#" + (q["el"] ?? "none"))))?.click()")
        case "select": js("document.getElementById('row-' + \(literal(q["id"] ?? "")))?.click()")
        case "snapshot":
            let path = NSTemporaryDirectory() + "agentdeck-snapshot.png"
            web.takeSnapshot(with: nil) { image, _ in
                guard let tiff = image?.tiffRepresentation, let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) else { return }
                try? png.write(to: URL(fileURLWithPath: path))
                log("snapshot \(path) frame \(self.panel.frame) visible \(self.panel.isVisible) key \(self.panel.isKeyWindow) shape \(self.shape)")
            }
        default: break
        }
    }
}

signal(SIGPIPE, SIG_IGN)  // a child that exits before reading its input must not take the app with it
let app = NSApplication.shared
let delegate = App()
app.delegate = delegate
app.setActivationPolicy(.accessory)  // menu bar only: no Dock icon, never steals the foreground
app.run()
