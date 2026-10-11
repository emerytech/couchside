import Foundation
import Security

/// Per-transfer trust: a self-signed box is identified by its paired RSA key.
/// Never changes URLSession.shared, the system trust store, or other API clients.
final class PinnedUpload: NSObject, URLSessionDataDelegate, URLSessionTaskDelegate, @unchecked Sendable {
  private let pin: String
  private let destination: URL
  private let file: URL
  private let size: Int64
  private let progress: (Int64, Int64) -> Void
  private let complete: (Int?, String?) -> Void
  private var session: URLSession?
  private var task: URLSessionUploadTask?
  private var response = Data()
  private var status: Int?
  private var lastProgress = Date.distantPast
  private var failed = false

  init(host: String, port: Int, modulus: String, ticket: String, name: String, file: URL,
       progress: @escaping (Int64, Int64) -> Void, complete: @escaping (Int?, String?) -> Void) throws {
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

  func cancel() { task?.cancel() }

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
    session.invalidateAndCancel()
    self.session = nil
    self.task = nil
    // Never expose the native error's URL (which contains the scoped ticket).
    complete(ok && body != nil ? status : nil, body)
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
