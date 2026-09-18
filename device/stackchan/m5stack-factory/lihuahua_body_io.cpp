#include "lihuahua_body_io.h"
#include "stackchan_body_config.h"
#include <hal/hal.h>
#include <hal/board/hal_bridge.h>
#include <hal/board/stackchan_camera.h>
#include <board.h>
#include <audio/audio_codec.h>
#include <esp_http_client.h>
#include <esp_log.h>
#include <esp_heap_caps.h>
#include <cJSON.h>
#include <lwip/sockets.h>
#include <unistd.h>
#include <atomic>
#include <string>
#include <vector>
#include <algorithm>

namespace {
std::atomic<bool> capture_requested{false}, record_requested{false};
std::string bridge_base;
esp_err_t collect(esp_http_client_event_t* e) {
    if(e->event_id==HTTP_EVENT_ON_DATA && e->user_data) {
        auto& out=*static_cast<std::string*>(e->user_data);
        if(out.size()+e->data_len>4096) return ESP_FAIL;
        out.append(static_cast<char*>(e->data),e->data_len);
    }
    return ESP_OK;
}
bool request(const char* path,const void* data,size_t size,const char* type,std::string& out) {
    auto url=lihuahuaBodyEndpoint(path);
    esp_http_client_config_t cfg{}; cfg.url=url.c_str(); cfg.timeout_ms=8000;
    cfg.event_handler=collect; cfg.user_data=&out;
    auto c=esp_http_client_init(&cfg); if(!c) return false;
    if(data) { esp_http_client_set_method(c,HTTP_METHOD_POST); esp_http_client_set_header(c,"Content-Type",type);
        esp_http_client_set_post_field(c,static_cast<const char*>(data),size); }
    auto err=esp_http_client_perform(c); int status=esp_http_client_get_status_code(c); esp_http_client_cleanup(c);
    return err==ESP_OK && status>=200 && status<300;
}
void ack(const char* kind, bool ok, size_t bytes) {
    char body[160]; snprintf(body,sizeof(body),"{\"kind\":\"%s\",\"ok\":%s,\"bytes\":%u}",kind,ok?"true":"false",unsigned(bytes));
    std::string out; request("/v1/body/ack",body,strlen(body),"application/json",out);
    ESP_LOGI("LiHuahua","%s ok=%d bytes=%u",kind,ok,unsigned(bytes));
}
void capture() {
    auto cam=hal_bridge::board_get_camera();
    if(!cam || !cam->Capture()) { ack("camera",false,0); return; }
    uint8_t* jpeg=nullptr; size_t size=0;
    bool ok=image_to_jpeg(const_cast<uint8_t*>(cam->GetFrameData()),cam->GetFrameSize(),cam->GetFrameWidth(),cam->GetFrameHeight(),cam->GetFrameFormat(),75,&jpeg,&size);
    if(ok) { std::string out; ok=request("/v1/body/camera",jpeg,size,"image/jpeg",out); }
    free(jpeg); ack("camera",ok,size);
}
void record() {
    auto codec=Board::GetInstance().GetAudioCodec();
    if(!codec) { ack("microphone",false,0); return; }
    constexpr size_t frames=24000*5;
    auto pcm=static_cast<int16_t*>(heap_caps_malloc(frames*2,MALLOC_CAP_SPIRAM));
    if(!pcm) { ack("microphone",false,0); return; }
    codec->EnableInput(true); size_t done=0; int channels=codec->input_channels();
    std::vector<int16_t> chunk(480*channels);
    while(done<frames && codec->InputData(chunk)) {
        for(size_t i=0;i<480;++i) pcm[done+i]=chunk[i*channels];
        done+=480;
    }
    codec->EnableInput(false); std::string out;
    bool ok=done==frames && request("/v1/body/microphone",pcm,done*2,"audio/pcm",out);
    heap_caps_free(pcm); ack("microphone",ok,done*2);
}
void play() {
    auto url=lihuahuaBodyEndpoint("/v1/body/audio"); esp_http_client_config_t cfg{};
    cfg.url=url.c_str(); cfg.timeout_ms=8000;
    auto c=esp_http_client_init(&cfg); if(!c) return;
    auto codec=Board::GetInstance().GetAudioCodec(); size_t total=0; bool ok=false;
    if(codec && esp_http_client_open(c,0)==ESP_OK) {
        int length=esp_http_client_fetch_headers(c);
        if(esp_http_client_get_status_code(c)==200 && length>0 && length%2==0) {
            codec->SetOutputVolume(90); codec->EnableOutput(true);
            std::vector<int16_t> pcm(960);
            while(total<size_t(length)) {
                size_t wanted=std::min<size_t>(1920,length-total), have=0;
                while(have<wanted) {
                    int n=esp_http_client_read(c,reinterpret_cast<char*>(pcm.data())+have,wanted-have);
                    if(n<=0) break;
                    have+=n;
                }
                if(!have || have%2) break;
                pcm.resize(have/2); codec->OutputData(pcm); total+=have; pcm.resize(960);
            }
            codec->EnableOutput(false); ok=total==size_t(length);
        }
    }
    esp_http_client_cleanup(c); ack("speaker",ok,total);
}
}
void lihuahuaBodyRequestCapture() { capture_requested=true; }
void lihuahuaBodyRequestRecord() { record_requested=true; }
void lihuahuaBodyIOPoll() {
    std::string out;
    if(request("/v1/body/commands",nullptr,0,nullptr,out)) {
        auto json=cJSON_Parse(out.c_str());
        if(json) {
            if(cJSON_IsTrue(cJSON_GetObjectItem(json,"capture"))) capture_requested=true;
            if(cJSON_IsTrue(cJSON_GetObjectItem(json,"record"))) record_requested=true;
            bool audio=cJSON_IsTrue(cJSON_GetObjectItem(json,"audio")); cJSON_Delete(json);
            if(audio) play();
        }
    }
    if(capture_requested.exchange(false)) capture();
    if(record_requested.exchange(false)) record();
}
std::string lihuahuaBodyEndpoint(const char* path) {
    if(bridge_base.empty()) {
        std::string initial=STACKCHAN_BODY_BRIDGE_URL;
        bridge_base=initial.substr(0,initial.find("/v1/body/state"));
    }
    return bridge_base+path;
}
void lihuahuaBodyDiscover() {
    int fd=socket(AF_INET,SOCK_DGRAM,0); if(fd<0)return;
    int enabled=1; setsockopt(fd,SOL_SOCKET,SO_BROADCAST,&enabled,sizeof(enabled));
    timeval timeout{0,600000}; setsockopt(fd,SOL_SOCKET,SO_RCVTIMEO,&timeout,sizeof(timeout));
    sockaddr_in target{};target.sin_family=AF_INET;target.sin_port=htons(17872);target.sin_addr.s_addr=INADDR_BROADCAST;
    const char* probe="LIHUAHUA_DISCOVER_V1";
    sendto(fd,probe,strlen(probe),0,reinterpret_cast<sockaddr*>(&target),sizeof(target));
    sockaddr_in peer{};socklen_t length=sizeof(peer);char reply[64]{};
    int n=recvfrom(fd,reply,sizeof(reply)-1,0,reinterpret_cast<sockaddr*>(&peer),&length);
    if(n>0 && std::string(reply,n)=="LIHUAHUA_BODY_V1 17871") {
        bridge_base=std::string("http://")+inet_ntoa(peer.sin_addr)+":17871";
        ESP_LOGI("LiHuahua","LAN bridge discovered");
    }
    close(fd);
}
