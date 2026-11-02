// Claw Hub menubar: shows how many Claude sessions are working / waiting,
// lists them, and jumps straight to one when you click it.
import AppKit

let base = "http://127.0.0.1:4777"

struct Act: Decodable { let asking: Bool? }
struct Live: Decodable { let pid: Int?; let status: String?; let entrypoint: String?; let inHub: Bool?; let activity: Act? }
struct Convo: Decodable { let id: String; let title: String; let cwd: String?; let bot: Bool?; let live: Live? }
struct Overview: Decodable { let convos: [Convo] }

final class App: NSObject, NSApplicationDelegate, NSMenuDelegate {
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    var live: [Convo] = []
    var reachable = true

    func applicationDidFinishLaunching(_ n: Notification) {
        item.button?.toolTip = "Claw Hub"
        let menu = NSMenu()
        menu.delegate = self
        item.menu = menu
        render()
        poll()
        Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { _ in self.poll() }
        // flip between the two sprite frames
        Timer.scheduledTimer(withTimeInterval: 0.45, repeats: true) { _ in
            self.tick += 1
            let slow = self.pose == "idle" || self.pose == "nap"
            if !slow || self.tick % 2 == 0 { self.frame ^= 1; self.render() }
        }
    }

    var tick = 0
    var frame = 0
    var imageCache: [String: NSImage] = [:]
    var pose: String {
        if !reachable || live.isEmpty { return "nap" }
        if live.contains(where: { $0.live?.status != "busy" && $0.live?.activity?.asking == true }) { return "ask" }
        if live.contains(where: { $0.live?.status == "busy" }) { return "type" }
        return "idle"
    }

    // pixel hermit crab from Frames.swift, drawn as a template image so it follows light/dark menubars
    func crabImage(_ pose: String, _ f: Int) -> NSImage {
        let key = "\(pose)\(f)"
        if let hit = imageCache[key] { return hit }
        let rows = (FRAMES[pose] ?? FRAMES["idle"]!)[f]
        let px: CGFloat = 0.8
        let w = CGFloat(rows[0].count) * px, h = CGFloat(rows.count) * px
        let img = NSImage(size: NSSize(width: w, height: h), flipped: true) { _ in
            NSColor.black.setFill()
            for (y, row) in rows.enumerated() {
                for (x, ch) in row.enumerated() where ch == "#" {
                    NSRect(x: CGFloat(x) * px, y: CGFloat(y) * px, width: px, height: px).fill()
                }
            }
            return true
        }
        img.isTemplate = true
        imageCache[key] = img
        return img
    }

    func poll() {
        guard let url = URL(string: "\(base)/api/overview") else { return }
        URLSession.shared.dataTask(with: url) { data, _, err in
            var next: [Convo] = []
            var ok = false
            if err == nil, let data = data, let o = try? JSONDecoder().decode(Overview.self, from: data) {
                next = o.convos.filter { $0.live != nil && $0.bot != true }
                ok = true
            }
            DispatchQueue.main.async { self.live = next; self.reachable = ok; self.render() }
        }.resume()
    }

    func dot(_ color: NSColor) -> NSAttributedString {
        NSAttributedString(string: "●", attributes: [.foregroundColor: color, .font: NSFont.systemFont(ofSize: 10)])
    }

    let pink = NSColor(red: 1, green: 0.37, blue: 0.64, alpha: 1)
    let green = NSColor(red: 0.18, green: 0.75, blue: 0.44, alpha: 1)

