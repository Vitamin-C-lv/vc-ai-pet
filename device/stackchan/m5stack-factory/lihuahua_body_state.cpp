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
    }

    cJSON_Delete(root);
    if (!valid) return false;
    *output = parsed;
    return true;
}

Face faceFor(const BodyState& state)
{
    if (!state.online) return Face::Offline;
    if (state.dream) return Face::Dreaming;
    if (state.sleeping) return Face::Sleep;

    Face face = Face::Idle;
    knownFaceName(state.expression, &face);  // Unknown states intentionally fall back to idle.
    return face;
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
        case Face::Sleep: return "SLEEP";
        case Face::Dreaming: return "DREAMING";
    }
    return "IDLE";
}

}  // namespace lihuahua_body
