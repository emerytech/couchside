package expo.modules.exitreason

import android.app.ActivityManager
import android.content.Context
import android.os.Build
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Why did this app's PREVIOUS process end? Android 11+ (API 30) records it:
 * ActivityManager.getHistoricalProcessExitReasons(ourPackage, 0, 1) returns the
 * newest ApplicationExitInfo for our own package (no permission needed for our
 * own UID). lib/crashLogCore.ts classifyExit() decides what it means; this only
 * reads it.
 *
 * Returns null — never throws — when the API is unavailable (< API 30), there is
 * no record, or anything fails. null means "unknown" to the caller, which then
 * falls back to the session-marker inference worded as "may have".
 *
 * The timestamp is returned as a Double (ms since epoch) so it crosses the bridge
 * as a plain JS number.
 */
class ExitReasonModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ExitReason")

    Function("getLastExitReason") { -> lastExit() }
  }

  private fun lastExit(): Map<String, Any?>? {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return null
    return try {
      val ctx = appContext.reactContext ?: return null
      val am = ctx.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager ?: return null
      val info = am.getHistoricalProcessExitReasons(ctx.packageName, 0, 1).firstOrNull() ?: return null
      mapOf(
        "reason" to info.reason,
        "timestamp" to info.timestamp.toDouble(),
        "status" to info.status,
        "description" to (info.description ?: ""),
        "importance" to info.importance,
      )
    } catch (_: Exception) {
      null
    }
  }
}
