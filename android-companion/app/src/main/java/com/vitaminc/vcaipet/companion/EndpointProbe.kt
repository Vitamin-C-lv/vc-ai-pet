package com.vitaminc.vcaipet.companion

import java.net.HttpURLConnection
import java.net.URL

object EndpointProbe {
    const val DEFAULT_TIMEOUT_MS = 1_500
    private const val STATE_PATH = "api/pet/state"

    fun isAvailable(address: LanAddress, timeoutMs: Int = DEFAULT_TIMEOUT_MS): Boolean {
        val connection = URL(address.url + STATE_PATH).openConnection() as HttpURLConnection
        return try {
            connection.requestMethod = "GET"
            connection.connectTimeout = timeoutMs
            connection.readTimeout = timeoutMs
            connection.instanceFollowRedirects = false
            connection.useCaches = false
            connection.responseCode == HttpURLConnection.HTTP_OK
        } catch (_: Exception) {
            false
        } finally {
            connection.disconnect()
        }
    }
}
