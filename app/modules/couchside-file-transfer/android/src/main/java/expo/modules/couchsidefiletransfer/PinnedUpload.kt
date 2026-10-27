package expo.modules.couchsidefiletransfer

import java.io.File
import java.io.IOException
import java.math.BigInteger
import java.net.Proxy
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.security.interfaces.RSAPublicKey
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager
import okhttp3.Call
import okhttp3.Callback
import okhttp3.ConnectionPool
import okhttp3.HttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.Response
import okio.BufferedSink

/** One isolated HTTPS connection. No shared trust overrides, redirects or retries. */
internal class PinnedUpload(
  host: String, port: Int, modulus: String, ticket: String, name: String, file: File,
  private val progress: (Long, Long) -> Unit,
) {
  private val client: OkHttpClient
  private val call: Call

  init {
    require(port in 1..65535 && Regex("[0-9a-fA-F]{512,2048}").matches(modulus)) { "Incomplete secure pairing" }
    require(Regex("[0-9a-fA-F]{32}").matches(ticket)) { "Invalid upload ticket" }
    require(name.isNotEmpty() && name != "." && name != ".." && name.none { it < ' ' || it == '\u007f' || it == '/' || it == '\\' }) { "Invalid filename" }
    require(host.isNotBlank() && host.none { it.isWhitespace() || it in "/@?#\\" }) { "Invalid box address" }
    val pin = BigInteger(modulus, 16)
    val trust = object : X509TrustManager {
      override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
      override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) {
        throw CertificateException("Client certificates are not supported")
      }
      override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
        val key = chain.firstOrNull()?.publicKey as? RSAPublicKey
        if (key == null || key.modulus != pin || key.publicExponent != BigInteger.valueOf(65537)) {
          throw CertificateException("Box certificate does not match the saved pairing")
        }
      }
    }
    val tls = SSLContext.getInstance("TLS").apply { init(null, arrayOf(trust), null) }
    val url = HttpUrl.Builder().scheme("https").host(host.removeSurrounding("[", "]")).port(port)
      .addPathSegments("api/upload").addQueryParameter("name", name).addQueryParameter("ticket", ticket).build()
    client = OkHttpClient.Builder()
      .sslSocketFactory(tls.socketFactory, trust)
      // A paired key is the identity, not a public CA/DNS name. Check that same
      // leaf key here too; never use an unconditional hostname verifier.
      .hostnameVerifier { hostname, session ->
        val key = try { (session.peerCertificates.firstOrNull() as? X509Certificate)?.publicKey as? RSAPublicKey } catch (_: Exception) { null }
        hostname == url.host && key?.modulus == pin && key.publicExponent == BigInteger.valueOf(65537)
      }
      .followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false)
      .proxy(Proxy.NO_PROXY).protocols(listOf(Protocol.HTTP_1_1))
      .connectionPool(ConnectionPool(0, 1, TimeUnit.SECONDS))
      .connectTimeout(12, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS).writeTimeout(30, TimeUnit.SECONDS)
      .callTimeout(2, TimeUnit.HOURS).build()
    val size = file.length()
    require(file.isFile && size > 0 && size <= 8L * 1024 * 1024 * 1024) { "Choose a nonempty file no larger than 8 GB" }
    val body = object : RequestBody() {
      override fun contentType() = "application/octet-stream".toMediaType()
      override fun contentLength() = size
      override fun isOneShot() = true
      override fun writeTo(sink: BufferedSink) {
        // OkHttp invokes this only AFTER TLS and the pin have been verified.
        file.inputStream().use { input ->
          val buffer = ByteArray(64 * 1024)
          var sent = 0L
          var lastProgress = 0L
          while (sent < size) {
            val count = input.read(buffer, 0, minOf(buffer.size.toLong(), size - sent).toInt())
            if (count < 0) throw IOException("The selected file changed during upload")
            sink.write(buffer, 0, count)
            sent += count
            val now = System.nanoTime()
            if (sent == size || now - lastProgress >= 100_000_000) {
              progress(sent, size)
              lastProgress = now
            }
          }
          if (input.read() != -1) throw IOException("The selected file changed during upload")
        }
      }
    }
    call = client.newCall(Request.Builder().url(url).header("Connection", "close")
      .header("Accept", "application/json").post(body).build())
  }

  fun start(complete: (Int?, String?) -> Unit) {
    call.enqueue(object : Callback {
      override fun onFailure(call: Call, e: IOException) {
        cleanup()
        // Do not bridge native exception text: it can include the ticket URL.
        complete(null, null)
      }
      override fun onResponse(call: Call, response: Response) {
        var status: Int? = null
        var text: String? = null
        try {
          response.use {
            val source = it.body?.source() ?: throw IOException("Empty upload response")
            if (source.request(64 * 1024 + 1L)) throw IOException("Upload response too large")
            text = source.readUtf8()
            status = it.code
          }
        } catch (_: Exception) {
          // Failure remains failure even if the server may already have saved it.
        } finally {
          cleanup()
        }
        complete(status, text)
      }
    })
  }

  fun cancel() { call.cancel() }
  private fun cleanup() {
    client.connectionPool.evictAll()
    client.dispatcher.executorService.shutdown()
  }
}
