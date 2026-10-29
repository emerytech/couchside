import Foundation

final class FakeTask: UploadContinuationTask {
  var onExpiration: (() -> Void)?
  var reports: [(Int64, Int64)] = []
  var completions: [Bool] = []
  func report(sent: Int64, total: Int64) { reports.append((sent, total)) }
  func finish(success: Bool) { completions.append(success) }
}
final class FakeScheduler: UploadContinuationScheduler {
  var handler: ((UploadContinuationTask) -> Void)?
  var registrations = 0, submissions = 0, cancellations = 0
  var permitted = true, reject = false
  func register(_ handler: @escaping (UploadContinuationTask) -> Void) -> Bool {
    registrations += 1; self.handler = handler; return permitted
  }
  func submit() throws { submissions += 1; if reject { throw Failure.rejected } }
  func cancelPending() { cancellations += 1 }
  func grant() -> FakeTask { let task = FakeTask(); handler?(task); return task }
  enum Failure: Error { case rejected }
}
func scenario(_ name: String, _ run: () -> Void) { run(); print("PASS \(name)") }

scenario("grant, monotonic byte progress, completion and identifier reuse") {
  let scheduler = FakeScheduler()
  let c = UploadContinuationCoordinator(scheduler: scheduler)
  var grants = 0
  let lease = c.begin(total: 100, granted: { grants += 1 }, expired: { preconditionFailure() })!
  precondition(grants == 0)
  let task = scheduler.grant(); precondition(grants == 1)
  lease.report(sent: 60); lease.report(sent: 20); lease.report(sent: 200)
  precondition(task.reports.map { $0.0 } == [0, 60, 60, 100])
  lease.finish(success: true); lease.finish(success: false)
  precondition(task.completions == [true])
  let next = c.begin(total: 10, granted: {}, expired: {})!
  let nextTask = scheduler.grant(); next.finish(success: false)
  precondition(nextTask.completions == [false] && scheduler.registrations == 1 && scheduler.submissions == 2)
}
scenario("denied registration uses fallback and never submits") {
  let s = FakeScheduler(); s.permitted = false
  let c = UploadContinuationCoordinator(scheduler: s)
  precondition(c.begin(total: 1, granted: { preconditionFailure() }, expired: {}) == nil)
  precondition(c.begin(total: 1, granted: {}, expired: {}) == nil)
  precondition(s.registrations == 1 && s.submissions == 0)
}
scenario("submission failure releases owner for a later upload") {
  let s = FakeScheduler(); s.reject = true
  let c = UploadContinuationCoordinator(scheduler: s)
  precondition(c.begin(total: 1, granted: { preconditionFailure() }, expired: {}) == nil)
  s.reject = false
  let lease = c.begin(total: 1, granted: {}, expired: {})!
  let task = s.grant(); lease.finish(success: true)
  precondition(task.completions == [true] && s.registrations == 1)
}
scenario("expiration cancels once and releases the running slot") {
  let s = FakeScheduler()
  let coordinator = UploadContinuationCoordinator(scheduler: s)
  var expired = 0
  let lease = coordinator.begin(total: 10, granted: {}, expired: { expired += 1 })!
  let task = s.grant(), notify = task.onExpiration!
  notify(); notify(); lease.finish(success: true)
  precondition(expired == 1 && task.completions == [false])
  precondition(coordinator.begin(total: 1, granted: {}, expired: {}) != nil)
}
scenario("cancel before grant cannot start or attach to a subsequent upload") {
  let s = FakeScheduler()
  let coordinator = UploadContinuationCoordinator(scheduler: s)
  var grants = 0
  let lease = coordinator.begin(total: 1, granted: { grants += 1 }, expired: { preconditionFailure() })!
  lease.finish(success: false)
  precondition(s.cancellations == 1)
  precondition(coordinator.begin(total: 2, granted: { preconditionFailure() }, expired: {}) == nil)
  let stale = s.grant()
  precondition(stale.completions == [false] && grants == 0)
  let next = coordinator.begin(total: 2, granted: { grants += 1 }, expired: {})!
  let task = s.grant(); precondition(grants == 1); next.finish(success: true)
  precondition(task.completions == [true])
}
scenario("an active task rejects overlap and duplicate launch without replacement") {
  let s = FakeScheduler()
  let coordinator = UploadContinuationCoordinator(scheduler: s)
  let lease = coordinator.begin(total: 10, granted: {}, expired: {})!
  let task = s.grant()
  precondition(coordinator.begin(total: 1, granted: {}, expired: {}) == nil)
  let duplicate = s.grant(); precondition(duplicate.completions == [false])
  lease.finish(success: true); precondition(task.completions == [true])
}
scenario("late expiration after success cannot cancel another transfer") {
  let s = FakeScheduler()
  let c = UploadContinuationCoordinator(scheduler: s)
  let lease = c.begin(total: 1, granted: {}, expired: { preconditionFailure() })!
  let task = s.grant(), staleExpiration = task.onExpiration!
  lease.finish(success: true)
  let next = c.begin(total: 1, granted: {}, expired: {})!
  let nextTask = s.grant(); staleExpiration()
  precondition(nextTask.completions.isEmpty); next.finish(success: true)
}
scenario("native task identifier and build configuration stay aligned") {
  let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
  let source = try! String(contentsOf: root.appendingPathComponent("app/modules/couchside-file-transfer/ios/UploadContinuation.swift"), encoding: .utf8)
  let pattern = try! NSRegularExpression(pattern: #"static let identifier = "([^"]+)""#)
  let range = NSRange(source.startIndex..., in: source)
  let match = pattern.firstMatch(in: source, range: range)!
  let id = String(source[Range(match.range(at: 1), in: source)!])
  let data = try! Data(contentsOf: root.appendingPathComponent("app/app.json"))
  let json = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
  let expo = json["expo"] as! [String: Any], ios = expo["ios"] as! [String: Any]
  let info = ios["infoPlist"] as! [String: Any]
  precondition(id.hasPrefix((ios["bundleIdentifier"] as! String) + "."))
  precondition((info["BGTaskSchedulerPermittedIdentifiers"] as! [String]).filter { $0 == id }.count == 1)
  precondition((info["UIBackgroundModes"] as! [String]).contains("processing"))
}
