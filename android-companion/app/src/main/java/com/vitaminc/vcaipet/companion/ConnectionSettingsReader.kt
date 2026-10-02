package com.vitaminc.vcaipet.companion

import android.content.SharedPreferences

object ConnectionSettingsReader {
    fun read(preferences: SharedPreferences): EndpointSettings {
        val lanEndpoint = readEndpoint(
            preferences,
            ConnectionPreferenceKeys.LAN_ENDPOINT,
            ConnectionDefaults.LAN_ENDPOINT,
        )
        val remoteEndpoint = readEndpoint(
            preferences,
            ConnectionPreferenceKeys.REMOTE_ENDPOINT,
            ConnectionDefaults.REMOTE_ENDPOINT,
        )
        val mode = ConnectionMode.fromPreference(
            preferences.getString(ConnectionPreferenceKeys.CONNECTION_MODE, null),
        )
        val learnedLanEndpoint = preferences.getString(
            ConnectionPreferenceKeys.LEARNED_LAN_ENDPOINT,
            null,
        )?.let { runCatching { LanAddress.parse(it) }.getOrNull() }
            ?.takeIf { LanAddress.isPrivateLanIpv4(it.host) }
        val lastSuccessfulEndpoint = listOf(
            preferences.getString(ConnectionPreferenceKeys.LAST_SUCCESSFUL_ENDPOINT, null),
            preferences.getString("pet_host", null),
        ).asSequence()
            .filterNotNull()
            .mapNotNull { runCatching { LanAddress.parse(it) }.getOrNull() }
            .firstOrNull()

        val editor = preferences.edit()
            .putString(ConnectionPreferenceKeys.LAN_ENDPOINT, lanEndpoint.hostPort)
            .putString(ConnectionPreferenceKeys.REMOTE_ENDPOINT, remoteEndpoint.hostPort)
            .putString(ConnectionPreferenceKeys.CONNECTION_MODE, mode.name)
        if (lastSuccessfulEndpoint != null) {
            editor.putString(
                ConnectionPreferenceKeys.LAST_SUCCESSFUL_ENDPOINT,
                lastSuccessfulEndpoint.hostPort,
            )
        }
        if (learnedLanEndpoint != null) {
            editor.putString(
                ConnectionPreferenceKeys.LEARNED_LAN_ENDPOINT,
                learnedLanEndpoint.hostPort,
            )
        }
        editor.apply()

        return EndpointSettings(
            lanEndpoint = lanEndpoint,
            remoteEndpoint = remoteEndpoint,
            mode = mode,
            lastSuccessfulEndpoint = lastSuccessfulEndpoint,
            learnedLanEndpoint = learnedLanEndpoint,
        )
    }

    private fun readEndpoint(
        preferences: SharedPreferences,
        key: String,
        fallback: String,
    ): LanAddress {
        val raw = preferences.getString(key, null) ?: fallback
        return runCatching { LanAddress.parse(raw) }
            .getOrElse { LanAddress.parse(fallback) }
    }
}
