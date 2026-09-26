package expo.modules.appiconswitch

import android.content.ComponentName
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Switches the home-screen icon by enabling exactly ONE launcher component.
 *
 * WHY THIS EXISTS (and not expo-alternate-app-icons' own switch): that module
 * decides the "current" icon from the RUNNING Activity's component name, which
 * Android fixes at launch for the whole process. So a second switch in one
 * session (Pro -> Standard -> Pro) early-returns without touching PackageManager
 * while the JS believes it worked, and the default MainActivity — the only
 * component carrying the couchside:// deep-link filter unless the aliases copy
 * it — stays disabled. We keep that package for what it does well (generating
 * the <activity-alias> entries and adaptive-icon resources at prebuild) and own
 * the switch here, reading the truth from PackageManager every time.
 *
 * INVARIANTS (the safety of a launcher icon is the safety of "can the user open
 * the app at all"):
 *  - The target is looked up in the manifest's declared launcher components; an
 *    unknown name throws and touches nothing (allowlist, never interpolation).
 *  - The target is ENABLED before anything is disabled, and everything else is
 *    disabled only afterwards, so the package never has zero launcher entries.
 *  - DONT_KILL_APP on every call: some OEM launchers kill the process otherwise.
 *  - "Enabled" is computed from PackageManager state, falling back to the
 *    manifest default (android:enabled) when the state is COMPONENT_ENABLED_STATE_DEFAULT.
 */
class AppIconSwitchModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("AppIconSwitch")

    // Alias suffix of the launcher component that is currently enabled, or null
    // for the plain MainActivity. Never throws; null on any failure.
    Function("getEnabledAlias") { -> enabledAliasOrNull() }

    // Enable the launcher component for `alias` (null = MainActivity) and
    // disable every other launcher component. Resolves to the alias now enabled.
    AsyncFunction("setEnabledAlias") { alias: String? -> setEnabledAlias(alias) }
  }

  private val mainName = "MainActivity"

  private fun pm(): PackageManager = appContext.reactContext!!.packageManager
  private fun pkg(): String = appContext.reactContext!!.packageName

  /** Every activity / activity-alias in OUR package whose simple name is MainActivity or MainActivity<Suffix>. */
  private fun launcherComponents(): List<ActivityInfo> {
    val flags = PackageManager.GET_ACTIVITIES or PackageManager.MATCH_DISABLED_COMPONENTS
    val info = pm().getPackageInfo(pkg(), flags)
    val prefix = "$mainName"
    return (info.activities ?: emptyArray()).filter { ai ->
      val simple = ai.name.substringAfterLast('.')
      simple == prefix || (simple.startsWith(prefix) && simple.length > prefix.length)
    }
  }

  private fun isEnabled(ai: ActivityInfo): Boolean {
    val state = pm().getComponentEnabledSetting(ComponentName(pkg(), ai.name))
    return when (state) {
      PackageManager.COMPONENT_ENABLED_STATE_ENABLED -> true
      PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
      PackageManager.COMPONENT_ENABLED_STATE_DISABLED_USER,
      PackageManager.COMPONENT_ENABLED_STATE_DISABLED_UNTIL_USED -> false
      else -> ai.enabled // DEFAULT: the manifest's android:enabled
    }
  }

  private fun suffixOf(ai: ActivityInfo): String? {
    val simple = ai.name.substringAfterLast('.')
    return if (simple == mainName) null else simple.substring(mainName.length)
  }

  private fun enabledAliasOrNull(): String? = try {
    val enabled = launcherComponents().filter { isEnabled(it) }
    // Prefer an enabled alias over the main activity if (abnormally) both are on.
    (enabled.firstOrNull { suffixOf(it) != null } ?: enabled.firstOrNull())?.let { suffixOf(it) }
  } catch (_: Exception) {
    null
  }

  private fun setEnabledAlias(alias: String?): String? {
    val components = launcherComponents()
    val wanted = "$mainName${alias ?: ""}"
    val target = components.firstOrNull { it.name.substringAfterLast('.') == wanted }
      ?: throw CodedException("ERR_APP_ICON_UNKNOWN", "no launcher component named $wanted in this build", null)
    val manager = pm()
    val targetComponent = ComponentName(pkg(), target.name)
    // Enable first: the package must never be left with zero launcher entries.
    manager.setComponentEnabledSetting(
      targetComponent,
      PackageManager.COMPONENT_ENABLED_STATE_ENABLED,
      PackageManager.DONT_KILL_APP
    )
    for (ai in components) {
      if (ai.name == target.name) continue
      manager.setComponentEnabledSetting(
        ComponentName(pkg(), ai.name),
        PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
        PackageManager.DONT_KILL_APP
      )
    }
    return suffixOf(target)
  }
}
