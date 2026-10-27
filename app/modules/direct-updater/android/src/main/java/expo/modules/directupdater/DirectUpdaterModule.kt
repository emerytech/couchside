package expo.modules.directupdater

import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/** Only prepares signed production Direct updates; Android owns installation and consent. */
class DirectUpdaterModule : Module() {
  private val busy = AtomicBoolean(false)
  private val client = OkHttpClient.Builder().connectTimeout(20, TimeUnit.SECONDS)
    .readTimeout(30, TimeUnit.SECONDS).callTimeout(10, TimeUnit.MINUTES)
    .followSslRedirects(false).build()
  private fun context() = requireNotNull(appContext.reactContext).also {
    check(it.packageName == "com.ets3d.rescueremote.direct") { "Updates are available in production Direct only." }
  }
  private fun apk() = File(context().cacheDir, "direct-update/update.apk")
  private fun digest(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
  @Suppress("DEPRECATION")
  private fun verify(file: File) {
    val pm = context().packageManager
    val flags = if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES
    val candidate = requireNotNull(pm.getPackageArchiveInfo(file.path, flags)) { "Invalid update package." }
    val installed = pm.getPackageInfo(context().packageName, flags)
    check(candidate.packageName == installed.packageName) { "This update is for a different app." }
    val next = if (Build.VERSION.SDK_INT >= 28) candidate.longVersionCode else candidate.versionCode.toLong()
    val current = if (Build.VERSION.SDK_INT >= 28) installed.longVersionCode else installed.versionCode.toLong()
    check(next > current) { "This update is not newer than your installed build." }
    val signatures = if (Build.VERSION.SDK_INT >= 28) candidate.signingInfo?.apkContentsSigners else candidate.signatures
    val currentSignatures = if (Build.VERSION.SDK_INT >= 28) installed.signingInfo?.apkContentsSigners else installed.signatures
    val expected = setOf("2f3427b2c702b51c55af12b302342cb9db3770a925e9f00da2798012d0b825b6")
    check(signatures?.map { digest(it.toByteArray()) }?.toSet() == expected &&
      currentSignatures?.map { digest(it.toByteArray()) }?.toSet() == expected) { "Update signature does not match Couchside Direct." }
  }
  override fun definition() = ModuleDefinition {
    Name("DirectUpdater")
    Events("progress")
    AsyncFunction("download") { url: String, promise: Promise ->
      if (!busy.compareAndSet(false, true)) {
        promise.reject("BUSY", "An update is already downloading.", null)
      } else Thread {
        try {
          check(url.matches(Regex("https://github\\.com/emerytech/couchside/releases/download/couchside-direct/couchside-direct-[0-9.]+-build[0-9]+\\.apk"))) { "Unrecognized update location." }
          val file = apk()
          file.parentFile!!.mkdirs()
          file.delete()
          val checksum = client.newCall(Request.Builder().url("$url.sha256").build()).execute().use { response ->
            check(response.isSuccessful) { "Could not verify this release. Try again later." }
            val body = requireNotNull(response.body)
            // Bound untrusted metadata before reading it into memory.
            val bytes = body.byteStream().use { input ->
              val out = java.io.ByteArrayOutputStream()
              while (out.size() <= 4096) { val next = input.read(); if (next < 0) break; out.write(next) }
              out.toByteArray()
            }
            check(bytes.size <= 4096)
            String(bytes).trim().split(Regex("\\s+")).first().also { check(it.matches(Regex("[a-fA-F0-9]{64}"))) }
          }
          val partial = File(file.parentFile, "update.partial")
          try {
            client.newCall(Request.Builder().url(url).build()).execute().use { response ->
              check(response.isSuccessful) { "Download failed. Try again." }
              val body = requireNotNull(response.body)
              val total = body.contentLength()
              check(total <= 512L * 1024 * 1024) { "Update is too large." }
              val hash = MessageDigest.getInstance("SHA-256")
              body.byteStream().use { input -> partial.outputStream().use { output ->
                val buffer = ByteArray(65536); var received = 0L; var last = 0L
                while (true) {
                  val count = input.read(buffer); if (count < 0) break
                  received += count
                  check(received <= 512L * 1024 * 1024)
                  output.write(buffer, 0, count); hash.update(buffer, 0, count)
                  val now = System.currentTimeMillis()
                  if (now - last > 250) { sendEvent("progress", mapOf("received" to received.toDouble(), "total" to total.toDouble())); last = now }
                }
                check(total < 0 || received == total) { "Download was interrupted." }
              } }
              check(hash.digest().joinToString("") { "%02x".format(it) }.equals(checksum, true)) { "Checksum failed. Please download again." }
            }
            verify(partial)
            check(partial.renameTo(file))
          } finally { partial.delete() }
          promise.resolve(null)
        } catch (e: Exception) { promise.reject("UPDATE_FAILED", e.message ?: "Update failed. Please retry.", e) }
        finally { busy.set(false) }
      }.start()
    }
    AsyncFunction("install") {
      check(!busy.get())
      val context = context()
      val file = apk()
      verify(file)
      if (Build.VERSION.SDK_INT >= 26 && !context.packageManager.canRequestPackageInstalls()) {
        context.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        "permission"
      } else {
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.directupdates", file)
        context.startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
          .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK))
        "installer"
      }
    }
  }
}
