package com.vitaminc.vcaipet.companion

enum class ConnectionMode {
    AUTO,
    LAN,
    REMOTE;

    companion object {
        fun fromPreference(value: String?): ConnectionMode {
            return values().firstOrNull { it.name.equals(value?.trim(), ignoreCase = true) } ?: AUTO
        }
    }
}

data class EndpointSettings(
    val lanEndpoint: LanAddress,
    val remoteEndpoint: LanAddress,
    val mode: ConnectionMode = ConnectionMode.AUTO,
    val lastSuccessfulEndpoint: LanAddress? = null,
) {
    fun candidates(): List<LanAddress> {
        val configured = listOf(lanEndpoint, remoteEndpoint).distinct()
        return when (mode) {
            ConnectionMode.LAN -> listOf(lanEndpoint)
            ConnectionMode.REMOTE -> listOf(remoteEndpoint)
            ConnectionMode.AUTO -> {
                val preferred = lastSuccessfulEndpoint
                listOfNotNull(preferred) + configured.filterNot { it == preferred }
            }
        }
    }
}

fun firstReachableEndpoint(
    settings: EndpointSettings,
    probe: (LanAddress) -> Boolean,
): LanAddress? {
    return settings.candidates().firstOrNull(probe)
}

object ConnectionDefaults {
    const val LAN_ENDPOINT = "192.168.1.175:17870"
    const val REMOTE_ENDPOINT = "100.69.220.26:17870"
}

object ConnectionPreferenceKeys {
    const val LAN_ENDPOINT = "LAN_ENDPOINT"
    const val REMOTE_ENDPOINT = "REMOTE_ENDPOINT"
    const val CONNECTION_MODE = "CONNECTION_MODE"
    const val LAST_SUCCESSFUL_ENDPOINT = "lastSuccessfulEndpoint"
}
