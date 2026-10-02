package com.vitaminc.vcaipet.companion

data class ProactiveMessageCursor(val value: Long?) {
    fun baseline(latestCursor: Long): ProactiveMessageCursor {
        return if (value == null) copy(value = latestCursor) else this
    }

    fun receive(messageCursor: Long, chatVisible: Boolean): ProactiveMessageCursorStep? {
        val current = value ?: return null
        if (messageCursor <= current) return null
        return ProactiveMessageCursorStep(
            cursor = copy(value = messageCursor),
            shouldNotify = !chatVisible,
        )
    }

    fun advanceTo(latestCursor: Long): ProactiveMessageCursor {
        val current = value
        return if (current == null || latestCursor > current) copy(value = latestCursor) else this
    }
}

data class ProactiveMessageCursorStep(
    val cursor: ProactiveMessageCursor,
    val shouldNotify: Boolean,
)
