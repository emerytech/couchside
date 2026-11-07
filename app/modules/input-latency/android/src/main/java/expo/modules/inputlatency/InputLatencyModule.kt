package expo.modules.inputlatency

import android.content.Context
import android.net.wifi.WifiManager
import android.os.Build
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** Foreground controller lease only; no Wi-Fi credentials, scans or configuration. */
class InputLatencyModule : Module() {
  private var wifiLock: WifiManager.WifiLock? = null
  private var foreground = true

  override fun definition() = ModuleDefinition {
    Name("InputLatency")
    AsyncFunction("setEnabled") { enabled: Boolean -> setEnabled(enabled) }
    OnActivityEntersForeground { synchronized(this@InputLatencyModule) { foreground = true } }
    OnActivityEntersBackground { synchronized(this@InputLatencyModule) { foreground = false; release() } }
    OnDestroy { synchronized(this@InputLatencyModule) { foreground = false; release() } }
  }

  @Synchronized
  private fun setEnabled(enabled: Boolean): Boolean {
    if (!enabled || !foreground) { release(); return false }
    return try {
      if (wifiLock == null) {
        val context = appContext.reactContext?.applicationContext ?: return false
        val manager = context.getSystemService(Context.WIFI_SERVICE) as? WifiManager ?: return false
        val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) WifiManager.WIFI_MODE_FULL_LOW_LATENCY else WifiManager.WIFI_MODE_FULL_HIGH_PERF
        wifiLock = manager.createWifiLock(mode, "Couchside:controller").apply { setReferenceCounted(false) }
      }
      wifiLock?.let { if (!it.isHeld) it.acquire(); it.isHeld } ?: false
    } catch (_: Exception) { release(); false }
  }

  private fun release() {
    try { wifiLock?.let { if (it.isHeld) it.release() } } catch (_: Exception) { }
  }
}
