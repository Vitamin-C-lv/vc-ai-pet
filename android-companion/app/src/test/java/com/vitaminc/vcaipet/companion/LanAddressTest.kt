package com.vitaminc.vcaipet.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class LanAddressTest {
    @Test
    fun preservesExistingLocalRangesAndLocalhost() {
        listOf(
            "localhost:17870",
            "127.0.0.1:17870",
            "10.0.0.1:17870",
            "172.16.0.1:17870",
            "172.31.255.254:17870",
            "192.168.1.175:17870",
        ).forEach { assertTrue(LanAddress.parse(it).port == 17870) }
    }

    @Test
    fun acceptsTailscaleCgnatBoundaries() {
        assertEquals("100.64.0.1:17870", LanAddress.parse("100.64.0.1:17870").hostPort)
        assertEquals("100.127.255.254:17870", LanAddress.parse("100.127.255.254:17870").hostPort)
        assertEquals("100.69.220.26:17870", LanAddress.parse("100.69.220.26:17870").hostPort)
    }

    @Test
    fun rejectsPublicAndOutsideCgnatAddresses() {
        listOf(
            "8.8.8.8:17870",
            "100.63.255.255:17870",
            "100.128.0.1:17870",
        ).forEach { assertThrows(IllegalArgumentException::class.java) { LanAddress.parse(it) } }
    }

    @Test
    fun preservesPortRangeValidation() {
        assertThrows(IllegalArgumentException::class.java) { LanAddress.parse("100.69.220.26:0") }
        assertThrows(IllegalArgumentException::class.java) { LanAddress.parse("100.69.220.26:65536") }
        assertEquals(1, LanAddress.parse("100.69.220.26:1").port)
        assertEquals(65535, LanAddress.parse("100.69.220.26:65535").port)
    }
}
