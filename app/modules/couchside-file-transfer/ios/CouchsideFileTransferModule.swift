import ExpoModulesCore

public class CouchsideFileTransferModule: Module {
  private let lock = NSLock()
  private var active: PinnedUpload?

  public func definition() -> ModuleDefinition {
    Name("CouchsideFileTransfer")
    Events("progress")
    AsyncFunction("upload") { (options: [String: String], promise: Promise) in
      self.lock.lock()
      defer { self.lock.unlock() }
      guard self.active == nil else { promise.reject("ERR_UPLOAD_BUSY", "Another file is still sending."); return }
      do {
        guard let uri = options["fileUri"], let file = URL(string: uri), file.isFileURL,
              file.host == nil || file.host == "" || file.host == "localhost",
              let host = options["host"], let port = Int(options["port"] ?? ""),
              let pin = options["pinModulus"], let ticket = options["ticket"],
              let name = options["name"], let id = options["id"] else { throw PinnedUpload.UploadError.invalid }
        let resolved = file.resolvingSymlinksInPath().standardizedFileURL
        let roots = [FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!,
                     FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!,
                     FileManager.default.temporaryDirectory]
        guard roots.contains(where: { resolved.path.hasPrefix($0.resolvingSymlinksInPath().standardizedFileURL.path + "/") })
          else { throw PinnedUpload.UploadError.invalid }
        let upload = try PinnedUpload(host: host, port: port, modulus: pin, ticket: ticket, name: name, file: resolved,
          progress: { [weak self] sent, total in self?.sendEvent("progress", ["id": id, "sent": sent, "total": total]) },
          complete: { [weak self] status, body in
            if let self {
              self.lock.lock(); self.active = nil; self.lock.unlock()
            }
            if let status, let body { promise.resolve(["status": status, "body": body]) }
            else { promise.reject("ERR_UPLOAD_FAILED", "Secure upload failed. Check the box connection and saved pairing, then try again.") }
          })
        self.active = upload
        upload.start()
      } catch {
        promise.reject("ERR_UPLOAD_INVALID", "Could not start the secure upload. Select the file again and check the box pairing.")
      }
    }
    OnDestroy {
      self.lock.lock(); defer { self.lock.unlock() }
      self.active?.cancel()
    }
  }
}
