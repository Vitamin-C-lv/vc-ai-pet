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

LV_FONT_DECLARE(BUILTIN_TEXT_FONT);

namespace {
constexpr std::size_t kMaxResponseBytes = 4096;
constexpr uint32_t kPollIntervalMs = 2000;
constexpr uint32_t kLastKnownMaxAgeMs = 10000;
constexpr int kHttpTimeoutMs = 1500;

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
    const esp_err_t result = esp_http_client_perform(client);
    const int status = esp_http_client_get_status_code(client);
    esp_http_client_cleanup(client);

    if (result != ESP_OK || status != 200 || response.overflow) return false;
    return lihuahua_body::parseBodyState(response.body, response.length, output);
}

void stylePill(lv_obj_t* object, lv_color_t color)
{
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
    lv_obj_set_style_text_color(name_label_, lv_color_hex(0xF6E9D2), 0);
    lv_obj_align(name_label_, LV_ALIGN_TOP_MID, 0, 5);

    lv_obj_t* head = lv_obj_create(root_);
    lv_obj_set_size(head, 154, 154);
    lv_obj_align(head, LV_ALIGN_CENTER, 0, 9);
    lv_obj_set_style_radius(head, LV_RADIUS_CIRCLE, 0);
    lv_obj_set_style_bg_color(head, lv_color_hex(0xF3D8A3), 0);
    lv_obj_set_style_bg_opa(head, LV_OPA_COVER, 0);
    lv_obj_set_style_border_width(head, 0, 0);
    lv_obj_set_style_pad_all(head, 0, 0);

    left_eye_ = lv_obj_create(head);
    lv_obj_set_size(left_eye_, 16, 20);
    lv_obj_set_pos(left_eye_, 42, 50);
    stylePill(left_eye_, lv_color_hex(0x2B2631));

    right_eye_ = lv_obj_create(head);
    lv_obj_set_size(right_eye_, 16, 20);
    lv_obj_set_pos(right_eye_, 96, 50);
    stylePill(right_eye_, lv_color_hex(0x2B2631));

    mouth_ = lv_obj_create(head);
    lv_obj_set_size(mouth_, 24, 6);
    lv_obj_set_pos(mouth_, 65, 104);
    stylePill(mouth_, lv_color_hex(0xA64D58));

    state_label_ = lv_label_create(root_);
    lv_obj_set_style_text_font(state_label_, &lv_font_montserrat_16, 0);
    lv_obj_set_style_text_color(state_label_, lv_color_hex(0xF6E9D2), 0);
    lv_obj_align(state_label_, LV_ALIGN_BOTTOM_MID, 0, -24);
    lv_label_set_text(state_label_, "OFFLINE");

    reachability_label_ = lv_label_create(root_);
    lv_obj_set_style_text_font(reachability_label_, &lv_font_montserrat_14, 0);
    lv_obj_set_style_text_color(reachability_label_, lv_color_hex(0xB8C2D1), 0);
    lv_obj_align(reachability_label_, LV_ALIGN_BOTTOM_MID, 0, -5);
    lv_label_set_text(reachability_label_, "BRIDGE: OFFLINE");

    lv_obj_add_event_cb(root_, [](lv_event_t*) { lihuahuaBodyRequestCapture(); }, LV_EVENT_SHORT_CLICKED, nullptr);
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
    const char* face_text = lihuahua_body::faceName(face);
    const char* reachability_text = !state.online ? "BRIDGE: OFFLINE"
                                  : state.reachable ? "BRIDGE: ONLINE"
                                                    : "BRIDGE: STALE";
    if (std::strcmp(lv_label_get_text(name_label_), state.name) != 0) lv_label_set_text(name_label_, state.name);
    if (std::strcmp(lv_label_get_text(state_label_), face_text) != 0) lv_label_set_text(state_label_, face_text);
    if (std::strcmp(lv_label_get_text(reachability_label_), reachability_text) != 0) {
        lv_label_set_text(reachability_label_, reachability_text);
    }

    const auto geometry = lihuahua_body::faceGeometry(face, blink);
    lv_obj_set_size(left_eye_, geometry.left_eye_width, geometry.left_eye_height);
    lv_obj_set_size(right_eye_, geometry.right_eye_width, geometry.right_eye_height);
    lv_obj_set_size(mouth_, geometry.mouth_width, geometry.mouth_height);
    lv_obj_set_pos(mouth_, geometry.mouth_x, geometry.mouth_y);
    lv_obj_set_style_bg_color(mouth_, lv_color_hex(geometry.mouth_color), 0);
}

void LiHuahuaBodyApp::onRunning()
{
    if (root_ == nullptr || state_mutex_ == nullptr) return;
    renderState();
}

void LiHuahuaBodyApp::onClose()
{
    running_.store(false);
    while (poll_task_ != nullptr) vTaskDelay(pdMS_TO_TICKS(10));

    LvglLockGuard lock;
    if (root_ != nullptr) lv_obj_delete(root_);
    root_ = nullptr;
    left_eye_ = nullptr;
    right_eye_ = nullptr;
    mouth_ = nullptr;
    name_label_ = nullptr;
    state_label_ = nullptr;
    reachability_label_ = nullptr;
}
