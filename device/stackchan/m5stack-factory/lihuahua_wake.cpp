#include "lihuahua_wake.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <string>

#include <esp_heap_caps.h>
#include <esp_image_format.h>
#include <esp_private/esp_clk.h>
#include <esp_log.h>
#include <esp_partition.h>
#include <esp_timer.h>
#include <esp_mn_speech_commands.h>
#include <freertos/ringbuf.h>
#include <miniz.h>

#include <assets.h>

namespace {
constexpr char kTag[] = "LiHuahuaWake";
constexpr int kAfeSampleRate = 16000;
constexpr int kInputFrameMs = 10;
constexpr int kPreRollMs = 2000;
constexpr int kEndSilenceMs = 800;
constexpr int kMaximumCaptureMs = 12000;
constexpr uint32_t kKwsWindowMs = 2500;
constexpr uint32_t kKwsWindowSamples = kAfeSampleRate * kKwsWindowMs / 1000;
// The ESP-SR AFE ring remains the SDK's own bounded feed/fetch buffer. The
// application-side inference ring below absorbs MultiNet lag without blocking
// fetch or resetting the model context.
constexpr int kAfeRingBufferFrames = 128;
constexpr uint32_t kInferenceRingCapacityFrames = 128;
constexpr UBaseType_t kFeedTaskPriority = 2;
constexpr UBaseType_t kAfeTaskPriority = 3;
constexpr UBaseType_t kFetchTaskPriority = 5;
constexpr UBaseType_t kMultinetTaskPriority = 3;
constexpr UBaseType_t kCallbackTaskPriority = 1;
constexpr size_t kMaximumEmbeddedModelSize = 3 * 1024 * 1024;

// The compressed Chinese MultiNet pack is embedded in the OTA1 application so
// the recovery slot and the shared assets partition remain untouched. The
// staging script supplies this binary from the already-present ESP-SR
// component; no model is fetched at runtime.
extern const uint8_t lihuahua_wake_model_start[] asm("_binary_lihuahua_mn5q8_cn_srmodels_zlib_start");
extern const uint8_t lihuahua_wake_model_end[] asm("_binary_lihuahua_mn5q8_cn_srmodels_zlib_end");

size_t freePsram() {
    return heap_caps_get_free_size(MALLOC_CAP_SPIRAM);
}

size_t freeInternalHeap() {
    return heap_caps_get_free_size(MALLOC_CAP_INTERNAL);
}

void logOta1Space() {
    const esp_partition_t* partition = esp_partition_find_first(
        ESP_PARTITION_TYPE_APP, ESP_PARTITION_SUBTYPE_APP_OTA_1, nullptr);
    if (partition == nullptr) {
        ESP_LOGI(kTag, "OTA1_APP_BYTES=0");
        ESP_LOGI(kTag, "OTA1_FREE_BYTES=0");
        return;
    }

    esp_partition_pos_t position{
        .offset = partition->address,
        .size = partition->size,
    };
    esp_image_metadata_t metadata{};
    const esp_err_t result = esp_image_get_metadata(&position, &metadata);
    const size_t image_bytes = result == ESP_OK ? metadata.image_len : 0;
    const size_t free_bytes = image_bytes <= partition->size ? partition->size - image_bytes : 0;
    ESP_LOGI(kTag, "OTA1_APP_BYTES=%u", static_cast<unsigned>(image_bytes));
    ESP_LOGI(kTag, "OTA1_FREE_BYTES=%u", static_cast<unsigned>(free_bytes));
}
}

LiHuahuaWake::~LiHuahuaWake() {
    Stop();
}

