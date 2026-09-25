#include "lihuahua_body_app.h"
#include "lihuahua_body_state.h"
#include "lihuahua_body_io.h"
#include <esp_log.h>

#include <hal/hal.h>
#include <esp_http_client.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include <freertos/task.h>
#include <lvgl.h>
#include <mooncake_log.h>

#include <cstdio>
#include <cstring>

#if __has_include("stackchan_body_config.h")
#include "stackchan_body_config.h"
#endif
#ifndef STACKCHAN_BODY_BRIDGE_URL
#define STACKCHAN_BODY_BRIDGE_URL ""
#endif
#ifndef STACKCHAN_BODY_KEY
#define STACKCHAN_BODY_KEY ""
#endif

LV_FONT_DECLARE(BUILTIN_TEXT_FONT);

namespace {
constexpr std::size_t kMaxResponseBytes = 4096;
constexpr uint32_t kPollIntervalMs = 2000;
constexpr uint32_t kLastKnownMaxAgeMs = 10000;
constexpr int kHttpTimeoutMs = 1500;
constexpr uint32_t kDoubleTapWindowMs = 450;

struct HttpResponse {
    char body[kMaxResponseBytes + 1]{};
    std::size_t length = 0;
    bool overflow = false;
};

esp_err_t onHttpEvent(esp_http_client_event_t* event)
{
    if (event == nullptr || event->user_data == nullptr || event->event_id != HTTP_EVENT_ON_DATA) return ESP_OK;
    auto* response = static_cast<HttpResponse*>(event->user_data);
    const auto length = static_cast<std::size_t>(event->data_len);
    if (length > kMaxResponseBytes - response->length) {
        response->overflow = true;
        return ESP_FAIL;
    }
    std::memcpy(response->body + response->length, event->data, length);
    response->length += length;
    response->body[response->length] = '\0';
    return ESP_OK;
}

void setBodyKey(esp_http_client_handle_t client)
{
    if (STACKCHAN_BODY_KEY[0] != '\0') {
        esp_http_client_set_header(client, "X-LiHuahua-Body-Key", STACKCHAN_BODY_KEY);
    }
}

bool fetchBodyState(lihuahua_body::BodyState* output)
{
    if (STACKCHAN_BODY_BRIDGE_URL[0] == '\0') return false;

    HttpResponse response;
    esp_http_client_config_t config{};
    auto state_url = lihuahuaBodyEndpoint("/v1/body/state"); config.url = state_url.c_str();
    config.timeout_ms = kHttpTimeoutMs;
    config.buffer_size = 512;
    config.event_handler = onHttpEvent;
    config.user_data = &response;

    esp_http_client_handle_t client = esp_http_client_init(&config);
    if (client == nullptr) return false;
    esp_http_client_set_method(client, HTTP_METHOD_GET);
    setBodyKey(client);
    const esp_err_t result = esp_http_client_perform(client);
    const int status = esp_http_client_get_status_code(client);
    esp_http_client_cleanup(client);

    if (result != ESP_OK || status != 200 || response.overflow) return false;
    return lihuahua_body::parseBodyState(response.body, response.length, output);
}

void stylePill(lv_obj_t* object, lv_color_t color)
{
    lv_obj_remove_flag(object, LV_OBJ_FLAG_CLICKABLE);
    lv_obj_set_style_bg_color(object, color, 0);
    lv_obj_set_style_bg_opa(object, LV_OPA_COVER, 0);
    lv_obj_set_style_border_width(object, 0, 0);
    lv_obj_set_style_radius(object, LV_RADIUS_CIRCLE, 0);
}

}  // namespace

LiHuahuaBodyApp::LiHuahuaBodyApp()
{
    setAppInfo().name = "LI HUAHUA";
}

void LiHuahuaBodyApp::onCreate()
{
    state_mutex_ = xSemaphoreCreateMutex();
}

