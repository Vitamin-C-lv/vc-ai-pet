#include "lihuahua_wake.h"

#include <algorithm>
#include <cmath>
#include <cstring>

#include <esp_heap_caps.h>
#include <esp_log.h>
#include <esp_mn_speech_commands.h>

#include <assets.h>

namespace {
constexpr char kTag[] = "LiHuahuaWake";
constexpr int kSampleRate = 16000;
constexpr int kFrameMs = 10;
constexpr int kFrameSamples = kSampleRate * kFrameMs / 1000;
constexpr int kPreRollMs = 2000;
constexpr int kEndSilenceMs = 800;
constexpr int kMinimumCaptureMs = 350;
constexpr int kMaximumCaptureMs = 12000;
constexpr float kMinimumVoiceRms = 550.0f;
constexpr float kVoiceMultiplier = 2.4f;
}

LiHuahuaWake::~LiHuahuaWake() {
    Stop();
}

bool LiHuahuaWake::initializeModel() {
    // The factory image packages ESP-SR models in the existing assets
    // partition.  Load that bounded blob directly so the standalone body app
    // does not depend on the cloud/Xiaozhi application mounting a model FS.
    void* packed_models = nullptr;
    size_t packed_models_size = 0;
    if (Assets::GetInstance().GetAssetData("srmodels.bin", packed_models, packed_models_size)) {
        (void)packed_models_size;
        models_ = srmodel_load(packed_models);
    }
    if (models_ == nullptr) models_ = esp_srmodel_init("model");
    if (models_ == nullptr || models_->num <= 0) {
        ESP_LOGE(kTag, "ESP-SR model list unavailable");
        return false;
    }
    multinet_name_ = esp_srmodel_filter(models_, ESP_MN_PREFIX, "cn");
    if (multinet_name_ == nullptr) multinet_name_ = esp_srmodel_filter(models_, ESP_MN_PREFIX, nullptr);
    if (multinet_name_ == nullptr) {
        ESP_LOGE(kTag, "Chinese MultiNet model unavailable");
        return false;
    }
    multinet_ = esp_mn_handle_from_name(multinet_name_);
    if (multinet_ == nullptr) return false;
    multinet_model_data_ = multinet_->create(multinet_name_, 3000);
    if (multinet_model_data_ == nullptr) return false;
#ifdef CONFIG_CUSTOM_WAKE_WORD_THRESHOLD
    const float threshold = static_cast<float>(CONFIG_CUSTOM_WAKE_WORD_THRESHOLD) / 100.0f;
#else
    const float threshold = 0.25f;
#endif
    multinet_->set_det_threshold(multinet_model_data_, threshold);
    esp_mn_commands_clear();
    // The ESP-SR layer deliberately detects only the strict first phrase.
    // “花花在吗” is disambiguated by the PC Vosk stage from this bounded PCM.
    esp_mn_commands_add(1, "hua hua");
    esp_mn_commands_update();
    multinet_->print_active_speech_commands(multinet_model_data_);
    return true;
}

bool LiHuahuaWake::Start(AudioCodec* codec, WakeCallback callback) {
    if (running_.load() || codec == nullptr || !callback) return false;
    codec_ = codec;
    callback_ = std::move(callback);
    ring_.assign(kSampleRate * kPreRollMs / 1000, 0);
    ring_write_ = 0;
    capture_.clear();
    mode_ = Mode::Idle;
    silence_ms_ = 0;
    capture_ms_ = 0;
    noise_floor_ = 300.0f;
    if (!initializeModel()) {
        if (models_ != nullptr) esp_srmodel_deinit(models_);
        models_ = nullptr;
        return false;
    }
    paused_.store(false);
    running_.store(true);
    if (xTaskCreatePinnedToCore([](void* arg) {
            static_cast<LiHuahuaWake*>(arg)->taskLoop();
            vTaskDelete(nullptr);
        }, "lihuahua_wake", 8192, this, 7, &task_, 0) != pdPASS) {
        running_.store(false);
        if (multinet_model_data_ != nullptr) multinet_->destroy(multinet_model_data_);
        multinet_model_data_ = nullptr;
        if (models_ != nullptr) esp_srmodel_deinit(models_);
        models_ = nullptr;
        return false;
    }
    ESP_LOGI(kTag, "local wake started: MultiNet=%s preroll=%dms eos=%dms", multinet_name_, kPreRollMs, kEndSilenceMs);
    return true;
}

void LiHuahuaWake::Stop() {
    if (!running_.exchange(false)) return;
    paused_.store(false);
    while (task_ != nullptr) vTaskDelay(pdMS_TO_TICKS(10));
    std::lock_guard<std::mutex> lock(input_mutex_);
    if (codec_ != nullptr) codec_->EnableInput(false);
    if (multinet_model_data_ != nullptr && multinet_ != nullptr) multinet_->destroy(multinet_model_data_);
    multinet_model_data_ = nullptr;
    if (models_ != nullptr) esp_srmodel_deinit(models_);
    models_ = nullptr;
    multinet_ = nullptr;
    multinet_name_ = nullptr;
    callback_ = nullptr;
    codec_ = nullptr;
}

void LiHuahuaWake::Pause() {
    paused_.store(true);
    while (reading_.load()) vTaskDelay(pdMS_TO_TICKS(2));
    std::lock_guard<std::mutex> lock(input_mutex_);
    if (codec_ != nullptr) codec_->EnableInput(false);
}

