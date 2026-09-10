package com.vitaminc.vcaipet.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SplashTimingCoordinatorTest {
    @Test
    fun readyAt300MsRevealsNoEarlierThanThe2SecondMinimum() {
        val coordinator = SplashTimingCoordinator()
        val attempt = coordinator.startAttempt(0L)

        val decision = coordinator.markPageReady(attempt, 300L)

        assertEquals(1_700L, decision?.revealDelayMs)
        assertEquals(ConnectionUiState.PAGE_READY_WAITING_MIN_HOLD, decision?.state)
        assertFalse(coordinator.canReveal(attempt, 1_999L))
        assertTrue(coordinator.canReveal(attempt, 2_000L))
    }

    @Test
    fun readyAt2500MsRevealsImmediately() {
        val coordinator = SplashTimingCoordinator()
        val attempt = coordinator.startAttempt(0L)

        val decision = coordinator.markPageReady(attempt, 2_500L)

        assertEquals(0L, decision?.revealDelayMs)
        assertEquals(ConnectionUiState.CONNECTED, decision?.state)
        assertTrue(coordinator.canReveal(attempt, 2_500L))
    }

    @Test
    fun failureAt19SecondsDoesNotReachRecoveryState() {
        val coordinator = SplashTimingCoordinator()
        val attempt = coordinator.startAttempt(0L)

        assertEquals(1_000L, coordinator.recoveryRemaining(attempt, 19_000L))
        assertFalse(coordinator.isRecoveryDue(attempt, 19_000L))
    }

    @Test
    fun recoveryBecomesDueAt20Seconds() {
        val coordinator = SplashTimingCoordinator()
        val attempt = coordinator.startAttempt(0L)

        assertTrue(coordinator.isRecoveryDue(attempt, 20_000L))
    }

    @Test
    fun retryCreatesANewGenerationAndIgnoresTheStaleFirstGeneration() {
        val coordinator = SplashTimingCoordinator()
        val firstAttempt = coordinator.startAttempt(0L)
        val secondAttempt = coordinator.startAttempt(20_000L)

        assertFalse(coordinator.isCurrent(firstAttempt))
        assertTrue(coordinator.isCurrent(secondAttempt))
        assertNull(coordinator.markPageReady(firstAttempt, 22_000L))
        assertEquals(
            ConnectionUiState.CONNECTED,
            coordinator.markPageReady(secondAttempt, 22_000L)?.state,
        )
    }
}
