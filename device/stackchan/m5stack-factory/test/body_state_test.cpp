#include "../lihuahua_body_state.h"

#include <cJSON.h>

#include <cassert>
#include <cstring>

int main()
{
    using namespace lihuahua_body;
    constexpr char valid[] =
        "{\"schemaVersion\":1,\"online\":true,\"reachable\":true,"
        "\"pet\":{\"name\":\"Li Huahua\"},\"presentation\":{"
        "\"visualState\":\"relaxed\",\"expression\":\"relaxed\","
        "\"animation\":\"stretch\",\"dream\":false,\"sleeping\":false}}";

    BodyState state;
    assert(parseBodyState(valid, sizeof(valid) - 1, &state));
    assert(state.online && state.reachable);
    assert(std::strcmp(state.name, "Li Huahua") == 0);
    assert(faceFor(state) == Face::Relaxed);

    constexpr char dream[] =
        "{\"schemaVersion\":1,\"online\":true,\"reachable\":false,"
        "\"pet\":{},\"presentation\":{\"visualState\":\"relaxed\","
        "\"expression\":\"relaxed\",\"dream\":true}}";
    assert(parseBodyState(dream, sizeof(dream) - 1, &state));
    assert(faceFor(state) == Face::Dreaming);
    assert(!state.reachable);  // Cached/stale states remain displayable.

    constexpr char unknown[] =
        "{\"schemaVersion\":1,\"online\":true,\"reachable\":true,"
        "\"pet\":{},\"presentation\":{\"expression\":\"new-state\"}}";
    assert(parseBodyState(unknown, sizeof(unknown) - 1, &state));
    assert(faceFor(state) == Face::Idle);

    constexpr char offline[] =
        "{\"schemaVersion\":1,\"online\":false,\"reachable\":false,"
        "\"pet\":{},\"presentation\":{\"expression\":\"happy\"}}";
    assert(parseBodyState(offline, sizeof(offline) - 1, &state));
    assert(faceFor(state) == Face::Offline);
    assert(!parseBodyState("{", 1, &state));
    assert(!parseBodyState(valid, sizeof(valid) - 1, nullptr));
    assert(!parseBodyState(valid, 4097, &state));
    return 0;
}
