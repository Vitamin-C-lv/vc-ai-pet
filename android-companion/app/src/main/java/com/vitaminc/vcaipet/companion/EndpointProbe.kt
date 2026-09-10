package com.vitaminc.vcaipet.companion

import android.net.Network
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets
import org.json.JSONObject

object EndpointProbe {
    const val DEFAULT_TIMEOUT_MS = 1_500
    const val DISCOVERY_CONNECT_TIMEOUT_MS = 300
    const val DISCOVERY_READ_TIMEOUT_MS = 500
    private const val MAX_RESPONSE_BYTES = 16 * 1024
    private const val STATE_PATH = "api/pet/state"

    fun isAvailable(
        address: LanAddress,
        timeoutMs: Int = DEFAULT_TIMEOUT_MS,
        network: Network? = null,
    ): Boolean {
        return isAvailable(address, timeoutMs, timeoutMs, network)
    }

    fun isAvailable(
        address: LanAddress,
        connectTimeoutMs: Int,
        readTimeoutMs: Int,
        network: Network? = null,
    ): Boolean {
        val connection = runCatching {
            val url = URL(address.url + STATE_PATH)
            (network?.openConnection(url) ?: url.openConnection()) as HttpURLConnection
        }.getOrNull() ?: return false
        return try {
            connection.requestMethod = "GET"
            connection.connectTimeout = connectTimeoutMs
            connection.readTimeout = readTimeoutMs
            connection.instanceFollowRedirects = false
            connection.useCaches = false
            if (connection.responseCode != HttpURLConnection.HTTP_OK) {
                false
            } else {
                readResponseBody(connection)?.let(::isVcAiPetStateResponse) == true
            }
        } catch (_: Exception) {
            false
        } finally {
            connection.disconnect()
        }
    }

    fun isVcAiPetStateResponse(body: String): Boolean {
        val state = runCatching { JSONObject(body) }.getOrNull() ?: return false
        if (!hasNonBlankString(state, "visualState")) return false
        if (state.opt("dream") !is Boolean) return false
        if (!hasNonBlankString(state, "sprite")) return false

        val emotion = state.opt("emotion") as? JSONObject ?: return false
        return emotion.opt("happiness") is Number && emotion.opt("energy") is Number
    }

    private fun hasNonBlankString(json: JSONObject, key: String): Boolean {
        return json.opt(key) is String && json.optString(key).isNotBlank()
    }

    private fun readResponseBody(connection: HttpURLConnection): String? {
        val bytes = ByteArray(MAX_RESPONSE_BYTES + 1)
        val count = runCatching {
            connection.inputStream.use { input ->
                var total = 0
                while (total < bytes.size) {
                    val read = input.read(bytes, total, bytes.size - total)
                    if (read <= 0) break
                    total += read
                }
                total
            }
        }.getOrNull() ?: return null
        if (count > MAX_RESPONSE_BYTES) return null
        return String(bytes, 0, count, StandardCharsets.UTF_8)
    }
}
