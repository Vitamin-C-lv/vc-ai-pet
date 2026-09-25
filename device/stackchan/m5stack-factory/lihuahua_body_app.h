#pragma once

#include <mooncake.h>
#include "lihuahua_body_state.h"

#include <atomic>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include <freertos/task.h>
#include <lvgl.h>

class LiHuahuaBodyApp : public mooncake::AppAbility {
public:
    LiHuahuaBodyApp();
    void onCreate() override;
    void onOpen() override;
    void onRunning() override;
    void onClose() override;

private:
    void pollLoop();
    void renderState();

    std::atomic<bool> running_{false};
    TaskHandle_t poll_task_ = nullptr;
    SemaphoreHandle_t state_mutex_ = nullptr;
    lihuahua_body::BodyState state_;
    lv_obj_t* root_ = nullptr;
    lv_obj_t* left_eye_ = nullptr;
    lv_obj_t* right_eye_ = nullptr;
    lv_obj_t* left_brow_ = nullptr;
    lv_obj_t* right_brow_ = nullptr;
    lv_obj_t* mouth_ = nullptr;
    lv_obj_t* name_label_ = nullptr;
    lv_obj_t* state_label_ = nullptr;
    lv_obj_t* reachability_label_ = nullptr;
    lv_obj_t* accent_label_ = nullptr;
    uint32_t last_blink_ = 0;
    uint32_t single_tap_at_ = 0;
    bool pending_single_tap_ = false;
};
