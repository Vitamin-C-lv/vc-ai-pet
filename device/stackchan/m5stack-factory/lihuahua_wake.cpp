#include "lihuahua_wake.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <string>

#include <esp_heap_caps.h>
#include <esp_image_format.h>
#include <esp_log.h>
#include <esp_partition.h>
#include <esp_timer.h>
#include <esp_mn_speech_commands.h>
#include <miniz.h>

#include <assets.h>

namespace {
constexpr char kTag[] = "LiHuahuaWake";
constexpr int kAfeSampleRate = 16000;
constexpr int kInputFrameMs = 10;
constexpr int kPreRollMs = 2000;
constexpr int kEndSilenceMs = 800;
constexpr int kMaximumCaptureMs = 12000;
// The ESP-SR AFE ring is the SDK's own feed/fetch buffer.  A larger frame
// window absorbs the bounded MultiNet5 detect latency without introducing an
// application-side inference queue or dropping/resetting the command stream.
constexpr int kAfeRingBufferFrames = 32;
constexpr UBaseType_t kFeedTaskPriority = 4;
constexpr UBaseType_t kAfeTaskPriority = 4;
constexpr UBaseType_t kFetchTaskPriority = 1;
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
            ESP_LOGI(kTag, "MULTINET_LOADER_MODE=PSRAM");
        } else {
            ESP_LOGI(kTag, "MULTINET_LOADER_MODE=DEFAULT reason=unsupported");
        }
    } else {
        ESP_LOGI(kTag, "MULTINET_LOADER_MODE=DEFAULT reason=unavailable");
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
    afe_config->agc_init = false;
    // Keep the AFE speech-enhancement worker on CPU1 at the same real-time
    // priority as feed. The synchronous MultiNet fetch worker also stays on
    // CPU1, below AFE, so it cannot starve speech enhancement.
    afe_config->afe_perferred_core = 1;
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
    kws_buffer_.clear();
    afe_fetch_samples_ = afe_iface_->get_fetch_chunksize(afe_data_);
    ESP_LOGI(kTag, "AFE_INITIALIZED=YES feed_rate=%d feed_channels=%d feed_chunk=%d fetch_chunk=%d",
             afe_iface_->get_samp_rate(afe_data_), afe_feed_channels_,
             afe_iface_->get_feed_chunksize(afe_data_), afe_iface_->get_fetch_chunksize(afe_data_));
    ESP_LOGI(kTag, "AFE_FETCH_SAMPLES=%d", afe_fetch_samples_);
    ESP_LOGI(kTag, "AFE_RINGBUF_FRAMES=%d", kAfeRingBufferFrames);
    ESP_LOGI(kTag, "MN_CHUNK_SAMPLES=%d", multinet_chunk_size_);
    ESP_LOGI(kTag, "AFE_VAD_ENABLED=YES");
    ESP_LOGI(kTag, "AFE_VAD_CONFIG=MODE_2 MIN_SPEECH_MS=128 MIN_NOISE_MS=200 DELAY_MS=128");
    afe_iface_->print_pipeline(afe_data_);
    return true;
}

void LiHuahuaWake::cleanupRuntime() {
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
    multinet_chunk_size_ = 0;
    afe_fetch_samples_ = 0;
    afe_feed_buffer_.clear();
    kws_buffer_.clear();
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
    afe_ringbuffer_full_count_ = 0;
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
    afe_ringbuffer_full_count_ = 0;
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
        }, "lihuahua_wake_afe", 8192, this, kFetchTaskPriority, &afe_task_, 0) != pdPASS) {
        task_alive_mask_.fetch_and(~kFetchTaskBit);
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
    ESP_LOGI(kTag, "LOCAL_WAKE_TASKS=FEED_CORE0P4_AFE_CORE1P4_FETCH_DETECT_CORE0P1_CALLBACK_CORE0P1");
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
        applyMultinetResetIfRequested();
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
}

void LiHuahuaWake::applyMultinetResetIfRequested() {
    if (!multinet_reset_requested_.exchange(false)) return;
    kws_buffer_.clear();
    vad_speech_active_ = false;
    if (multinet_model_data_ != nullptr && multinet_ != nullptr) {
        multinet_->clean(multinet_model_data_);
    }
}

void LiHuahuaWake::processMultinetSamples(const int16_t* data, std::size_t sample_count) {
    if (data == nullptr || sample_count == 0 || !running_.load() || paused_.load() ||
        mode_.load() != Mode::Idle || candidate_pending_.load() || multinet_model_data_ == nullptr ||
        multinet_ == nullptr || multinet_chunk_size_ <= 0) {
        return;
    }

    kws_buffer_.insert(kws_buffer_.end(), data, data + sample_count);
    while (static_cast<int>(kws_buffer_.size()) >= multinet_chunk_size_ && running_.load() &&
           !paused_.load() && mode_.load() == Mode::Idle && !candidate_pending_.load()) {
        const int64_t started_at = esp_timer_get_time();
        const auto state = multinet_->detect(multinet_model_data_, kws_buffer_.data());
        const uint32_t elapsed_us = static_cast<uint32_t>(std::max<int64_t>(0, esp_timer_get_time() - started_at));
        ++mn_detect_frame_count_;
        mn_detect_total_us_ += elapsed_us;
        mn_detect_max_us_ = std::max(mn_detect_max_us_, elapsed_us);

        kws_buffer_.erase(kws_buffer_.begin(), kws_buffer_.begin() + multinet_chunk_size_);
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
            break;
        }
        if (state == ESP_MN_STATE_TIMEOUT) {
            ++mn_timeout_count_;
            multinet_->clean(multinet_model_data_);
            kws_buffer_.clear();
            break;
        }
    }
}