void LiHuahuaBodyApp::onOpen()
{
    LvglLockGuard lock;

    root_ = lv_obj_create(lv_screen_active());
    lv_obj_set_size(root_, 320, 240);
    lv_obj_center(root_);
    lv_obj_set_style_bg_color(root_, lv_color_hex(0x151923), 0);
    lv_obj_set_style_bg_opa(root_, LV_OPA_COVER, 0);
    lv_obj_set_style_border_width(root_, 0, 0);
    lv_obj_set_style_pad_all(root_, 0, 0);

    name_label_ = lv_label_create(root_);
    lv_label_set_text(name_label_, "\xE6\x9D\x8E\xE8\x8A\xB1\xE8\x8A\xB1");
    lv_obj_set_style_text_font(name_label_, &BUILTIN_TEXT_FONT, 0);
    lv_obj_set_style_text_color(name_label_, lv_color_hex(0xAEB8C8), 0);
    lv_obj_align(name_label_, LV_ALIGN_TOP_MID, 0, 6);

    left_eye_ = lv_obj_create(root_);
    lv_obj_set_size(left_eye_, 16, 22);
    lv_obj_set_pos(left_eye_, 118, 88);
    stylePill(left_eye_, lv_color_hex(0xE8EEF7));

    right_eye_ = lv_obj_create(root_);
    lv_obj_set_size(right_eye_, 16, 22);
    lv_obj_set_pos(right_eye_, 186, 88);
    stylePill(right_eye_, lv_color_hex(0xE8EEF7));

    left_brow_ = lv_obj_create(root_);
    lv_obj_set_size(left_brow_, 24, 3);
    lv_obj_set_pos(left_brow_, 114, 70);
    stylePill(left_brow_, lv_color_hex(0xAEB8C8));

    right_brow_ = lv_obj_create(root_);
    lv_obj_set_size(right_brow_, 24, 3);
    lv_obj_set_pos(right_brow_, 182, 70);
    stylePill(right_brow_, lv_color_hex(0xAEB8C8));

    mouth_ = lv_obj_create(root_);
    lv_obj_set_size(mouth_, 18, 7);
    lv_obj_set_pos(mouth_, 151, 150);
    stylePill(mouth_, lv_color_hex(0xF6B6C0));

    accent_label_ = lv_label_create(root_);
    lv_obj_set_style_text_font(accent_label_, &lv_font_montserrat_14, 0);
    lv_obj_set_style_text_color(accent_label_, lv_color_hex(0xAEB8C8), 0);
    lv_obj_set_pos(accent_label_, 0, 0);
    lv_label_set_text(accent_label_, "");
    lv_obj_add_flag(accent_label_, LV_OBJ_FLAG_HIDDEN);

    state_label_ = lv_label_create(root_);
    lv_obj_set_style_text_font(state_label_, &lv_font_montserrat_14, 0);
    lv_obj_set_style_text_color(state_label_, lv_color_hex(0xE8EEF7), 0);
    lv_obj_align(state_label_, LV_ALIGN_BOTTOM_MID, 0, -23);
    lv_label_set_text(state_label_, "OFFLINE");

    reachability_label_ = lv_label_create(root_);
    lv_obj_set_style_text_font(reachability_label_, &lv_font_montserrat_14, 0);
    lv_obj_set_style_text_color(reachability_label_, lv_color_hex(0x7F8A9C), 0);
    lv_obj_align(reachability_label_, LV_ALIGN_BOTTOM_MID, 0, -5);
    lv_label_set_text(reachability_label_, "bridge offline");

    lv_obj_add_event_cb(root_, [](lv_event_t* event) {
        auto* app = static_cast<LiHuahuaBodyApp*>(lv_event_get_user_data(event));
        app->single_tap_at_ = GetHAL().millis();
        app->pending_single_tap_ = true;
    }, LV_EVENT_SINGLE_CLICKED, this);
    lv_obj_add_event_cb(root_, [](lv_event_t* event) {
        auto* app = static_cast<LiHuahuaBodyApp*>(lv_event_get_user_data(event));
        app->pending_single_tap_ = false;
        lihuahuaBodyRequestTouchWake();
    }, LV_EVENT_DOUBLE_CLICKED, this);
    lv_obj_add_event_cb(root_, [](lv_event_t*) { lihuahuaBodyRequestRecord(); }, LV_EVENT_LONG_PRESSED, nullptr);
    lv_obj_remove_flag(root_, LV_OBJ_FLAG_SCROLLABLE);
    running_.store(true);
    if (state_mutex_ != nullptr && xTaskCreate([](void* context) {
            static_cast<LiHuahuaBodyApp*>(context)->pollLoop();
        }, "lihuahua_body", 16384, this, 3, &poll_task_) != pdPASS) {
        poll_task_ = nullptr;
        running_.store(false);
    }
}

