import AppKit
import Darwin
import Foundation
import SwiftUI

// OpenCodex macOS companion: one status item plus a native AppKit/SwiftUI app
// window. A file lock prevents compile-check leftovers or a second launchd
// start from stacking extra icons.

private let appName = "OpenCodex"
private let defaultPort: UInt16 = 10100
private let pollInterval: TimeInterval = 10
private let apiTimeout: TimeInterval = 4
private let singletonNotification = Notification.Name("com.opencodex.menubar.show")

private final class SingletonLock {
    let fd: Int32

    static func path() -> String {
        let home = ProcessInfo.processInfo.environment["OPENCODEX_HOME"]
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".opencodex").path
        let dir = (home as NSString).appendingPathComponent("menubar")
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        return (dir as NSString).appendingPathComponent("singleton.lock")
    }

    init?() {
        let fd = open(Self.path(), O_CREAT | O_RDWR, 0o600)
        guard fd >= 0 else { return nil }
        if flock(fd, LOCK_EX | LOCK_NB) != 0 {
            close(fd)
            return nil
        }
        self.fd = fd
    }

    deinit {
        flock(fd, LOCK_UN)
        close(fd)
    }
}

private var singletonLock: SingletonLock?

// MARK: - Configuration

private struct OcxConfig {
    var home: String
    var port: UInt16 = defaultPort
    var apiKey: String?

    init() {
        self.home = ProcessInfo.processInfo.environment["OPENCODEX_HOME"]
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".opencodex").path
        self.port = Self.discoverPort(home: self.home)
        self.apiKey = Self.readToken(path: (self.home as NSString).appendingPathComponent("admin-api-token"))
    }

    var baseURL: URL {
        URL(string: "http://127.0.0.1:\(port)")!
    }

    var dashboardURL: URL {
        baseURL
    }

    private static func discoverPort(home: String) -> UInt16 {
        let fm = FileManager.default
        let candidates = [
            (home as NSString).appendingPathComponent("runtime-port.json"),
            (home as NSString).appendingPathComponent("config.json"),
        ]
        for path in candidates {
            guard let data = fm.contents(atPath: path),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
            if let port = json["port"] as? UInt16 {
                return port
            }
            if let listen = json["listen"] as? [String: Any],
               let port = listen["port"] as? UInt16 {
                return port
            }
        }
        return defaultPort
    }

    private static func readToken(path: String) -> String? {
        guard let data = FileManager.default.contents(atPath: path),
              let raw = String(data: data, encoding: .utf8) else { return nil }
        return raw.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

// MARK: - API types

private struct CodexAccount: Codable {
    let id: String
    let alias: String?
    let email: String?
    let plan: String?
    let isMain: Bool
    let paused: Bool
    let priority: Int?
    let quota: AccountQuota?
    let needsReauth: Bool?
    let healthLabel: String?
    let healthSummary: String?
}

private struct AccountsResponse: Codable {
    let accounts: [CodexAccount]
}

private struct AccountQuota: Codable {
    let weeklyPercent: Double?
    let monthlyPercent: Double?
    let weeklyResetAt: Double?
    let monthlyResetAt: Double?
}

/// WHAM/OpenCodex `weeklyPercent` is remaining quota. The menu shows percent used.
private func usedQuotaPercent(_ remaining: Double) -> Int {
    Int(max(0, min(100, 100 - remaining)).rounded())
}

private func maskEmail(_ email: String) -> String {
    let parts = email.split(separator: "@", maxSplits: 1, omittingEmptySubsequences: false)
    guard parts.count == 2, !parts[0].isEmpty, !parts[1].isEmpty else { return email }
    let local = String(parts[0])
    let domain = String(parts[1])
    if local.count == 1 { return "*@\(domain)" }
    if local.count == 2 { return "\(local.prefix(1))*@\(domain)" }
    return "\(local.prefix(1))***\(local.suffix(1))@\(domain)"
}

private func jwtEmail(from token: String) -> String? {
    let parts = token.split(separator: ".", omittingEmptySubsequences: false)
    guard parts.count >= 2 else { return nil }
    var payload = String(parts[1])
        .replacingOccurrences(of: "-", with: "+")
        .replacingOccurrences(of: "_", with: "/")
    while payload.count % 4 != 0 { payload.append("=") }
    guard let data = Data(base64Encoded: payload),
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let email = json["email"] as? String else { return nil }
    let trimmed = email.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
}

private func collectLocalEmails(opencodexHome: String) -> [String] {
    var emails: [String] = []
    let fm = FileManager.default
    let home = fm.homeDirectoryForCurrentUser

    func appendEmail(_ value: String?) {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              value.contains("@") else { return }
        if !emails.contains(where: { $0.caseInsensitiveCompare(value) == .orderedSame }) {
            emails.append(value)
        }
    }

    let authPath = home.appendingPathComponent(".codex/auth.json").path
    if let data = fm.contents(atPath: authPath),
       let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
        let tokens = json["tokens"] as? [String: Any]
        appendEmail(jwtEmail(from: tokens?["id_token"] as? String ?? ""))
        appendEmail(json["email"] as? String)
    }

    let configPath = (opencodexHome as NSString).appendingPathComponent("config.json")
    if let data = fm.contents(atPath: configPath),
       let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
       let accounts = json["codexAccounts"] as? [[String: Any]] {
        for account in accounts { appendEmail(account["email"] as? String) }
    }

    let codexBar = home.appendingPathComponent("Library/Application Support/CodexBar/managed-codex-accounts.json").path
    if let data = fm.contents(atPath: codexBar),
       let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
       let accounts = json["accounts"] as? [[String: Any]] {
        for account in accounts { appendEmail(account["email"] as? String) }
    }

    return emails
}