void LiHuahuaWake::Resume() {
    if (running_.load()) paused_.store(false);
}

std::vector<int16_t> LiHuahuaWake::readFrame() {
    const int inputRate = codec_->input_sample_rate();
    const int channels = std::max(1, codec_->input_channels());
    const std::size_t inputSamples = static_cast<std::size_t>(inputRate / 100) * channels;
    std::vector<int16_t> input(inputSamples);
    {
        std::lock_guard<std::mutex> lock(input_mutex_);
        reading_.store(true);
        if (!codec_->input_enabled()) codec_->EnableInput(true);
        const bool ok = codec_->InputData(input);
        reading_.store(false);
        if (!ok) return {};
    }
    if (channels == 1 && inputRate == kSampleRate) return input;
    std::vector<int16_t> mono(inputSamples / channels);
    for (std::size_t i = 0; i < mono.size(); ++i) mono[i] = input[i * channels];
    if (inputRate == kSampleRate) return mono;
    std::vector<int16_t> output(kFrameSamples);
    for (int i = 0; i < kFrameSamples; ++i) {
        const float source = static_cast<float>(i) * static_cast<float>(mono.size() - 1) / static_cast<float>(kFrameSamples - 1);
        const auto left = static_cast<std::size_t>(source);
        const auto right = std::min(left + 1, mono.size() - 1);
        const float fraction = source - static_cast<float>(left);
        output[i] = static_cast<int16_t>(mono[left] + (mono[right] - mono[left]) * fraction);
    }
    return output;
}

float LiHuahuaWake::frameRms(const std::vector<int16_t>& frame) {
    if (frame.empty()) return 0.0f;
    double sum = 0.0;
    for (const auto sample : frame) sum += static_cast<double>(sample) * static_cast<double>(sample);
    return static_cast<float>(std::sqrt(sum / static_cast<double>(frame.size())));
}

void LiHuahuaWake::pushRing(const std::vector<int16_t>& frame) {
    for (const auto sample : frame) {
        ring_[ring_write_] = sample;
        ring_write_ = (ring_write_ + 1) % ring_.size();
    }
}

std::vector<int16_t> LiHuahuaWake::snapshotRing() const {
    std::vector<int16_t> snapshot(ring_.size());
    for (std::size_t i = 0; i < ring_.size(); ++i) snapshot[i] = ring_[(ring_write_ + i) % ring_.size()];
    return snapshot;
}

void LiHuahuaWake::beginCapture() {
    mode_ = Mode::Capture;
    capture_ = snapshotRing();
    capture_ms_ = 0;
    silence_ms_ = 0;
}

void LiHuahuaWake::appendCapture(const std::vector<int16_t>& frame, float rms) {
    capture_.insert(capture_.end(), frame.begin(), frame.end());
    capture_ms_ += kFrameMs;
    const bool voiced = rms >= std::max(kMinimumVoiceRms, noise_floor_ * kVoiceMultiplier);
    if (voiced) silence_ms_ = 0;
    else silence_ms_ += kFrameMs;
    if (capture_ms_ >= kMaximumCaptureMs || (capture_ms_ >= kMinimumCaptureMs && silence_ms_ >= kEndSilenceMs)) finishCapture();
}

void LiHuahuaWake::finishCapture() {
    if (capture_.empty()) {
        mode_ = Mode::Idle;
        return;
    }
    auto pcm = std::move(capture_);
    capture_.clear();
    mode_ = Mode::Idle;
    silence_ms_ = 0;
    capture_ms_ = 0;
    if (callback_) callback_(std::move(pcm), "huahua");
}

void LiHuahuaWake::taskLoop() {
    while (running_.load()) {
        if (paused_.load()) {
            vTaskDelay(pdMS_TO_TICKS(20));
            continue;
        }
        auto frame = readFrame();
        if (frame.size() != kFrameSamples) {
            vTaskDelay(pdMS_TO_TICKS(10));
            continue;
        }
        const float rms = frameRms(frame);
        pushRing(frame);
        if (mode_ == Mode::Idle) {
            if (rms < kMinimumVoiceRms * 1.5f) noise_floor_ = noise_floor_ * 0.995f + rms * 0.005f;
            if (multinet_model_data_ != nullptr) {
                const int chunkSize = multinet_->get_samp_chunksize(multinet_model_data_);
                static std::vector<int16_t> kwsBuffer;
                kwsBuffer.insert(kwsBuffer.end(), frame.begin(), frame.end());
                while (static_cast<int>(kwsBuffer.size()) >= chunkSize && mode_ == Mode::Idle) {
                    const auto state = multinet_->detect(multinet_model_data_, kwsBuffer.data());
                    if (state == ESP_MN_STATE_DETECTED) {
                        auto* result = multinet_->get_results(multinet_model_data_);
                        if (result != nullptr && result->num > 0 && result->command_id[0] == 1) {
                            ESP_LOGI(kTag, "local wake candidate detected probability=%f", result->prob[0]);
                            beginCapture();
                        }
                        multinet_->clean(multinet_model_data_);
                    } else if (state == ESP_MN_STATE_TIMEOUT) {
                        multinet_->clean(multinet_model_data_);
                    }
                    kwsBuffer.erase(kwsBuffer.begin(), kwsBuffer.begin() + chunkSize);
                }
            }
        } else {
            appendCapture(frame, rms);
        }
    }
    task_ = nullptr;
}
