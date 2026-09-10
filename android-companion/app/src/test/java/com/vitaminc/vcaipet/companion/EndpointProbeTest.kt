package com.vitaminc.vcaipet.companion

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class EndpointProbeTest {
    @Test
    fun acceptsTheCurrentPetStateContract() {
        val body = """
            {
              "visualState": "idle",
              "emotion": {"happiness": 0.5, "energy": 0.8},
              "dream": false,
              "sprite": "idle-front.png"
            }
        """.trimIndent()

        assertTrue(EndpointProbe.isVcAiPetStateResponse(body))
    }

    @Test
    fun acceptsExtraTopLevelAndEmotionFields() {
        assertTrue(
            EndpointProbe.isVcAiPetStateResponse(
                """{"visualState":"idle","emotion":{"happiness":0.5,"energy":0.8,"extraMetric":1},"dream":false,"sprite":"idle.png","protocolVersion":2}""",
            ),
        )
    }

    @Test
    fun rejectsARegularHttpJsonResponse() {
        assertFalse(EndpointProbe.isVcAiPetStateResponse("{\"ok\":true}"))
    }

    @Test
    fun rejectsMissingRequiredFields() {
        assertFalse(
            EndpointProbe.isVcAiPetStateResponse(
                """{"visualState":"idle","emotion":{"happiness":1},"dream":false,"sprite":"idle.png"}""",
            ),
        )
    }

    @Test
    fun rejectsWrongRequiredTypes() {
        assertFalse(
            EndpointProbe.isVcAiPetStateResponse(
                """{"visualState":1,"emotion":{"happiness":"0.5","energy":0.8},"dream":"false","sprite":"idle.png"}""",
            ),
        )
    }
}