private func revealEmail(_ masked: String?, localEmails: [String]) -> String? {
    guard let masked = masked?.trimmingCharacters(in: .whitespacesAndNewlines), !masked.isEmpty else { return nil }
    if !masked.contains("*") { return masked }
    return localEmails.first { maskEmail($0).caseInsensitiveCompare(masked) == .orderedSame }
}

private func accountDisplayName(_ account: CodexAccount, localEmails: [String]) -> String {
    let alias = account.alias?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    if !alias.isEmpty { return alias }
    if let email = revealEmail(account.email, localEmails: localEmails) { return email }
    if let email = account.email, !email.contains("*") { return email }
    return account.isMain ? "Main" : account.id
}

private func accountDetailLine(_ account: CodexAccount) -> String {
    var parts: [String] = []
    if let plan = account.plan, !plan.isEmpty { parts.append(plan) }
    if let weekly = account.quota?.weeklyPercent {
        parts.append("\(usedQuotaPercent(weekly))% used")
    } else if let monthly = account.quota?.monthlyPercent {
        parts.append("\(usedQuotaPercent(monthly))% used")
    }
    if let health = account.healthLabel, !health.isEmpty, health != "Healthy" {
        parts.append(health)
    }
    return parts.joined(separator: " · ")
}

private struct ActiveAccount: Codable {
    let activeCodexAccountId: String?
    let pinned: Bool?
    let pinnedAccountId: String?
}

private struct UsageSummary: Codable {
    let summary: UsageTotals
    let models: [UsageModel]
    let accounts: [UsageAccount]
}

private struct UsageTotals: Codable {
    let requests: Int
    let totalTokens: Int
    let outputTokens: Int
    let durationMs: Int?
}

private struct UsageModel: Codable {
    let provider: String
    let model: String
    let requests: Int
    let totalTokens: Int
    let outputTokens: Int
    let durationMs: Int?
}

private struct UsageAccount: Codable {
    let accountLogLabel: String
    let requests: Int
    let totalTokens: Int
    let durationMs: Int?
}

private struct PinRequest: Codable {
    let accountId: String?
}

private struct EmptyBody: Codable {}

private struct ImportCodexBarResponse: Codable {
    let ok: Bool?
    let importedCount: Int?
    let existingCount: Int?
    let failedCount: Int?
    let error: String?
}

private struct LoginStartResponse: Codable {
    let flowId: String?
    let error: String?
}

private struct LoginStatusResponse: Codable {
    let status: String
    let error: String?
}

private enum LoginStartOutcome {
    case ready(flowId: String?)
    case failed(message: String)
}

private struct UsageRow: Identifiable {
    let id: String
    let model: String
    let provider: String
    let requests: Int
    let tokens: Int
    let wallMs: Int
    let tps: Double?
}

// MARK: - State

private final class AppState: NSObject, NSMenuDelegate {
    let config = OcxConfig()
    var statusItem: NSStatusItem?
    var menu: NSMenu?
    var timer: Timer?

    var accounts: [CodexAccount] = []
    var localEmails: [String] = []
    var active: ActiveAccount?
    var usage: UsageSummary?
    var proxyOnline = false
    var selectedRange = UserDefaults.standard.string(forKey: "opencodex.menubar.range") ?? "today"
    // Keep the controller alive after openUsage returns. NSWindow does not own
    // its controller, so a weak reference makes a newly opened window vanish.
    var usageWindowController: UsageWindowController?
    var addingAccount = false
    var importingAccounts = false
    var accountLoginNotice: String?
    var loginPollTask: Task<Void, Never>?

    private let session: URLSession = {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = apiTimeout
        cfg.timeoutIntervalForResource = apiTimeout
        return URLSession(configuration: cfg)
    }()

    func start() {
        DistributedNotificationCenter.default().addObserver(
            self,
            selector: #selector(showExistingInstance(_:)),
            name: singletonNotification,
            object: nil
        )
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.image = menuIcon()
        item.button?.imagePosition = .imageLeading
        item.button?.title = appName
        let menu = NSMenu(title: appName)
        menu.delegate = self
        item.menu = menu
        self.statusItem = item
        self.menu = menu

        Task { await refresh() }
        timer = Timer.scheduledTimer(withTimeInterval: pollInterval, repeats: true) { [weak self] _ in
            Task { await self?.refresh() }
        }
    }

    func stop() {
        timer?.invalidate()
        loginPollTask?.cancel()
    }

    private func menuIcon() -> NSImage? {
        if let image = NSImage(systemSymbolName: "bolt.horizontal.circle", accessibilityDescription: appName) {
            image.isTemplate = true
            return image
        }
        // Fallback to a simple rendered template if SF Symbols is unavailable.
        let size = NSSize(width: 18, height: 18)
        let image = NSImage(size: size)
        image.lockFocus()
        NSColor.labelColor.setFill()
        let rect = NSRect(x: 4, y: 4, width: 10, height: 10)
        let path = NSBezierPath(ovalIn: rect)
        path.fill()
        image.unlockFocus()
        image.isTemplate = true
        return image
    }

