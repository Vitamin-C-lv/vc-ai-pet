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
        if (!hasExactKeys(state, "visualState", "emotion", "dream", "sprite")) return false
        if ((state.optString("visualState").isBlank()) || state.get("visualState") !is String) {
            return false
        }
        if (state.get("dream") !is Boolean) return false
        if (state.optString("sprite").isBlank() || state.get("sprite") !is String) return false

        val emotion = state.optJSONObject("emotion") ?: return false
        if (!hasExactKeys(emotion, "happiness", "energy")) return false
        return emotion.get("happiness") is Number && emotion.get("energy") is Number
    }

    private fun hasExactKeys(json: JSONObject, vararg keys: String): Boolean {
        return json.length() == keys.size && keys.all(json::has)
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
