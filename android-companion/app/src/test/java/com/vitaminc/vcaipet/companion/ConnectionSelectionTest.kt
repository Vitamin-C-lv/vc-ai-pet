package com.vitaminc.vcaipet.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ConnectionSelectionTest {
    private val lan = LanAddress.parse(ConnectionDefaults.LAN_ENDPOINT)
    private val remote = LanAddress.parse(ConnectionDefaults.REMOTE_ENDPOINT)

    @Test
    fun connectionModeDefaultsToAutoAndSupportsExplicitModes() {
        assertEquals(ConnectionMode.AUTO, ConnectionMode.fromPreference(null))
        assertEquals(ConnectionMode.AUTO, ConnectionMode.fromPreference("unknown"))
        assertEquals(listOf(lan), EndpointSettings(lan, remote, ConnectionMode.LAN).candidates())
        assertEquals(listOf(remote), EndpointSettings(lan, remote, ConnectionMode.REMOTE).candidates())
    }

    @Test
    fun caseJHomeWifiSelectsLanWhenRemoteIsUnavailable() {
        val selected = firstReachableEndpoint(
            EndpointSettings(lan, remote),
        ) { it == lan }

        assertEquals(lan, selected)
    }

    @Test
    fun caseKRemoteOnlySelectsTailscaleEndpoint() {
        val selected = firstReachableEndpoint(
            EndpointSettings(lan, remote),
        ) { it == remote }

        assertEquals(remote, selected)
    }

    @Test
    fun caseLBothEndpointsAreValidWithoutNetworkTypeHeuristics() {
        val selected = firstReachableEndpoint(
            EndpointSettings(lan, remote),
        ) { true }

        assertTrue(selected == lan || selected == remote)
    }

    @Test
    fun caseMRemoteLastSuccessFallsBackToLan() {
        val selected = firstReachableEndpoint(
            EndpointSettings(
                lanEndpoint = lan,
                remoteEndpoint = remote,
                lastSuccessfulEndpoint = remote,
            ),
        ) { it == lan }

        assertEquals(lan, selected)
    }

    @Test
    fun caseNLanLastSuccessFallsBackToRemote() {
        val selected = firstReachableEndpoint(
            EndpointSettings(
                lanEndpoint = lan,
                remoteEndpoint = remote,
                lastSuccessfulEndpoint = lan,
            ),
        ) { it == remote }

        assertEquals(remote, selected)
    }

    @Test
    fun autoTriesLastSuccessfulEndpointFirstThenTheOtherEndpoint() {
        val attempted = mutableListOf<LanAddress>()
        val selected = firstReachableEndpoint(
            EndpointSettings(
                lanEndpoint = lan,
                remoteEndpoint = remote,
                lastSuccessfulEndpoint = remote,
            ),
        ) {
            attempted += it
            it == lan
        }

        assertEquals(lan, selected)
        assertEquals(listOf(remote, lan), attempted)
    }
}