    // MARK: Networking

    private func authHeaders() -> [String: String] {
        var headers: [String: String] = [:]
        if let key = config.apiKey, !key.isEmpty {
            headers["x-opencodex-api-key"] = key
        }
        return headers
    }

    @discardableResult
    private func request(path: String, method: String = "GET", body: Encodable? = nil) async throws -> (Data, HTTPURLResponse) {
        guard let url = URL(string: path, relativeTo: config.baseURL) else {
            throw URLError(.badURL)
        }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        for (k, v) in authHeaders() { req.setValue(v, forHTTPHeaderField: k) }
        if let body = body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONEncoder().encode(body)
        }
        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse else {
            throw URLError(.cannotParseResponse)
        }
        return (data, http)
    }

    private func fetchAccounts() async -> [CodexAccount] {
        do {
            let (data, resp) = try await request(path: "/api/codex-auth/accounts")
            guard resp.statusCode == 200 else { return [] }
            return (try? JSONDecoder().decode(AccountsResponse.self, from: data))?.accounts ?? []
        } catch {
            return []
        }
    }

    private func fetchActive() async -> ActiveAccount? {
        do {
            let (data, resp) = try await request(path: "/api/codex-auth/active")
            guard resp.statusCode == 200 else { return nil }
            return try? JSONDecoder().decode(ActiveAccount.self, from: data)
        } catch {
            return nil
        }
    }

    private func fetchUsage() async -> UsageSummary? {
        do {
            let (data, resp) = try await request(path: "/api/usage?range=\(selectedRange)")
            guard resp.statusCode == 200 else { return nil }
            return try? JSONDecoder().decode(UsageSummary.self, from: data)
        } catch {
            return nil
        }
    }

    private func healthCheck() async -> Bool {
        do {
            let (_, resp) = try await request(path: "/healthz")
            return resp.statusCode == 200
        } catch {
            return false
        }
    }

    fileprivate func pinForApp(_ id: String?) async -> Bool {
        return await pinAccount(id)
    }

    private func pinAccount(_ id: String?) async -> Bool {
        do {
            let (_, resp) = try await request(path: "/api/codex-auth/active", method: "PUT", body: PinRequest(accountId: id))
            return resp.statusCode == 200
        } catch {
            return false
        }
    }

    private func importCodexBarAccounts() async -> String {
        do {
            let (data, resp) = try await request(
                path: "/api/codex-auth/accounts/import-codexbar",
                method: "POST",
                body: EmptyBody()
            )
            if resp.statusCode == 404 {
                return "Restart OpenCodex to import CodexBar accounts"
            }
            let decoded = try? JSONDecoder().decode(ImportCodexBarResponse.self, from: data)
            if resp.statusCode != 200 {
                return decoded?.error ?? "Import failed (HTTP \(resp.statusCode))"
            }
            let imported = decoded?.importedCount ?? 0
            let existing = decoded?.existingCount ?? 0
            let failed = decoded?.failedCount ?? 0
            if failed > 0 {
                return "Imported \(imported), already present \(existing), failed \(failed)"
            }
            if imported == 0 && existing > 0 {
                return "All \(existing) CodexBar accounts are already in OpenCodex"
            }
            return "Imported \(imported) CodexBar account\(imported == 1 ? "" : "s")"
        } catch {
            return "Could not reach OpenCodex to import accounts"
        }
    }

    private func startAccountLogin() async -> LoginStartOutcome {
        do {
            // Use the original route so this menu app remains compatible with
            // an already-running proxy and never requires an API rollover just
            // to add an account.
            let (data, resp) = try await request(path: "/api/codex-auth/login", method: "POST")
            let decoded = try? JSONDecoder().decode(LoginStartResponse.self, from: data)
            if resp.statusCode == 200 {
                return .ready(flowId: decoded?.flowId)
            }
            return .failed(message: decoded?.error ?? "Sign-in could not be started (HTTP \(resp.statusCode)).")
        } catch {
            return .failed(message: "Could not connect to OpenCodex to start sign-in.")
        }
    }

    private func fetchLoginStatus(flowId: String?) async -> LoginStatusResponse? {
        let path: String
        if let flowId = flowId,
           let encoded = flowId.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) {
            path = "/api/codex-auth/login-status?flowId=\(encoded)"
        } else {
            // Legacy response shapes may not return a flow id. The endpoint's
            // no-query form reports the latest pending flow.
            path = "/api/codex-auth/login-status"
        }
        do {
            let (data, resp) = try await request(path: path)
            guard resp.statusCode == 200 else { return nil }
            return try? JSONDecoder().decode(LoginStatusResponse.self, from: data)
        } catch {
            return nil
        }
    }

    // MARK: Menu lifecycle

    func menuWillOpen(_ menu: NSMenu) {
        Task { await refresh() }
    }

    fileprivate func refresh() async {
        await MainActor.run {
            self.usageWindowController?.setRefreshing(true)
        }
        let online = await healthCheck()
        let newAccounts = online ? await fetchAccounts() : []
        let newActive = online ? await fetchActive() : nil
        let newUsage = online ? await fetchUsage() : nil
        let emails = collectLocalEmails(opencodexHome: config.home)
        let refreshedAt = newUsage == nil ? nil : Date()
        await MainActor.run {
            self.proxyOnline = online
            self.accounts = newAccounts
            self.localEmails = emails
            self.active = newActive
            self.usage = newUsage
            self.rebuildMenu()
            self.usageWindowController?.update(
                with: newUsage,
                range: self.selectedRange,
                proxyOnline: online,
                refreshedAt: refreshedAt,
                accounts: self.accounts,
                active: self.active,
                localEmails: self.localEmails
            )
        }
    }

    @MainActor
    private func rebuildMenu() {
        guard let menu = self.menu else { return }
        menu.removeAllItems()

        // Proxy status
        menu.addItem(infoItem(proxyOnline ? "Proxy: Online (port \(config.port))" : "Proxy: Offline"))

        // Active account
        if let active = active {
            let label = accountLabel(forId: active.activeCodexAccountId) ?? (active.activeCodexAccountId ?? "Automatic")
            let pinSuffix = (active.pinned == true) ? " · pinned" : ""
            menu.addItem(infoItem("Active: \(label)\(pinSuffix)"))
        }

        menu.addItem(NSMenuItem.separator())

        // Billing account section
        menu.addItem(headerItem("Billing account"))
        let autoItem = NSMenuItem(title: menuTitle(forAutomatic: true), action: #selector(selectAutomatic(_:)), keyEquivalent: "")
        autoItem.target = self
        autoItem.state = (active?.activeCodexAccountId == nil || active?.pinned != true) ? .on : .off
        menu.addItem(autoItem)

        for account in accounts {
            let title = accountMenuTitle(account)
            let item = NSMenuItem(title: title, action: #selector(selectAccount(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = account.id
            let isActive = active?.activeCodexAccountId == account.id && active?.pinned == true
            item.state = isActive ? .on : .off
            item.isEnabled = !account.paused && !(account.needsReauth == true)
            menu.addItem(item)
        }

        if let rollover = nextQuotaResetDate() {
            menu.addItem(infoItem("Next quota reset: \(formatRolloverDate(rollover))"))
        }

        let addAccountItem = NSMenuItem(
            title: addingAccount ? "Waiting for Codex Sign-In..." : "Add Codex Account...",
            action: #selector(addAccount(_:)),
            keyEquivalent: ""
        )
        addAccountItem.target = self
        addAccountItem.image = NSImage(
            systemSymbolName: addingAccount ? "hourglass" : "plus.circle",
            accessibilityDescription: nil
        )
        addAccountItem.isEnabled = proxyOnline && !addingAccount
        menu.addItem(addAccountItem)

        let importItem = NSMenuItem(
            title: importingAccounts ? "Importing CodexBar Accounts..." : "Import CodexBar Accounts...",
            action: #selector(importCodexBar(_:)),
            keyEquivalent: ""
        )
        importItem.target = self
        importItem.image = NSImage(
            systemSymbolName: importingAccounts ? "hourglass" : "square.and.arrow.down",
            accessibilityDescription: nil
        )
        importItem.isEnabled = proxyOnline && !importingAccounts && !addingAccount
        menu.addItem(importItem)

        if let notice = accountLoginNotice, !notice.isEmpty {
            let noticeItem = NSMenuItem(title: notice, action: nil, keyEquivalent: "")
            noticeItem.isEnabled = false
            menu.addItem(noticeItem)
        }

        menu.addItem(NSMenuItem.separator())

        // Usage section
        menu.addItem(headerItem("Usage (\(rangeLabel(selectedRange)))"))
        if let usage = usage, !usage.models.isEmpty {
            let total = usage.summary
            let totalTokens = formatTokens(total.totalTokens)
            let totalWall = formatDuration(total.durationMs ?? 0)
            let totalItem = NSMenuItem(title: "Total: \(totalTokens) tok · \(totalWall) wall", action: nil, keyEquivalent: "")
            totalItem.isEnabled = false
            menu.addItem(totalItem)

            for model in usage.models {
                let tokens = formatTokens(model.totalTokens)
                let wall = formatDuration(model.durationMs ?? 0)
                let tps = formatTps(tokensPerSecond(tokens: model.outputTokens, ms: model.durationMs))
                let item = NSMenuItem(
                    title: "\(model.model) — \(tokens) tok · \(wall) · \(tps)/s",
                    action: nil,
                    keyEquivalent: ""
                )
                item.isEnabled = false
                menu.addItem(item)
            }
        } else {
            let noneItem = NSMenuItem(title: "No usage in this range", action: nil, keyEquivalent: "")
            noneItem.isEnabled = false
            menu.addItem(noneItem)
        }

        // Range submenu
        let rangeMenu = NSMenu()
        for range in ["today", "7d", "30d", "all"] {
            let item = NSMenuItem(title: rangeLabel(range), action: #selector(selectRange(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = range
            item.state = (range == selectedRange) ? .on : .off
            rangeMenu.addItem(item)
        }
        let rangeItem = NSMenuItem(title: "Range", action: nil, keyEquivalent: "")
        rangeItem.submenu = rangeMenu
        menu.addItem(rangeItem)

        menu.addItem(NSMenuItem.separator())

        // Actions
        let refreshItem = NSMenuItem(title: "Refresh Now", action: #selector(refreshNow(_:)), keyEquivalent: "r")
        refreshItem.target = self
        menu.addItem(refreshItem)

        let usageItem = NSMenuItem(title: "Open OpenCodex…", action: #selector(openUsage(_:)), keyEquivalent: "o")
        usageItem.target = self
        menu.addItem(usageItem)

        let quitItem = NSMenuItem(title: "Quit", action: #selector(quit(_:)), keyEquivalent: "q")
        quitItem.target = self
        menu.addItem(quitItem)
    }

    @objc private func menuInfo(_ sender: NSMenuItem) {}

    private func infoItem(_ title: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: #selector(menuInfo(_:)), keyEquivalent: "")
        item.target = self
        return item
    }

    private func headerItem(_ title: String) -> NSMenuItem {
        infoItem(title)
    }

    private func accountLabel(forId id: String?) -> String? {
        guard let id = id else { return nil }
        if let account = accounts.first(where: { $0.id == id }) {
            return accountDisplayName(account, localEmails: localEmails)
        }
        return id == "__main__" ? "Main" : id
    }

    private func accountMenuTitle(_ account: CodexAccount) -> String {
        var parts: [String] = []
        parts.append(accountDisplayName(account, localEmails: localEmails))
        if let plan = account.plan, !plan.isEmpty { parts.append(plan) }
        if let weekly = account.quota?.weeklyPercent {
            parts.append("\(usedQuotaPercent(weekly))% used")
        } else if let monthly = account.quota?.monthlyPercent {
            parts.append("\(usedQuotaPercent(monthly))% used")
        }
        var title = parts.joined(separator: " · ")
        if account.paused || account.needsReauth == true {
            title = "◌ \(title)"
        }
        if let health = account.healthLabel, !health.isEmpty, health != "Healthy" {
            title += " · \(health)"
        }
        return title
    }

    private func nextQuotaResetDate() -> Date? {
        let activeAccount = active?.activeCodexAccountId.flatMap { activeId in
            accounts.first(where: { $0.id == activeId })
        }
        let candidates = activeAccount.map { [$0] } ?? accounts
        return candidates
            .flatMap { account in
                [account.quota?.weeklyResetAt, account.quota?.monthlyResetAt]
                    .compactMap(normalizedResetDate)
            }
            .filter { $0 > Date() }
            .min()
    }

    private func normalizedResetDate(_ timestamp: Double?) -> Date? {
        guard let timestamp = timestamp, timestamp.isFinite, timestamp > 0 else { return nil }
        let seconds = timestamp >= 1_000_000_000_000 ? timestamp / 1_000 : timestamp
        return Date(timeIntervalSince1970: seconds)
    }

    private func formatRolloverDate(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "EEE, MMM d 'at' h:mm a"
        return formatter.string(from: date)
    }

    private func menuTitle(forAutomatic: Bool) -> String {
        let base = "Automatic (pool)"
        return (active?.activeCodexAccountId == nil || active?.pinned != true) ? "✓ \(base)" : base
    }

    private func rangeLabel(_ range: String) -> String {
        switch range {
        case "today": return "Today"
        case "7d": return "7 days"
        case "30d": return "30 days"
        case "all": return "All time"
        default: return range
        }
    }

    // MARK: Actions

    @objc private func selectAccount(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String else { return }
        Task {
            _ = await pinAccount(id)
            await refresh()
        }
    }

    @objc private func selectAutomatic(_ sender: NSMenuItem) {
        Task {
            _ = await pinAccount(nil)
            await refresh()
        }
    }

    @objc @MainActor private func addAccount(_ sender: NSMenuItem) {
        guard proxyOnline, !addingAccount else { return }
        addingAccount = true
        accountLoginNotice = "Complete sign-in in your browser"
        rebuildMenu()

        loginPollTask?.cancel()
        loginPollTask = Task { @MainActor [weak self] in
            guard let self = self else { return }
            let result = await self.startAccountLogin()
            switch result {
            case .failed(let message):
                self.finishAccountLogin(message)
                return
            case .ready(let flowId):
                // The server owns the OAuth browser callback. The menu app only
                // watches the token-safe status endpoint and refreshes accounts
                // once persistence finishes.
                for _ in 0..<150 {
                    if Task.isCancelled { return }
                    try? await Task.sleep(nanoseconds: 2_000_000_000)
                    if Task.isCancelled { return }
                    guard let status = await self.fetchLoginStatus(flowId: flowId) else { continue }
                    switch status.status {
                    case "done":
                        self.addingAccount = false
                        self.accountLoginNotice = "Codex account added"
                        self.rebuildMenu()
                        await self.refresh()
                        return
                    case "error", "expired":
                        self.finishAccountLogin(status.error ?? "Codex sign-in expired. Try again.")
                        return
                    default:
                        continue
                    }
                }
                if !Task.isCancelled {
                    self.finishAccountLogin("Codex sign-in timed out. Try again.")
                }
            }
        }
    }

    @MainActor
    private func finishAccountLogin(_ message: String) {
        addingAccount = false
        accountLoginNotice = String(message.prefix(120))
        rebuildMenu()
    }

    @objc @MainActor private func importCodexBar(_ sender: NSMenuItem) {
        guard proxyOnline, !importingAccounts, !addingAccount else { return }
        importingAccounts = true
        accountLoginNotice = nil
        rebuildMenu()
        Task {
            let notice = await self.importCodexBarAccounts()
            await MainActor.run {
                self.importingAccounts = false
                self.accountLoginNotice = String(notice.prefix(120))
                self.rebuildMenu()
            }
            await self.refresh()
        }
    }

    @objc private func selectRange(_ sender: NSMenuItem) {
        guard let range = sender.representedObject as? String else { return }
        selectedRange = range
        UserDefaults.standard.set(range, forKey: "opencodex.menubar.range")
        Task { await refresh() }
    }

    @objc private func refreshNow(_ sender: NSMenuItem) {
        Task { await refresh() }
    }

    @objc private func showExistingInstance(_ notification: Notification) {
        presentApp()
    }

    fileprivate func presentApp() {
        if #available(macOS 12.0, *) {
            NSApp.setActivationPolicy(.regular)
            openUsage(NSMenuItem())
        }
    }

    @objc private func openUsage(_ sender: NSMenuItem) {
        if #available(macOS 12.0, *) {
            NSApp.setActivationPolicy(.regular)
            if let controller = usageWindowController {
                controller.showWindow(nil)
                NSApp.activate(ignoringOtherApps: true)
                controller.window?.makeKeyAndOrderFront(nil)
                return
            }
            let controller = UsageWindowController(appState: self)
            usageWindowController = controller
            controller.showWindow(nil)
            NSApp.activate(ignoringOtherApps: true)
            controller.window?.makeKeyAndOrderFront(nil)
        }
    }

    @objc private func quit(_ sender: NSMenuItem) {
        stop()
        NSApp.terminate(nil)
    }
}

// MARK: - Usage window

@available(macOS 12.0, *)
private enum AppPane: String, CaseIterable, Identifiable {
    case usage
    case accounts
    var id: String { rawValue }
    var title: String {
        switch self {
        case .usage: return "Usage"
        case .accounts: return "Accounts"
        }
    }
}

@available(macOS 12.0, *)
private final class UsageViewModel: ObservableObject {
    @Published var selectedRange: String
    @Published var usage: UsageSummary?
    @Published var proxyOnline: Bool
    @Published var isRefreshing = false
    @Published var refreshedAt: Date?
    @Published var pane: AppPane = .usage
    @Published var accounts: [CodexAccount] = []
    @Published var active: ActiveAccount?
    @Published var localEmails: [String] = []
    var onRangeChange: ((String) -> Void)?
    var onRefresh: (() -> Void)?
    var onPin: ((String?) -> Void)?

    var rows: [UsageRow] {
        guard let usage = usage else { return [] }
        return usage.models.map { model in
            UsageRow(
                id: "\(model.provider)\u{0}\(model.model)",
                model: model.model,
                provider: model.provider,
                requests: model.requests,
                tokens: model.totalTokens,
                wallMs: model.durationMs ?? 0,
                tps: tokensPerSecond(tokens: model.outputTokens, ms: model.durationMs)
            )
        }
    }

    var totalTps: Double? {
        guard let usage = usage else { return nil }
        return tokensPerSecond(tokens: usage.summary.outputTokens, ms: usage.summary.durationMs)
    }

    init(selectedRange: String, usage: UsageSummary?, proxyOnline: Bool) {
        self.selectedRange = selectedRange
        self.usage = usage
        self.proxyOnline = proxyOnline
    }

    func selectRange(_ range: String) {
        guard range != selectedRange else { return }
        selectedRange = range
        isRefreshing = true
        onRangeChange?(range)
    }

    func refresh() {
        isRefreshing = true
        onRefresh?()
    }
}

@available(macOS 12.0, *)
private struct UsageView: View {
    @StateObject var viewModel: UsageViewModel

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 12) {
                Image(systemName: viewModel.pane == .usage ? "chart.bar.xaxis" : "person.2")
                    .font(.system(size: 22, weight: .semibold))
                    .foregroundStyle(.tint)
                    .frame(width: 30)

                VStack(alignment: .leading, spacing: 2) {
                    Text(viewModel.pane == .usage ? "Model usage" : "Billing accounts")
                        .font(.title2.weight(.semibold))
                    HStack(spacing: 6) {
                        Circle()
                            .fill(viewModel.proxyOnline ? Color.green : Color.red)
                            .frame(width: 7, height: 7)
                        Text(viewModel.proxyOnline ? "OpenCodex is online" : "OpenCodex is offline")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                Spacer()

                Picker("Pane", selection: $viewModel.pane) {
                    ForEach(AppPane.allCases) { pane in
                        Text(pane.title).tag(pane)
                    }
                }
                .pickerStyle(.segmented)
                .frame(width: 180)

                if viewModel.pane == .usage {
                    Picker("Range", selection: Binding(
                        get: { viewModel.selectedRange },
                        set: { viewModel.selectRange($0) }
                    )) {
                        Text("Today").tag("today")
                        Text("7 days").tag("7d")
                        Text("30 days").tag("30d")
                        Text("All time").tag("all")
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    .frame(width: 290)
                }

                Button(action: { viewModel.refresh() }) {
                    if viewModel.isRefreshing {
                        ProgressView()
                            .controlSize(.small)
                            .frame(width: 16, height: 16)
                    } else {
                        Image(systemName: "arrow.clockwise")
                            .frame(width: 16, height: 16)
                    }
                }
                .buttonStyle(.bordered)
                .help("Refresh")
                .disabled(viewModel.isRefreshing)
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 16)

            Divider()

            if viewModel.pane == .accounts {
                AccountsPane(viewModel: viewModel)
            } else if let usage = viewModel.usage {
                HStack(spacing: 12) {
                    SummaryCard(
                        title: "Total tokens",
                        value: formatTokens(usage.summary.totalTokens),
                        systemImage: "number"
                    )
                    SummaryCard(
                        title: "Wall time",
                        value: formatDuration(usage.summary.durationMs ?? 0),
                        systemImage: "clock"
                    )
                    SummaryCard(
                        title: "Output speed",
                        value: formatTps(viewModel.totalTps),
                        systemImage: "gauge.with.dots.needle.50percent"
                    )
                    SummaryCard(
                        title: "Requests",
                        value: formatCount(usage.summary.requests),
                        systemImage: "arrow.up.arrow.down"
                    )
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 14)

                if viewModel.rows.isEmpty {
                    Spacer()
                    EmptyUsageView(
                        title: "No usage in this range",
                        message: "New model requests will appear here automatically."
                    )
                    Spacer()
                } else {
                    Table(viewModel.rows) {
                        TableColumn("Model") { row in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(row.model)
                                    .fontWeight(.medium)
                                    .lineLimit(1)
                                Text(row.provider)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                            }
                            .padding(.vertical, 3)
                        }
                        .width(min: 180, ideal: 250)

                        TableColumn("Requests") { row in
                            Text(formatCount(row.requests))
                                .monospacedDigit()
                                .frame(maxWidth: .infinity, alignment: .trailing)
                        }
                        .width(min: 70, ideal: 85)

                        TableColumn("Tokens") { row in
                            Text(formatTokens(row.tokens))
                                .monospacedDigit()
                                .frame(maxWidth: .infinity, alignment: .trailing)
                        }
                        .width(min: 75, ideal: 95)

                        TableColumn("Wall time") { row in
                            Text(formatDuration(row.wallMs))
                                .monospacedDigit()
                                .frame(maxWidth: .infinity, alignment: .trailing)
                        }
                        .width(min: 85, ideal: 105)

                        TableColumn("tok/s") { row in
                            Text(formatTps(row.tps))
                                .monospacedDigit()
                                .frame(maxWidth: .infinity, alignment: .trailing)
                        }
                        .width(min: 80, ideal: 100)
                    }
                    .tableStyle(.inset(alternatesRowBackgrounds: true))
                }
            } else if viewModel.isRefreshing {
                Spacer()
                ProgressView("Loading usage...")
                    .controlSize(.regular)
                Spacer()
            } else {
                Spacer()
                EmptyUsageView(
                    title: viewModel.proxyOnline ? "Usage is unavailable" : "OpenCodex is offline",
                    message: viewModel.proxyOnline
                        ? "Try refreshing in a moment."
                        : "Start the proxy, then refresh this window."
                )
                Spacer()
            }

            Divider()

            HStack {
                Text("tok/s uses output tokens divided by request wall time.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                if let refreshedAt = viewModel.refreshedAt {
                    Text("Updated \(refreshedAt.formatted(date: .omitted, time: .standard))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 9)
        }
        .frame(minWidth: 720, minHeight: 430)
    }
}

@available(macOS 12.0, *)
private struct AccountsPane: View {
    @ObservedObject var viewModel: UsageViewModel

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Button("Automatic pool rotation") {
                viewModel.onPin?(nil)
            }
            .buttonStyle(.bordered)
            .disabled(!viewModel.proxyOnline)

            if viewModel.accounts.isEmpty {
                Spacer()
                EmptyUsageView(
                    title: "Only the main Codex login is loaded",
                    message: "Restart OpenCodex, then use Import CodexBar Accounts in the menu."
                )
                Spacer()
            } else {
                List(viewModel.accounts, id: \.id) { account in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(accountDisplayName(account, localEmails: viewModel.localEmails))
                                .fontWeight(.medium)
                            Text(accountDetailLine(account))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        if viewModel.active?.activeCodexAccountId == account.id && viewModel.active?.pinned == true {
                            Image(systemName: "checkmark.circle.fill")
                                .foregroundStyle(.tint)
                        }
                        Button("Use") {
                            viewModel.onPin?(account.id)
                        }
                        .disabled(!viewModel.proxyOnline || account.paused || account.needsReauth == true)
                    }
                }
            }
        }
        .padding(16)
    }
}

@available(macOS 12.0, *)
private struct SummaryCard: View {
    let title: String
    let value: String
    let systemImage: String

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: systemImage)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(.tint)
                .frame(width: 28, height: 28)
                .background(Color.accentColor.opacity(0.12), in: RoundedRectangle(cornerRadius: 7))
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(value)
                    .font(.headline)
                    .monospacedDigit()
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .frame(maxWidth: .infinity)
        .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 10))
        .overlay {
            RoundedRectangle(cornerRadius: 10)
                .stroke(Color.primary.opacity(0.08), lineWidth: 1)
        }
    }
}

