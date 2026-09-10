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
    val learnedLanEndpoint: LanAddress? = null,
) {
    fun candidateEntries(): List<EndpointCandidate> {
        val configured = listOf(
            EndpointCandidate(lanEndpoint, EndpointRoute.WIFI),
            EndpointCandidate(remoteEndpoint, EndpointRoute.DEFAULT),
        )
        return when (mode) {
            ConnectionMode.LAN -> listOf(EndpointCandidate(lanEndpoint, EndpointRoute.WIFI))
            ConnectionMode.REMOTE -> listOf(EndpointCandidate(remoteEndpoint, EndpointRoute.DEFAULT))
            ConnectionMode.AUTO -> {
                val preferred = lastSuccessfulEndpoint?.let {
                    EndpointCandidate(it, routeFor(it))
                }
                val learned = learnedLanEndpoint?.let {
                    EndpointCandidate(it, EndpointRoute.WIFI)
                }
                (listOfNotNull(preferred, learned) + configured).distinctBy { it.address }
            }
        }
    }

    fun candidates(): List<LanAddress> {
        return candidateEntries().map { it.address }
    }

    private fun routeFor(address: LanAddress): EndpointRoute {
        return if (LanAddress.isPrivateLanIpv4(address.host)) {
            EndpointRoute.WIFI
        } else {
            EndpointRoute.DEFAULT
        }
    }
}

enum class EndpointRoute {
    WIFI,
    DEFAULT,
}

data class EndpointCandidate(
    val address: LanAddress,
    val route: EndpointRoute,
)

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
    const val LEARNED_LAN_ENDPOINT = "LEARNED_LAN_ENDPOINT"
}
