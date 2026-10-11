import Foundation

// Executes the same URLSession/Security transport used by iOS, on macOS.
let args = CommandLine.arguments
let done = DispatchSemaphore(value: 0)
do {
  let upload = try PinnedUpload(host: "127.0.0.1", port: Int(args[1])!, modulus: args[2], ticket: args[3],
    name: args[5], file: URL(fileURLWithPath: args[4]), progress: { sent, total in
      precondition(sent <= total && sent > 0)
    }, complete: { status, body in
      print("STATUS=\(status ?? 0)")
      if let body { print("BODY=\(body)") }
      done.signal()
    })
  upload.start()
  if args.count > 6 && args[6] == "cancel" {
    DispatchQueue.global().asyncAfter(deadline: .now() + 0.1) { upload.cancel() }
  }
  guard done.wait(timeout: .now() + 40) == .success else { upload.cancel(); fatalError("Fixture deadline") }
} catch { print("STATUS=0"); exit(3) }