void LiHuahuaWake::maybeLogTelemetry() {
    const int64_t now = esp_timer_get_time();
    if (mn_last_telemetry_us_ == 0 || now - mn_last_telemetry_us_ < 3000000) return;
    mn_last_telemetry_us_ = now;
    const uint32_t average_us = mn_detect_frame_count_ == 0
                                    ? 0
                                    : static_cast<uint32_t>(mn_detect_total_us_ / mn_detect_frame_count_);
    ESP_LOGI(kTag, "MN_DETECT_FRAME_COUNT=%u MN_DETECT_AVG_US=%u MN_DETECT_MAX_US=%u",
             static_cast<unsigned>(mn_detect_frame_count_), static_cast<unsigned>(average_us),
             static_cast<unsigned>(mn_detect_max_us_));
    ESP_LOGI(kTag, "AFE_FETCH_FRAME_SAMPLES=%d MN_CHUNK_SAMPLES=%d VAD_CACHE_BYTES_LAST=%u "
                   "VAD_SPEECH_TRANSITIONS=%u MN_DETECTED_COUNT=%u MN_TIMEOUT_COUNT=%u",
             afe_fetch_samples_, multinet_chunk_size_, static_cast<unsigned>(vad_cache_bytes_last_),
             static_cast<unsigned>(vad_speech_transitions_), static_cast<unsigned>(mn_detected_count_),
             static_cast<unsigned>(mn_timeout_count_));
    ESP_LOGI(kTag, "VAD_CACHE_USED=%s AFE_RINGBUFFER_FULL=%u",
             vad_cache_bytes_last_ > 0 ? "YES" : "NO",
             static_cast<unsigned>(afe_ringbuffer_full_count_));
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
    applyMultinetResetIfRequested();
    std::lock_guard<std::mutex> state_lock(state_mutex_);
    if (!running_.load() || paused_.load()) return;
    const size_t samples = static_cast<size_t>(result->data_size) / sizeof(int16_t);
    if ((result->data_size % static_cast<int>(sizeof(int16_t))) != 0) {
        ESP_LOGW(kTag, "AFE_DATA_ODD_BYTES=%d", result->data_size);
    }
    std::vector<int16_t> frame(result->data, result->data + samples);
    pushRing(frame);
    const bool speech = result->vad_state == VAD_SPEECH;
    if (result->ringbuff_free_pct <= 0.0f) ++afe_ringbuffer_full_count_;

    bool started_capture = false;
    if (candidate_pending_.exchange(false) && mode_.load() == Mode::Idle) {
        candidate_score_ = std::clamp(candidate_score_pending_.load(), 0.0f, 1.0f);
        beginCapture();
        // beginCapture() snapshots the ring after this frame was inserted, so
        // appending it a second time would duplicate the boundary frame.
        started_capture = true;
    }

    if (mode_.load() == Mode::Capture) {
        if (!started_capture) appendCapture(frame, speech);
        maybeLogTelemetry();
        return;
    }

    if (speech && !vad_speech_active_) {
        vad_speech_active_ = true;
        ++vad_speech_transitions_;
        multinet_->clean(multinet_model_data_);
        kws_buffer_.clear();
        vad_cache_bytes_last_ = result->vad_cache_size > 0 ? static_cast<uint32_t>(result->vad_cache_size) : 0;
        if (result->vad_cache != nullptr && result->vad_cache_size > 0) {
            if ((result->vad_cache_size % static_cast<int>(sizeof(int16_t))) == 0) {
                processMultinetSamples(result->vad_cache,
                                       static_cast<size_t>(result->vad_cache_size) / sizeof(int16_t));
            } else {
                ESP_LOGW(kTag, "VAD_CACHE_ODD_BYTES=%d", result->vad_cache_size);
            }
        }
        ESP_LOGI(kTag, "VAD_SPEECH_TRANSITION=START VAD_CACHE_BYTES=%u",
                 static_cast<unsigned>(vad_cache_bytes_last_));
    }

    // V1 remains VAD-gated, but MultiNet now runs synchronously on this AFE
    // fetch task so it sees one continuous utterance without an intermediate
    // queue that can reset the model under normal speech load.
    if (!speech) {
        if (vad_speech_active_) {
            multinet_->clean(multinet_model_data_);
            kws_buffer_.clear();
            vad_speech_active_ = false;
            ESP_LOGI(kTag, "VAD_SPEECH_TRANSITION=END");
        }
        maybeLogTelemetry();
        return;
    }
    processMultinetSamples(frame.data(), frame.size());
    maybeLogTelemetry();
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
    multinet_reset_requested_.store(true);
    vad_speech_active_ = false;
    enqueueCallback(std::move(pcm), score);
}
