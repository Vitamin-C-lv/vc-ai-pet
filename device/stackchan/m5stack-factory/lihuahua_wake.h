#pragma once

#include <atomic>
#include <cstdint>
#include <functional>
#include <mutex>
#include <vector>

#include <freertos/FreeRTOS.h>
#include <freertos/task.h>

#include <audio/audio_codec.h>
#include <esp_mn_iface.h>
#include <esp_mn_models.h>
#include <model_path.h>

class LiHuahuaWake {
public:
    using WakeCallback = std::function<void(std::vector<int16_t>&&, const char* candidate)>;

    LiHuahuaWake() = default;
    ~LiHuahuaWake();

    bool Start(AudioCodec* codec, WakeCallback callback);
    void Stop();
    void Pause();
    void Resume();
    bool IsRunning() const { return running_.load(); }

private:
    enum class Mode { Idle, Capture };

    AudioCodec* codec_ = nullptr;
    WakeCallback callback_;
    srmodel_list_t* models_ = nullptr;
    esp_mn_iface_t* multinet_ = nullptr;
    model_iface_data_t* multinet_model_data_ = nullptr;
    char* multinet_name_ = nullptr;
    TaskHandle_t task_ = nullptr;
    std::atomic<bool> running_{false};
    std::atomic<bool> paused_{false};
    std::atomic<bool> reading_{false};
    std::mutex input_mutex_;

    std::vector<int16_t> ring_;
    std::size_t ring_write_ = 0;
    std::vector<int16_t> capture_;
    Mode mode_ = Mode::Idle;
    uint32_t silence_ms_ = 0;
    uint32_t capture_ms_ = 0;
    float noise_floor_ = 300.0f;

    bool initializeModel();
    void taskLoop();
    std::vector<int16_t> readFrame();
    std::vector<int16_t> toMono16k(const std::vector<int16_t>& input) const;
    void pushRing(const std::vector<int16_t>& frame);
    std::vector<int16_t> snapshotRing() const;
    void beginCapture();
    void appendCapture(const std::vector<int16_t>& frame, float rms);
    void finishCapture();
    static float frameRms(const std::vector<int16_t>& frame);
};
