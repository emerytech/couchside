package expo.modules.couchsidefiletransfer

import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.net.URI

class CouchsideFileTransferModule : Module() {
  private val lock = Any()
  private var active: PinnedUpload? = null

  override fun definition() = ModuleDefinition {
    Name("CouchsideFileTransfer")
    Events("progress")
    AsyncFunction("upload") { options: Map<String, String>, promise: Promise ->
      synchronized(lock) {
        if (active != null) {
          promise.reject("ERR_UPLOAD_BUSY", "Another file is still sending.", null)
          return@synchronized
        }
        try {
          val context = appContext.reactContext ?: error("App context unavailable")
          val uri = URI(options.getValue("fileUri"))
          require(uri.scheme == "file" && uri.authority.isNullOrEmpty())
          val file = File(uri).canonicalFile
          // DocumentPicker copies to cache. Never let this bridge read arbitrary
          // device paths or reopen a remote/content URL as an upload source.
          require(listOf(context.cacheDir, context.filesDir).any {
            file.path.startsWith(it.canonicalPath + File.separator)
          })
          val id = options.getValue("id")
          val upload = PinnedUpload(options.getValue("host"), options.getValue("port").toInt(),
            options.getValue("pinModulus"), options.getValue("ticket"), options.getValue("name"), file) { sent, total ->
            sendEvent("progress", mapOf("id" to id, "sent" to sent.toDouble(), "total" to total.toDouble()))
          }
          active = upload
          upload.start { status, body ->
            synchronized(lock) { if (active === upload) active = null }
            if (status != null && body != null) promise.resolve(mapOf("status" to status, "body" to body))
            else promise.reject("ERR_UPLOAD_FAILED", "Secure upload failed. Check the box connection and saved pairing, then try again.", null)
          }
        } catch (_: Exception) {
          active = null
          promise.reject("ERR_UPLOAD_INVALID", "Could not start the secure upload. Select the file again and check the box pairing.", null)
        }
      }
    }
    OnDestroy { synchronized(lock) { active?.cancel(); active = null } }
  }
}