@available(macOS 12.0, *)
private struct EmptyUsageView: View {
    let title: String
    let message: String

    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: "chart.bar.xaxis")
                .font(.system(size: 28))
                .foregroundStyle(.tertiary)
            Text(title)
                .font(.headline)
            Text(message)
                .font(.callout)
                .foregroundStyle(.secondary)
        }
        .multilineTextAlignment(.center)
        .padding()
    }
}

@available(macOS 12.0, *)
private final class UsageWindowController: NSWindowController {
    private weak var appState: AppState?
    private let viewModel: UsageViewModel

    init(appState: AppState) {
        self.appState = appState
        let viewModel = UsageViewModel(
            selectedRange: appState.selectedRange,
            usage: appState.usage,
            proxyOnline: appState.proxyOnline
        )
        self.viewModel = viewModel
        viewModel.onRangeChange = { [weak appState] range in
            appState?.selectedRange = range
            UserDefaults.standard.set(range, forKey: "opencodex.menubar.range")
            Task { await appState?.refresh() }
        }
        viewModel.onRefresh = { [weak appState] in
            Task { await appState?.refresh() }
        }
        viewModel.onPin = { [weak appState] accountId in
            Task {
                _ = await appState?.pinForApp(accountId)
                await appState?.refresh()
            }
        }
        viewModel.accounts = appState.accounts
        viewModel.active = appState.active
        viewModel.localEmails = appState.localEmails

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 920, height: 560),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "OpenCodex"
        window.isReleasedWhenClosed = false
        window.setFrameAutosaveName("OpenCodexAppWindow")
        window.center()
        window.contentViewController = NSHostingController(rootView: UsageView(viewModel: viewModel))
        super.init(window: window)
        window.delegate = self
    }

    required init?(coder: NSCoder) {
        nil
    }

    func setRefreshing(_ refreshing: Bool) {
        viewModel.isRefreshing = refreshing
    }

    func update(
        with usage: UsageSummary?,
        range: String,
        proxyOnline: Bool,
        refreshedAt: Date?,
        accounts: [CodexAccount],
        active: ActiveAccount?,
        localEmails: [String]
    ) {
        viewModel.selectedRange = range
        viewModel.usage = usage
        viewModel.proxyOnline = proxyOnline
        viewModel.isRefreshing = false
        viewModel.accounts = accounts
        viewModel.active = active
        viewModel.localEmails = localEmails
        if let refreshedAt = refreshedAt {
            viewModel.refreshedAt = refreshedAt
        }
    }
}

