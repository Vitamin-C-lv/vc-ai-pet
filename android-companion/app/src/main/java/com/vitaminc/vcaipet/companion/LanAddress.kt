package com.vitaminc.vcaipet.companion

import java.net.URI
import java.util.Locale

class LanAddress private constructor(
    val host: String,
    val port: Int,
) {
    val hostPort: String
        get() = "$host:$port"

    val url: String
        get() = "http://$hostPort/"

    override fun equals(other: Any?): Boolean {
        return other is LanAddress && host == other.host && port == other.port
    }

    override fun hashCode(): Int = 31 * host.hashCode() + port

    companion object {
        const val DEFAULT_PORT = 17870

        private val ipv4Pattern = Regex("^\\d{1,3}(?:\\.\\d{1,3}){3}$")
        private val localHostPattern = Regex(
            "^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\\.local$",
        )

        fun parse(raw: String): LanAddress {
            val value = raw.trim()
            require(value.isNotEmpty()) { "empty address" }

            val parsed = if (value.contains("://")) {
                parseHttpUri(value)
            } else {
                parseHostPort(value)
            }
            val normalizedHost = parsed.first.lowercase(Locale.ROOT)
            require(isAllowedHost(normalizedHost)) { "host is outside the private LAN" }
            require(parsed.second in 1..65535) { "port is out of range" }
            return LanAddress(normalizedHost, parsed.second)
        }

        private fun parseHttpUri(value: String): Pair<String, Int> {
            val uri = runCatching { URI(value) }
                .getOrElse { throw IllegalArgumentException("invalid HTTP address", it) }
            require(uri.scheme.equals("http", ignoreCase = true)) { "only HTTP LAN addresses are allowed" }
            require(uri.userInfo == null && uri.query == null && uri.fragment == null) {
                "address must not include credentials or query data"
            }
            require(uri.path.isNullOrEmpty() || uri.path == "/") { "address must not include a path" }
            val host = uri.host ?: throw IllegalArgumentException("invalid host")
            val port = if (uri.port == -1) DEFAULT_PORT else uri.port
            return host to port
        }

        private fun parseHostPort(value: String): Pair<String, Int> {
            require(value.none { it == '/' || it == '?' || it == '#' || it == '@' || it == '\\' }) {
                "address must contain only host and port"
            }
            val colon = value.indexOf(':')
            require(colon == value.lastIndexOf(':')) { "IPv6 addresses are not supported in v0.1" }
            if (colon < 0) return value to DEFAULT_PORT

            val host = value.substring(0, colon)
            val portText = value.substring(colon + 1)
            require(portText.isNotEmpty()) { "missing port" }
            val port = portText.toIntOrNull() ?: throw IllegalArgumentException("invalid port")
            return host to port
        }

        private fun isAllowedHost(host: String): Boolean {
            if (host == "localhost" || host == "127.0.0.1") return true
            if (isPrivateIpv4(host)) return true
            return localHostPattern.matches(host)
        }

        private fun isPrivateIpv4(host: String): Boolean {
            if (!ipv4Pattern.matches(host)) return false
            val octets = host.split('.').map(String::toInt)
            if (octets.any { it !in 0..255 }) return false
            return octets[0] == 10
                || (octets[0] == 172 && octets[1] in 16..31)
                || (octets[0] == 192 && octets[1] == 168)
        }
    }
}
