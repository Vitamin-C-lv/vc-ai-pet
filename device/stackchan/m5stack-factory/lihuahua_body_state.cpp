#include "lihuahua_body_state.h"

#include <cJSON.h>

#include <algorithm>
#include <cstdio>
#include <cstring>

namespace lihuahua_body {
namespace {

bool readBool(const cJSON* object, const char* key, bool* value, bool required)
{
    const cJSON* item = cJSON_GetObjectItemCaseSensitive(object, key);
    if (cJSON_IsTrue(item)) {
        *value = true;
        return true;
    }
    if (cJSON_IsFalse(item)) {
        *value = false;
        return true;
    }
    return !required;
}

void copyString(const cJSON* object, const char* key, char* destination, std::size_t capacity)
{
    const cJSON* item = cJSON_GetObjectItemCaseSensitive(object, key);
    if (cJSON_IsString(item) && item->valuestring != nullptr && capacity > 0) {
        std::snprintf(destination, capacity, "%s", item->valuestring);
    }
}

bool knownFaceName(const char* name, Face* face)
{
    if (std::strcmp(name, "idle") == 0 || std::strcmp(name, "waiting") == 0) *face = Face::Idle;
    else if (std::strcmp(name, "relaxed") == 0) *face = Face::Relaxed;
    else if (std::strcmp(name, "happy") == 0 || std::strcmp(name, "excited") == 0) *face = Face::Happy;
    else if (std::strcmp(name, "thinking") == 0) *face = Face::Thinking;
    else if (std::strcmp(name, "curious") == 0) *face = Face::Curious;
    else if (std::strcmp(name, "confused") == 0) *face = Face::Confused;
    else if (std::strcmp(name, "listening") == 0 || std::strcmp(name, "listen") == 0) *face = Face::Listening;
    else if (std::strcmp(name, "speaking") == 0 || std::strcmp(name, "speak") == 0 || std::strcmp(name, "talking") == 0) *face = Face::Speaking;
    else if (std::strcmp(name, "sleep") == 0 || std::strcmp(name, "sleeping") == 0) *face = Face::Sleep;
    else if (std::strcmp(name, "dreaming") == 0 || std::strcmp(name, "dream") == 0) *face = Face::Dreaming;
    else return false;
    return true;
}

}  // namespace

bool parseBodyState(const char* json, std::size_t length, BodyState* output)
{
    if (json == nullptr || output == nullptr || length == 0 || length > 4096) return false;

    cJSON* root = cJSON_ParseWithLength(json, length);
    if (!cJSON_IsObject(root)) {
        cJSON_Delete(root);
        return false;
    }

    const cJSON* version = cJSON_GetObjectItemCaseSensitive(root, "schemaVersion");
    const cJSON* pet = cJSON_GetObjectItemCaseSensitive(root, "pet");
    const cJSON* presentation = cJSON_GetObjectItemCaseSensitive(root, "presentation");
    BodyState parsed;
    bool valid = cJSON_IsNumber(version) && version->valueint == 1 &&
                 readBool(root, "online", &parsed.online, true) &&
                 readBool(root, "reachable", &parsed.reachable, true) &&
                 cJSON_IsObject(pet) && cJSON_IsObject(presentation);

    if (valid) {
        copyString(pet, "name", parsed.name, sizeof(parsed.name));
        copyString(presentation, "visualState", parsed.visual_state, sizeof(parsed.visual_state));
        copyString(presentation, "expression", parsed.expression, sizeof(parsed.expression));
        copyString(presentation, "animation", parsed.animation, sizeof(parsed.animation));
        readBool(presentation, "dream", &parsed.dream, false);
        readBool(presentation, "sleeping", &parsed.sleeping, false);
        readBool(presentation, "thinking", &parsed.thinking, false);
        readBool(presentation, "listening", &parsed.listening, false);
        readBool(presentation, "speaking", &parsed.speaking, false);
    }

    cJSON_Delete(root);
    if (!valid) return false;
    *output = parsed;
    return true;
}

Face faceFor(const BodyState& state)
{
    if (!state.online) return Face::Offline;
    if (state.speaking) return Face::Speaking;
    if (state.listening) return Face::Listening;
    if (state.dream) return Face::Dreaming;
    if (state.sleeping) return Face::Sleep;

    Face expression_face = Face::Idle;
    if (knownFaceName(state.expression, &expression_face) && expression_face != Face::Idle) return expression_face;

    Face visual_face = Face::Idle;
    if (knownFaceName(state.visual_state, &visual_face)) return visual_face;
    return expression_face;  // Unknown states intentionally fall back to idle.
}

const char* faceName(Face face)
{
    switch (face) {
        case Face::Offline: return "OFFLINE";
        case Face::Idle: return "IDLE";
        case Face::Relaxed: return "RELAXED";
        case Face::Happy: return "HAPPY";
        case Face::Thinking: return "THINKING";
        case Face::Curious: return "CURIOUS";
        case Face::Confused: return "CONFUSED";
        case Face::Listening: return "LISTENING";
        case Face::Speaking: return "SPEAKING";
        case Face::Sleep: return "SLEEP";
        case Face::Dreaming: return "DREAMING";
    }
    return "IDLE";
}

FaceGeometry faceGeometry(Face face, bool eyes_closed)
{
    FaceGeometry geometry{12, 16, 12, 16, 20, 4, 150, 151, 0xF6B6C0};
    switch (face) {
        case Face::Relaxed:
            geometry.left_eye_height = geometry.right_eye_height = 7;
            geometry.mouth_width = 16;
            geometry.mouth_height = 3;
            geometry.mouth_x = 152;
            geometry.mouth_y = 151;
            break;
        case Face::Happy:
            geometry.left_eye_height = geometry.right_eye_height = 14;
            geometry.mouth_width = 24;
            geometry.mouth_height = 5;
            geometry.mouth_x = 148;
            geometry.mouth_y = 149;
            break;
        case Face::Thinking:
            geometry.left_eye_height = 13;
            geometry.right_eye_height = 9;
            geometry.mouth_width = 12;
            geometry.mouth_height = 3;
            geometry.mouth_x = 154;
            geometry.mouth_y = 151;
            break;
        case Face::Curious:
            geometry.left_eye_width = geometry.right_eye_width = 15;
            geometry.left_eye_height = geometry.right_eye_height = 18;
            geometry.mouth_width = 10;
            geometry.mouth_height = 6;
            geometry.mouth_x = 155;
            geometry.mouth_y = 150;
            break;
        case Face::Confused:
            geometry.left_eye_height = 17;
            geometry.right_eye_height = 10;
            geometry.mouth_width = 15;
            geometry.mouth_height = 3;
            geometry.mouth_x = 152;
            geometry.mouth_y = 151;
            break;
        case Face::Listening:
            geometry.left_eye_width = geometry.right_eye_width = 14;
            geometry.left_eye_height = geometry.right_eye_height = 19;
            geometry.mouth_width = 8;
            geometry.mouth_height = 3;
            geometry.mouth_x = 156;
            geometry.mouth_y = 151;
            break;
        case Face::Speaking:
            geometry.left_eye_height = geometry.right_eye_height = 14;
            geometry.mouth_width = 16;
            geometry.mouth_height = 8;
            geometry.mouth_x = 152;
            geometry.mouth_y = 148;
            break;
        case Face::Sleep:
        case Face::Dreaming:
            geometry.left_eye_height = geometry.right_eye_height = 2;
            geometry.mouth_width = 8;
            geometry.mouth_height = 2;
            geometry.mouth_x = 156;
            geometry.mouth_y = 153;
            break;
        case Face::Offline:
            geometry.left_eye_height = geometry.right_eye_height = 2;
            geometry.mouth_width = 12;
            geometry.mouth_height = 2;
            geometry.mouth_x = 154;
            geometry.mouth_y = 153;
            geometry.mouth_color = 0x6F7785;
            break;
        case Face::Idle:
            break;
    }

    if (eyes_closed) {
        geometry.left_eye_height = geometry.right_eye_height = 2;
    }
    return geometry;
}

}  // namespace lihuahua_body
