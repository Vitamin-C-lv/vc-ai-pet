#pragma once

#include <cstddef>
#include <cstdint>

namespace lihuahua_body {

struct BodyState {
    bool online = false;
    bool reachable = false;
    bool dream = false;
    bool sleeping = false;
    bool thinking = false;
    bool listening = false;
    bool speaking = false;
    char name[32] = "\xE6\x9D\x8E\xE8\x8A\xB1\xE8\x8A\xB1";
    char visual_state[32] = "idle";
    char expression[24] = "idle";
    char animation[24] = "blink";
};

enum class Face {
    Offline,
    Idle,
    Relaxed,
    Happy,
    Thinking,
    Curious,
    Confused,
    Listening,
    Speaking,
    Sleep,
    Dreaming,
};

struct FaceGeometry {
    int left_eye_width;
    int left_eye_height;
    int right_eye_width;
    int right_eye_height;
    int mouth_width;
    int mouth_height;
    int mouth_x;
    int mouth_y;
    uint32_t mouth_color;
};

bool parseBodyState(const char* json, std::size_t length, BodyState* output);
Face faceFor(const BodyState& state);
const char* faceName(Face face);
FaceGeometry faceGeometry(Face face, bool eyes_closed = false);

}  // namespace lihuahua_body
