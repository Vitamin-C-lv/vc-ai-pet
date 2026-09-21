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
#include <freertos/ringbuf.h>
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
    enum class InferenceKind : uint8_t { UtteranceStart = 1, Data = 2, UtteranceEnd = 3 };
    static constexpr std::size_t kInferenceItemSamples = 512;

    struct InferenceItem {
        uint8_t kind = 0;
        uint8_t reserved = 0;
        uint16_t sample_count = 0;
        uint32_t generation = 0;
        uint64_t enqueued_at_us = 0;
        int16_t samples[kInferenceItemSamples] = {};
    };

    AudioCodec* codec_ = nullptr;
    WakeCallback callback_;
    srmodel_list_t* models_ = nullptr;
    void* embedded_model_storage_ = nullptr;
    size_t embedded_model_storage_size_ = 0;
    esp_mn_iface_t* multinet_ = nullptr;
    model_iface_data_t* multinet_model_data_ = nullptr;
    char* multinet_name_ = nullptr;
    const char* multinet_loader_mode_ = "UNKNOWN";
    const esp_afe_sr_iface_t* afe_iface_ = nullptr;
    esp_afe_sr_data_t* afe_data_ = nullptr;
    esp_ae_rate_cvt_handle_t input_resampler_ = nullptr;
    RingbufHandle_t inference_ring_ = nullptr;
    TaskHandle_t task_ = nullptr;
    TaskHandle_t afe_task_ = nullptr;
    TaskHandle_t multinet_task_ = nullptr;
    TaskHandle_t callback_task_ = nullptr;
    std::atomic<bool> running_{false};
    std::atomic<bool> paused_{false};
    std::atomic<bool> reading_{false};
    std::atomic<bool> multinet_reset_requested_{false};
    std::atomic<bool> inference_end_pending_{false};
    std::atomic<bool> candidate_pending_{false};
    std::atomic<float> candidate_score_pending_{0.0f};
    std::atomic<uint32_t> task_alive_mask_{0};
    std::mutex input_mutex_;
    std::mutex state_mutex_;
    std::mutex callback_mutex_;

    std::vector<int16_t> ring_;
    std::size_t ring_write_ = 0;
    std::vector<int16_t> afe_feed_buffer_;
    std::vector<int16_t> kws_enqueue_buffer_;
    std::deque<std::pair<std::vector<int16_t>, float>> callback_queue_;
    std::vector<int16_t> capture_;
    std::atomic<Mode> mode_{Mode::Idle};
    uint32_t silence_ms_ = 0;
    uint32_t capture_ms_ = 0;
    uint32_t kws_input_samples_ = 0;
    uint32_t kws_utterance_generation_ = 0;
    float candidate_score_ = 0.0f;
    bool vad_speech_active_ = false;
    bool kws_utterance_active_ = false;
    std::atomic<bool> kws_overflow_current_utterance_{false};
    bool multinet_utterance_active_ = false;
    uint32_t multinet_processing_generation_ = 0;
    int codec_input_rate_ = 0;
    int codec_input_channels_ = 0;
    int afe_feed_channels_ = 0;
    int afe_fetch_samples_ = 0;
    int multinet_chunk_size_ = 0;

    uint32_t vad_cache_bytes_last_ = 0;
    uint32_t vad_speech_transitions_ = 0;
    uint32_t mn_detect_frame_count_ = 0;
    uint32_t mn_detected_count_ = 0;
    uint32_t mn_timeout_count_ = 0;
    uint32_t mn_detect_max_us_ = 0;
    uint64_t mn_detect_total_us_ = 0;
    std::atomic<uint32_t> mn_queue_depth_frames_{0};
    std::atomic<uint32_t> mn_queue_high_water_frames_{0};
    std::atomic<uint32_t> mn_queue_overflow_count_{0};
    std::atomic<uint32_t> mn_decision_lag_max_ms_{0};
    std::atomic<uint32_t> latest_utterance_generation_{0};
    std::atomic<uint32_t> mn_stale_frames_skipped_{0};
    std::atomic<uint32_t> mn_generations_superseded_{0};
    std::atomic<uint32_t> mn_stale_candidate_discarded_{0};
    std::atomic<uint32_t> mn_latest_generation_lag_max_ms_{0};
    std::atomic<uint32_t> afe_ringbuffer_overflow_count_{0};
    std::atomic<uint32_t> afe_ringbuffer_min_free_pct_milli_{100000};
    int64_t mn_last_telemetry_us_ = 0;

    static constexpr uint32_t kFeedTaskBit = 1u << 0;
    static constexpr uint32_t kFetchTaskBit = 1u << 1;
    static constexpr uint32_t kMultinetTaskBit = 1u << 2;
    static constexpr uint32_t kCallbackTaskBit = 1u << 3;

    bool initializeModel();
    bool initializeAfe();
    void feedTaskLoop();
    void fetchTaskLoop();
    void multinetTaskLoop();
    void callbackTaskLoop();
    void processAfeResult(const afe_fetch_result_t* result);
    void enqueueKwsSamples(const int16_t* data, std::size_t sample_count);
    bool enqueueInferenceMarker(InferenceKind kind, uint32_t generation);
    bool enqueueInferenceData(const int16_t* data, std::size_t sample_count, uint32_t generation);
    bool processInferenceItem(InferenceItem& item);
    void drainInferenceQueue();
    void applyMultinetResetIfRequested();
    void maybeLogTelemetry();
    void cleanupRuntime();
    std::vector<int16_t> readFrame();
    void feedAfe(const std::vector<int16_t>& input);
    void requestMultinetReset();
    void enqueueCallback(std::vector<int16_t>&& pcm, float score);
    void pushRing(const std::vector<int16_t>& frame);
    std::vector<int16_t> snapshotRing() const;
    void beginCapture();
    void appendCapture(const std::vector<int16_t>& frame, bool speech);
    void finishCapture();
};
