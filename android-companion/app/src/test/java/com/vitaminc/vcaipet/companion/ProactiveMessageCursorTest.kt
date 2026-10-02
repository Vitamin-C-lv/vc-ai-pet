package com.vitaminc.vcaipet.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ProactiveMessageCursorTest {
    @Test
    fun firstEnableBaselineSkipsExistingMessages() {
        val state = ProactiveMessageCursor(null).baseline(42L)

        assertEquals(42L, state.value)
        assertNull(state.receive(42L, chatVisible = false))
    }

    @Test
    fun consumedCursorSurvivesRecreationWithoutDuplicateNotification() {
        val firstRun = ProactiveMessageCursor(42L)
        val received = firstRun.receive(43L, chatVisible = false)!!
        val restarted = ProactiveMessageCursor(received.cursor.value)

        assertEquals(43L, restarted.value)
        assertNull(restarted.receive(43L, chatVisible = false))
        assertTrue(restarted.receive(44L, chatVisible = false)!!.shouldNotify)
    }

    @Test
    fun foregroundChatAdvancesCursorWithoutSystemNotification() {
        val received = ProactiveMessageCursor(42L).receive(43L, chatVisible = true)!!

        assertEquals(43L, received.cursor.value)
        assertFalse(received.shouldNotify)
    }

    @Test
    fun responseCursorOnlyMovesForward() {
        val state = ProactiveMessageCursor(42L)

        assertEquals(42L, state.advanceTo(41L).value)
        assertEquals(45L, state.advanceTo(45L).value)
    }
}
