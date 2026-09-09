package com.vitaminc.vcaipet.companion

import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import java.net.Inet4Address
import java.util.concurrent.Callable
import java.util.concurrent.ExecutorCompletionService
import java.util.concurrent.Executors

data class WifiNetworkSnapshot(
    val network: Network,
    val ipv4Address: Inet4Address,
    val prefixLength: Int,
)

object WifiLanDiscovery {
    const val MAX_DISCOVERY_HOSTS = 512
    const val DISCOVERY_CONCURRENCY = 20

    fun findWifiNetwork(connectivityManager: ConnectivityManager): WifiNetworkSnapshot? {
        return connectivityManager.allNetworks.asSequence()
            .mapNotNull { network ->
                val capabilities = connectivityManager.getNetworkCapabilities(network)
                    ?: return@mapNotNull null
                if (!capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) {
                    return@mapNotNull null
                }
                val linkAddress = connectivityManager.getLinkProperties(network)
                    ?.linkAddresses
                    ?.firstOrNull { it.address is Inet4Address }
                    ?: return@mapNotNull null
                WifiNetworkSnapshot(
                    network = network,
                    ipv4Address = linkAddress.address as Inet4Address,
                    prefixLength = linkAddress.prefixLength,
                )
            }
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
}
