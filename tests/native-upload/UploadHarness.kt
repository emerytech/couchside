package expo.modules.couchsidefiletransfer

import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.system.exitProcess

/** Executes the production Android transport on a JVM against the local fixture. */
fun main(args: Array<String>) {
  val done = CountDownLatch(1)
  var code = 3
  try {
    val upload = PinnedUpload("127.0.0.1", args[0].toInt(), args[1], args[2], args[4], File(args[3])) { sent, total ->
      if (sent > total || sent <= 0) error("Invalid progress")
    }
    if (args.getOrNull(5) == "cancel-before-start") upload.cancel()
    upload.start { status, body ->
      println("STATUS=${status ?: 0}")
      if (body != null) println("BODY=$body")
      code = 0
      done.countDown()
    }
    if (args.getOrNull(5) == "cancel") { Thread.sleep(100); upload.cancel() }
    if (!done.await(40, TimeUnit.SECONDS)) { upload.cancel(); error("Fixture deadline") }
  } catch (_: Exception) {
    println("STATUS=0")
  }
  exitProcess(code)
}
