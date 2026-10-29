import Foundation

// All lifecycle calls are serialized on the main queue. The small injectable
// boundary lets tests exercise delayed grants/cancellation without faking UIKit.
protocol UploadContinuationTask: AnyObject {
  var onExpiration: (() -> Void)? { get set }
  func report(sent: Int64, total: Int64)
  func finish(success: Bool)
}

protocol UploadContinuationScheduler: AnyObject {
  func register(_ handler: @escaping (UploadContinuationTask) -> Void) -> Bool
  func submit() throws
  func cancelPending()
}

final class UploadContinuationCoordinator {
  private let scheduler: UploadContinuationScheduler
  private var registered: Bool?
  private var owner: UploadContinuationLease?

  init(scheduler: UploadContinuationScheduler) { self.scheduler = scheduler }

  func begin(total: Int64, granted: @escaping () -> Void, expired: @escaping () -> Void) -> UploadContinuationLease? {
    precondition(Thread.isMainThread)
    guard owner == nil else { return nil }
    if registered == nil {
      registered = scheduler.register { [weak self] task in
        guard let self, let owner = self.owner else { task.finish(success: false); return }
        owner.receive(task)
      }
    }
    guard registered == true else { return nil }
    let lease = UploadContinuationLease(total: total, granted: granted, expired: expired, cancelPending: { [weak self] in self?.scheduler.cancelPending() }) { [weak self] lease in
      if self?.owner === lease { self?.owner = nil }
    }
    owner = lease
    do { try scheduler.submit() }
    catch { owner = nil; lease.abandon(); return nil }
    return lease
  }

}

final class UploadContinuationLease {
  private var task: UploadContinuationTask?
  private var completed = false
  private var sent: Int64 = 0
  private let total: Int64
  private var granted: (() -> Void)?
  private var expired: (() -> Void)?
  private let release: (UploadContinuationLease) -> Void
  private let cancelPending: () -> Void

  init(total: Int64, granted: @escaping () -> Void, expired: @escaping () -> Void,
       cancelPending: @escaping () -> Void, release: @escaping (UploadContinuationLease) -> Void) {
    self.total = total
    self.granted = granted
    self.expired = expired
    self.release = release
    self.cancelPending = cancelPending
  }

  fileprivate func receive(_ task: UploadContinuationTask) {
    precondition(Thread.isMainThread)
    // A cancelled pending request may already have dispatched its launch handler.
    // Keep its retired owner until that callback arrives: never assign an old
    // grant to a newer upload. At most one retired owner exists per process.
    guard !completed else { task.finish(success: false); release(self); return }
    guard self.task == nil else { task.finish(success: false); return }
    self.task = task
    task.onExpiration = { [weak self] in
      guard let self, !self.completed else { return }
      let notify = self.expired
      self.finish(success: false)
      notify?()
    }
    task.report(sent: sent, total: total)
    let notify = granted
    granted = nil
    notify?()
  }

  func report(sent: Int64) {
    precondition(Thread.isMainThread)
    guard !completed else { return }
    self.sent = max(self.sent, min(max(0, sent), total))
    task?.report(sent: self.sent, total: total)
  }

  func finish(success: Bool) {
    precondition(Thread.isMainThread)
    guard !completed else { return }
    completed = true
    granted = nil
    expired = nil
    if let task {
      task.onExpiration = nil
      task.finish(success: success)
      self.task = nil
      release(self)
    } else { cancelPending() }
    // When still pending, the coordinator retains a callback-free tombstone.
    // A late callback completes only that cancelled task. Until then new uploads
    // use the foreground fallback instead of risking a stale task association.
  }

  fileprivate func abandon() {
    completed = true
    granted = nil
    expired = nil
  }
}

#if canImport(UIKit) && canImport(BackgroundTasks) && !targetEnvironment(macCatalyst)
import UIKit
import BackgroundTasks

@available(iOS 26.0, *)
final class AppleUploadContinuationScheduler: UploadContinuationScheduler {
  // One explicit identifier, registered once. No filename, host, pin or ticket
  // is put into scheduler identifiers or the system activity.
  static let identifier = "com.ets3d.rescueremote.secure-upload"
  static let shared = UploadContinuationCoordinator(scheduler: AppleUploadContinuationScheduler())

  func register(_ handler: @escaping (UploadContinuationTask) -> Void) -> Bool {
    let permitted = Bundle.main.object(forInfoDictionaryKey: "BGTaskSchedulerPermittedIdentifiers") as? [String] ?? []
    guard permitted.contains(Self.identifier) else { return false }
    return BGTaskScheduler.shared.register(forTaskWithIdentifier: Self.identifier, using: .main) { task in
      guard let continued = task as? BGContinuedProcessingTask else { task.setTaskCompleted(success: false); return }
      handler(AppleUploadContinuationTask(task: continued))
    }
  }

  func submit() throws {
    guard UIApplication.shared.applicationState == .active else { throw SubmissionError.notForeground }
    let request = BGContinuedProcessingTaskRequest(identifier: Self.identifier,
      title: "Sending file to your box", subtitle: "Encrypted transfer")
    // Never queue a one-use upload for later: its ticket may no longer be valid.
    request.strategy = .fail
    try BGTaskScheduler.shared.submit(request)
  }

  func cancelPending() { BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: Self.identifier) }
  private enum SubmissionError: Error { case notForeground }
}

@available(iOS 26.0, *)
private final class AppleUploadContinuationTask: UploadContinuationTask {
  private let task: BGContinuedProcessingTask
  var onExpiration: (() -> Void)?
  private var completed = false
  private var lastPercent = -1

  init(task: BGContinuedProcessingTask) {
    self.task = task
    task.expirationHandler = { [weak self] in
      DispatchQueue.main.async { self?.onExpiration?() }
    }
  }

  func report(sent: Int64, total: Int64) {
    guard !completed else { return }
    task.progress.totalUnitCount = max(1, total)
    // Uploaded bytes are not a server acknowledgement. Reserve the final unit
    // until the pinned server responds successfully.
    task.progress.completedUnitCount = min(sent, max(0, total - 1))
    let percent = Int(task.progress.fractionCompleted * 100)
    if percent != lastPercent {
      lastPercent = percent
      task.updateTitle("Sending file to your box", subtitle: sent >= total ? "Waiting for box confirmation" : "Encrypted transfer · \(percent)%")
    }
  }

  func finish(success: Bool) {
    guard !completed else { return }
    completed = true
    onExpiration = nil
    task.expirationHandler = nil
    if success {
      task.progress.completedUnitCount = task.progress.totalUnitCount
      task.updateTitle("Transfer complete", subtitle: "Encrypted transfer · 100%")
    }
    task.setTaskCompleted(success: success)
  }
}
#endif
