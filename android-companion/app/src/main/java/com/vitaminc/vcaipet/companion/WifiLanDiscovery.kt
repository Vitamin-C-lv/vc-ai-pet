package com.vitaminc.vcaipet.companion

import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.util.Log
import java.net.Inet4Address
import java.util.concurrent.Callable
import java.util.concurrent.ExecutorCompletionService
import java.util.concurrent.Executors

data class WifiNetworkSnapshot(
    val network: Network,
    val ipv4Address: Inet4Address,
    val prefixLength: Int,
)

internal data class WifiNetworkCandidate<T>(
    val network: T,
    val networkId: String,
    val hasWifiTransport: Boolean,
    val hasVpnTransport: Boolean,
    val interfaceName: String?,
    val ipv4Address: Inet4Address?,
    val prefixLength: Int?,
)

object WifiLanDiscovery {
    const val MAX_DISCOVERY_HOSTS = 512
    const val DISCOVERY_CONCURRENCY = 20

    fun findWifiNetwork(connectivityManager: ConnectivityManager): WifiNetworkSnapshot? {
        val candidates = connectivityManager.allNetworks.mapNotNull { network ->
            val capabilities = connectivityManager.getNetworkCapabilities(network)
                ?: return@mapNotNull null
            val linkProperties = connectivityManager.getLinkProperties(network)
            val linkAddress = linkProperties
                ?.linkAddresses
                ?.firstOrNull { it.address is Inet4Address }
            WifiNetworkCandidate(
                network = network,
                networkId = network.toString(),
                hasWifiTransport = capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI),
                hasVpnTransport = capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN),
                interfaceName = linkProperties?.interfaceName,
                ipv4Address = linkAddress?.address as? Inet4Address,
                prefixLength = linkAddress?.prefixLength,
            )
        }

        val selected = selectPhysicalWifiCandidate(candidates)
        candidates.forEach { candidate ->
            logCandidate(
                candidate = candidate,
                selected = candidate === selected,
            )
        }

        return selected?.let { candidate ->
            val ipv4Address = candidate.ipv4Address ?: return@let null
            val prefixLength = candidate.prefixLength ?: return@let null
            WifiNetworkSnapshot(
                network = candidate.network,
                ipv4Address = ipv4Address,
                prefixLength = prefixLength,
            )
        }
    }

    /**
     * Selects a physical Wi-Fi candidate without relying on ConnectivityManager
     * network enumeration order. VPN-over-Wi-Fi is deliberately rejected.
     */
    internal fun <T> selectPhysicalWifiCandidate(
        candidates: List<WifiNetworkCandidate<T>>,
    ): WifiNetworkCandidate<T>? {
        return candidates
            .asSequence()
            .filter { candidate ->
                candidate.hasWifiTransport &&
                    !candidate.hasVpnTransport &&
                    !isVirtualInterface(candidate.interfaceName) &&
                    candidate.ipv4Address != null &&
                    candidate.prefixLength?.let { it in 0..32 } == true
            }
            .sortedWith(
                compareBy<WifiNetworkCandidate<T>>(
                    { if (it.interfaceName.equals("wlan0", ignoreCase = true)) 0 else 1 },
                    {
                        if (it.ipv4Address?.hostAddress?.let(LanAddress::isPrivateLanIpv4) == true) {
                            0
                        } else {
                            1
                        }
                    },
                    { it.interfaceName ?: "" },
                    { it.ipv4Address?.hostAddress ?: "" },
                    { it.networkId },
                ),
            )
            .firstOrNull()
    }

    /**
     * Returns null when the subnet is too large to scan. An empty list means
     * that the subnet has no usable host addresses for discovery.
     */
    fun candidateAddresses(
        address: Inet4Address,
        prefixLength: Int,
        port: Int = LanAddress.DEFAULT_PORT,
    ): List<LanAddress>? {
        if (prefixLength !in 0..32) return null
        val self = ipv4ToLong(address)
        val hostAddress = address.hostAddress ?: return emptyList()
        if (!LanAddress.isPrivateLanIpv4(hostAddress)) return emptyList()

        val hostBits = 32 - prefixLength
        if (hostBits <= 1) return emptyList()

        val hostCount = (1L shl hostBits) - 2
        if (hostCount > MAX_DISCOVERY_HOSTS) return null

        val mask = (0xffffffffL shl hostBits) and 0xffffffffL
        val networkAddress = self and mask
        val candidates = ArrayList<LanAddress>(hostCount.toInt())
        for (offset in 1..hostCount) {
            val candidate = networkAddress + offset
            if (candidate == self) continue
            val host = longToIpv4(candidate)
            if (LanAddress.isPrivateLanIpv4(host)) {
                candidates += LanAddress.parse("$host:$port")
            }
        }
        return candidates
    }

    fun discover(
        candidates: List<LanAddress>,
        probe: (LanAddress) -> Boolean,
    ): LanAddress? {
        if (candidates.isEmpty()) return null

        val executor = Executors.newFixedThreadPool(DISCOVERY_CONCURRENCY)
        val completion = ExecutorCompletionService<LanAddress?>(executor)
        val futures = candidates.map { address ->
            completion.submit(Callable {
                if (Thread.currentThread().isInterrupted) {
                    null
                } else if (probe(address)) {
                    address
                } else {
                    null
                }
            })
        }

        var selected: LanAddress? = null
        var completed = 0
        try {
            while (completed < futures.size && selected == null) {
                selected = completion.take().get()
                completed += 1
            }
            return selected
        } finally {
            futures.forEach { it.cancel(true) }
            executor.shutdownNow()
        }
    }

    private fun ipv4ToLong(address: Inet4Address): Long {
        return address.address.fold(0L) { value, byte ->
            (value shl 8) or (byte.toLong() and 0xff)
        }
    }

    private fun longToIpv4(value: Long): String {
        return listOf(24, 16, 8, 0)
            .joinToString(".") { shift -> ((value shr shift) and 0xff).toString() }
    }

    private fun isVirtualInterface(interfaceName: String?): Boolean {
        val normalized = interfaceName?.trim()?.lowercase() ?: return true
        return normalized.isEmpty() ||
            normalized.startsWith("tun") ||
            normalized.startsWith("vpn")
    }

    private fun logCandidate(
        candidate: WifiNetworkCandidate<Network>,
        selected: Boolean,
    ) {
        val reason = when {
            !candidate.hasWifiTransport -> "NO_WIFI_TRANSPORT"
            candidate.hasVpnTransport -> "VPN_TRANSPORT"
            isVirtualInterface(candidate.interfaceName) -> "VIRTUAL_INTERFACE"
            candidate.ipv4Address == null -> "NO_IPV4"
            candidate.prefixLength?.let { it !in 0..32 } == true -> "INVALID_PREFIX"
            selected -> "SELECTED_WIFI"
            else -> "LOWER_PRIORITY"
        }
        Log.i(
            TAG,
            "WIFI_DISCOVERY_NETWORK_CANDIDATE " +
                "network=${candidate.networkId} " +
                "wifi=${candidate.hasWifiTransport} " +
                "vpn=${candidate.hasVpnTransport} " +
                "iface=${candidate.interfaceName ?: "unknown"} " +
                "ipv4=${candidate.ipv4Address?.hostAddress ?: "none"}/" +
                "${candidate.prefixLength ?: "none"} " +
                "selected=$selected " +
                "reason=$reason",
        )
    }

    private const val TAG = "WifiLanDiscovery"
}