@available(macOS 12.0, *)
extension UsageWindowController: NSWindowDelegate {
    func windowWillClose(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
    }
}

// MARK: - Formatting

private func formatTokens(_ value: Int) -> String {
    if value >= 1_000_000 {
        return String(format: "%.2fM", Double(value) / 1_000_000)
    } else if value >= 1_000 {
        return String(format: "%.1fk", Double(value) / 1_000)
    }
    return "\(value)"
}

private func formatDuration(_ ms: Int) -> String {
    if ms <= 0 { return "—" }
    if ms < 1_000 { return "\(ms) ms" }
    if ms < 10_000 { return String(format: "%.1fs", Double(ms) / 1_000.0) }
    let totalSeconds = ms / 1000
    let hours = totalSeconds / 3600
    let minutes = (totalSeconds % 3600) / 60
    let seconds = totalSeconds % 60
    if hours > 0 {
        return String(format: "%dh %02dm %02ds", hours, minutes, seconds)
    } else if minutes > 0 {
        return String(format: "%dm %02ds", minutes, seconds)
    } else {
        return "\(seconds)s"
    }
}

private func formatCount(_ value: Int) -> String {
    let formatter = NumberFormatter()
    formatter.numberStyle = .decimal
    return formatter.string(from: NSNumber(value: value)) ?? "\(value)"
}

private func tokensPerSecond(tokens: Int, ms: Int?) -> Double? {
    guard tokens > 0, let ms = ms, ms > 0 else { return nil }
    return Double(tokens) / (Double(ms) / 1000.0)
}

private func formatTps(_ tps: Double?) -> String {
    guard let tps = tps, tps.isFinite, tps > 0 else { return "—" }
    let value: String
    if tps >= 1_000_000 {
        value = String(format: "%.2fM", tps / 1_000_000)
    } else if tps >= 1_000 {
        value = String(format: "%.1fk", tps / 1_000)
    } else {
        value = String(format: "%.1f", tps)
    }
    return value
}

// MARK: - Entry

autoreleasepool {
    if let lock = SingletonLock() {
        singletonLock = lock
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let delegate = AppState()
        app.delegate = delegate
        delegate.start()
        app.run()
    } else {
        DistributedNotificationCenter.default().postNotificationName(
            singletonNotification,
            object: nil,
            userInfo: nil,
            deliverImmediately: true
        )
    }
}

extension AppState: NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {}

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        presentApp()
        return true
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return false
    }
}
