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
    fun physicalWifiCandidateIsSelected() {
        val selected = WifiLanDiscovery.selectPhysicalWifiCandidate(
            listOf(candidate("wlan0", interfaceName = "wlan0")),
        )

        assertEquals("wlan0", selected?.network)
    }

    @Test
    fun vpnOverWifiCandidateIsRejected() {
        val selected = WifiLanDiscovery.selectPhysicalWifiCandidate(
            listOf(
                candidate(
                    network = "tun0",
                    hasVpnTransport = true,
                    interfaceName = "tun0",
                    address = "172.19.0.1",
                    prefixLength = 30,
                ),
            ),
        )

        assertNull(selected)
    }

    @Test
    fun physicalWifiWinsWhenVpnNetworkAppearsFirst() {
        val selected = WifiLanDiscovery.selectPhysicalWifiCandidate(
            listOf(
                candidate(
                    network = "vpn",
                    hasVpnTransport = true,
                    interfaceName = "tun0",
                    address = "172.19.0.1",
                    prefixLength = 30,
                ),
                candidate("physical", interfaceName = "wlan0"),
            ),
        )

        assertEquals("physical", selected?.network)
    }

    @Test
    fun physicalWifiWinsWhenReturnedAfterVpnNetwork() {
        val selected = WifiLanDiscovery.selectPhysicalWifiCandidate(
            listOf(
                candidate("physical", interfaceName = "wlan0"),
                candidate(
                    network = "vpn",
                    hasVpnTransport = true,
                    interfaceName = "tun0",
                    address = "172.19.0.1",
                    prefixLength = 30,
                ),
            ),
        )

        assertEquals("physical", selected?.network)
    }

    @Test
    fun wlan0AndPrivateIpv4ArePreferredAmongPhysicalCandidates() {
        val selected = WifiLanDiscovery.selectPhysicalWifiCandidate(
            listOf(
                candidate(
                    network = "public",
                    interfaceName = "eth0",
                    address = "8.8.8.8",
                ),
                candidate(
                    network = "wlan1",
                    interfaceName = "wlan1",
                    address = "192.168.1.8",
                ),
                candidate(
                    network = "wlan0",
                    interfaceName = "wlan0",
                    address = "192.168.1.3",
                ),
            ),
        )

        assertEquals("wlan0", selected?.network)
    }

    @Test
    fun onlyVpnOverWifiCandidatesFailClosed() {
        val selected = WifiLanDiscovery.selectPhysicalWifiCandidate(
            listOf(
                candidate(
                    network = "vpn",
                    hasVpnTransport = true,
                    interfaceName = "tun0",
                    address = "172.19.0.1",
                    prefixLength = 30,
                ),
            ),
        )

        assertNull(selected)
    }

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

    private fun candidate(
        network: String,
        hasWifiTransport: Boolean = true,
        hasVpnTransport: Boolean = false,
        interfaceName: String = "wlan0",
        address: String = "192.168.1.3",
        prefixLength: Int = 24,
    ): WifiNetworkCandidate<String> {
        return WifiNetworkCandidate(
            network = network,
            networkId = network,
            hasWifiTransport = hasWifiTransport,
            hasVpnTransport = hasVpnTransport,
            interfaceName = interfaceName,
            ipv4Address = InetAddress.getByName(address) as Inet4Address,
            prefixLength = prefixLength,
        )
    }
}