void LiHuahuaBodyApp::pollLoop()
{
    GetHAL().startNetwork(nullptr);
    lihuahuaBodyDiscover();
    if (!lihuahuaBodyWakeStart()) ESP_LOGW("LiHuahua", "local wake start failed; manual recording remains available");
    lihuahua_body::BodyState last_known;
    bool has_last_known = false;
    uint32_t last_success = 0;

    while (running_.load()) {
        lihuahua_body::BodyState received;
        const uint32_t now = GetHAL().millis();
        lihuahua_body::BodyState current;
        if (fetchBodyState(&received)) {
            current = received;
            last_known = received;
            has_last_known = true;
            last_success = now;
        } else if (has_last_known && now - last_success < kLastKnownMaxAgeMs) {
            current = last_known;
            current.reachable = false;
        } else {
            current = lihuahua_body::BodyState{};
            current.online = false;
            current.reachable = false;
        }

        if (state_mutex_ != nullptr && xSemaphoreTake(state_mutex_, pdMS_TO_TICKS(100)) == pdTRUE) {
            state_ = current;
            xSemaphoreGive(state_mutex_);
        }

        ESP_LOGI("LiHuahua", "state=%s reachable=%d", lihuahua_body::faceName(lihuahua_body::faceFor(current)), current.reachable);
        if (!current.reachable) lihuahuaBodyDiscover();
        lihuahuaBodyIOPoll();
        vTaskDelay(pdMS_TO_TICKS(kPollIntervalMs));
    }

    poll_task_ = nullptr;
    vTaskDelete(nullptr);
}

