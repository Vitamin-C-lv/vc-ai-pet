package com.vitaminc.vcaipet.companion

import kotlin.math.max

enum class ConnectionUiState {
    SEARCHING,
    PAGE_READY_WAITING_MIN_HOLD,
    CONNECTED,
    FAILED_RETRYABLE,
    ADVANCED_SETTINGS,
}

/**
 * Owns the time and stale-attempt rules for the splash connection UX.
 * Android callbacks use the returned delays, while this class stays free of
 * Handler/View concerns so the timing contract can be unit tested directly.
 */
class SplashTimingCoordinator(
    val minSplashHoldMs: Long = MIN_SPLASH_HOLD_MS,
    val recoveryWindowMs: Long = CONNECTION_RECOVERY_WINDOW_MS,
) {
    class Attempt internal constructor(
        val generation: Long,
        val startedAtMs: Long,
    )

    data class PageReadyDecision(
        val revealDelayMs: Long,
    ) {
        val state: ConnectionUiState = if (revealDelayMs == 0L) {
            ConnectionUiState.CONNECTED
        } else {
            ConnectionUiState.PAGE_READY_WAITING_MIN_HOLD
        }
    }

    private var nextGeneration = 0L
    private var currentAttempt: Attempt? = null
    private var pageReadyGeneration: Long? = null

    fun startAttempt(startedAtMs: Long): Attempt {
        val attempt = Attempt(
            generation = ++nextGeneration,
            startedAtMs = startedAtMs,
        )
        currentAttempt = attempt
        pageReadyGeneration = null
        return attempt
    }

    fun isCurrent(attempt: Attempt): Boolean {
        return currentAttempt == attempt
    }

    fun markPageReady(attempt: Attempt, nowMs: Long): PageReadyDecision? {
        if (!isCurrent(attempt)) return null
        pageReadyGeneration = attempt.generation
        return PageReadyDecision(minimumHoldRemaining(attempt, nowMs))
    }

    fun minimumHoldRemaining(attempt: Attempt, nowMs: Long): Long {
        if (!isCurrent(attempt)) return 0L
        return max(0L, minSplashHoldMs - elapsedMs(attempt, nowMs))
    }

    fun canReveal(attempt: Attempt, nowMs: Long): Boolean {
        return isCurrent(attempt) &&
            pageReadyGeneration == attempt.generation &&
            minimumHoldRemaining(attempt, nowMs) == 0L
    }

    fun recoveryRemaining(attempt: Attempt, nowMs: Long): Long {
        if (!isCurrent(attempt) || pageReadyGeneration == attempt.generation) return 0L
        return max(0L, recoveryWindowMs - elapsedMs(attempt, nowMs))
    }

    fun isRecoveryDue(attempt: Attempt, nowMs: Long): Boolean {
        return isCurrent(attempt) &&
            pageReadyGeneration != attempt.generation &&
            recoveryRemaining(attempt, nowMs) == 0L
    }

    fun invalidate() {
        currentAttempt = null
        pageReadyGeneration = null
    }

    private fun elapsedMs(attempt: Attempt, nowMs: Long): Long {
        return (nowMs - attempt.startedAtMs).coerceAtLeast(0L)
    }

    companion object {
        const val MIN_SPLASH_HOLD_MS = 2_000L
        const val CONNECTION_RECOVERY_WINDOW_MS = 20_000L
    }
}