    func render() {
        let busy = live.filter { $0.live?.status == "busy" }.count
        let waiting = live.count - busy
        let s = NSMutableAttributedString()
        let font = NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .semibold)
        item.button?.image = crabImage(pose, frame)
        item.button?.imagePosition = .imageLeft
        if !reachable {
            s.append(NSAttributedString(string: " off", attributes: [.font: font, .foregroundColor: NSColor.secondaryLabelColor]))
        } else {
            if busy > 0 { s.append(NSAttributedString(string: " ")); s.append(dot(pink)); s.append(NSAttributedString(string: "\(busy)", attributes: [.font: font])) }
            if waiting > 0 { s.append(NSAttributedString(string: " ")); s.append(dot(green)); s.append(NSAttributedString(string: "\(waiting)", attributes: [.font: font])) }
        }
        item.button?.attributedTitle = s
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        let busy = live.filter { $0.live?.status == "busy" }.count
        let head = NSMenuItem(title: reachable ? "\(busy) working · \(live.count - busy) waiting for you" : "Claw Hub isn't running", action: nil, keyEquivalent: "")
        head.isEnabled = false
        menu.addItem(head)
        menu.addItem(.separator())
        let sorted = live.sorted { ($0.live?.status == "idle" ? 0 : 1) < ($1.live?.status == "idle" ? 0 : 1) }
        for c in sorted {
            let isBusy = c.live?.status == "busy"
            let where_: String = {
                if c.live?.inHub == true { return "Claw Hub" }
                switch c.live?.entrypoint ?? "" {
                case "claude-vscode": return "VS Code"
                case "claude-desktop": return "Claude app"
                case "cli": return "Terminal"
                default: return c.live?.entrypoint ?? ""
                }
            }()
            let title = c.title.count > 48 ? String(c.title.prefix(46)) + "…" : c.title
            let mi = NSMenuItem(title: "", action: #selector(jump(_:)), keyEquivalent: "")
            let t = NSMutableAttributedString()
            t.append(dot(isBusy ? pink : green))
            t.append(NSAttributedString(string: "  \(title)", attributes: [.font: NSFont.menuFont(ofSize: 13)]))
            t.append(NSAttributedString(string: "   \(isBusy ? "working" : "waiting") · \(where_)", attributes: [.font: NSFont.menuFont(ofSize: 11), .foregroundColor: NSColor.secondaryLabelColor]))
            mi.attributedTitle = t
            mi.representedObject = c
            mi.target = self
            menu.addItem(mi)
        }
        if live.isEmpty && reachable {
            let none = NSMenuItem(title: "No Claude sessions running", action: nil, keyEquivalent: "")
            none.isEnabled = false
            menu.addItem(none)
        }
        menu.addItem(.separator())
        let open = NSMenuItem(title: "Open Claw Hub", action: #selector(openHub), keyEquivalent: "o")
        open.target = self
        menu.addItem(open)
        let quit = NSMenuItem(title: "Quit menubar icon", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        menu.addItem(quit)
    }

    // Waiting/working sessions in a terminal or app: jump there. Hub chats: open the hub on that chat.
    @objc func jump(_ sender: NSMenuItem) {
        guard let c = sender.representedObject as? Convo else { return }
        if c.live?.inHub == true || c.live?.pid == nil { showHub(hash: c.id); return }
        var req = URLRequest(url: URL(string: "\(base)/api/focus")!)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["pid": c.live!.pid!])
        URLSession.shared.dataTask(with: req) { data, _, _ in
            let ok = (data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] })?["ok"] as? Bool ?? false
            if !ok { DispatchQueue.main.async { self.showHub(hash: c.id) } }
        }.resume()
    }

    @objc func openHub() { showHub(hash: "") }

    func showHub(hash: String) {
        let app = NSHomeDirectory() + "/Applications/Claw Hub.app"
        if hash.isEmpty, FileManager.default.fileExists(atPath: app) {
            NSWorkspace.shared.open(URL(fileURLWithPath: app))
            return
        }
        let chrome = "/Applications/Google Chrome.app"
        let url = "\(base)/#\(hash)"
        if FileManager.default.fileExists(atPath: chrome) {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/usr/bin/open")
            p.arguments = ["-na", "Google Chrome", "--args", "--app=\(url)", "--window-size=1400,900"]
            try? p.run()
        } else if let u = URL(string: url) {
            NSWorkspace.shared.open(u)
        }
    }
}

let app = NSApplication.shared
let delegate = App()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