void LiHuahuaBodyApp::renderState()
{
    lihuahua_body::BodyState state;
    if (state_mutex_ == nullptr || xSemaphoreTake(state_mutex_, 0) != pdTRUE) return;
    state = state_;
    xSemaphoreGive(state_mutex_);

    const auto face = lihuahua_body::faceFor(state);
    const bool sleeping = face == lihuahua_body::Face::Sleep || face == lihuahua_body::Face::Dreaming;
    const uint32_t now = GetHAL().millis();
    uint32_t blink_cycle = now - last_blink_;
    if (blink_cycle >= 4000) {
        last_blink_ = now;
        blink_cycle = 0;
    }
    const bool blink = !sleeping && face != lihuahua_body::Face::Offline && blink_cycle >= 3800 && blink_cycle < 3920;

    LvglLockGuard lock;
    if (name_label_ == nullptr) return;
    if (std::strcmp(lv_label_get_text(name_label_), state.name) != 0) lv_label_set_text(name_label_, state.name);
    const bool show_offline_text = face == lihuahua_body::Face::Offline;
    const char* state_text = show_offline_text ? "OFFLINE" : "";
    if (std::strcmp(lv_label_get_text(state_label_), state_text) != 0) lv_label_set_text(state_label_, state_text);
    if (show_offline_text) lv_obj_clear_flag(state_label_, LV_OBJ_FLAG_HIDDEN);
    else lv_obj_add_flag(state_label_, LV_OBJ_FLAG_HIDDEN);

    const char* reachability_text = !state.online ? "bridge offline"
                                  : state.reachable ? ""
                                                    : "bridge stale";
    if (std::strcmp(lv_label_get_text(reachability_label_), reachability_text) != 0) {
        lv_label_set_text(reachability_label_, reachability_text);
    }
    if (reachability_text[0] == '\0') lv_obj_add_flag(reachability_label_, LV_OBJ_FLAG_HIDDEN);
    else lv_obj_clear_flag(reachability_label_, LV_OBJ_FLAG_HIDDEN);

    const char* accent = "";
    switch (face) {
        case lihuahua_body::Face::Offline: accent = "x"; break;
        case lihuahua_body::Face::Thinking: accent = "..."; break;
        case lihuahua_body::Face::Listening: accent = "))"; break;
        case lihuahua_body::Face::Sleep: accent = "z"; break;
        case lihuahua_body::Face::Dreaming: accent = "zz"; break;
        case lihuahua_body::Face::Confused: accent = "?"; break;
        default: break;
    }
    if (std::strcmp(lv_label_get_text(accent_label_), accent) != 0) lv_label_set_text(accent_label_, accent);

    auto geometry = lihuahua_body::faceGeometry(face, blink);
    if (face == lihuahua_body::Face::Speaking && ((now / 220U) % 2U) == 0U) {
        geometry.mouth_height = 7;
        geometry.mouth_y = 149;
    }
    const uint32_t breath_phase = (now / 500U) % 4U;
    const int breath_offset = sleeping
                                  ? (breath_phase == 0U ? 0 : breath_phase == 1U ? 1 : breath_phase == 2U ? 2 : 1)
                                  : 0;
    int left_eye_x = 118;
    int right_eye_x = 186;
    int eye_y = 88;
    switch (face) {
        case lihuahua_body::Face::Curious:
            left_eye_x = 116;
            right_eye_x = 190;
            eye_y = 86;
            break;
        case lihuahua_body::Face::Confused:
            right_eye_x = 188;
            eye_y = 89;
            break;
        case lihuahua_body::Face::Listening:
            eye_y = 85;
            break;
        case lihuahua_body::Face::Sleep:
        case lihuahua_body::Face::Dreaming:
            left_eye_x = 114;
            right_eye_x = 182;
            eye_y = 100;
            break;
        default:
            break;
    }
    lv_obj_set_pos(left_eye_, left_eye_x, eye_y + breath_offset);
    lv_obj_set_pos(right_eye_, right_eye_x, eye_y + breath_offset);
    lv_obj_set_size(left_eye_, geometry.left_eye_width, geometry.left_eye_height);
    lv_obj_set_size(right_eye_, geometry.right_eye_width, geometry.right_eye_height);
    const bool brows_visible = face != lihuahua_body::Face::Offline &&
                               face != lihuahua_body::Face::Sleep &&
                               face != lihuahua_body::Face::Dreaming;
    if (brows_visible) {
        lv_obj_clear_flag(left_brow_, LV_OBJ_FLAG_HIDDEN);
        lv_obj_clear_flag(right_brow_, LV_OBJ_FLAG_HIDDEN);
        int left_brow_y = 70;
        int right_brow_y = 70;
        switch (face) {
            case lihuahua_body::Face::Happy:
            case lihuahua_body::Face::Curious:
                left_brow_y = right_brow_y = 67;
                break;
            case lihuahua_body::Face::Thinking:
                right_brow_y = 74;
                break;
            case lihuahua_body::Face::Confused:
                left_brow_y = 66;
                right_brow_y = 75;
                break;
            default:
                break;
        }
        lv_obj_set_pos(left_brow_, left_eye_x - 4, left_brow_y);
        lv_obj_set_pos(right_brow_, right_eye_x - 4, right_brow_y);
    } else {
        lv_obj_add_flag(left_brow_, LV_OBJ_FLAG_HIDDEN);
        lv_obj_add_flag(right_brow_, LV_OBJ_FLAG_HIDDEN);
    }
    lv_obj_set_size(mouth_, geometry.mouth_width, geometry.mouth_height);
    lv_obj_set_pos(mouth_, geometry.mouth_x, geometry.mouth_y + breath_offset);
    lv_obj_set_style_bg_color(mouth_, lv_color_hex(geometry.mouth_color), 0);
    if (geometry.mouth_width <= 0 || geometry.mouth_height <= 0) lv_obj_add_flag(mouth_, LV_OBJ_FLAG_HIDDEN);
    else lv_obj_clear_flag(mouth_, LV_OBJ_FLAG_HIDDEN);

    int accent_x = 0;
    int accent_y = 0;
    switch (face) {
        case lihuahua_body::Face::Offline:
            accent_x = right_eye_x + geometry.right_eye_width + 6;
            accent_y = eye_y - 2;
            break;
        case lihuahua_body::Face::Thinking:
            accent_x = 204;
            accent_y = 126;
            break;
        case lihuahua_body::Face::Listening:
            accent_x = right_eye_x + geometry.right_eye_width + 8;
            accent_y = eye_y - 2;
            break;
        case lihuahua_body::Face::Sleep:
            accent_x = right_eye_x + geometry.right_eye_width + 7;
            accent_y = eye_y - 15 + breath_offset;
            break;
        case lihuahua_body::Face::Dreaming:
            accent_x = right_eye_x + geometry.right_eye_width + 5;
            accent_y = eye_y - 21 + breath_offset;
            break;
        case lihuahua_body::Face::Confused:
            accent_x = right_eye_x + geometry.right_eye_width + 6;
            accent_y = eye_y - 13;
            break;
        default:
            break;
    }
    lv_obj_set_pos(accent_label_, accent_x, accent_y);
    const bool accent_visible = accent[0] != '\0' && (!sleeping || breath_phase != 3U);
    if (accent_visible) lv_obj_clear_flag(accent_label_, LV_OBJ_FLAG_HIDDEN);
    else lv_obj_add_flag(accent_label_, LV_OBJ_FLAG_HIDDEN);
}

void LiHuahuaBodyApp::onRunning()
{
    if (root_ == nullptr || state_mutex_ == nullptr) return;
    if (pending_single_tap_ && GetHAL().millis() - single_tap_at_ >= kDoubleTapWindowMs) {
        pending_single_tap_ = false;
        lihuahuaBodyRequestCapture();
    }
    renderState();
}

void LiHuahuaBodyApp::onClose()
{
    running_.store(false);
    pending_single_tap_ = false;
    while (poll_task_ != nullptr) vTaskDelay(pdMS_TO_TICKS(10));
    lihuahuaBodyWakeStop();

    LvglLockGuard lock;
    if (root_ != nullptr) lv_obj_delete(root_);
    root_ = nullptr;
    left_eye_ = nullptr;
    right_eye_ = nullptr;
    left_brow_ = nullptr;
    right_brow_ = nullptr;
    mouth_ = nullptr;
    name_label_ = nullptr;
    state_label_ = nullptr;
    reachability_label_ = nullptr;
    accent_label_ = nullptr;
}
