import Foundation
import Security
#if canImport(UIKit)
import UIKit
#endif

/// Per-transfer trust: a self-signed box is identified by its paired RSA key.
/// Never changes URLSession.shared, the system trust store, or other API clients.
final class PinnedUpload: NSObject, URLSessionDataDelegate, URLSessionTaskDelegate, @unchecked Sendable {
  private let pin: String
  private let destination: URL
  private let file: URL
  private let size: Int64
  private let progress: (Int64, Int64) -> Void
  private let complete: (Int?, String?, Failure?) -> Void
  private var session: URLSession?
  private var task: URLSessionUploadTask?
  private var response = Data()
  private var status: Int?
  private var lastProgress = Date.distantPast
  private var failed = false
  // Lifecycle operations run on the main queue on iOS. Delegate data remains
  // confined to the serial URLSession queue.
  private var started = false
  private var finished = false
  private var cancelled = false
  private var backgroundExpired = false
#if canImport(UIKit)
  private var backgroundTask: UIBackgroundTaskIdentifier = .invalid
#endif

  init(host: String, port: Int, modulus: String, ticket: String, name: String, file: URL,
       progress: @escaping (Int64, Int64) -> Void, complete: @escaping (Int?, String?, Failure?) -> Void) throws {
    guard (1...65535).contains(port), modulus.range(of: "^[0-9a-fA-F]{512,2048}$", options: .regularExpression) != nil,
          ticket.range(of: "^[0-9a-fA-F]{32}$", options: .regularExpression) != nil,
          !host.isEmpty, !host.contains(where: { $0.isWhitespace || "/@?#\\".contains($0) }),
          !name.isEmpty, name != ".", name != "..", !name.contains(where: { $0 == "/" || $0 == "\\" || $0.asciiValue.map { $0 < 32 || $0 == 127 } == true }),
          file.isFileURL else { throw UploadError.invalid }
    var components = URLComponents()
    components.scheme = "https"
    components.host = host.contains(":") && !host.hasPrefix("[") ? "[\(host)]" : host
    components.port = port
    components.path = "/api/upload"
    components.queryItems = [URLQueryItem(name: "name", value: name), URLQueryItem(name: "ticket", value: ticket)]
    // Python parse_qs interprets a raw '+' as a space.
    components.percentEncodedQuery = components.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
    guard let url = components.url else { throw UploadError.invalid }
    let attributes = try FileManager.default.attributesOfItem(atPath: file.path)
    guard attributes[.type] as? FileAttributeType == .typeRegular,
          let length = (attributes[.size] as? NSNumber)?.int64Value,
          length > 0, length <= 8 * 1024 * 1024 * 1024 else { throw UploadError.invalid }
    self.pin = modulus.lowercased().drop(while: { $0 == "0" }).description
    self.destination = url
    self.file = file
    self.size = length
    self.progress = progress
    self.complete = complete
  }

  func start() {
    onLifecycleQueue { self.startTransfer() }
  }

