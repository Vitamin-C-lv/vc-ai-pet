package com.vitaminc.vcaipet.companion

import java.net.InetAddress
import java.net.Inet4Address
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class WifiLanDiscoveryTest {
    private val phoneAddress = InetAddress.getByName("192.168.1.3") as Inet4Address

    @Test
    fun slash24ExcludesNetworkBroadcastAndDeviceAddress() {
        val candidates = WifiLanDiscovery.candidateAddresses(phoneAddress, 24)

        assertNotNull(candidates)
        assertEquals(253, candidates!!.size)
        assertFalse(candidates.any { it.host == "192.168.1.0" })
        assertFalse(candidates.any { it.host == "192.168.1.255" })
        assertFalse(candidates.any { it.host == "192.168.1.3" })
        assertTrue(candidates.any { it.host == "192.168.1.1" })
        assertTrue(candidates.any { it.host == "192.168.1.254" })
    }

    @Test
    fun slash25IsSupportedAndLargeSubnetsFailClosed() {
        val slash25 = WifiLanDiscovery.candidateAddresses(phoneAddress, 25)
        assertNotNull(slash25)
        assertEquals(125, slash25!!.size)
        assertNull(WifiLanDiscovery.candidateAddresses(phoneAddress, 16))
    }

    @Test
    fun tailscaleAndPublicSubnetsAreNotScanned() {
        val tailscale = InetAddress.getByName("100.69.220.3") as Inet4Address
        val publicAddress = InetAddress.getByName("8.8.8.8") as Inet4Address

        assertTrue(WifiLanDiscovery.candidateAddresses(tailscale, 24).isNullOrEmpty())
        assertTrue(WifiLanDiscovery.candidateAddresses(publicAddress, 24).isNullOrEmpty())
    }

    @Test
    fun discoveryStopsAtTheFirstSuccessfulIdentityProbe() {
        val candidates = WifiLanDiscovery.candidateAddresses(phoneAddress, 30)!!
        val selected = WifiLanDiscovery.discover(candidates) { it.host == "192.168.1.2" }

        assertEquals("192.168.1.2", selected?.host)
    }
}
