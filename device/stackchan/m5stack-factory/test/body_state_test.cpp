#include "../lihuahua_body_state.h"

#include <cJSON.h>

#include <cassert>
#include <cstring>

namespace {

void assertGeometry(const lihuahua_body::FaceGeometry& actual,
                    int left_width, int left_height, int right_width, int right_height,
                    int mouth_width, int mouth_height, int mouth_x, int mouth_y,
                    uint32_t mouth_color)
{
    assert(actual.left_eye_width == left_width);
    assert(actual.left_eye_height == left_height);
    assert(actual.right_eye_width == right_width);
    assert(actual.right_eye_height == right_height);
    assert(actual.mouth_width == mouth_width);
    assert(actual.mouth_height == mouth_height);
    assert(actual.mouth_x == mouth_x);
    assert(actual.mouth_y == mouth_y);
    assert(actual.mouth_color == mouth_color);
}

void assertBlinkRestores(lihuahua_body::Face face)
{
    using namespace lihuahua_body;
    const FaceGeometry open_before = faceGeometry(face);
    const FaceGeometry closed = faceGeometry(face, true);
    const FaceGeometry open_after = faceGeometry(face);

    assert(open_after.left_eye_width == open_before.left_eye_width);
    assert(open_after.left_eye_height == open_before.left_eye_height);
    assert(open_after.right_eye_width == open_before.right_eye_width);
    assert(open_after.right_eye_height == open_before.right_eye_height);
    assert(closed.left_eye_height == 4);
    assert(closed.right_eye_height == 4);
    assert(closed.mouth_width == open_before.mouth_width);
    assert(closed.mouth_height == open_before.mouth_height);
    assert(closed.mouth_x == open_before.mouth_x);
    assert(closed.mouth_y == open_before.mouth_y);
    assert(open_after.mouth_color == open_before.mouth_color);
    assert(closed.mouth_color == open_before.mouth_color);
}

}  // namespace

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

    assertGeometry(faceGeometry(Face::Idle), 16, 20, 16, 20, 24, 6, 65, 104, 0xA64D58);
    assertGeometry(faceGeometry(Face::Relaxed), 16, 8, 16, 8, 20, 5, 67, 103, 0xA64D58);
    assertGeometry(faceGeometry(Face::Happy), 16, 20, 16, 20, 34, 12, 60, 100, 0xA64D58);
    assertGeometry(faceGeometry(Face::Thinking), 16, 20, 16, 16, 16, 5, 69, 102, 0xA64D58);
    assertGeometry(faceGeometry(Face::Curious), 22, 22, 22, 22, 12, 7, 71, 101, 0xA64D58);
    assertGeometry(faceGeometry(Face::Confused), 16, 23, 16, 17, 20, 5, 67, 105, 0xA64D58);
    assertGeometry(faceGeometry(Face::Sleep), 16, 4, 16, 4, 14, 4, 70, 105, 0xA64D58);
    assertGeometry(faceGeometry(Face::Dreaming), 16, 4, 16, 4, 14, 4, 70, 105, 0xA64D58);
    assertGeometry(faceGeometry(Face::Offline), 16, 4, 16, 4, 18, 4, 68, 105, 0x777B86);

    assertBlinkRestores(Face::Idle);
    assertBlinkRestores(Face::Relaxed);
    assertBlinkRestores(Face::Happy);
    assertBlinkRestores(Face::Thinking);
    assertBlinkRestores(Face::Curious);
    assertBlinkRestores(Face::Confused);
    assertBlinkRestores(Face::Sleep);
    assertBlinkRestores(Face::Dreaming);
    assertBlinkRestores(Face::Offline);
    return 0;
}
