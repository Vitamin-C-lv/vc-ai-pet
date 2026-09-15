#pragma once

#include <cstddef>

namespace lihuahua_body {

struct BodyState {
    bool online = false;
    bool reachable = false;
    bool dream = false;
    bool sleeping = false;
    bool thinking = false;
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
    Sleep,
    Dreaming,
};

bool parseBodyState(const char* json, std::size_t length, BodyState* output);
Face faceFor(const BodyState& state);
const char* faceName(Face face);

}  // namespace lihuahua_body