bool LiHuahuaWake::initializeModel() {
    logOta1Space();
    ESP_LOGI(kTag, "PSRAM_FREE_BEFORE_MODEL=%u", static_cast<unsigned>(freePsram()));
    ESP_LOGI(kTag, "INTERNAL_HEAP_BEFORE_MODEL=%u", static_cast<unsigned>(freeInternalHeap()));

    // Prefer the compact model bundled in the OTA1 app. This keeps local
    // wake independent of whichever model set happens to be in the shared
    // Factory assets partition and preserves that partition for recovery.
    const size_t embedded_size = static_cast<size_t>(lihuahua_wake_model_end - lihuahua_wake_model_start);
    if (embedded_size > sizeof(uint32_t)) {
        uint32_t inflated_size = 0;
        std::memcpy(&inflated_size, lihuahua_wake_model_start, sizeof(inflated_size));
        if (inflated_size > 0 && inflated_size <= kMaximumEmbeddedModelSize) {
            embedded_model_storage_ = heap_caps_malloc(inflated_size, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
            embedded_model_storage_size_ = inflated_size;
            if (embedded_model_storage_ != nullptr) {
                const size_t compressed_size = embedded_size - sizeof(uint32_t);
                const size_t result = tinfl_decompress_mem_to_mem(
                    embedded_model_storage_, inflated_size,
                    lihuahua_wake_model_start + sizeof(uint32_t), compressed_size,
                    TINFL_FLAG_PARSE_ZLIB_HEADER | TINFL_FLAG_USING_NON_WRAPPING_OUTPUT_BUF);
                if (result == inflated_size) {
                    ESP_LOGI(kTag, "PSRAM_FREE_AFTER_DECOMPRESS=%u", static_cast<unsigned>(freePsram()));
                    models_ = srmodel_load(embedded_model_storage_);
                    ESP_LOGI(kTag, "ESP-SR local model source=ota1-embedded compressed=%u inflated=%u",
                             static_cast<unsigned>(compressed_size), static_cast<unsigned>(inflated_size));
                } else {
                    ESP_LOGE(kTag, "ESP-SR embedded model inflate failed result=%u expected=%u",
                             static_cast<unsigned>(result), static_cast<unsigned>(inflated_size));
                }
            } else {
                ESP_LOGE(kTag, "ESP-SR embedded model allocation failed bytes=%u",
                         static_cast<unsigned>(inflated_size));
            }
        } else {
            ESP_LOGE(kTag, "ESP-SR embedded model header invalid inflated=%u",
                     static_cast<unsigned>(inflated_size));
        }
    }

    // If decompression or loading failed, release the temporary blob before
    // trying the read-only Factory asset fallback. A successfully loaded
    // model keeps this blob until Stop(), because srmodel_load() retains
    // pointers into it.
    if (models_ == nullptr && embedded_model_storage_ != nullptr) {
        heap_caps_free(embedded_model_storage_);
        embedded_model_storage_ = nullptr;
        embedded_model_storage_size_ = 0;
    }

    // Keep a read-only fallback for a future Factory asset pack that already
    // contains a compatible MultiNet model.
    if (models_ == nullptr) {
        void* packed_models = nullptr;
        size_t packed_models_size = 0;
        if (Assets::GetInstance().GetAssetData("srmodels.bin", packed_models, packed_models_size)) {
            (void)packed_models_size;
            models_ = srmodel_load(packed_models);
        }
    }
    if (models_ == nullptr) models_ = esp_srmodel_init("model");
    if (models_ == nullptr || models_->num <= 0) {
        ESP_LOGE(kTag, "ESP-SR model list unavailable");
        return false;
    }

    multinet_name_ = esp_srmodel_filter(models_, ESP_MN_PREFIX, "cn");
    if (multinet_name_ == nullptr) multinet_name_ = esp_srmodel_filter(models_, ESP_MN_PREFIX, nullptr);
    if (multinet_name_ == nullptr && models_->model_name != nullptr) {
        for (int i = 0; i < models_->num; ++i) {
            const char* name = models_->model_name[i];
            ESP_LOGI(kTag, "ESP-SR packed model[%d]=%s", i, name ? name : "(null)");
            if (name != nullptr && std::strncmp(name, ESP_MN_PREFIX, std::strlen(ESP_MN_PREFIX)) == 0) {
                multinet_name_ = models_->model_name[i];
                break;
            }
        }
    }
    if (multinet_name_ == nullptr) {
        ESP_LOGE(kTag, "Chinese MultiNet model unavailable");
        return false;
    }

    multinet_ = esp_mn_handle_from_name(multinet_name_);
    if (multinet_ == nullptr) {
        ESP_LOGE(kTag, "MultiNet handle unavailable name=%s", multinet_name_);
        return false;
    }
    multinet_model_data_ = multinet_->create(multinet_name_, 3000);
    if (multinet_model_data_ == nullptr) {
        ESP_LOGE(kTag, "MultiNet create failed name=%s", multinet_name_);
        return false;
    }
    // MultiNet 5 exposes the same loader hook as newer models on this ESP-SR
    // build.  Keep the existing model and command graph, but request the
    // PSRAM-backed weight layout when the runtime supports it; otherwise stay
    // on the SDK default without making startup depend on that optional hook.
    if (multinet_->switch_loader_mode != nullptr) {
        auto* psram_model = multinet_->switch_loader_mode(multinet_model_data_, ESP_MN_LOAD_FROM_PSRAM);
        if (psram_model != nullptr) {
            multinet_model_data_ = psram_model;
            multinet_loader_mode_ = "PSRAM";
            ESP_LOGI(kTag, "MULTINET_LOADER_MODE=%s", multinet_loader_mode_);
        } else {
            multinet_loader_mode_ = "DEFAULT";
            ESP_LOGI(kTag, "MULTINET_LOADER_MODE=%s reason=unsupported", multinet_loader_mode_);
        }
    } else {
        multinet_loader_mode_ = "DEFAULT";
        ESP_LOGI(kTag, "MULTINET_LOADER_MODE=%s reason=unavailable", multinet_loader_mode_);
    }
    multinet_chunk_size_ = multinet_->get_samp_chunksize(multinet_model_data_);
    if (multinet_chunk_size_ <= 0) {
        ESP_LOGE(kTag, "MultiNet chunk size invalid=%d", multinet_chunk_size_);
        multinet_->destroy(multinet_model_data_);
        multinet_model_data_ = nullptr;
        return false;
    }

#ifdef CONFIG_CUSTOM_WAKE_WORD_THRESHOLD
    const float threshold = static_cast<float>(CONFIG_CUSTOM_WAKE_WORD_THRESHOLD) / 100.0f;
#else
    const float threshold = 0.25f;
#endif
    multinet_->set_det_threshold(multinet_model_data_, threshold);
    if (esp_mn_commands_clear() != ESP_OK) {
        ESP_LOGE(kTag, "WAKE_COMMAND_REGISTRATION=FAIL reason=clear");
        return false;
    }
    // The ESP-SR layer deliberately detects only the first candidate phrase.
    // “花花在吗” is disambiguated by the PC Vosk stage from this bounded PCM.
    if (esp_mn_commands_add(1, "hua hua") != ESP_OK) {
        ESP_LOGE(kTag, "WAKE_COMMAND_REGISTRATION=FAIL reason=add");
        return false;
    }
    if (esp_mn_commands_update() != nullptr) {
        ESP_LOGE(kTag, "WAKE_COMMAND_REGISTRATION=FAIL reason=update");
        return false;
    }
    multinet_->print_active_speech_commands(multinet_model_data_);
    ESP_LOGI(kTag, "WAKE_COMMAND_REGISTRATION=PASS");
    ESP_LOGI(kTag, "WAKE_COMMAND=hua hua");
    ESP_LOGI(kTag, "WAKE_MODEL_NAME=%s", multinet_name_);
    ESP_LOGI(kTag, "MODEL_BLOB_LIFETIME=HELD_UNTIL_STOP bytes=%u",
             static_cast<unsigned>(embedded_model_storage_size_));
    ESP_LOGI(kTag, "PSRAM_FREE_AFTER_MULTINET_CREATE=%u", static_cast<unsigned>(freePsram()));
    ESP_LOGI(kTag, "INTERNAL_HEAP_AFTER_MULTINET_CREATE=%u", static_cast<unsigned>(freeInternalHeap()));
    ESP_LOGI(kTag, "MULTINET_INITIALIZED=YES");
    return true;
}

bool LiHuahuaWake::initializeAfe() {
    if (codec_ == nullptr || models_ == nullptr) return false;

    codec_input_rate_ = codec_->input_sample_rate();
    codec_input_channels_ = codec_->input_channels();
    const int reference_channels = codec_->input_reference() ? 1 : 0;
    if (codec_input_rate_ <= 0 || codec_input_channels_ <= reference_channels) {
        ESP_LOGE(kTag, "CODEC_INPUT_INVALID rate=%d channels=%d reference=%d",
                 codec_input_rate_, codec_input_channels_, reference_channels);
        return false;
    }

    std::string input_format;
    for (int i = 0; i < codec_input_channels_ - reference_channels; ++i) input_format.push_back('M');
    for (int i = 0; i < reference_channels; ++i) input_format.push_back('R');
    ESP_LOGI(kTag, "CODEC_INPUT_SAMPLE_RATE=%d CODEC_INPUT_CHANNELS=%d INPUT_REFERENCE=%d AFE_INPUT_FORMAT=%s",
             codec_input_rate_, codec_input_channels_, reference_channels, input_format.c_str());

    if (codec_input_rate_ != kAfeSampleRate) {
        esp_ae_rate_cvt_cfg_t resampler_config = {
            .src_rate = static_cast<uint32_t>(codec_input_rate_),
            .dest_rate = kAfeSampleRate,
            .channel = static_cast<uint8_t>(codec_input_channels_),
            .bits_per_sample = 16,
            .complexity = 2,
            .perf_type = ESP_AE_RATE_CVT_PERF_TYPE_SPEED,
        };
        const auto result = esp_ae_rate_cvt_open(&resampler_config, &input_resampler_);
        if (input_resampler_ == nullptr) {
            ESP_LOGE(kTag, "AFE input resampler failed src=%d dst=%d result=%d",
                     codec_input_rate_, kAfeSampleRate, static_cast<int>(result));
            return false;
        }
    }

    afe_config_t* afe_config = afe_config_init(input_format.c_str(), models_, AFE_TYPE_VC, AFE_MODE_HIGH_PERF);
    if (afe_config == nullptr) {
        ESP_LOGE(kTag, "AFE config init failed");
        return false;
    }
    afe_config->aec_init = false;
    afe_config->vad_init = true;
    afe_config->vad_mode = VAD_MODE_2;
    afe_config->vad_min_speech_ms = 128;
    afe_config->vad_min_noise_ms = 200;
    afe_config->vad_delay_ms = 128;
    afe_config->vad_mute_playback = true;
    afe_config->agc_init = false;
    // Keep the AFE speech-enhancement worker on CPU0 while the synchronous
    // MultiNet fetch/detect task runs on CPU1. This leaves the two halves of
    // the SDK pipeline with a core each instead of making detect wait behind
    // AFE processing on the same core.
    afe_config->afe_perferred_core = 0;
    afe_config->afe_perferred_priority = kAfeTaskPriority;
    afe_config->afe_ringbuf_size = kAfeRingBufferFrames;
    afe_config->memory_alloc_mode = AFE_MEMORY_ALLOC_MORE_PSRAM;
    afe_config_check(afe_config);

    afe_iface_ = esp_afe_handle_from_config(afe_config);
    if (afe_iface_ == nullptr) {
        ESP_LOGE(kTag, "AFE interface unavailable");
        return false;
    }
    afe_data_ = afe_iface_->create_from_config(afe_config);
    if (afe_data_ == nullptr) {
        ESP_LOGE(kTag, "AFE create failed");
        afe_iface_ = nullptr;
        return false;
    }
    afe_feed_channels_ = afe_iface_->get_feed_channel_num(afe_data_);
    if (afe_feed_channels_ <= 0) afe_feed_channels_ = codec_input_channels_;
    if (afe_feed_channels_ != codec_input_channels_) {
        ESP_LOGE(kTag, "AFE channel layout mismatch codec=%d afe=%d", codec_input_channels_, afe_feed_channels_);
        afe_iface_->destroy(afe_data_);
        afe_data_ = nullptr;
        afe_iface_ = nullptr;
        return false;
    }
    afe_feed_buffer_.clear();
    kws_enqueue_buffer_.clear();
    afe_fetch_samples_ = afe_iface_->get_fetch_chunksize(afe_data_);
    if (multinet_chunk_size_ <= 0 ||
        multinet_chunk_size_ > static_cast<int>(kInferenceItemSamples)) {
        ESP_LOGE(kTag, "MULTINET_CHUNK_UNSUPPORTED=%d max=%u",
                 multinet_chunk_size_, static_cast<unsigned>(kInferenceItemSamples));
        return false;
    }
    kws_enqueue_buffer_.reserve(kInferenceItemSamples * 2);
    const size_t inference_ring_bytes =
        sizeof(InferenceItem) * static_cast<size_t>(kInferenceRingCapacityFrames);
    inference_ring_ = xRingbufferCreateWithCaps(
        inference_ring_bytes, RINGBUF_TYPE_NOSPLIT, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (inference_ring_ == nullptr) {
        ESP_LOGE(kTag, "MN_INFERENCE_RING_CREATE=FAIL bytes=%u",
                 static_cast<unsigned>(inference_ring_bytes));
        return false;
    }
    ESP_LOGI(kTag, "AFE_INITIALIZED=YES feed_rate=%d feed_channels=%d feed_chunk=%d fetch_chunk=%d",
             afe_iface_->get_samp_rate(afe_data_), afe_feed_channels_,
             afe_iface_->get_feed_chunksize(afe_data_), afe_iface_->get_fetch_chunksize(afe_data_));
    ESP_LOGI(kTag, "AFE_FETCH_SAMPLES=%d", afe_fetch_samples_);
    ESP_LOGI(kTag, "AFE_RINGBUF_FRAMES=%d", kAfeRingBufferFrames);
    ESP_LOGI(kTag, "MN_CHUNK_SAMPLES=%d", multinet_chunk_size_);
    ESP_LOGI(kTag, "MN_QUEUE_CAPACITY_FRAMES=%u", static_cast<unsigned>(kInferenceRingCapacityFrames));
    ESP_LOGI(kTag, "MN_KWS_WINDOW_MS=%u", static_cast<unsigned>(kKwsWindowMs));
    ESP_LOGI(kTag, "CPU_FREQ_MHZ=%d", esp_clk_cpu_freq() / 1000000);
    ESP_LOGI(kTag, "AFE_MODE=HIGH_PERF");
    ESP_LOGI(kTag, "MULTINET_LOADER_MODE=%s", multinet_loader_mode_);
    ESP_LOGI(kTag, "AFE_VAD_ENABLED=YES");
    ESP_LOGI(kTag, "AFE_VAD_CONFIG=MODE_2 MIN_SPEECH_MS=128 MIN_NOISE_MS=200 DELAY_MS=128");
    afe_iface_->print_pipeline(afe_data_);
    return true;
}

void LiHuahuaWake::cleanupRuntime() {
    if (inference_ring_ != nullptr) {
        vRingbufferDeleteWithCaps(inference_ring_);
        inference_ring_ = nullptr;
    }
    if (multinet_model_data_ != nullptr && multinet_ != nullptr) {
        multinet_->destroy(multinet_model_data_);
    }
    multinet_model_data_ = nullptr;

    if (afe_data_ != nullptr && afe_iface_ != nullptr) {
        afe_iface_->destroy(afe_data_);
    }
    afe_data_ = nullptr;
    afe_iface_ = nullptr;

    if (input_resampler_ != nullptr) {
        esp_ae_rate_cvt_close(input_resampler_);
        input_resampler_ = nullptr;
    }

    if (models_ != nullptr) {
        esp_srmodel_deinit(models_);
    }
    models_ = nullptr;

    // srmodel_load() retains pointers into this blob. It is intentionally
    // freed only after MultiNet destruction and model deinitialization.
    if (embedded_model_storage_ != nullptr) {
        heap_caps_free(embedded_model_storage_);
        embedded_model_storage_ = nullptr;
    }
    embedded_model_storage_size_ = 0;
    multinet_ = nullptr;
    multinet_name_ = nullptr;
    multinet_loader_mode_ = "UNKNOWN";
    multinet_chunk_size_ = 0;
    afe_fetch_samples_ = 0;
    afe_feed_buffer_.clear();
    kws_enqueue_buffer_.clear();
    {
        std::lock_guard<std::mutex> lock(callback_mutex_);
        callback_queue_.clear();
    }
    multinet_reset_requested_.store(false);
    candidate_pending_.store(false);
    candidate_score_pending_.store(0.0f);
    vad_speech_active_ = false;
    vad_cache_bytes_last_ = 0;
    vad_speech_transitions_ = 0;
    mn_detect_frame_count_ = 0;
    mn_detected_count_ = 0;
    mn_timeout_count_ = 0;
    mn_detect_max_us_ = 0;
    mn_detect_total_us_ = 0;
    mn_queue_depth_frames_.store(0);
    mn_queue_high_water_frames_.store(0);
    mn_queue_overflow_count_.store(0);
    mn_decision_lag_max_ms_.store(0);
    afe_ringbuffer_overflow_count_.store(0);
    afe_ringbuffer_min_free_pct_milli_.store(100000);
    inference_end_pending_.store(false);
    multinet_reset_requested_.store(false);
    kws_input_samples_ = 0;
    vad_speech_active_ = false;
    kws_utterance_active_ = false;
    kws_overflow_current_utterance_ = false;
    multinet_utterance_active_ = false;
    mn_last_telemetry_us_ = 0;
    task_alive_mask_.store(0);
}

bool LiHuahuaWake::Start(AudioCodec* codec, WakeCallback callback) {
    if (running_.load() || codec == nullptr || !callback) return false;
    codec_ = codec;
    callback_ = std::move(callback);
    ring_.assign(kAfeSampleRate * kPreRollMs / 1000, 0);
    ring_write_ = 0;
    capture_.clear();
    mode_.store(Mode::Idle);
    silence_ms_ = 0;
    capture_ms_ = 0;
    candidate_score_ = 0.0f;
    multinet_reset_requested_.store(false);
    candidate_pending_.store(false);
    candidate_score_pending_.store(0.0f);
    vad_speech_active_ = false;
    vad_cache_bytes_last_ = 0;
    vad_speech_transitions_ = 0;
    mn_detect_frame_count_ = 0;
    mn_detected_count_ = 0;
    mn_timeout_count_ = 0;
    mn_detect_max_us_ = 0;
    mn_detect_total_us_ = 0;
    mn_queue_depth_frames_.store(0);
    mn_queue_high_water_frames_.store(0);
    mn_queue_overflow_count_.store(0);
    mn_decision_lag_max_ms_.store(0);
    afe_ringbuffer_overflow_count_.store(0);
    afe_ringbuffer_min_free_pct_milli_.store(100000);
    inference_end_pending_.store(false);
    kws_input_samples_ = 0;
    kws_utterance_active_ = false;
    kws_overflow_current_utterance_ = false;
    multinet_utterance_active_ = false;
    mn_last_telemetry_us_ = esp_timer_get_time();
    {
        std::lock_guard<std::mutex> lock(callback_mutex_);
        callback_queue_.clear();
    }

    if (!initializeModel() || !initializeAfe()) {
        cleanupRuntime();
        callback_ = nullptr;
        codec_ = nullptr;
        return false;
    }

    paused_.store(false);
    running_.store(true);
    task_alive_mask_.store(0);
    task_alive_mask_.fetch_or(kFeedTaskBit);
    if (xTaskCreatePinnedToCore([](void* arg) {
            static_cast<LiHuahuaWake*>(arg)->feedTaskLoop();
            vTaskDelete(nullptr);
        }, "lihuahua_wake_feed", 8192, this, kFeedTaskPriority, &task_, 0) != pdPASS) {
        task_alive_mask_.fetch_and(~kFeedTaskBit);
        running_.store(false);
        cleanupRuntime();
        callback_ = nullptr;
        codec_ = nullptr;
        return false;
    }
    task_alive_mask_.fetch_or(kFetchTaskBit);
    if (xTaskCreatePinnedToCore([](void* arg) {
            static_cast<LiHuahuaWake*>(arg)->fetchTaskLoop();
            vTaskDelete(nullptr);
        }, "lihuahua_wake_fetch", 8192, this, kFetchTaskPriority, &afe_task_, 1) != pdPASS) {
        task_alive_mask_.fetch_and(~kFetchTaskBit);
        running_.store(false);
        while (task_alive_mask_.load() != 0) vTaskDelay(pdMS_TO_TICKS(10));
        cleanupRuntime();
        callback_ = nullptr;
        codec_ = nullptr;
        return false;
    }
    task_alive_mask_.fetch_or(kMultinetTaskBit);
    if (xTaskCreatePinnedToCore([](void* arg) {
            static_cast<LiHuahuaWake*>(arg)->multinetTaskLoop();
            vTaskDelete(nullptr);
        }, "lihuahua_wake_mn", 8192, this, kMultinetTaskPriority, &multinet_task_, 1) != pdPASS) {
        task_alive_mask_.fetch_and(~kMultinetTaskBit);
        running_.store(false);
        while (task_alive_mask_.load() != 0) vTaskDelay(pdMS_TO_TICKS(10));
        cleanupRuntime();
        callback_ = nullptr;
        codec_ = nullptr;
        return false;
    }
    task_alive_mask_.fetch_or(kCallbackTaskBit);
    if (xTaskCreatePinnedToCore([](void* arg) {
            static_cast<LiHuahuaWake*>(arg)->callbackTaskLoop();
            vTaskDelete(nullptr);
        }, "lihuahua_wake_cb", 6144, this, kCallbackTaskPriority, &callback_task_, 0) != pdPASS) {
        task_alive_mask_.fetch_and(~kCallbackTaskBit);
        running_.store(false);
        while (task_alive_mask_.load() != 0) {
            vTaskDelay(pdMS_TO_TICKS(10));
        }
        cleanupRuntime();
        callback_ = nullptr;
        codec_ = nullptr;
        return false;
    }
    ESP_LOGI(kTag, "LOCAL_WAKE_STAGE1=AFE_VAD_GATED_MULTINET");
    ESP_LOGI(kTag, "LOCAL_WAKE_TASKS=FEED_CORE0P2_AFE_CORE0P3_FETCH_CORE1P5_MULTINET_CORE1P3_CALLBACK_CORE0P1");
    ESP_LOGI(kTag, "local wake started: MultiNet=%s preroll=%dms eos=%dms",
             multinet_name_, kPreRollMs, kEndSilenceMs);
    return true;
}

void LiHuahuaWake::Stop() {
    running_.store(false);
    paused_.store(false);
    if (callback_task_ != nullptr) xTaskNotifyGive(callback_task_);
    while (task_alive_mask_.load() != 0) {
        vTaskDelay(pdMS_TO_TICKS(10));
    }
    {
        std::lock_guard<std::mutex> lock(input_mutex_);
        if (codec_ != nullptr) codec_->EnableInput(false);
        if (afe_data_ != nullptr && afe_iface_ != nullptr) afe_iface_->reset_buffer(afe_data_);
    }
    cleanupRuntime();
    callback_ = nullptr;
    codec_ = nullptr;
    mode_.store(Mode::Idle);
    capture_.clear();
}

void LiHuahuaWake::Pause() {
    paused_.store(true);
    while (reading_.load()) vTaskDelay(pdMS_TO_TICKS(2));
    {
        std::lock_guard<std::mutex> lock(input_mutex_);
        if (codec_ != nullptr) codec_->EnableInput(false);
        if (afe_data_ != nullptr && afe_iface_ != nullptr) afe_iface_->reset_buffer(afe_data_);
        afe_feed_buffer_.clear();
    }
    {
        std::lock_guard<std::mutex> lock(state_mutex_);
        candidate_pending_.store(false);
        candidate_score_pending_.store(0.0f);
        candidate_score_ = 0.0f;
        mode_.store(Mode::Idle);
        silence_ms_ = 0;
        capture_ms_ = 0;
        capture_.clear();
        kws_enqueue_buffer_.clear();
        kws_input_samples_ = 0;
        kws_utterance_active_ = false;
        kws_overflow_current_utterance_.store(false);
    }
    requestMultinetReset();
}

void LiHuahuaWake::Resume() {
    if (running_.load()) paused_.store(false);
}

std::vector<int16_t> LiHuahuaWake::readFrame() {
    const int input_rate = codec_->input_sample_rate();
    const int channels = std::max(1, codec_->input_channels());
    const std::size_t input_samples = static_cast<std::size_t>(input_rate * kInputFrameMs / 1000) * channels;
    if (input_samples == 0) return {};
    std::vector<int16_t> input(input_samples);
    {
        std::lock_guard<std::mutex> lock(input_mutex_);
        if (!running_.load() || paused_.load()) return {};
        reading_.store(true);
        if (!running_.load() || paused_.load()) {
            reading_.store(false);
            return {};
        }
        if (!codec_->input_enabled()) codec_->EnableInput(true);
        const bool ok = codec_->InputData(input);
        reading_.store(false);
        if (!ok) return {};
    }
    if (input_rate == kAfeSampleRate) return input;
    if (input_resampler_ == nullptr) return {};

    const uint32_t input_samples_per_channel = static_cast<uint32_t>(input.size() / channels);
    uint32_t output_samples = 0;
    if (esp_ae_rate_cvt_get_max_out_sample_num(input_resampler_, input_samples_per_channel, &output_samples) != ESP_AE_ERR_OK ||
        output_samples == 0) return {};
    std::vector<int16_t> output(static_cast<size_t>(output_samples) * channels);
    uint32_t actual_output = output_samples;
    if (esp_ae_rate_cvt_process(input_resampler_, input.data(), input_samples_per_channel,
                                output.data(), &actual_output) != ESP_AE_ERR_OK || actual_output == 0) return {};
    output.resize(static_cast<size_t>(actual_output) * channels);
    return output;
}

void LiHuahuaWake::feedAfe(const std::vector<int16_t>& input) {
    if (input.empty() || afe_data_ == nullptr || afe_iface_ == nullptr) return;
    std::lock_guard<std::mutex> lock(input_mutex_);
    if (!running_.load() || paused_.load()) return;
    afe_feed_buffer_.insert(afe_feed_buffer_.end(), input.begin(), input.end());
    const size_t feed_samples = static_cast<size_t>(afe_iface_->get_feed_chunksize(afe_data_)) * afe_feed_channels_;
    if (feed_samples == 0) return;
    while (afe_feed_buffer_.size() >= feed_samples) {
        afe_iface_->feed(afe_data_, afe_feed_buffer_.data());
        afe_feed_buffer_.erase(afe_feed_buffer_.begin(), afe_feed_buffer_.begin() + feed_samples);
    }
}

void LiHuahuaWake::feedTaskLoop() {
    while (running_.load()) {
        if (paused_.load()) {
            vTaskDelay(pdMS_TO_TICKS(20));
            continue;
        }
        const auto frame = readFrame();
        if (frame.empty()) {
            vTaskDelay(pdMS_TO_TICKS(10));
            continue;
        }
        feedAfe(frame);
        vTaskDelay(pdMS_TO_TICKS(1));
    }
    task_alive_mask_.fetch_and(~kFeedTaskBit);
    task_ = nullptr;
}

void LiHuahuaWake::fetchTaskLoop() {
    while (running_.load()) {
        if (paused_.load()) {
            vTaskDelay(pdMS_TO_TICKS(20));
            continue;
        }
        const auto* result = afe_iface_ != nullptr && afe_data_ != nullptr
                                 ? afe_iface_->fetch_with_delay(afe_data_, pdMS_TO_TICKS(100))
                                 : nullptr;
        if (!running_.load()) break;
        if (result == nullptr || result->ret_value == ESP_FAIL) continue;
        processAfeResult(result);
    }
    task_alive_mask_.fetch_and(~kFetchTaskBit);
    afe_task_ = nullptr;
}

void LiHuahuaWake::requestMultinetReset() {
    multinet_reset_requested_.store(true);
    if (multinet_task_ != nullptr) xTaskNotifyGive(multinet_task_);
}

void LiHuahuaWake::applyMultinetResetIfRequested() {
    if (!multinet_reset_requested_.exchange(false)) return;
    drainInferenceQueue();
    inference_end_pending_.store(false);
    if (multinet_model_data_ != nullptr && multinet_ != nullptr) {
        multinet_->clean(multinet_model_data_);
    }
    multinet_utterance_active_ = false;
}

bool LiHuahuaWake::enqueueInferenceMarker(InferenceKind kind) {
    if (inference_ring_ == nullptr) return false;
    InferenceItem item{};
    item.kind = static_cast<uint8_t>(kind);
    item.enqueued_at_us = static_cast<uint64_t>(esp_timer_get_time());
    if (xRingbufferSend(inference_ring_, &item, sizeof(item), 0) != pdTRUE) return false;
    const uint32_t depth = mn_queue_depth_frames_.fetch_add(1) + 1;
    uint32_t high_water = mn_queue_high_water_frames_.load();
    while (depth > high_water &&
           !mn_queue_high_water_frames_.compare_exchange_weak(high_water, depth)) {
    }
    return true;
}

bool LiHuahuaWake::enqueueInferenceData(const int16_t* data, std::size_t sample_count) {
    if (data == nullptr || sample_count == 0 || sample_count > kInferenceItemSamples ||
        inference_ring_ == nullptr) {
        return false;
    }
    InferenceItem item{};
    item.kind = static_cast<uint8_t>(InferenceKind::Data);
    item.sample_count = static_cast<uint16_t>(sample_count);
    item.enqueued_at_us = static_cast<uint64_t>(esp_timer_get_time());
    std::copy_n(data, sample_count, item.samples);
    if (xRingbufferSend(inference_ring_, &item, sizeof(item), 0) != pdTRUE) return false;
    const uint32_t depth = mn_queue_depth_frames_.fetch_add(1) + 1;
    uint32_t high_water = mn_queue_high_water_frames_.load();
    while (depth > high_water &&
           !mn_queue_high_water_frames_.compare_exchange_weak(high_water, depth)) {
    }
    return true;
}

void LiHuahuaWake::enqueueKwsSamples(const int16_t* data, std::size_t sample_count) {
    if (data == nullptr || sample_count == 0 || !kws_utterance_active_ ||
        kws_overflow_current_utterance_.load() || candidate_pending_.load() ||
        multinet_chunk_size_ <= 0) {
        return;
    }

    const std::size_t remaining =
        kws_input_samples_ < kKwsWindowSamples ? kKwsWindowSamples - kws_input_samples_ : 0;
    const std::size_t accepted = std::min(sample_count, remaining);
    if (accepted == 0) return;
    kws_enqueue_buffer_.insert(kws_enqueue_buffer_.end(), data, data + accepted);
    kws_input_samples_ += static_cast<uint32_t>(accepted);

    while (kws_enqueue_buffer_.size() >= static_cast<std::size_t>(multinet_chunk_size_)) {
        if (!enqueueInferenceData(kws_enqueue_buffer_.data(),
                                   static_cast<std::size_t>(multinet_chunk_size_))) {
            if (!kws_overflow_current_utterance_.exchange(true)) {
                mn_queue_overflow_count_.fetch_add(1);
                ESP_LOGW(kTag, "MN_INFERENCE_OVERFLOW_CURRENT_UTTERANCE=YES");
            }
            kws_enqueue_buffer_.clear();
            return;
        }
        kws_enqueue_buffer_.erase(
            kws_enqueue_buffer_.begin(),
            kws_enqueue_buffer_.begin() + multinet_chunk_size_);
    }
}

void LiHuahuaWake::drainInferenceQueue() {
    if (inference_ring_ == nullptr) return;
    size_t item_size = 0;
    while (void* raw = xRingbufferReceive(inference_ring_, &item_size, 0)) {
        mn_queue_depth_frames_.fetch_sub(1);
        vRingbufferReturnItem(inference_ring_, raw);
    }
}

void LiHuahuaWake::processInferenceItem(InferenceItem& item) {
    const auto kind = static_cast<InferenceKind>(item.kind);
    if (kind == InferenceKind::UtteranceStart) {
        if (multinet_ != nullptr && multinet_model_data_ != nullptr) {
            multinet_->clean(multinet_model_data_);
        }
        multinet_utterance_active_ = true;
        return;
    }

    if (kind == InferenceKind::UtteranceEnd) {
        if (multinet_utterance_active_ && multinet_ != nullptr && multinet_model_data_ != nullptr) {
            multinet_->clean(multinet_model_data_);
        }
        multinet_utterance_active_ = false;
        return;
    }

    if (kind != InferenceKind::Data || !multinet_utterance_active_ ||
        candidate_pending_.load() || multinet_ == nullptr || multinet_model_data_ == nullptr ||
        item.sample_count != static_cast<uint16_t>(multinet_chunk_size_)) {
        return;
    }

    const uint32_t lag_ms = static_cast<uint32_t>(
        std::max<int64_t>(0, esp_timer_get_time() - static_cast<int64_t>(item.enqueued_at_us)) / 1000);
    uint32_t previous_lag = mn_decision_lag_max_ms_.load();
    while (lag_ms > previous_lag &&
           !mn_decision_lag_max_ms_.compare_exchange_weak(previous_lag, lag_ms)) {
    }

    const int64_t started_at = esp_timer_get_time();
    const auto state = multinet_->detect(multinet_model_data_, item.samples);
    const uint32_t elapsed_us = static_cast<uint32_t>(
        std::max<int64_t>(0, esp_timer_get_time() - started_at));
    ++mn_detect_frame_count_;
    mn_detect_total_us_ += elapsed_us;
    mn_detect_max_us_ = std::max(mn_detect_max_us_, elapsed_us);

    if (state == ESP_MN_STATE_DETECTED) {
        ++mn_detected_count_;
        auto* result_data = multinet_->get_results(multinet_model_data_);
        if (result_data != nullptr && result_data->num > 0 && result_data->command_id[0] == 1) {
            const float score = std::clamp(result_data->prob[0], 0.0f, 1.0f);
            candidate_score_pending_.store(score);
            candidate_pending_.store(true);
            ESP_LOGI(kTag, "local wake candidate=huahua score=%0.4f vad=speech", score);
        }
        multinet_->clean(multinet_model_data_);
        multinet_utterance_active_ = false;
        drainInferenceQueue();
        inference_end_pending_.store(false);
        return;
    }

    if (state == ESP_MN_STATE_TIMEOUT) {
        ++mn_timeout_count_;
        multinet_->clean(multinet_model_data_);
        multinet_utterance_active_ = false;
        drainInferenceQueue();
        inference_end_pending_.store(false);
    }
}

void LiHuahuaWake::multinetTaskLoop() {
    while (running_.load()) {
        if (paused_.load()) {
            applyMultinetResetIfRequested();
            ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(100));
            continue;
        }
        applyMultinetResetIfRequested();
        size_t item_size = 0;
        void* raw = inference_ring_ != nullptr
                        ? xRingbufferReceive(inference_ring_, &item_size, pdMS_TO_TICKS(100))
                        : nullptr;
        if (raw == nullptr) {
            maybeLogTelemetry();
            continue;
        }
        mn_queue_depth_frames_.fetch_sub(1);
        if (item_size == sizeof(InferenceItem)) {
            processInferenceItem(*static_cast<InferenceItem*>(raw));
        }
        vRingbufferReturnItem(inference_ring_, raw);
        maybeLogTelemetry();
    }

    applyMultinetResetIfRequested();
    drainInferenceQueue();
    if (multinet_utterance_active_ && multinet_model_data_ != nullptr && multinet_ != nullptr) {
        multinet_->clean(multinet_model_data_);
    }
    multinet_utterance_active_ = false;
    task_alive_mask_.fetch_and(~kMultinetTaskBit);
    multinet_task_ = nullptr;
}

void LiHuahuaWake::maybeLogTelemetry() {
    const int64_t now = esp_timer_get_time();
    if (mn_last_telemetry_us_ == 0 || now - mn_last_telemetry_us_ < 3000000) return;
    mn_last_telemetry_us_ = now;
    const uint32_t average_us = mn_detect_frame_count_ == 0
                                    ? 0
                                    : static_cast<uint32_t>(mn_detect_total_us_ / mn_detect_frame_count_);
    const uint32_t min_free_milli = afe_ringbuffer_min_free_pct_milli_.load();
    ESP_LOGI(kTag, "MN_DETECT_FRAME_COUNT=%u MN_DETECT_AVG_US=%u MN_DETECT_MAX_US=%u",
             static_cast<unsigned>(mn_detect_frame_count_), static_cast<unsigned>(average_us),
             static_cast<unsigned>(mn_detect_max_us_));
    ESP_LOGI(kTag, "MN_QUEUE_DEPTH_FRAMES=%u MN_QUEUE_HIGH_WATER_FRAMES=%u "
                   "MN_QUEUE_OVERFLOW_COUNT=%u MN_DECISION_LAG_MAX_MS=%u MN_KWS_WINDOW_MS=%u",
             static_cast<unsigned>(mn_queue_depth_frames_.load()),
             static_cast<unsigned>(mn_queue_high_water_frames_.load()),
             static_cast<unsigned>(mn_queue_overflow_count_.load()),
             static_cast<unsigned>(mn_decision_lag_max_ms_.load()),
             static_cast<unsigned>(kKwsWindowMs));
    ESP_LOGI(kTag, "AFE_FETCH_FRAME_SAMPLES=%d MN_CHUNK_SAMPLES=%d VAD_CACHE_BYTES_LAST=%u "
                   "VAD_SPEECH_TRANSITIONS=%u MN_DETECTED_COUNT=%u MN_TIMEOUT_COUNT=%u",
             afe_fetch_samples_, multinet_chunk_size_, static_cast<unsigned>(vad_cache_bytes_last_),
             static_cast<unsigned>(vad_speech_transitions_), static_cast<unsigned>(mn_detected_count_),
             static_cast<unsigned>(mn_timeout_count_));
    ESP_LOGI(kTag, "AFE_RINGBUF_MIN_FREE_PCT=%0.1f AFE_FEED_OVERFLOW=%u "
                   "MN_INFERENCE_OVERFLOW_CURRENT_UTTERANCE=%s",
             static_cast<float>(min_free_milli) / 1000.0f,
             static_cast<unsigned>(afe_ringbuffer_overflow_count_.load()),
             kws_overflow_current_utterance_.load() ? "YES" : "NO");
}

void LiHuahuaWake::enqueueCallback(std::vector<int16_t>&& pcm, float score) {
    if (pcm.empty() || !running_.load()) return;
    {
        std::lock_guard<std::mutex> lock(callback_mutex_);
        // Only one wake submission may be in flight. A newer capture replaces
        // a stale one rather than allowing network I/O to grow without bound.
        callback_queue_.clear();
        callback_queue_.emplace_back(std::move(pcm), score);
    }
    if (callback_task_ != nullptr) xTaskNotifyGive(callback_task_);
}

void LiHuahuaWake::callbackTaskLoop() {
    while (running_.load()) {
        std::pair<std::vector<int16_t>, float> item;
        {
            std::lock_guard<std::mutex> lock(callback_mutex_);
            if (!callback_queue_.empty()) {
                item = std::move(callback_queue_.front());
                callback_queue_.pop_front();
            }
        }
        if (item.first.empty()) {
            ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(100));
            continue;
        }
        if (callback_) callback_(std::move(item.first), "huahua", item.second);
    }
    {
        std::lock_guard<std::mutex> lock(callback_mutex_);
        callback_queue_.clear();
    }
    task_alive_mask_.fetch_and(~kCallbackTaskBit);
    callback_task_ = nullptr;
}