  private func startTransfer() {
    guard !started, !finished else { return }
    started = true
    guard !cancelled else { finish(status: nil, body: nil, failure: .cancelled); return }
#if canImport(UIKit)
    // Keep this pinned, in-process transfer alive for the OS's bounded grace
    // period. This is not a background URLSession or force-quit persistence.
    backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "Couchside secure upload") { [weak self] in
      guard let self, !self.finished else { return }
      self.backgroundExpired = true
      self.task?.cancel()
      self.endBackgroundTask()
    }
    guard backgroundTask != .invalid else {
      finish(status: nil, body: nil, failure: .backgroundExpired)
      return
    }
#endif
    let configuration = URLSessionConfiguration.ephemeral
    configuration.urlCache = nil
    configuration.httpCookieStorage = nil
    configuration.urlCredentialStorage = nil
    configuration.connectionProxyDictionary = [:]
    configuration.waitsForConnectivity = false
    configuration.timeoutIntervalForRequest = 30
    configuration.timeoutIntervalForResource = 2 * 60 * 60
    configuration.tlsMinimumSupportedProtocolVersion = .TLSv12
    configuration.httpMaximumConnectionsPerHost = 1
    let queue = OperationQueue()
    queue.maxConcurrentOperationCount = 1
    let session = URLSession(configuration: configuration, delegate: self, delegateQueue: queue)
    self.session = session
    var request = URLRequest(url: destination)
    request.httpMethod = "POST"
    request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    request.setValue(String(size), forHTTPHeaderField: "Content-Length")
    request.setValue("close", forHTTPHeaderField: "Connection")
    let task = session.uploadTask(with: request, fromFile: file)
    self.task = task
    task.resume()
  }

  func cancel() {
    onLifecycleQueue {
      self.cancelled = true
      self.task?.cancel()
      self.endBackgroundTask()
    }
  }

  private func onLifecycleQueue(_ action: @escaping @Sendable () -> Void) {
#if canImport(UIKit)
    // Always enqueue, including callers already on main: the module may still
    // hold its active-upload lock until start()/cancel() returns.
    DispatchQueue.main.async(execute: action)
#else
    action() // The macOS TLS harness has no UIApplication lifecycle.
#endif
  }

  private func endBackgroundTask() {
#if canImport(UIKit)
    let identifier = backgroundTask
    backgroundTask = .invalid
    if identifier != .invalid { UIApplication.shared.endBackgroundTask(identifier) }
#endif
  }

  private func finish(status: Int?, body: String?, failure: Failure?) {
    guard !finished else { return }
    finished = true
    endBackgroundTask()
    session?.invalidateAndCancel()
    session = nil
    task = nil
    complete(status, body, failure)
  }

  func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                  completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
    guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
          let trust = challenge.protectionSpace.serverTrust,
          let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate],
          let certificate = chain.first,
          let key = SecCertificateCopyKey(certificate),
          Self.matches(key: key, modulus: pin) else {
      completionHandler(.cancelAuthenticationChallenge, nil)
      return
    }
    // TLS proves possession of this exact saved key before the request is sent.
    completionHandler(.useCredential, URLCredential(trust: trust))
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge,
                  completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
    // No HTTP auth retries or proxy credentials. Server trust is session-level.
    completionHandler(.cancelAuthenticationChallenge, nil)
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                  newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
    completionHandler(nil) // including same-origin redirects: never replay a one-use upload
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                  completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
    guard let http = response as? HTTPURLResponse, response.expectedContentLength <= 65536 else {
      failed = true
      completionHandler(.cancel)
      return
    }
    status = http.statusCode
    completionHandler(.allow)
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    guard response.count + data.count <= 65536 else { failed = true; dataTask.cancel(); return }
    response.append(data)
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64,
                  totalBytesSent: Int64, totalBytesExpectedToSend: Int64) {
    let now = Date()
    if totalBytesSent == size || now.timeIntervalSince(lastProgress) >= 0.1 {
      progress(totalBytesSent, size)
      lastProgress = now
    }
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    let ok = error == nil && !failed
    let body = ok ? String(data: response, encoding: .utf8) : nil
    let responseStatus = ok && body != nil ? status : nil
    // Only a numeric URL loading code can cross the bridge. NSError URLs,
    // userInfo and localized descriptions can include the one-use ticket.
    let native = error as NSError?
    let code = native?.domain == NSURLErrorDomain ? native?.code : nil
    onLifecycleQueue {
      let failure: Failure? = self.backgroundExpired ? .backgroundExpired :
        (self.cancelled ? .cancelled : (responseStatus == nil ? .transport(code) : nil))
      self.finish(status: responseStatus, body: body, failure: failure)
    }
  }

  enum Failure {
    case backgroundExpired, cancelled, transport(Int?)

    var message: String {
      switch self {
      case .backgroundExpired:
        return "iOS ended the upload's background time. Keep Couchside open and select the file again."
      case .cancelled:
        return "The upload was cancelled. Select the file again to retry."
      case .transport(let code):
        let detail = code.map { " (network code \($0))" } ?? ""
        return "Secure upload failed\(detail). Check the box connection, then select the file again."
      }
    }
  }

  enum UploadError: Error { case invalid }

  /// SecKey's RSA external representation is PKCS#1 (SEQUENCE of n, e).
  /// Parse bounded DER integers; no ASN.1 library or certificate fetch required.
  static func matches(key: SecKey, modulus: String) -> Bool {
    guard let attributes = SecKeyCopyAttributes(key) as? [CFString: Any],
          attributes[kSecAttrKeyType] as? String == kSecAttrKeyTypeRSA as String,
          let data = SecKeyCopyExternalRepresentation(key, nil) as Data? else { return false }
    var der = DER(bytes: Array(data))
    guard let sequence = der.value(tag: 0x30), der.atEnd else { return false }
    var integers = DER(bytes: sequence)
    guard let n = integers.value(tag: 0x02), let e = integers.value(tag: 0x02), integers.atEnd,
          e == [1, 0, 1], !n.isEmpty else { return false }
    let hex = n.map { String(format: "%02x", $0) }.joined().drop(while: { $0 == "0" })
    return hex == modulus.lowercased().drop(while: { $0 == "0" })
  }
}

private struct DER {
  let bytes: [UInt8]
  var offset = 0
  var atEnd: Bool { offset == bytes.count }
  mutating func value(tag: UInt8) -> [UInt8]? {
    guard offset + 2 <= bytes.count, bytes[offset] == tag else { return nil }
    offset += 1
    var length = Int(bytes[offset]); offset += 1
    if length >= 128 {
      let count = length & 127
      guard count > 0, count <= 3, offset + count <= bytes.count else { return nil }
      length = 0
      for _ in 0..<count { length = length * 256 + Int(bytes[offset]); offset += 1 }
    }
    guard length > 0, offset + length <= bytes.count else { return nil }
    let value = Array(bytes[offset..<offset + length])
    offset += length
    return value
  }
}
