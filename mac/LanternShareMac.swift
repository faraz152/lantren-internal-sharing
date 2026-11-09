import AppKit
import WebKit

@NSApplicationMain
@MainActor
final class LanternShareAppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var addressField: NSTextField!
    private var statusLabel: NSTextField!
    private var currentURL: URL?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        installMenu()
        buildWindow()
        let saved = UserDefaults.standard.string(forKey: "LanternShareLastAddress") ?? "http://localhost:8787"
        addressField.stringValue = saved
        openAddress()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    private func installMenu() {
        let menu = NSMenu()
        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Quit Lantern Share", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        menu.addItem(appItem)
        NSApp.mainMenu = menu
    }

    private func buildWindow() {
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1180, height: 820),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Lantern Share"
        window.minSize = NSSize(width: 760, height: 560)
        window.center()
        window.isReleasedWhenClosed = false

        let root = NSView()
        root.wantsLayer = true
        root.layer?.backgroundColor = NSColor(calibratedRed: 0.96, green: 0.97, blue: 0.95, alpha: 1).cgColor

        let iconView = NSImageView(image: NSApp.applicationIconImage)
        iconView.imageScaling = .scaleProportionallyUpOrDown
        iconView.setContentHuggingPriority(.required, for: .horizontal)

        let title = NSTextField(labelWithString: "Lantern Share")
        title.font = .systemFont(ofSize: 15, weight: .semibold)
        title.textColor = NSColor(calibratedRed: 0.12, green: 0.27, blue: 0.19, alpha: 1)
        title.setContentHuggingPriority(.required, for: .horizontal)

        addressField = NSTextField()
        addressField.placeholderString = "http://localhost:8787 or a paired host address"
        addressField.font = .systemFont(ofSize: 13)
        addressField.lineBreakMode = .byTruncatingMiddle
        addressField.focusRingType = .default
        addressField.target = self
        addressField.action = #selector(openAddress(_:))

        let openButton = NSButton(title: "Open", target: self, action: #selector(openAddress(_:)))
        openButton.bezelStyle = .rounded
        openButton.keyEquivalent = "\r"
        openButton.contentTintColor = NSColor(calibratedRed: 0.12, green: 0.48, blue: 0.34, alpha: 1)
        openButton.setContentHuggingPriority(.required, for: .horizontal)

        let header = NSStackView(views: [iconView, title, addressField, openButton])
        header.orientation = .horizontal
        header.alignment = .centerY
        header.spacing = 12
        header.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(header)

        statusLabel = NSTextField(labelWithString: "Connect to a Lantern Share host on your local network.")
        statusLabel.font = .systemFont(ofSize: 11)
        statusLabel.textColor = .secondaryLabelColor
        statusLabel.lineBreakMode = .byTruncatingTail
        statusLabel.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(statusLabel)

        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(webView)

        NSLayoutConstraint.activate([
            header.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 18),
            header.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -18),
            header.topAnchor.constraint(equalTo: root.topAnchor, constant: 14),
            header.heightAnchor.constraint(equalToConstant: 36),
            iconView.widthAnchor.constraint(equalToConstant: 30),
            iconView.heightAnchor.constraint(equalToConstant: 30),
            addressField.widthAnchor.constraint(greaterThanOrEqualToConstant: 260),
            statusLabel.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 22),
            statusLabel.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -22),
            statusLabel.topAnchor.constraint(equalTo: header.bottomAnchor, constant: 8),
            webView.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            webView.topAnchor.constraint(equalTo: statusLabel.bottomAnchor, constant: 8),
            webView.bottomAnchor.constraint(equalTo: root.bottomAnchor)
        ])

        window.contentView = root
    }

    @objc private func openAddress(_ sender: Any? = nil) {
        guard let url = normalizedLocalURL(addressField.stringValue) else {
            statusLabel.stringValue = "Enter the local host address printed by Lantern Share, including port 8787."
            return
        }
        currentURL = url
        addressField.stringValue = url.absoluteString
        UserDefaults.standard.set(url.absoluteString, forKey: "LanternShareLastAddress")
        statusLabel.stringValue = "Connecting to \(url.host ?? "your Lantern Share host")…"
        webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData))
    }

    private func normalizedLocalURL(_ input: String) -> URL? {
        var value = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return nil }
        if !value.contains("://") { value = "http://" + value }
        guard var parts = URLComponents(string: value),
              let scheme = parts.scheme?.lowercased(), ["http", "https"].contains(scheme),
              let host = parts.host?.lowercased(),
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              parts.path.isEmpty || parts.path == "/" else { return nil }
        guard host == "localhost" || host == "127.0.0.1" || isPrivateIPv4(host) || host.hasSuffix(".local") || host.hasSuffix(".home.arpa") else { return nil }
        let port = parts.port ?? 8787
        guard (1...65535).contains(port) else { return nil }
        parts.host = host
        parts.port = port
        parts.path = ""
        return parts.url
    }

    private func isPrivateIPv4(_ host: String) -> Bool {
        let octets = host.split(separator: ".").compactMap { Int($0) }
        guard octets.count == 4, octets.allSatisfy({ (0...255).contains($0) }) else { return false }
        return octets[0] == 10 || (octets[0] == 172 && (16...31).contains(octets[1])) || (octets[0] == 192 && octets[1] == 168)
    }

    private func isSameOrigin(_ url: URL) -> Bool {
        guard let currentURL else { return false }
        return url.scheme?.lowercased() == currentURL.scheme?.lowercased()
            && url.host?.lowercased() == currentURL.host?.lowercased()
            && (url.port ?? 80) == (currentURL.port ?? 80)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.allow); return }
        if isSameOrigin(url) || url.scheme == "about" || url.scheme == "blob" || url.scheme == "data" {
            decisionHandler(.allow)
        } else if ["http", "https", "mailto"].contains(url.scheme?.lowercased() ?? "") {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
        } else {
            decisionHandler(.cancel)
        }
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url {
            if isSameOrigin(url) { webView.load(URLRequest(url: url)) }
            else { NSWorkspace.shared.open(url) }
        }
        return nil
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        // WKOpenPanelParameters exposes directory and multi-selection options,
        // but file selection is implicit for an HTML file input.
        panel.canChooseFiles = true
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.beginSheetModal(for: window) { result in
            completionHandler(result == .OK ? panel.urls : nil)
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        statusLabel.stringValue = "Connected directly to \(currentURL?.host ?? "your host") · local network"
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        statusLabel.stringValue = "Could not reach this host. Check its address and that Lantern Share is running."
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = suggestedFilename
        panel.canCreateDirectories = true
        panel.beginSheetModal(for: window) { result in
            guard result == .OK, let destination = panel.url else { completionHandler(nil); return }
            if FileManager.default.fileExists(atPath: destination.path) {
                do { try FileManager.default.removeItem(at: destination) }
                catch { completionHandler(nil); return }
            }
            completionHandler(destination)
        }
    }

    func downloadDidFinish(_ download: WKDownload) {
        statusLabel.stringValue = "Download finished."
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        statusLabel.stringValue = "Download failed: \(error.localizedDescription)"
    }
}