void LiHuahuaWake::processAfeResult(const afe_fetch_result_t* result) {
    if (result == nullptr || result->data == nullptr || result->data_size <= 0) return;
    if (!running_.load() || paused_.load()) return;
    std::lock_guard<std::mutex> state_lock(state_mutex_);
    if (!running_.load() || paused_.load()) return;

    const size_t samples = static_cast<size_t>(result->data_size) / sizeof(int16_t);
    if ((result->data_size % static_cast<int>(sizeof(int16_t))) != 0) {
        ESP_LOGW(kTag, "AFE_DATA_ODD_BYTES=%d", result->data_size);
    }
    std::vector<int16_t> frame(result->data, result->data + samples);
    pushRing(frame);
    const float free_pct = std::clamp(result->ringbuff_free_pct, 0.0f, 100.0f);
    const uint32_t free_milli = static_cast<uint32_t>(free_pct * 1000.0f);
    uint32_t previous_free = afe_ringbuffer_min_free_pct_milli_.load();
    while (free_milli < previous_free &&
           !afe_ringbuffer_min_free_pct_milli_.compare_exchange_weak(previous_free, free_milli)) {
    }
    if (free_pct <= 0.0f) afe_ringbuffer_overflow_count_.fetch_add(1);

    const bool speech = result->vad_state == VAD_SPEECH;
    bool started_capture = false;
    if (candidate_pending_.exchange(false) && mode_.load() == Mode::Idle) {
        candidate_score_ = std::clamp(candidate_score_pending_.load(), 0.0f, 1.0f);
        beginCapture();
        started_capture = true;
    }

    if (mode_.load() == Mode::Capture) {
        if (!started_capture) appendCapture(frame, speech);
        return;
    }

    if (speech && !vad_speech_active_) {
        vad_speech_active_ = true;
        ++vad_speech_transitions_;
        kws_utterance_active_ = true;
        kws_input_samples_ = 0;
        kws_enqueue_buffer_.clear();
        kws_overflow_current_utterance_.store(false);
        if (inference_end_pending_.load() || !enqueueInferenceMarker(InferenceKind::UtteranceStart)) {
            kws_overflow_current_utterance_.store(true);
            mn_queue_overflow_count_.fetch_add(1);
            ESP_LOGW(kTag, "MN_INFERENCE_OVERFLOW_CURRENT_UTTERANCE=YES");
        }
        vad_cache_bytes_last_ = result->vad_cache_size > 0 ? static_cast<uint32_t>(result->vad_cache_size) : 0;
        if (result->vad_cache != nullptr && result->vad_cache_size > 0) {
            if ((result->vad_cache_size % static_cast<int>(sizeof(int16_t))) == 0) {
                enqueueKwsSamples(result->vad_cache,
                                  static_cast<size_t>(result->vad_cache_size) / sizeof(int16_t));
            } else {
                ESP_LOGW(kTag, "VAD_CACHE_ODD_BYTES=%d", result->vad_cache_size);
            }
        }
        ESP_LOGI(kTag, "VAD_SPEECH_TRANSITION=START VAD_CACHE_BYTES=%u",
                 static_cast<unsigned>(vad_cache_bytes_last_));
    }

    if (!speech) {
        if (vad_speech_active_) {
            kws_enqueue_buffer_.clear();
            kws_utterance_active_ = false;
            if (!enqueueInferenceMarker(InferenceKind::UtteranceEnd)) {
                inference_end_pending_.store(true);
            }
            vad_speech_active_ = false;
            ESP_LOGI(kTag, "VAD_SPEECH_TRANSITION=END");
        }
        return;
    }

    enqueueKwsSamples(frame.data(), frame.size());
}

