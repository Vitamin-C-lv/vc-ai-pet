#pragma once

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <functional>
#include <mutex>
#include <utility>
#include <vector>

#include <freertos/FreeRTOS.h>
#include <freertos/task.h>

#include <audio/audio_codec.h>
#include <esp_ae_rate_cvt.h>
#include <esp_afe_sr_iface.h>
#include <esp_afe_sr_models.h>
#include <esp_mn_iface.h>
#include <esp_mn_models.h>
#include <model_path.h>

class LiHuahuaWake {
public:
    using WakeCallback = std::function<void(std::vector<int16_t>&&, const char* candidate, float score)>;

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
    void* embedded_model_storage_ = nullptr;
    size_t embedded_model_storage_size_ = 0;
    esp_mn_iface_t* multinet_ = nullptr;
    model_iface_data_t* multinet_model_data_ = nullptr;
    char* multinet_name_ = nullptr;
    const esp_afe_sr_iface_t* afe_iface_ = nullptr;
    esp_afe_sr_data_t* afe_data_ = nullptr;
    esp_ae_rate_cvt_handle_t input_resampler_ = nullptr;
    TaskHandle_t task_ = nullptr;
    TaskHandle_t afe_task_ = nullptr;
    TaskHandle_t inference_task_ = nullptr;
    TaskHandle_t callback_task_ = nullptr;
    std::atomic<bool> running_{false};
    std::atomic<bool> paused_{false};
    std::atomic<bool> reading_{false};
    std::atomic<bool> inference_reset_requested_{false};
    std::atomic<bool> candidate_pending_{false};
    std::atomic<float> candidate_score_pending_{0.0f};
    std::atomic<uint32_t> wake_epoch_{0};
    std::atomic<uint32_t> task_alive_mask_{0};
    std::mutex input_mutex_;
    std::mutex state_mutex_;
    std::mutex inference_mutex_;
    std::mutex callback_mutex_;

    std::vector<int16_t> ring_;
    std::size_t ring_write_ = 0;
    std::vector<int16_t> afe_feed_buffer_;
    std::vector<int16_t> kws_buffer_;
    std::deque<std::vector<int16_t>> inference_frames_;
    std::deque<std::pair<std::vector<int16_t>, float>> callback_queue_;
    std::vector<int16_t> capture_;
    std::atomic<Mode> mode_{Mode::Idle};
    uint32_t silence_ms_ = 0;
    uint32_t capture_ms_ = 0;
    float candidate_score_ = 0.0f;
    float debug_rms_ = 0.0f;
    int codec_input_rate_ = 0;
    int codec_input_channels_ = 0;
    int afe_feed_channels_ = 0;
    int multinet_chunk_size_ = 0;

    static constexpr uint32_t kFeedTaskBit = 1u << 0;
    static constexpr uint32_t kFetchTaskBit = 1u << 1;
    static constexpr uint32_t kInferenceTaskBit = 1u << 2;
    static constexpr uint32_t kCallbackTaskBit = 1u << 3;

    bool initializeModel();
    bool initializeAfe();
    void feedTaskLoop();
    void fetchTaskLoop();
    void inferenceTaskLoop();
    void callbackTaskLoop();
    void processAfeResult(const afe_fetch_result_t* result);
    void cleanupRuntime();
    std::vector<int16_t> readFrame();
    void feedAfe(const std::vector<int16_t>& input);
    void enqueueInferenceFrame(const std::vector<int16_t>& frame);
    void requestInferenceReset();
    void enqueueCallback(std::vector<int16_t>&& pcm, float score);
    void pushRing(const std::vector<int16_t>& frame);
    std::vector<int16_t> snapshotRing() const;
    void beginCapture();
    void appendCapture(const std::vector<int16_t>& frame, bool speech);
    void finishCapture();
    static float frameRms(const std::vector<int16_t>& frame);
};