void LiHuahuaWake::pushRing(const std::vector<int16_t>& frame) {
    if (ring_.empty()) return;
    for (const auto sample : frame) {
        ring_[ring_write_] = sample;
        ring_write_ = (ring_write_ + 1) % ring_.size();
    }
}

std::vector<int16_t> LiHuahuaWake::snapshotRing() const {
    std::vector<int16_t> snapshot(ring_.size());
    if (ring_.empty()) return snapshot;
    for (std::size_t i = 0; i < ring_.size(); ++i) snapshot[i] = ring_[(ring_write_ + i) % ring_.size()];
    return snapshot;
}

void LiHuahuaWake::beginCapture() {
    mode_.store(Mode::Capture);
    capture_ = snapshotRing();
    capture_ms_ = kPreRollMs;
    silence_ms_ = 0;
}

void LiHuahuaWake::appendCapture(const std::vector<int16_t>& frame, bool speech) {
    capture_.insert(capture_.end(), frame.begin(), frame.end());
    const uint32_t frame_ms = static_cast<uint32_t>(frame.size() * 1000 / kAfeSampleRate);
    capture_ms_ += frame_ms;
    if (speech) silence_ms_ = 0;
    else silence_ms_ += frame_ms;
    if (capture_ms_ >= kMaximumCaptureMs || (capture_ms_ >= kPreRollMs && silence_ms_ >= kEndSilenceMs)) finishCapture();
}

void LiHuahuaWake::finishCapture() {
    if (capture_.empty()) {
        mode_.store(Mode::Idle);
        return;
    }
    auto pcm = std::move(capture_);
    capture_.clear();
    const float score = candidate_score_;
    mode_.store(Mode::Idle);
    silence_ms_ = 0;
    capture_ms_ = 0;
    candidate_score_ = 0.0f;
    requestMultinetReset();
    vad_speech_active_ = false;
    enqueueCallback(std::move(pcm), score);
}
